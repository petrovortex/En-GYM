import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import {
  roundRules,
  responseParts,
  prepGroups,
  gameNames,
  type PrepFocus,
  type Track,
  type GameRound,
  type GameCard,
  type Level,
} from '../core/games.ts'
import {
  gameStorage,
  restored,
  makeSession,
  clock,
  outcome,
  canAppeal,
  totals,
  checkedCards,
  submitCard,
  applyChecks,
  type Checks,
  type Session,
} from './game-session.ts'
import './games.css'

type Game = 'match' | 'gap' | 'relations'
const games = {
  match: {
    name: gameNames.match,
    description: 'Pair each word with its meaning.',
  },
  gap: {
    name: gameNames.vocabulary,
    description: 'Complete a sentence in context.',
  },
  relations: {
    name: gameNames.relations,
    description: 'Find another way to say it, or its opposite.',
  },
}
function captureCard(card: GameCard, answer = card.answers[0]) {
  const context =
    card.track === 'match'
      ? card.term + ' — ' + card.prompt
      : card.prompt.replace('___', () =>
          answer === 'no preposition' ? '' : answer,
        )
  return {
    'data-game-item': card.id,
    'data-game-track': card.track,
    'data-game-context': context,
  }
}

const labels = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  skipped: 'Skipped',
}
function AnswerFeedback({
  card,
  result,
  required,
  answer,
  note,
  check,
  next,
  nextLabel,
  busy,
}: {
  card: GameCard
  result: keyof typeof labels
  required: number
  answer: string
  note?: string
  check?: () => void
  next?: () => void
  nextLabel: string
  busy: boolean
}) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!busy) button.current?.focus({ preventScroll: true })
  }, [card.id, busy])
  const key =
    card.track === 'match'
      ? card.term + ' — ' + card.prompt
      : result === 'correct'
        ? answer
        : card.answers.slice(0, required).join(', ')
  const explanation =
    note ??
    (card.track !== 'match' && result !== 'correct' ? card.note : '')
  return (
    <div
      className={'answerFeedback ' + result}
      {...captureCard(card, result === 'correct' ? answer : undefined)}
    >
      <div role="status">
        <strong>
          {result === 'correct'
            ? 'Correct'
            : result === 'skipped'
              ? 'Skipped'
              : 'Incorrect'}
        </strong>
        <p>{key === 'no preposition' ? 'No preposition needed' : key}</p>
      </div>
      {explanation && (
        <details>
          <summary>Why?</summary>
          <p>{explanation}</p>
        </details>
      )}
      {(next || check) && (
        <div className="feedbackActions">
          {check && (
            <button className="textLink" onClick={check} disabled={busy}>
              Check my wording with trainer
            </button>
          )}
          {next && (
            <button
              type="button"
              className="primary"
              ref={button}
              onClick={next}
              disabled={busy}
            >
              {busy ? 'Please wait…' : nextLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
function GapText({ text, solution }: { text: string; solution?: string }) {
  const [first, last] = text.split('___')
  return (
    <>
      {first}
      {solution ? (
        <mark className="gameSolution">
          {solution === 'no preposition' ? (
            <span aria-label="no preposition">∅</span>
          ) : (
            solution
          )}
        </mark>
      ) : (
        <span className="gameBlank" aria-label="blank">
          ___
        </span>
      )}
      {last}
    </>
  )
}
function Preview({ game, prep }: { game: Game; prep: boolean }) {
  if (game === 'match')
    return (
      <div className="gameSample pairSample">
        <strong>threshold</strong>
        <span aria-hidden="true">⟷</span>
        <em>The point at which a change begins.</em>
      </div>
    )
  if (game === 'gap')
    return (
      <div className="gameSample">
        <GapText
          text={
            prep
              ? 'I’ll text you ___ Telegram when I arrive.'
              : 'The new evidence helped us rule ___ one possibility.'
          }
        />
      </div>
    )
  return (
    <div className="gameSample">
      “Space in the lab is <strong>limited</strong>.”{' '}
      <small>Find a synonym for limited.</small>
    </div>
  )
}
export function Games({ connected }: { connected: boolean }) {
  const [s, setSession] = useState<Session | undefined>(restored)
  const [game, setGame] = useState<Game>('match'),
    [prep, setPrep] = useState(true)
  const [level, setLevel] = useState<Level>('Standard')
  const [mode, setMode] = useState<'Round' | 'Timed round' | 'Endless'>(
    'Round',
  )
  const endless = mode === 'Endless',
    timed = mode === 'Timed round'
  const [focus, setFocus] = useState<PrepFocus | ''>('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [hint, setHint] = useState(false)
  const [activeWord, setActiveWord] = useState(''),
    [now, setNow] = useState(Date.now)
  const [reviewIssue, setReviewIssue] = useState<{
    batch: string; item?: string; message: string
  }>()
  const heading = useRef<HTMLHeadingElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const choices = useRef<HTMLDivElement>(null)
  const track: Track =
    game === 'gap' ? (prep ? 'prepositions' : 'vocabulary') : game
  const rules = roundRules(track, level)
  const round = s?.round
  const card = round?.cards[s?.index ?? 0]
  const feedbackCard = round?.cards.find((c) => c.id === s?.feedback)
  const events = s?.events,
    batch = s?.batch,
    playedTrack = s?.round.track
  const saved = useRef({ batch: '', count: 0 })
  // This call stays on localhost. A later prefix safely retries an interrupted write.
  useEffect(() => {
    if (!events?.length) return
    let active = true,
      retry: ReturnType<typeof setTimeout> | undefined
    let wait = 2000
    const flush = async () => {
      try {
        await api('games/progress', { track: playedTrack, batch, events })
        if (active) saved.current = { batch: batch!, count: events.length }
      } catch {
        if (active) {
          retry = setTimeout(flush, wait)
          wait = Math.min(30000, wait * 2)
        }
      }
    }
    void flush()
    return () => {
      active = false
      clearTimeout(retry)
    }
  }, [events, batch, playedTrack])
  useEffect(() => {
    if (s) sessionStorage.setItem(gameStorage, JSON.stringify(s))
    else sessionStorage.removeItem(gameStorage)
  }, [s])
  useEffect(() => {
    if (!s?.deadline || s.done) return
    const deadline = s.deadline
    const tick = () => {
      const time = Date.now()
      setNow(time)
      if (time >= deadline)
        setSession((v) => (v && !v.done ? { ...v, done: true } : v))
    }
    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [s?.deadline, s?.done])
  useEffect(() => {
    setHint(false)
    if (!s) return
    if (s.done) heading.current?.focus({ preventScroll: true })
    else if (!s.feedback || s.round.track === 'match') {
      const target =
        input.current ??
        choices.current?.querySelector<HTMLButtonElement>(
          'button:not(:disabled)',
        )
      target?.focus({ preventScroll: true })
    }
  }, [batch, card?.id, s?.feedback, s?.done])
  async function start() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const round = await api<GameRound>('games/start', {
        track,
        level,
        endless,
        focus: track === 'prepositions' && focus ? focus : undefined,
      })
      setNow(Date.now())
      setActiveWord('')
      setSession(makeSession(round, timed, endless))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function change(fn: (v: Session) => Session) {
    setSession((v) =>
      !v || v.done
        ? v
        : v.deadline && Date.now() >= v.deadline
          ? { ...v, done: true }
          : fn(v),
    )
  }
  async function back() {
    if (s) {
      if (
        s.events.length &&
        (saved.current.batch !== s.batch ||
          saved.current.count < s.events.length)
      ) {
        setBusy(true)
        try {
          await api('games/progress', {
            track: s.round.track,
            batch: s.batch,
            events: s.events,
          })
        } catch (e) {
          setError((e as Error).message)
          setBusy(false)
          return
        }
      }
      const t = s.round.track
      setGame(t === 'prepositions' || t === 'vocabulary' ? 'gap' : t)
      if (t === 'prepositions' || t === 'vocabulary')
        setPrep(t === 'prepositions')
      setLevel(s.round.level)
      setFocus(s.round.focus ?? '')
      setMode(s.endless ? 'Endless' : s.deadline ? 'Timed round' : 'Round')
    }
    setBusy(false)
    setActiveWord('')
    setError('')
    setSession(undefined)
  }
  async function review(only?: GameCard) {
    if (!s || busy) return
    setBusy(true)
    setError('')
    setReviewIssue(undefined)
    try {
      const checks = await api<Checks>('games/check', {
        track: s.round.track,
        required: s.round.required,
        answers: (only ? [only] : s.round.cards)
          .filter((c) => canAppeal(s, c))
          .map((c) => ({
            id: c.id,
            value: s.answers[c.id],
            prompt: c.prompt,
            term: c.term,
            relation: c.relation,
          })),
      })
      setSession((v) =>
        v?.batch === s.batch ? applyChecks(v, checks) : v,
      )
    } catch (e) {
      setReviewIssue({
        batch: s.batch, item: only?.id,
        message: e instanceof TypeError ? 'Check your connection and try again.' : (e as Error).message,
      })
    } finally {
      setBusy(false)
    }
  }
  async function advanceBatch() {
    if (!s || busy) return
    setError('')
    setReviewIssue(undefined)
    if (s.round.track !== 'match' && s.index + 1 < s.round.cards.length) {
      change((v) => ({ ...v, index: v.index + 1, feedback: undefined }))
      return
    }
    if (!s.endless) {
      change((v) => ({ ...v, done: true }))
      return
    }
    setBusy(true)
    try {
      const next = await api<GameRound>('games/start', {
        track: s.round.track,
        level: s.round.level,
        focus: s.round.focus,
        endless: true,
        previous: { batch: s.batch, events: s.events },
      })
      setActiveWord('')
      setSession(makeSession(next, false, true, totals(s)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const alert = error && (
    <p role="alert" className="alert">
      {error}
    </p>
  )
  const reviewNotice = reviewIssue && reviewIssue.batch === batch &&
    reviewIssue.item === (s?.done ? undefined : s?.feedback) && (
      <small className="gameReviewNotice" role="alert">{reviewIssue.message}</small>
    )
  if (!s || !round || !card)
    return (
      <section className="gamesLayout" aria-label="Vocabulary games">
        <div className="gamePicker">
          <h2>Choose a game</h2>
          {(Object.keys(games) as Game[]).map((g) => (
            <button
              key={g}
              aria-pressed={game === g}
              onClick={() => {
                setGame(g)
                setError('')
              }}
            >
              <span>
                <strong>{games[g].name}</strong>
                <small>{games[g].description}</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        <div className="gameSetup">
          <h2>{games[game].name}</h2>
          <Preview game={game} prep={prep} />
          {game === 'gap' && (
            <fieldset>
              <legend>Practice</legend>
              <div className="gameChoices">
                {(['Prepositions', 'Words & phrases'] as const).map(
                  (label, i) => (
                    <button
                      key={label}
                      aria-pressed={prep === (i === 0)}
                      onClick={() => setPrep(i === 0)}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
            </fieldset>
          )}
          {track === 'prepositions' && (
            <div className="gameFocus">
              <label htmlFor="game-preposition-topic">Topic</label>
              <select
                id="game-preposition-topic"
                value={focus}
                onChange={(e) =>
                  setFocus(e.target.value as PrepFocus | '')
                }
              >
                <option value="">All prepositions</option>
                {Object.keys(prepGroups).map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </div>
          )}
          <fieldset>
            <legend>Difficulty</legend>
            <div className="gameChoices">
              {(['Guided', 'Standard', 'Challenge'] as const).map((l) => (
                <button
                  key={l}
                  aria-pressed={level === l}
                  onClick={() => setLevel(l)}
                >
                  {l}
                </button>
              ))}
            </div>
          </fieldset>
          {game !== 'match' && (
            <p className="gameDetail">
              {level === 'Guided'
                ? 'Choose from three answers.'
                : game === 'relations'
                  ? 'Type ' +
                    (level === 'Challenge'
                      ? 'two different answers'
                      : 'one answer') +
                    ' for each sentence.'
                  : level === 'Standard'
                    ? 'Type the missing word. A hint is available.'
                    : 'Type the missing word or phrase without a hint.'}
            </p>
          )}
          <fieldset>
            <legend>Session</legend>
            <div className="gameChoices">
              {(['Round', 'Timed round', 'Endless'] as const).map((m) => (
                <button
                  key={m}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="gameStart">
            <span>
              {endless
                ? 'Practise until you stop.'
                : rules.count +
                  ' ' +
                  (game === 'match' ? 'pairs' : 'questions') +
                  ' · ' +
                  (timed ? clock(rules.seconds) : 'Untimed')}
            </span>
            <button
              className="primary"
              onClick={() => void start()}
              disabled={busy}
            >
              {busy
                ? 'Opening…'
                : endless
                  ? 'Start practice'
                  : 'Start round'}
            </button>
          </div>
          {alert}
        </div>
      </section>
    )
  const total = round.cards.length
  if (s.done) {
    const { correct, played } = totals(s)
    const report = s.endless ? checkedCards(s) : round.cards
    const missed = report.filter((c) =>
      ['incorrect', 'skipped'].includes(outcome(s, c)),
    )
    const pending = report.some((c) => canAppeal(s, c))
    return (
      <section className="gamePlay">
        <div className="gameTop">
          <span>{gameNames[round.track]}</span>
          <span>{round.level}</span>
        </div>
        <div className="gameResult">
          <h2 ref={heading} tabIndex={-1}>
            {s.endless ? 'Practice complete' : 'Round complete'}
          </h2>
          {s.endless && !played ? (
            <p>No answers submitted.</p>
          ) : (
            <p>
              <strong>
                {correct} / {s.endless ? played : total}
              </strong>{' '}
              correct
            </p>
          )}
        </div>
        {s.endless && played > 0 && (
          <p className="gameSummaryNote">
            {played} answered
            {report.length > 0 ? ' · Latest set below' : ''}
          </p>
        )}
        <ul className="gameReview">
          {report.map((c) => (
            <li
              key={c.id}
              {...captureCard(
                c,
                outcome(s, c) === 'correct' ? s.answers[c.id] : undefined,
              )}
            >
              <div>
                <strong>{c.term}</strong>
                <span className={'gameOutcome ' + outcome(s, c)}>
                  {labels[outcome(s, c)]}
                </span>
              </div>
              <p>
                {c.prompt.includes('___') ? (
                  <GapText text={c.prompt} />
                ) : (
                  c.prompt
                )}
              </p>
              <small>
                Your answer: {s.answers[c.id] || '—'}
                {round.track !== 'match' &&
                  ' · Examples: ' + c.answers.join(', ')}
              </small>
              {round.track !== 'match' && (
                <p className="gameDetail">
                  {s.checks[c.id]?.note ?? c.note}
                </p>
              )}
            </li>
          ))}
        </ul>
        {alert}
        <div className="gameActions">
          <button className="primary" disabled={busy} onClick={back}>
            Choose a game
          </button>
          {!!missed.length && (
            <button
              disabled={busy}
              onClick={() => {
                setError('')
                setActiveWord('')
                setSession(makeSession({ ...round, cards: missed }, false))
              }}
            >
              Practice missed items
            </button>
          )}
          {!!pending && connected && (
            <button disabled={busy} onClick={() => void review()}>
              {busy ? 'Checking…' : 'Check other answers with trainer'}
            </button>
          )}
          {reviewNotice}
          {!!pending && !connected && (
            <a href="#settings">
              Connect the trainer to check other answers
            </a>
          )}
        </div>
      </section>
    )
  }
  const selected = s.answers[card.id] ?? ''
  const paired = new Set(s.events.map((e) => e.id))
  const pairCount = paired.size
  function bind(id: string) {
    const target = round!.cards.find((c) => c.term === activeWord)
    const picked = round!.cards.find((c) => c.id === id)
    if (!target || !picked || paired.has(id)) return
    change((v) => submitCard(v, target, picked.term))
    setActiveWord('')
  }
  function submit(answer: string) {
    change((v) => submitCard(v, card!, answer))
  }
  const canContinue = round.track !== 'match' || pairCount === total
  const feedback = feedbackCard && (
    <AnswerFeedback
      key={feedbackCard.id}
      card={feedbackCard}
      result={outcome(s, feedbackCard)}
      required={round.required}
      answer={s.answers[feedbackCard.id]}
      note={s.checks[feedbackCard.id]?.note}
      check={
        connected && canAppeal(s, feedbackCard)
          ? () => void review(feedbackCard)
          : undefined
      }
      busy={busy}
      next={canContinue ? () => void advanceBatch() : undefined}
      nextLabel={
        !s.endless && (round.track === 'match' || s.index + 1 === total)
          ? 'See results'
          : 'Continue'
      }
    />
  )
  return (
    <section className="gamePlay">
      <div className="gameTop">
        <span>
          {gameNames[round.track]}
          {round.track === 'prepositions' ? ' · Prepositions' : ''}
          {s.endless ? ' · Endless' : ''}
        </span>
        <span>
          {round.level}{' '}
          {s.deadline > 0 && (
            <b className="gameClock" role="timer">
              {clock(Math.max(0, Math.ceil((s.deadline - now) / 1000)))}
            </b>
          )}
        </span>
      </div>
      <div
        className="gameInterior"
        {...(round.track === 'match'
          ? {}
          : captureCard(
              card,
              feedbackCard && outcome(s, card) === 'correct'
                ? selected
                : undefined,
            ))}
      >
        {round.track === 'match' ? (
          <>
            <h2 ref={heading} tabIndex={-1}>
              Match the pairs
            </h2>
            <p>Choose a word, then its definition.</p>
            <div className="gameBoard" ref={choices}>
              <div aria-label="Words">
                {round.cards.map((c) => (
                  <button
                    key={c.id}
                    data-word-choice
                    {...captureCard(c)}
                    aria-pressed={activeWord === c.term}
                    disabled={paired.has(c.id)}
                    className={paired.has(c.id) ? 'paired' : ''}
                    onClick={() => setActiveWord(c.term)}
                  >
                    {c.term}
                  </button>
                ))}
              </div>
              <div aria-label="Definitions">
                {s.right.map((id) => {
                  const c = round.cards.find((c) => c.id === id)!
                  return (
                    <button
                      key={id}
                      data-word-choice
                      {...captureCard(c)}
                      disabled={!activeWord || paired.has(id)}
                      onClick={() => bind(id)}
                    >
                      {c.prompt}
                      {paired.has(id) && <b>{c.term}</b>}
                    </button>
                  )
                })}
              </div>
            </div>
            {feedback}
          </>
        ) : (
          <>
            <div className="gameStep">
              <span>
                Question{' '}
                {s.endless
                  ? s.prior.played + s.index + 1
                  : s.index + 1 + ' of ' + total}
              </span>
              {!s.endless && <progress max={total} value={s.index + 1} />}
            </div>
            <h2 ref={heading} id="game-question" className="gameQuestion">
              {card.prompt.includes('___') ? (
                <GapText
                  text={card.prompt}
                  solution={
                    feedbackCard
                      ? outcome(s, card) === 'correct'
                        ? selected
                        : card.answers[0]
                      : undefined
                  }
                />
              ) : (
                card.prompt
              )}
            </h2>
            {round.track === 'relations' && (
              <p>
                Give{' '}
                {round.required === 2
                  ? 'two different ' + card.relation + 's'
                  : 'one ' + card.relation}{' '}
                for <b>{card.term}</b> in this sentence.
              </p>
            )}
            {feedback || (
              <form
                key={card.id}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (responseParts(selected).length === round.required)
                    submit(selected)
                }}
              >
                {round.level === 'Guided' ? (
                  <div className="gameChoices gameOptions" ref={choices}>
                    {s.options[card.id].map((x) => (
                      <button
                        type="button"
                        data-word-choice
                        key={x}
                        aria-pressed={selected === x}
                        onClick={() => submit(x)}
                      >
                        {x}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <label className="gameAnswer">
                      {round.required === 2
                        ? 'Your answers (separated by a comma)'
                        : 'Your answer'}
                      <input
                        ref={input}
                        aria-describedby="game-question"
                        autoComplete="off"
                        maxLength={180}
                        value={selected}
                        onChange={(e) => {
                          const value = e.target.value
                          change((v) => ({
                            ...v,
                            answers: { ...v.answers, [card.id]: value },
                          }))
                        }}
                      />
                    </label>
                    <div className="gameHints">
                      {round.track === 'prepositions' && (
                        <button
                          type="button"
                          className="textLink"
                          onClick={() =>
                            change((v) => ({
                              ...v,
                              answers: {
                                ...v.answers,
                                [card.id]: 'no preposition',
                              },
                            }))
                          }
                        >
                          No preposition needed
                        </button>
                      )}
                      {round.level === 'Standard' &&
                        round.track !== 'relations' && (
                          <button
                            type="button"
                            className="textLink"
                            onClick={() => setHint((x) => !x)}
                          >
                            {hint ? 'Hide hint' : 'Show hint'}
                          </button>
                        )}
                    </div>
                    {hint && (
                      <p className="gameDetail">
                        {card.family} ·{' '}
                        {card.answers[0] === 'no preposition'
                          ? 'Consider whether a word is needed.'
                          : 'One possible answer starts with “' +
                            card.answers[0][0] +
                            '”.'}
                      </p>
                    )}
                  </>
                )}
                <div className="gameActions">
                  <button
                    type="button"
                    className="textLink"
                    onClick={() => submit('')}
                  >
                    Skip
                  </button>
                  {round.level !== 'Guided' && (
                    <button
                      className="primary"
                      disabled={
                        responseParts(selected).length !== round.required
                      }
                    >
                      Check answer
                    </button>
                  )}
                </div>
              </form>
            )}
          </>
        )}
        {reviewNotice}
        {alert}
        <button
          className="textLink gameEnd"
          disabled={busy}
          onClick={() => change((v) => ({ ...v, done: true }))}
        >
          {s.endless ? 'Finish practice' : 'End round'}
        </button>
      </div>
    </section>
  )
}
