import { useEffect, useRef, useState } from 'react'
import {
  catalog,
  type PracticeLength as Length,
  type Task,
} from '../core/types.ts'
import { api } from './api.ts'
import { sessionKey, type SessionAvailability } from '../core/reserve.ts'
import { readyLabel } from './StockStatus.tsx'
interface Preview {
  planId: string
  questions: number
  responses: number
  sets: number
}
export function PracticeLength({
  task,
  close,
  start,
  availability,
}: {
  task: Task
  close: () => void
  start: (id: string | undefined, length: Length) => void
  availability?: Record<string, SessionAvailability>
}) {
  const [length, setLength] = useState<Length>(() =>
      availability?.[sessionKey('drill', task)]?.state === 'ready'
        ? 'standard'
        : ((['short', 'long'] as const).find(
            (l) =>
              availability?.[sessionKey('drill', task, l)]?.state === 'ready',
          ) ?? 'standard'),
    ),
    [plan, setPlan] = useState<Preview>(),
    [error, setError] = useState('')
  const status = availability?.[sessionKey('drill', task, length)]
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    let live = true
    setPlan(undefined)
    setError('')
    if (status?.state !== 'ready') return
    api<Preview>('practice-plan', { task, length })
      .then((p) => {
        if (live) setPlan(p)
      })
      .catch((e) => {
        if (live) {
          setError(e.message)
        }
      })
    return () => {
      live = false
    }
  }, [task, length, status?.state])
  return (
    <dialog
      ref={dialog}
      className="practiceDialog"
      onCancel={close}
      aria-labelledby="practiceTitle"
    >
      <h2 id="practiceTitle">{catalog[task][1]}</h2>
      <p>Choose your practice length.</p>
      <div className="filterChips">
        {(['short', 'standard', 'long'] as const).map((l) => (
          <button
            key={l}
            className={l === length ? 'on' : ''}
            aria-pressed={l === length}
            disabled={
              availability?.[sessionKey('drill', task, l)]?.state !== 'ready'
            }
            title={readyLabel(availability?.[sessionKey('drill', task, l)])}
            onClick={() => setLength(l)}
          >
            {l[0].toUpperCase() + l.slice(1)}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <p role="status">
          {plan
            ? task === 'words'
              ? `${plan.sets} texts · ${plan.questions} gaps`
              : plan.sets < plan.responses
                ? `${plan.sets} sets · ${plan.responses} questions`
                : `${plan.responses} ${['email', 'discussion'].includes(task) ? 'written responses' : 'questions'}`
            : status?.state === 'ready'
              ? 'Selecting your questions…'
              : readyLabel(status)}
        </p>
      )}
      <div className="row">
        <button onClick={close}>Cancel</button>
        <button
          className="primary"
          disabled={!plan || status?.state !== 'ready'}
          onClick={() => start(plan?.planId, length)}
        >
          Start practice
        </button>
      </div>
    </dialog>
  )
}
