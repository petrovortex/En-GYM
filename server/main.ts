import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  createReadStream,
  statSync,
  renameSync,
} from 'node:fs'
import { resolve, join, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { LocalSessions, launchPage, launchScript } from './local-session.ts'
import { promptUrl } from '../core/speech.ts'
import metadata from '../package.json' with { type: 'json' }
import { bank, advance, begin, expire, RULES } from '../core/exam.ts'
import { current, secondsLimit } from '../core/types.ts'
import type { Attempt, Mode, Item, Stage } from '../core/types.ts'
import {
  history,
  responseHistory,
  load,
  save,
  clips,
  cache,
  verifyProfile,
  timedExamInProgress,
} from './store.ts'
import {
  audioKey,
  synth,
  wavInfo,
  wave,
  voicePack,
} from './speech.ts'
import {
  authorize,
  callback,
  preferences,
  setProvider,
  saveConnection,
  setModels,
  disconnect,
  verify,
} from './provider.ts'
import { localTranscript } from './coach.ts'
import { chat } from './analysis.ts'
import {
  bankStatus,
  setBankEnabled,
  replenish,
  runBank,
  runGameBank,
  migratePreparedMaterial,
} from './bank.ts'
import { backgroundAllowed, examActivity, foregroundWork } from './work.ts'
import { checkUpdates, installUpdates, updateStatus } from './updates.ts'
import { practicePlan, consumePlan } from './practice.ts'
import { selectSession } from './selection.ts'
import {
  prepareSession,
  continuePreparation,
  preparationStatus,
  cancelPreparation,
  retryPreparation,
  readyPreparation,
  completePreparation,
  preparationPending,
  currentPreparation,
} from './preparation.ts'
import { MaterialShortage } from '../core/selection.ts'
import {
  availability,
  readySession,
  warmStockAudio,
  audioReady,
  promptPath,
  audioStatus,
} from './inventory.ts'
import { assessAttempt } from './assess.ts'
import {
  vocabularyWords,
  vocabularyTexts,
  removeVocabularyWord,
  removeVocabularyText,
} from './store.ts'
import { addWord, generateVocabularyText } from './vocabulary.ts'
import { startGame, continueGame, checkAlternatives, recordGameProgress } from './games.ts'

const installed = process.env.EN_GYM_INSTALLED === '1'
const sessions = installed ? new LocalSessions() : undefined
const port = Number(process.env.FIELDWORK_PORT ?? (installed ? 43128 : 43127)),
  host = '127.0.0.1:' + port,
  origin = 'http://' + host
const dist = resolve('dist')
if (process.argv.includes('--verify-update')) {
  if (!installed) throw Error('Use the installed profile to verify an update.')
  verifyProfile()
  const index = readFileSync(join(dist, 'index.html'), 'utf8')
  const assets = [...index.matchAll(/(?:src|href)="(\/assets\/[\w.-]+\.(?:js|css))"/g)].map((m) => m[1])
  if (!assets.some((p) => p.endsWith('.js')) || assets.some((p) => !statSync(join(dist, p)).isFile()))
    throw Error('The installed interface is incomplete.')
  process.exit(0)
}
const mime: Record<string, string> = {
  '.js': 'text/javascript',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
}
async function body(req: IncomingMessage, limit = 100000) {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of req) {
    size += part.length
    if (size > limit) throw Error('Upload is too large.')
    parts.push(part)
  }
  return Buffer.concat(parts)
}
function file(res: ServerResponse, path: string) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
    'Content-Length': statSync(path).size,
    'Cache-Control': path.endsWith('.wav')
      ? 'private, no-store'
      : 'no-cache',
  })
  createReadStream(path).pipe(res)
}
async function prepare(q: Item) {
  if (!audioReady(q)) await foregroundWork(() => synth(q, cache))
}
type Live = Attempt & {
  played?: string[]
  responseUntil?: number
  capture?: { item: string; start: number; end: number }
}
function view(a: Live) {
  if (a.ended) return a
  const st = a.stages[a.stage],
    q = current(a)
  return {
    id: a.id,
    mode: a.mode,
    focus: a.focus,
    stage: a.stage,
    index: a.index,
    deadline: a.deadline,
    itemStarted: a.itemStarted,
    stageName: st.name,
    section: st.section,
    count: st.items.length,
    minutes: st.minutes,
    answer: a.answers[q.id] ?? {},
    responseUntil: a.responseUntil ?? 0,
    item: {
      ...q,
      keys: undefined,
      evidence: undefined,
      speech: undefined,
      passage:
        q.task === 'words' ? q.passage : q.speech ? undefined : q.passage,
    },
    audio: q.speech
      ? audioReady(q)
        ? promptUrl('/audio/' + audioKey(q) + '.wav', voicePack)
        : promptUrl('/api/stimulus?id=' + a.id + '&item=' + q.id, voicePack)
      : null,
    played:
      a.played?.includes(
        q.group && q.task !== 'repeat' && q.task !== 'interview'
          ? q.group
          : q.id,
      ) ?? false,
    limit: secondsLimit(q),
  }
}
function active(id: string): Live {
  const a = load(id) as Live
  if (expire(a)) {
    a.responseUntil = 0
    save(a)
  }
  return a
}
let pendingWrites = 0
const safeToUpdate = () => !pendingWrites && backgroundAllowed(true) && !timedExamInProgress()
const server = createServer(async (req, res) => {
  let countsAsWrite = false
  const out = (data: unknown) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(data))
  }
  try {
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      res.writeHead(403).end()
      return
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    )
    const url = new URL(req.url ?? '/', origin),
      path = url.pathname
    if (req.method === 'GET' && path === '/auth/callback') {
      try {
        if (installed && updateStatus().state === 'restarting') throw Error('En-GYM is restarting.')
        await foregroundWork(() => callback(url.searchParams))
        res.writeHead(303, { Location: '/#settings' }).end()
      } catch (e) {
        res
          .writeHead(400, { 'content-type': 'text/plain' })
          .end((e as Error).message + ' Open Settings to reconnect.')
      }
      return
    }
    if (sessions) {
      if (req.method === 'GET' && (path === '/launch' || path === '/launch.js')) {
        const script = path === '/launch.js'
        res.writeHead(200, {
          'content-type': script ? 'text/javascript' : 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        }).end(script ? launchScript : launchPage)
        return
      }
      const writing = req.method !== 'GET'
      if (writing && (req.headers.origin !== origin || req.headers['x-fieldwork'] !== 'local')) {
        res.writeHead(403).end()
        return
      }
      if (req.method === 'POST' && path === '/api/local-session') {
        const session = sessions.exchange(JSON.parse((await body(req, 256)).toString()).ticket)
        if (session) return out({ session })
        res.writeHead(403).end()
        return
      }
      if ((writing || /^\/(api|clips|audio)\//.test(path)) &&
          !sessions.authenticated(req.headers.authorization)) {
        res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'Open En-GYM from its desktop shortcut or tray icon to reconnect.' }))
        return
      }
      if (updateStatus().state === 'restarting' && path.startsWith('/api/') && path !== '/api/updates/status')
        throw Error('En-GYM is restarting to apply the update.')
    }
    if (req.method === 'GET') {
      if (path === '/api/history') return out(history())
      if (path === '/api/voice-preview') {
        const q = bank.find((q) => q.task === 'conversation')!
        await prepare(q)
        return file(res, promptPath(audioKey(q)))
      }
      if (path === '/api/responses')
        return out(
          responseHistory(
            url.searchParams.get('section') ?? '',
            url.searchParams.get('task') ?? '',
          ),
        )
      if (path === '/api/prefs') return out(preferences())
      if (path === '/api/bank') return out(bankStatus())
      if (path === '/api/availability')
        return out({
          sessions: availability(),
          bank: bankStatus(),
          audio: audioStatus(),
        })
      if (path === '/api/vocabulary')
        return out({ words: vocabularyWords(), texts: vocabularyTexts() })
      if (path === '/api/preparation') return out(currentPreparation())
      if (path.startsWith('/api/preparation/'))
        return out(preparationStatus(path.split('/').pop()!))
      if (path === '/api/status')
        return out({
          app: 'En-GYM',
          rules: RULES,
          release: metadata.version,
          speech: voicePack,
        })
      if (path === '/api/updates/status') return out(updateStatus())
      if (path.startsWith('/api/attempt/')) {
        const a = active(path.split('/').pop()!)
        if (!a.ended) await prepare(current(a))
        return out(view(a))
      }
      if (path === '/api/reference') {
        const a = load(url.searchParams.get('id') ?? ''),
          q = a.stages
            .flatMap((s) => s.items)
            .find((q) => q.id === url.searchParams.get('item'))
        if (!a.ended || !q?.speech)
          throw Error('No reference recording for this response.')
        await prepare(q)
        return file(res, promptPath(audioKey(q)))
      }
      if (path === '/api/stimulus') {
        const a = active(url.searchParams.get('id') ?? ''),
          q = current(a)
        if (a.ended || q.id !== url.searchParams.get('item') || !q.speech)
          throw Error('This audio is not the active prompt.')
        await prepare(q)
        return file(res, promptPath(audioKey(q)))
      }
      if (/^\/audio\/[a-f0-9]{64}\.wav$/.test(path))
        return file(res, promptPath(path.slice(7, -4)))
      if (/^\/clips\/[a-f0-9-]{36}\.wav$/.test(path))
        return file(res, join(clips, path.slice(7)))
      const filename = resolve(
        dist,
        '.' + decodeURIComponent(path === '/' ? '/index.html' : path),
      )
      if (!filename.startsWith(dist + sep)) {
        res.writeHead(403).end()
        return
      }
      return file(res, filename)
    }
    if (req.method !== 'POST' || req.headers['x-fieldwork'] !== 'local') {
      res.writeHead(403).end()
      return
    }
    if (path === '/api/updates/check') return out(await checkUpdates())
    if (path === '/api/updates/install') {
      if (!installed) throw Error('Install En-GYM to update from Settings.')
      if (!safeToUpdate()) throw Error('Finish your current activity before updating.')
      const request = JSON.parse((await body(req, 1024)).toString() || '{}')
      return out(await installUpdates(safeToUpdate, request.components))
    }
    // A slow request body (particularly a recording upload) must finish before
    // the updater takes its SQLite snapshot and stops this process.
    if (installed) {
      countsAsWrite = true
      pendingWrites++
    }
    if (path === '/api/record') {
      const wav = await body(req, 4e6),
        { rate, pcm } = wavInfo(wav)
      const a = active(url.searchParams.get('id') ?? ''),
        capture = a.capture
      if (
        !capture ||
        capture.item !== url.searchParams.get('item') ||
        Date.now() > capture.end + 15000 ||
        rate !== 16000 ||
        pcm.length > 16000 * 2 * 90
      )
        throw Error(
          'This recording does not match the active response window.',
        )
      const samples = pcm.subarray(
        0,
        Math.max(
          0,
          Math.floor(((capture.end - capture.start) * rate) / 1000),
        ) * 2,
      )
      if (!samples.length) throw Error('The response window has closed.')
      const key = randomUUID()
      writeFileSync(join(clips, key + '.tmp'), wave(samples, rate))
      renameSync(join(clips, key + '.tmp'), join(clips, key + '.wav'))
      a.answers[capture.item] = {
        ...a.answers[capture.item],
        clip: key,
        seconds: samples.length / (rate * 2),
      }
      delete a.capture
      save(a)
      return out(view(a))
    }
    const b = JSON.parse((await body(req)).toString() || '{}')
    if (path === '/api/prepare') {
      examActivity(false)
      const result = prepareSession({
        mode: b.mode,
        focus: b.mode === 'full' ? 'Full mock' : String(b.focus),
        length: b.length,
        retry: b.retry,
        followUp: b.followUp,
      })
      out(result)
      void continuePreparation().catch((e) =>
        console.error('Preparation:', e.message),
      )
      return
    }
    if (path === '/api/cancel-preparation') {
      cancelPreparation(b.id)
      return out({ ok: true })
    }
    if (path === '/api/retry-preparation') {
      const result = retryPreparation(String(b.id))
      out(result)
      void continuePreparation().catch((e) =>
        console.error('Preparation:', e.message),
      )
      return
    }
    if (path === '/api/vocabulary/add') return out(addWord(b))
    if (path === '/api/games/progress') {
      recordGameProgress(b.track,b.batch,b.events)
      return out({ok:true})
    }
    if (path === '/api/games/start') {
      if (b.previous && b.endless === true) return out(continueGame(b.track,b.level,b.focus,b.previous))
      return out(startGame(b.track, b.level, b.focus, b.endless === true))
    }
    if (path === '/api/games/check') return out(await checkAlternatives(b.track, b.answers, b.required))
    if (path === '/api/vocabulary/remove') {
      removeVocabularyWord(String(b.id))
      return out({ ok: true })
    }
    if (path === '/api/vocabulary/text')
      return out(await generateVocabularyText(b))
    if (path === '/api/vocabulary/remove-text') {
      removeVocabularyText(String(b.id))
      return out({ ok: true })
    }
    if (path === '/api/practice-plan')
      return out(practicePlan(b.task, b.length))
    if (path === '/api/activity') {
      examActivity(!!b.active, String(b.client ?? 'browser').slice(0, 100))
      return out({ ok: true })
    }
    if (path === '/api/bank') {
      setBankEnabled(!!b.enabled)
      replenish()
      return out(bankStatus())
    }
    if (path === '/api/start') {
      const mode: Mode = b.mode
      if (!['full', 'section', 'drill'].includes(mode))
        throw Error('Unknown mode.')
      const focus = mode === 'full' ? 'Full mock' : String(b.focus)
      const prepared = b.preparationId
        ? readyPreparation(b.preparationId)
        : undefined
      if (
        prepared &&
        (prepared.request.mode !== mode || prepared.request.focus !== focus)
      )
        throw Error('Prepared session does not match this request.')
      const planned =
        !prepared && mode === 'drill' && b.planId
          ? consumePlan(b.planId, focus)
          : undefined
      const ready =
        !prepared && !planned && !b.retry && !b.followUp
          ? readySession({ mode, focus, length: b.length })
          : undefined
      const seed =
        prepared?.seed ??
        planned?.seed ??
        ready?.seed ??
        randomBytes(4).readUInt32LE()
      const selected: { stages: Stage[]; retryOf?: Attempt['retryOf'] } =
        prepared ??
        planned ??
        ready ??
        selectSession(
          {
            mode,
            focus,
            length: b.length,
            retry: b.retry,
            followUp: b.followUp,
          },
          seed,
        )
      const { stages, retryOf } = selected
      examActivity()
      await foregroundWork(async () => {
        for (const s of stages)
          for (const q of [...s.items, ...(s.upper ?? [])]) await prepare(q)
      })
      const a: Live = {
        id: randomUUID(),
        mode,
        focus,
        seed,
        started: Date.now(),
        stage: 0,
        index: 0,
        deadline: 0,
        itemStarted: 0,
        rules: RULES,
        stages,
        answers: {},
        bands: {},
        messages: [],
      }
      a.retryOf = retryOf
      if (mode === 'drill')
        a.practiceLength =
          prepared?.request.length ??
          planned?.length ??
          b.length ??
          'standard'
      if (prepared) completePreparation(prepared.id, () => save(a))
      else save(a)
      return out(view(a))
    }
    if (path === '/api/connect') return out({ url: authorize(origin) })
    if (path === '/api/disconnect') {
      disconnect(b.provider)
      return out(preferences())
    }
    if (path === '/api/prefs') {
      setProvider(b.provider, String(b.model ?? ''), b.key)
      return out(preferences())
    }
    if (path === '/api/connections') {
      saveConnection(b.provider, String(b.model ?? ''), b.key)
      return out(preferences())
    }
    if (path === '/api/models') {
      setModels(b.roles)
      return out(preferences())
    }
    if (path === '/api/verify')
      return out(await foregroundWork(() => verify(b.provider)))
    if (path === '/api/assess') return out(await assessAttempt(b.id))
    if (path === '/api/transcript')
      return out(await foregroundWork(() => localTranscript(b.id, b.item)))
    if (path === '/api/chat')
      return out(
        await chat(b.id, b.message, {
          scope: b.scope,
          item: b.item,
          action: b.action,
        }),
      )
    const a = active(b.id),
      q = current(a)
    if (a.ended || q.id !== b.item) return out(view(a))
    switch (path) {
      case '/api/begin':
        begin(a)
        break
      case '/api/play': {
        const key =
          q.group && !['repeat', 'interview'].includes(q.task)
            ? q.group
            : q.id
        a.played ??= []
        if (!a.played.includes(key)) a.played.push(key)
        break
      }
      case '/api/response': {
        if (!a.itemStarted || !secondsLimit(q))
          throw Error('Start a speaking item first.')
        if (!a.responseUntil || a.mode === 'drill') {
          const start = Date.now(),
            end = Math.min(
              start + secondsLimit(q) * 1000,
              a.deadline || Infinity,
            )
          a.capture = { item: q.id, start, end }
          a.responseUntil = end
        }
        break
      }
      case '/api/answer':
        if (!a.itemStarted) throw Error('Start the module first.')
        ;(a.answers[q.id] ??= {}).text = String(b.text ?? '').slice(
          0,
          40000,
        )
        break
      case '/api/next':
        advance(a)
        a.responseUntil = 0
        break
      case '/api/back':
        if (
          a.itemStarted &&
          a.stages[a.stage].section === 'Reading' &&
          a.index > 0
        ) {
          ;(a.answers[q.id] ??= {}).elapsed =
            (a.answers[q.id]?.elapsed ?? 0) +
            (Date.now() - a.itemStarted) / 1000
          a.index--
          a.itemStarted = Date.now()
        }
        break
      default:
        res.writeHead(404).end()
        return
    }
    save(a)
    if (a.ended) {
      examActivity(false)
      replenish()
    }
    out(view(a))
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: (e as Error).message,
          code:
            e instanceof MaterialShortage
              ? 'fresh_material_needed'
              : undefined,
        }),
      )
    } else res.end()
  } finally {
    if (countsAsWrite) pendingWrites--
  }
})
function openBrowser() {
  spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [origin], {
    windowsHide: true,
    stdio: 'ignore',
  }).unref()
}
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE'
    ? 'En-GYM could not start because its local port is already in use.'
    : 'Unable to start En-GYM: ' + e.message)
  process.exitCode = 1
})
server.listen(port, '127.0.0.1', () => {
  examActivity(true, 'startup') // Briefly defer background work until the browser restores its session.
  migratePreparedMaterial()
  const bankTick = async () => {
    try {
      replenish()
      await runGameBank()
      await runBank()
    } catch (e) {
      console.error('Bank:', (e as Error).message)
    } finally {
      setTimeout(bankTick, 1000).unref()
    }
  }
  const audioTick = async () => {
    try {
      await warmStockAudio()
    } catch (e) {
      console.error('Audio:', (e as Error).message)
    } finally {
      setTimeout(audioTick, 1000).unref()
    }
  }
  // Warming installed material should not wait for a slow provider response.
  void bankTick()
  void audioTick()
  if (sessions) {
    const control = createInterface({ input: process.stdin, terminal: false })
    control.on('line', (command) => {
      if (command === 'OPEN') process.stdout.write('EN_GYM_OPEN ' + origin + '/launch#' + sessions.ticket() + '\n')
      if (command === 'QUIT') control.close()
    })
    control.on('close', () => server.close(() => process.exit(0)))
    process.stdout.write('EN_GYM_READY\n')
  } else {
    console.log('En-GYM is ready at ' + origin)
    if (process.argv.includes('--open')) openBrowser()
  }
})
