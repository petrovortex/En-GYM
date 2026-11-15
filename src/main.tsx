import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  catalog,
  sections,
  type Task,
  type Mode,
  type Section,
  type HistoryRow,
  type PracticeLength as Length,
} from '../core/types.ts'
import { api, isLive, date, type Session } from './api.ts'
import { Mark } from './Art.tsx'
import { Exam } from './Exam.tsx'
import { Settings } from './Settings.tsx'
import { Notebook } from './Notebook.tsx'
import { Review } from './Review.tsx'
import { Vocabulary } from './Vocabulary.tsx'
import { PracticeLength } from './PracticeLength.tsx'
import { useStock, readyLabel, drillLabel } from './StockStatus.tsx'
import { sessionKey } from '../core/reserve.ts'
import './style.css'
const icons: Record<Section, string> = {
  Reading: 'Aa',
  Listening: '≋',
  Writing: '✎',
  Speaking: '◉',
}
const route = () => location.hash.slice(1) || 'desk'
const activityClient = crypto.randomUUID()
function App() {
  const [page, setPage] = useState(route),
    [rows, setRows] = useState<HistoryRow[]>([]),
    [session, setSession] = useState<Session>(),
    [choice, select] = useState<Section>('Speaking'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [filter, setFilter] = useState('All')
  const [drillTask, setDrillTask] = useState<Task>()
  const liveExam =
    page.startsWith('attempt/') && !!session && isLive(session)
  const [stock, setStock] = useStock(!liveExam, page)
  const available = (
    mode: Mode,
    focus: string,
    length: Length = 'standard',
  ) => stock?.sessions[sessionKey(mode, focus, length)]
  const canStart = (
    mode: Mode,
    focus: string,
    length: Length = 'standard',
  ) => available(mode, focus, length)?.state === 'ready'
  const canDrill = (task: string) =>
    (['short', 'standard', 'long'] as const).some((length) =>
      canStart('drill', task, length),
    )
  useEffect(() => {
    void api('activity', {
      active: liveExam,
      client: activityClient,
    }).catch(() => {})
    if (!liveExam) return
    const timer = setInterval(() => {
      void api('activity', { active: true, client: activityClient }).catch(
        () => {},
      )
    }, 15000)
    return () => clearInterval(timer)
  }, [liveExam])
  useEffect(() => {
    const f = () => {
      setPage(route())
      setError('')
    }
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  useEffect(() => {
    let live = true
    api<HistoryRow[]>('history')
      .then((v) => {
        if (live) setRows(v)
      })
      .catch((e) => setError(e.message))
    if (page.startsWith('attempt/')) {
      api<Session>(page)
        .then((v) => {
          if (live) setSession(v)
        })
        .catch((e) => setError(e.message))
    }
    return () => {
      live = false
    }
  }, [page])
  async function start(
    mode: Mode,
    focus: string,
    retry?: { id: string; item: string },
    options?: {
      followUp?: string
      planId?: string
      length?: Length
    },
  ) {
    if (busy) return
    if (
      mode === 'drill' &&
      !retry &&
      !options?.followUp &&
      !options?.planId &&
      !options?.length
    ) {
      setDrillTask(focus as Task)
      return
    }
    setDrillTask(undefined)
    setBusy(true)
    setError('')
    try {
      const s = await api<Session>('start', {
        mode,
        focus,
        retry,
        ...options,
      })
      setSession(s)
      location.hash = 'attempt/' + s.id
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const done = rows.filter((r) => r.ended),
    open = rows.find((r) => !r.ended),
    slug = page.split('/')[0]
  function row(r: HistoryRow) {
    return (
      <a className="historyRow" href={'#attempt/' + r.id} key={r.id}>
        <span className="historyIcon">
          {r.mode === 'full' ? '▤' : r.mode === 'section' ? '▥' : '◇'}
        </span>
        <div>
          <b>
            {r.mode === 'drill' ? catalog[r.focus as Task]?.[1] : r.focus}
          </b>
          <small>
            {date(r.started)} ·{' '}
            {r.mode === 'drill'
              ? 'Exercise'
              : r.mode === 'full'
                ? 'Full mock'
                : 'Section mock'}
          </small>
        </div>
        <span className={'pill ' + (r.ended ? '' : 'active')}>
          {r.ended ? 'Completed' : 'In progress'}
        </span>
        <span>→</span>
      </a>
    )
  }
  const attemptId = page.slice(8).split('?')[0]
  if (
    page.startsWith('attempt/') &&
    session?.id === attemptId &&
    isLive(session)
  )
    return (
      <Exam
        key={
          session.id + '-' + session.item.id + '-' + !!session.itemStarted
        }
        s={session}
        update={setSession}
      />
    )
  return (
    <>
      <header className="appHeader">
        <div className="headerIn">
          <a className="brand" href="#desk">
            <Mark />
            En-GYM
          </a>
          <nav>
            {[
              ['practice', 'Practice'],
              ['vocabulary', 'Vocabulary'],
              ['history', 'History'],
              ['settings', 'Settings'],
            ].map(([id, name]) => (
              <a
                className={slug === id ? 'selected' : ''}
                href={'#' + id}
                key={id}
              >
                {name}
              </a>
            ))}
          </nav>
          <span className="local">
            <i /> Local workspace
          </span>
        </div>
      </header>
      <main className={page === 'desk' ? 'homeMain' : undefined}>
        {drillTask && (
          <PracticeLength
            task={drillTask}
            availability={stock?.sessions}
            close={() => setDrillTask(undefined)}
            start={(planId, length) =>
              void start('drill', drillTask, undefined, { planId, length })
            }
          />
        )}
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <div className="notice" role="status">
            Opening your session…
          </div>
        )}
        {page === 'desk' && (
          <>
            <section className="hero">
              <div>
                <h1>Full-length mock test</h1>
                <p>
                  Reading, Listening, Writing, and Speaking in one timed
                  test.
                </p>
                <small>{readyLabel(available('full', 'Full mock'))}</small>
              </div>
              <button
                disabled={busy || !canStart('full', 'Full mock')}
                onClick={() => start('full', 'Full mock')}
              >
                Start a full mock <span aria-hidden="true">→</span>
              </button>
            </section>
            <div className="subhead">
              <div>
                <h2>Choose a skill</h2>
              </div>
              <a href="#practice">All exercises →</a>
            </div>
            <div className="skillGrid">
              {sections.map((s, i) => (
                <button
                  className={'skill skill' + i}
                  key={s}
                  onClick={() => {
                    select(s)
                    location.hash = 'practice'
                  }}
                >
                  <span className="skillIcon">{icons[s]}</span>
                  <span className="skillName">{s}</span>
                  <small>
                    {
                      Object.values(catalog).filter(([sec]) => sec === s)
                        .length
                    }{' '}
                    exercise types <b>↗</b>
                  </small>
                </button>
              ))}
            </div>
            <div className="subhead">
              <div>
                <h2>Recent practice</h2>
              </div>
              <a href="#history">View history →</a>
            </div>
            {rows.length ? (
              rows.slice(0, 3).map(row)
            ) : (
              <div className="empty">
                <strong>Your first attempt will appear here.</strong>
                <p>
                  Start with a short speaking exercise to check your
                  microphone and hear your response.
                </p>
                <button
                  disabled={busy || !canDrill('repeat')}
                  onClick={() => start('drill', 'repeat')}
                >
                  Try Listen and Repeat →
                </button>
              </div>
            )}
          </>
        )}
        {page === 'practice' && (
          <>
            <div className="pagehead">
              <span className="eyebrow">PRACTICE LIBRARY</span>
              <h1>
                Practice a skill<span className="gold">.</span>
              </h1>
              <p>
                Work through a section or spend a few minutes on one
                exercise.
              </p>
            </div>
            <div className="tabs">
              {sections.map((s) => (
                <button
                  className={choice === s ? 'on' : ''}
                  key={s}
                  onClick={() => select(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="sectionCard">
              <div>
                <span className="eyebrow">TIMED SECTION</span>
                <h2>{choice} mock</h2>
                <p>
                  Practice the complete section with material selected for
                  your level.
                </p>
                <small>{readyLabel(available('section', choice))}</small>
              </div>
              <button
                className="primary"
                disabled={busy || !canStart('section', choice)}
                onClick={() => start('section', choice)}
              >
                Start section →
              </button>
            </div>
            <div className="subhead">
              <h2>Exercise practice</h2>
            </div>
            <div className="taskList">
              {Object.entries(catalog)
                .filter(([, v]) => v[0] === choice)
                .map(([t, [, name]], i) => (
                  <button
                    disabled={busy || !canDrill(t)}
                    key={t}
                    onClick={() => start('drill', t)}
                  >
                    <span className="num">0{i + 1}</span>
                    <b>{name}</b>
                    <small>{drillLabel(t, stock?.sessions)}</small>
                    <span>→</span>
                  </button>
                ))}
            </div>
          </>
        )}
        {page === 'history' && (
          <>
            <div className="pagehead">
              <h1>
                Practice history<span className="gold">.</span>
              </h1>
              <p>
                {done.length} completed{' '}
                {done.length === 1 ? 'attempt' : 'attempts'}
                {open ? ' · An unfinished attempt is ready to resume.' : ''}
              </p>
            </div>
            <div className="tabs">
              {['All', 'Full mocks', 'Sections', 'Exercises'].map((v) => (
                <button
                  className={filter === v ? 'on' : ''}
                  onClick={() => setFilter(v)}
                  key={v}
                >
                  {v}
                </button>
              ))}
            </div>
            {rows
              .filter(
                (r) =>
                  filter === 'All' ||
                  {
                    full: 'Full mocks',
                    section: 'Sections',
                    drill: 'Exercises',
                  }[r.mode] === filter,
              )
              .map(row)}
            {!rows.length && (
              <div className="empty">
                Your saved practice will appear here.{' '}
                <a href="#practice">Explore exercises →</a>
              </div>
            )}
          </>
        )}
        {page === 'vocabulary' && <Vocabulary />}
        {page === 'settings' && (
          <Settings
            stock={stock}
            onBankChange={(bank) => setStock((s) => s && { ...s, bank })}
          />
        )}
        {page === 'history' && <Notebook />}
        {page.startsWith('attempt/') &&
          (session?.id === attemptId && !isLive(session) ? (
            <Review
              key={page}
              a={session}
              update={setSession}
              start={(t, retry) => start('drill', t, retry)}
              startFollow={(t) =>
                start('drill', t, undefined, { followUp: session.id })
              }
            />
          ) : (
            <p>Opening attempt…</p>
          ))}
      </main>
      <footer>
        <span>En-GYM</span>
        <span>Independent practice · 2026 iBT format</span>
      </footer>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
