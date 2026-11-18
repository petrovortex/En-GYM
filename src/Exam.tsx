import { useState, useEffect, useRef } from 'react'
import { WordCapture } from './WordCapture.tsx'
import { catalog } from '../core/types.ts'
import { liveSpeakingItem } from '../core/speech.ts'
import { api, isLive, localFetch, localAudioUrl } from './api.ts'
import { SessionAudio } from './SessionAudio.tsx'
import type { LiveView, Session } from './api.ts'
import { microphone, stopStream, toWave, waitForMicrophoneRelease } from './audio.ts'
const time = (seconds: number) =>
  Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
export function Exam({
  s,
  update,
}: {
  s: LiveView
  update: (s: Session) => void
}) {
  const [now, setNow] = useState(Date.now()),
    [error, err] = useState(''),
    [busy, setBusy] = useState(false),
    [playing, setPlaying] = useState(false),
    [recording, setRecording] = useState(false),
    [saving, setSaving] = useState(false),
    [hide, setHide] = useState(false)
  const q = liveSpeakingItem(s.item),
    localKey = 'fieldwork-draft-' + s.id + '-' + q.id
  const [text, setText] = useState(
    () => localStorage.getItem(localKey) ?? s.answer.text ?? '',
  )
  const [heard, setHeard] = useState(s.played),
    [clip, setClip] = useState(s.answer.clip)
  const audio = useRef<HTMLAudioElement | null>(null),
    rec = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    openingMic = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    pending = useRef(Promise.resolve()),
    latest = useRef(text),
    alive = useRef(true),
    expired = useRef(false)
  const [responseEnd, setEnd] = useState(s.responseUntil)
  const remaining = s.deadline
    ? Math.max(0, Math.ceil((s.deadline - now) / 1000))
    : 0
  const post = (name: string, data: object = {}) =>
    api<Session>(name, { id: s.id, item: q.id, ...data })
  function releaseMicrophone() {
    if (stream.current) stopStream(stream.current)
    stream.current = null
  }
  function finishRecording() {
    if (rec.current?.state === 'recording') rec.current.stop()
    releaseMicrophone()
  }
  useEffect(() => {
    alive.current = true
    const tick = setInterval(() => setNow(Date.now()), 200)
    return () => {
      alive.current = false
      clearInterval(tick)
      if (audio.current) {
        audio.current.onended = null
        audio.current.onerror = null
        audio.current.pause()
        if (audio.current.src.startsWith('blob:')) URL.revokeObjectURL(audio.current.src)
        audio.current = null
      }
      if (timer.current) clearTimeout(timer.current)
      finishRecording()
    }
  }, [])
  useEffect(() => {
    if (s.deadline && remaining === 0 && !expired.current) {
      expired.current = true
      api<Session>('attempt/' + s.id)
        .then(update)
        .catch((e) => {
          err(e.message)
          expired.current = false
        })
    }
  }, [remaining, s.deadline])
  useEffect(() => {
    if (
      recording &&
      responseEnd &&
      now >= responseEnd &&
      rec.current?.state === 'recording'
    )
      finishRecording()
  }, [recording, now, responseEnd])
  function queueSave(value: string) {
    const job = pending.current.then(async () => {
      await post('answer', { text: value })
      if (localStorage.getItem(localKey) === value)
        localStorage.removeItem(localKey)
    })
    pending.current = job.catch(() => {})
    return job
  }
  function change(value: string) {
    latest.current = value
    setText(value)
    localStorage.setItem(localKey, value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(
      () => queueSave(value).catch((e) => err(e.message)),
      220,
    )
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true)
    err('')
    try {
      await fn()
    } catch (e) {
      err((e as Error).message)
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  async function navigate(direction = 'next') {
    await action(async () => {
      if (timer.current) clearTimeout(timer.current)
      if (localStorage.getItem(localKey) !== null)
        await queueSave(latest.current)
      await pending.current
      update(await post(direction))
    })
  }
  async function startRecording() {
    if (openingMic.current || rec.current?.state === 'recording' || !alive.current) return
    openingMic.current = true
    try {
      await recordResponse()
    } finally {
      openingMic.current = false
    }
  }
  async function recordResponse() {
    const v = await post('response')
    if (!alive.current) return
    if (!isLive(v) || v.item.id !== q.id) {
      update(v)
      return
    }
    if (v.responseUntil <= Date.now()) {
      err('The response window has closed. Continue to the next item.')
      return
    }
    setEnd(v.responseUntil)
    const source = await microphone()
    if (!alive.current) {
      stopStream(source)
      return
    }
    stream.current = source
    try {
      const r = new MediaRecorder(source)
      rec.current = r
      const parts: Blob[] = []
      r.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data)
      }
      r.onstop = async () => {
        if (stream.current === source) releaseMicrophone()
        setRecording(false)
        setSaving(true)
        try {
          const wav = await toWave(new Blob(parts, { type: r.mimeType }))
          const res = await localFetch(
            '/api/record?id=' + s.id + '&item=' + q.id,
            {
              method: 'POST',
              headers: { 'x-fieldwork': 'local' },
              body: wav,
            },
          )
          const result = await res.json()
          if (!res.ok) throw Error(result.error)
          if (alive.current) {
            setClip(result.answer?.clip)
            if (s.mode !== 'drill') {
              const next = await post('next')
              if (alive.current) update(next)
            }
          }
        } catch (e) {
          if (alive.current) err((e as Error).message)
        } finally {
          if (alive.current) setSaving(false)
        }
      }
      if (v.responseUntil <= Date.now()) {
        releaseMicrophone()
        err('The response window has closed. Continue to the next item.')
        return
      }
      r.start(200)
      setRecording(true)
    } catch (e) {
      releaseMicrophone()
      throw e
    }
  }
  async function listen() {
    if (openingMic.current || stream.current) return
    await action(async () => {
      if (audio.current?.src.startsWith('blob:')) URL.revokeObjectURL(audio.current.src)
      const player = new Audio()
      audio.current = player
      const url = await localAudioUrl(s.audio!)
      if (!alive.current || audio.current !== player) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url)
        return
      }
      player.src = url
      await waitForMicrophoneRelease()
      if (!alive.current || audio.current !== player) return
      player.onended = () => {
        setPlaying(false)
        setHeard(true)
        if (s.limit && !clip) void action(async () => {
          try {
            await startRecording()
          } catch {
            throw Error('Microphone unavailable. Allow microphone access, then select Record. You can also continue without recording.')
          }
        })
      }
      player.onerror = () => {
        setPlaying(false)
        err('Audio could not play. Check your output device and retry.')
      }
      await player.play()
      if (!alive.current || audio.current !== player) return
      setPlaying(true)
      await post('play')
    })
  }
  useEffect(() => {
    if (s.itemStarted && s.mode !== 'drill' && s.audio && !s.played)
      void listen()
  }, [])
  const cardError = error && (
    <div className="alert" role="alert">
      {error}
    </div>
  )
  if (!s.itemStarted)
    return (
      <div className="exam">
        <div className="examBar">
          <b>En-GYM</b>
          <span>{s.section}</span>
        </div>
        <div className="directions">
          <span className="eyebrow">SECTION DIRECTIONS</span>
          <h1>{s.section}</h1>
          <h2>{s.stageName}</h2>
          <p>
            {s.minutes
              ? s.minutes +
                ' minutes are available for this module. The clock continues if the page is closed.'
              : 'Practice at your own pace. Your recordings and answers are saved on this computer.'}
          </p>
          <p>
            {s.section === 'Speaking'
              ? 'Use a microphone. Listen to the prompt, then record your response.'
              : s.section === 'Listening'
                ? 'Listen before answering. Questions about the same clip share one playback.'
                : 'Read each question carefully and select or enter your response.'}
          </p>
          {cardError}
          <button
            className="primary"
            disabled={busy}
            onClick={() => action(async () => update(await post('begin')))}
          >
            Begin {s.mode === 'drill' ? 'exercise' : 'module'} →
          </button>
        </div>
      </div>
    )
  const options = q.options,
    fill = text.split('|'),
    parts = q.passage?.split(/(\{\d+\})/)
  const selected = text ? text.split(' | ') : []
  const timerLabel = s.deadline ? time(remaining) : 'Untimed'
  return (
    <div className="exam">
      <div className="examBar">
        <b>En-GYM</b>
        <span>
          {s.section} &nbsp; / &nbsp; {s.stageName}
        </span>
        <button onClick={() => setHide(!hide)}>
          {hide ? 'Show time' : timerLabel}
        </button>
      </div>
      <div className="examTools">
        <span>
          Question {s.index + 1} of {s.count}
        </span>
        <div className="examNav">
          {s.section === 'Reading' && s.index > 0 && (
            <button disabled={busy} onClick={() => navigate('back')}>
              ← Back
            </button>
          )}
          <button
            disabled={busy || recording || saving || playing}
            onClick={() => navigate()}
          >
            Next →
          </button>
        </div>
      </div>
      <WordCapture
        attempt={s.id}
        item={q.id}
        className={
          'examBody ' + (q.passage && q.task !== 'words' ? 'split' : '')
        }
      >
        {q.passage && q.task !== 'words' && (
          <article className="stimulus">
            <h2>{q.title}</h2>
            <div className="prose">{q.passage}</div>
          </article>
        )}
        <section className="response">
          <span className="eyebrow">{catalog[q.task][1]}</span>
          <h2>{q.prompt}</h2>
          {s.audio && (
            <div className="audioPanel">
              <span className="soundMark">◖)))</span>
              <b>
                {playing
                  ? 'Playing prompt…'
                  : heard
                    ? 'Prompt played'
                    : 'Audio prompt'}
              </b>
              <button
                disabled={
                  playing ||
                  recording ||
                  saving ||
                  busy ||
                  (heard && s.mode !== 'drill')
                }
                onClick={listen}
              >
                {playing
                  ? 'Listening…'
                  : heard
                    ? 'Replay prompt'
                    : 'Play prompt'}
              </button>
            </div>
          )}
          {q.task === 'words' && (
            <div className="cloze">
              {parts?.map((p, i) => {
                if (!p.startsWith('{')) return p
                const n = Number(p.slice(1, -1))
                return (
                  <input
                    key={i}
                    aria-label={'Missing letters ' + (n + 1)}
                    autoComplete="off"
                    spellCheck={false}
                    value={fill[n] ?? ''}
                    onChange={(e) => {
                      const values = Array.from({ length: 10 }, (_, j) =>
                        j === n ? e.target.value : (fill[j] ?? ''),
                      )
                      change(values.join('|'))
                    }}
                  />
                )
              })}
            </div>
          )}
          {options && (
            <div className="options">
              {options.map((v, i) => (
                <label key={i}>
                  <input
                    type="radio"
                    name="answer"
                    checked={text === v}
                    disabled={!!s.audio && (!heard || playing)}
                    onChange={() => change(v)}
                  />
                  <span>{v}</span>
                </label>
              ))}
            </div>
          )}
          {q.chunks && (
            <>
              <div className="sentenceAnswer">
                {selected.length
                  ? selected.map((v, i) => (
                      <button
                        key={i}
                        onClick={() =>
                          change(
                            selected.filter((_, j) => j !== i).join(' | '),
                          )
                        }
                      >
                        {v} ×
                      </button>
                    ))
                  : 'Select the words in sentence order.'}
              </div>
              <div className="chips">
                {q.chunks.map((c, i) => (
                  <button
                    key={i}
                    disabled={selected.includes(c)}
                    onClick={() => change([...selected, c].join(' | '))}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </>
          )}
          {['email', 'discussion'].includes(q.task) && (
            <>
              <textarea
                className="essay"
                aria-label="Your response"
                spellCheck={false}
                value={text}
                onChange={(e) => change(e.target.value)}
              />
              <small>
                {text.trim() ? text.trim().split(/\s+/).length : 0} words
              </small>
            </>
          )}
          {!!s.limit && (
            <div className="micPanel">
              <strong>
                {recording
                  ? 'Recording · ' +
                    Math.max(0, Math.ceil((responseEnd - now) / 1000)) +
                    's'
                  : saving
                    ? 'Saving recording…'
                    : clip
                      ? 'Recording saved'
                      : 'Your response'}
              </strong>
              {clip && s.mode === 'drill' && (
                <SessionAudio label="Your recording" src={'/clips/' + clip + '.wav'} />
              )}
              <button
                disabled={
                  busy ||
                  saving ||
                  playing ||
                  !heard ||
                  (!!clip && s.mode !== 'drill')
                }
                onClick={() =>
                  recording ? finishRecording() : action(startRecording)
                }
              >
                {recording
                  ? 'Finish recording'
                  : clip
                    ? 'Record again'
                    : 'Record response'}
              </button>
            </div>
          )}
          {cardError}
        </section>
      </WordCapture>
    </div>
  )
}
