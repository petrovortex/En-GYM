import { randomUUID, randomBytes } from 'node:crypto'
import { selectSession, type SessionRequest } from './selection.ts'
import { MaterialShortage, assertSelection } from '../core/selection.ts'
import { emptyTrend, type Stage, type Attempt } from '../core/types.ts'
import {
  configure,
  setting,
  selectionMemory,
  transaction,
  jobs,
} from './store.ts'
import { modelFor, preparationModels } from './provider.ts'
import {
  queueMaterial,
  runBank,
  resetQualityRetries,
  MAX_QUALITY_ATTEMPTS,
  type BankJob,
} from './bank.ts'
import { backgroundAllowed } from './work.ts'
import { author } from './author.ts'
const key = 'session-preparation-v1'
interface Preparation {
  id: string
  request: SessionRequest
  seed: number
  state: 'preparing' | 'ready' | 'failed' | 'cancelled' | 'consumed'
  stages?: Stage[]
  retryOf?: Attempt['retryOf']
  checkedSets: number
  updated: number
  error?: string
  task?: string
  repair?: number
  failureKind?: 'quality' | 'other'
  detail?: string
}
const read = (): Preparation | undefined => {
  const raw = setting(key)
  return raw ? JSON.parse(raw) : undefined
}
const put = (p: Preparation) => configure(key, JSON.stringify(p))
let working = false
export const preparationPending = () => read()?.state === 'preparing'
export function currentPreparation() {
  const p = read()
  return p && ['preparing', 'ready', 'failed'].includes(p.state)
    ? preparationStatus(p.id)
    : null
}
export function preparationStatus(id: string) {
  const p = read()
  if (!p || p.id !== id)
    throw Error('This preparation is no longer available. Start a new session.')
  return {
    id: p.id,
    state: p.state,
    checkedSets: p.checkedSets,
    task: p.task,
    error: p.error,
    detail: p.detail,
    repair: p.repair,
    mode: p.request.mode,
    focus: p.request.focus,
    model: modelFor('generation').model,
    responses: p.stages?.reduce((n, s) => n + s.items.length, 0),
    waitingForPractice: !backgroundAllowed(),
  }
}
export function prepareSession(request: SessionRequest) {
  const old = read()
  if (old?.state === 'preparing') {
    if (JSON.stringify(old.request) === JSON.stringify(request))
      return preparationStatus(old.id)
    throw Error(
      'Another session is being prepared. Close its preparation before starting a different session.',
    )
  }
  const p: Preparation = {
    id: randomUUID(),
    request,
    seed: randomBytes(4).readUInt32LE(),
    state: 'preparing',
    checkedSets: 0,
    updated: Date.now(),
  }
  try {
    Object.assign(p, selectSession(request, p.seed))
    p.state = 'ready'
  } catch (error) {
    if (!(error instanceof MaterialShortage)) throw error
    if (!preparationModels().configured)
      throw Error(
        'More fresh material is needed under the 30-day / 50% rules. Connect your AI provider in Settings, then start this session again.',
      )
    p.task = error.tasks[0]
    resetQualityRetries(p.task)
  }
  put(p)
  return preparationStatus(p.id)
}
export async function continuePreparation(write: typeof author = author) {
  const p = read()
  if (working || !p || p.state !== 'preparing' || !backgroundAllowed()) return
  working = true
  try {
    for (;;) {
      if (read()?.id !== p.id || read()?.state !== 'preparing') return
      try {
        const selection = selectSession(p.request, p.seed)
        Object.assign(p, selection, {
          state: 'ready',
          error: undefined,
          detail: undefined,
          repair: undefined,
          updated: Date.now(),
        })
        put(p)
        return
      } catch (error) {
        if (!(error instanceof MaterialShortage)) throw error
        if (!backgroundAllowed()) return
        if (p.checkedSets >= 64)
          throw Error(
            'Preparation reached its safety limit. Saved material is kept; choose a shorter session or try again later.',
          )
        p.task = error.tasks[0]
        p.updated = Date.now()
        put(p)
        const id = queueMaterial(error.tasks[0])
        const state = await runBank(write, Date.now(), {
          id,
          active: () => read()?.id === p.id && read()?.state === 'preparing',
        })
        if (read()?.state !== 'preparing' || read()?.id !== p.id) return
        if (state === 'paused' && !backgroundAllowed()) return
        if (state === 'paused') {
          const job = jobs<BankJob>().find((job) => job.id === id)
          p.failureKind = job?.failureKind ?? 'other'
          p.detail = job?.error
          if (
            job?.failureKind === 'quality' &&
            (job.qualityFailures ?? 0) < MAX_QUALITY_ATTEMPTS
          ) {
            p.repair = job.qualityFailures
            put(p)
            continue
          }
          throw Error(
            p.failureKind === 'quality'
              ? 'This set did not pass quality checks after three attempts. Nothing from the rejected set was added. Completed sets are saved; retry preparation to continue.'
              : (job?.error ?? 'AI or audio preparation was unavailable.') +
                  ' Completed sets are saved. Retry preparation when ready.',
          )
        }
        if (state !== 'done') return
        p.checkedSets++
        delete p.repair
        delete p.detail
        put(p)
      }
    }
  } catch (error) {
    if (read()?.id === p.id && read()?.state === 'preparing') {
      p.state = 'failed'
      p.error = (error as Error).message
      put(p)
    }
  } finally {
    working = false
  }
}
export function retryPreparation(id: string) {
  const p = read()
  if (!p || p.id !== id || p.state !== 'failed')
    throw Error('This preparation is not paused.')
  resetQualityRetries(p.task)
  p.state = 'preparing'
  p.updated = Date.now()
  delete p.error
  delete p.detail
  delete p.repair
  put(p)
  return preparationStatus(id)
}
export function cancelPreparation(id: string) {
  const p = read()
  if (p?.id === id && p.state !== 'consumed') {
    p.state = 'cancelled'
    delete p.stages
    put(p)
  }
}
export function readyPreparation(id: string) {
  const p = read()
  if (!p || p.id !== id || p.state !== 'ready' || !p.stages)
    throw Error('The session is not ready. Prepare it again.')
  assertSelection(p.stages, {
    ...emptyTrend(),
    ...selectionMemory(
      p.stages.flatMap((s) => [...s.items, ...(s.upper ?? [])]),
    ),
  })
  return p as Preparation & { stages: Stage[] }
}
export function completePreparation(id: string, save: () => void) {
  transaction(() => {
    const p = readyPreparation(id)
    save()
    p.state = 'consumed'
    delete (p as Preparation).stages
    put(p)
  })
}
