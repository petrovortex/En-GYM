import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { catalog, type Mode, type Task } from '../core/types.ts'
export interface PreparationStatus {
  id: string
  mode: Mode
  focus: string
  state: string
  checkedSets: number
  task?: Task
  error?: string
  detail?: string
  repair?: number
  model: string
  responses?: number
  waitingForPractice: boolean
}
export function Preparation({
  initial,
  close,
  start,
}: {
  initial: PreparationStatus
  close: () => void
  start: () => void
}) {
  const [status, setStatus] = useState(initial),
    [error, setError] = useState(''),
    [retrying, setRetrying] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    let live = true
    const timer = setInterval(() => {
      void api<PreparationStatus>('preparation/' + initial.id)
        .then((s) => {
          if (live) setStatus(s)
        })
        .catch((e) => {
          if (live) setError(e.message)
        })
    }, 2000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [initial.id])
  async function cancel() {
    try {
      await api('cancel-preparation', { id: initial.id })
      close()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function retry() {
    setRetrying(true)
    setError('')
    try {
      setStatus(
        await api<PreparationStatus>('retry-preparation', { id: initial.id }),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRetrying(false)
    }
  }
  return (
    <dialog
      className="practiceDialog"
      ref={dialog}
      aria-labelledby="preparationTitle"
      onCancel={(e) => {
        e.preventDefault()
        void cancel()
      }}
    >
      <h2 id="preparationTitle">
        {status.state === 'ready'
          ? 'Your session is ready'
          : status.state === 'failed'
            ? 'Preparation paused'
            : 'Preparing fresh practice'}
      </h2>
      <p>
        {catalog[status.focus as Task]?.[1] ?? status.focus} · {status.model}
      </p>
      <p role="status">
        {status.state === 'ready'
          ? `${status.responses} responses prepared. Start when you are ready.`
          : (status.error ??
            (status.waitingForPractice
              ? 'Waiting for active practice or AI work to finish.'
              : status.repair
                ? `Improving a set that did not pass review · retry ${status.repair} of 2. No action needed.`
                : `Preparing ${status.task ? catalog[status.task][1] : 'material'} · ${status.checkedSets} new sets checked.`))}
      </p>
      {status.state === 'preparing' && (
        <p>
          The timer has not started. This preparation uses additional AI
          requests beyond the background allowance.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {status.state === 'failed' && status.detail && (
        <details>
          <summary>Review details</summary>
          <p>{status.detail}</p>
        </details>
      )}
      <div className="row">
        <button disabled={retrying} onClick={() => void cancel()}>
          {status.state === 'failed' ? 'Close' : 'Cancel'}
        </button>
        {status.state === 'failed' && (
          <button
            className="primary"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? 'Resuming…' : 'Retry preparation'}
          </button>
        )}
        {status.state === 'ready' && (
          <button className="primary" onClick={start}>
            Start prepared session
          </button>
        )}
      </div>
    </dialog>
  )
}
