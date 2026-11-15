import { useEffect, useState } from 'react'
import { api } from './api.ts'
import { catalog, type Task, type Section } from '../core/types.ts'
import type { SessionAvailability } from '../core/reserve.ts'
import {
  materialCount,
  preparationSections,
  type ReserveStock,
  type TimeEstimate,
} from '../core/preparation-progress.ts'
export interface StockState {
  sessions: Record<string, SessionAvailability>
  bank: {
    enabled: boolean
    state: string
    pending: number
    nextRetry?: number
    activeTask?: Task
    phase?: string
    stock: ReserveStock
    requests: number
    onDemandRequests: number
    error?: string
    waitReason?: 'off' | 'connection' | 'foreground' | 'retry'
    estimate?: TimeEstimate
  }
  audio: { active: boolean; error: string }
}
export function useStock(active: boolean, page: string) {
  const [stock, setStock] = useState<StockState>()
  useEffect(() => {
    if (!active) return
    let live = true
    const check = () => {
      void api<StockState>('availability')
        .then((s) => {
          if (live) setStock(s)
        })
        .catch(() => {})
    }
    check()
    const timer = setInterval(check, 5000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active, page])
  return [stock, setStock] as const
}
export function readyLabel(status?: SessionAvailability) {
  return !status
    ? 'Checking availability…'
    : status.state === 'ready'
      ? 'Ready to start'
      : status.state === 'audio'
        ? 'Preparing audio'
        : 'Waiting for fresh material'
}
export function drillLabel(task: string, sessions?: StockState['sessions']) {
  const lengths = (['short', 'standard', 'long'] as const).filter(
    (length) => sessions?.[`drill:${task}:${length}`]?.state === 'ready',
  )
  return lengths.length
    ? lengths.map((l) => l[0].toUpperCase() + l.slice(1)).join(' · ')
    : readyLabel(sessions?.[`drill:${task}:standard`])
}
export function StockStatus({
  stock,
  embedded = false,
  scope,
}: {
  stock?: StockState
  embedded?: boolean
  scope?: Section
}) {
  if (!stock)
    return (
      <p className="stockStatus stockLoading" role="status">
        Checking available practice…
      </p>
    )
  const task = stock.bank.activeTask && catalog[stock.bank.activeTask][1]
  const groups = preparationSections(stock.bank.stock).filter(
    (s) => !scope || s.section === scope,
  )
  const full = groups.every((s) => s.items.every((i) => i.deficit === 0))
  const paused = stock.bank.waitReason
  const estimate = stock.bank.estimate
  const minutes =
    estimate &&
    (estimate.minMinutes === estimate.maxMinutes
      ? String(estimate.minMinutes)
      : `${estimate.minMinutes}–${estimate.maxMinutes}`)
  const status = full
    ? 'Reserve full'
    : paused === 'off'
      ? 'Preparation off'
      : paused === 'connection'
        ? 'Connect AI to continue'
        : paused === 'foreground'
          ? 'Paused for your AI request'
          : paused === 'retry'
            ? 'Waiting to retry'
            : 'Filling reserve'
  const phase =
    stock.bank.phase === 'reviewing'
      ? 'Reviewing'
      : stock.bank.phase === 'audio'
        ? 'Preparing audio for'
        : 'Creating'
  return (
    <aside
      className={
        'stockStatus' +
        (embedded ? ' stockEmbedded' : '') +
        (scope ? ' stockScoped' : '')
      }
      aria-label="Practice availability"
    >
      <div className="stockHeading">
        <div>
          {!embedded && (
            <h2>{scope ? `${scope} reserve` : 'Practice preparation'}</h2>
          )}
          {!scope && (
            <p>
              Ready mocks can start now. Reserve target: fresh material for
              three more sessions.
            </p>
          )}
        </div>
        <span className={'stockState' + (paused && !full ? ' paused' : '')}>
          {status}
        </span>
      </div>
      <div className="stockGrid">
        {groups.map(({ section, percent, remaining }) => {
          const state = stock.sessions[`section:${section}`]?.state
          return (
            <div className="stockSection" key={section}>
              <div className="stockSectionTitle">
                <h3>{scope ? 'Reserve for 3 sessions' : section}</h3>
                <span>{percent}%</span>
              </div>
              <progress
                value={percent}
                max={100}
                aria-label={`${section} reserve`}
              />
              <small className="stockRemaining">{remaining}</small>
              {!scope && (
                <span
                  className={
                    'stockReadiness' + (state === 'ready' ? ' ready' : '')
                  }
                >
                  {state === 'ready'
                    ? 'Mock ready'
                    : state === 'audio'
                      ? 'Preparing mock audio'
                      : 'Preparing mock'}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div className="stockActivity">
        <span>
          {!paused && task
            ? `Now: ${phase.toLowerCase()} ${task}`
            : stock.audio.active
              ? 'Preparing local audio'
              : full
                ? 'The app tops up the reserve as you practice.'
                : paused === 'off'
                  ? 'Prepared tests remain available.'
                  : paused === 'connection'
                    ? 'Connect your account in Settings to add material.'
                    : paused === 'foreground'
                      ? 'Preparation resumes after grading or chat.'
                      : paused === 'retry'
                        ? 'Completed material is saved.'
                        : 'Preparing the next set of material.'}
        </span>
        {paused === 'retry' && stock.bank.nextRetry ? (
          <strong>
            Retry at{' '}
            {new Date(stock.bank.nextRetry).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </strong>
        ) : (
          !paused &&
          !full && (
            <strong>
              {stock.bank.estimate
                ? `${scope ? 'All sections: about' : 'About'} ${minutes} min${scope ? '' : ' to fill reserve'}`
                : 'Estimating time…'}
            </strong>
          )
        )}
      </div>
      <details className="stockDetails">
        <summary>Material breakdown</summary>
        <div className="stockBreakdown">
          {groups.map(({ section, items }) => (
            <div key={section}>
              <h3>{section}</h3>
              <dl>
                {items.map((s) => (
                  <div key={s.task}>
                    <dt>{catalog[s.task][1]}</dt>
                    <dd>{materialCount(s.task, s.deficit)} left</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <p>
          Progress measures the three-session reserve, not whether a mock is
          ready. Time estimates use recent completed work with your selected
          model; they appear after enough samples. Retries and new practice can
          extend the estimate.
        </p>
        {stock.bank.error && (
          <p className="stockError">
            Latest preparation issue: {stock.bank.error}
          </p>
        )}
      </details>
      {stock.audio.error && (
        <p className="stockError">Audio preparation: {stock.audio.error}</p>
      )}
      {!embedded && (
        <a className="stockSettings" href="#settings">
          Preparation settings
        </a>
      )}
    </aside>
  )
}
