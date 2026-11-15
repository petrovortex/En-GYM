import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { bank } from '../core/exam.ts'
import {
  catalog,
  sections,
  emptyTrend,
  type Item,
  type Stage,
} from '../core/types.ts'
import { MaterialShortage, assertSelection } from '../core/selection.ts'
import { reserveStock, sessionKey } from '../core/reserve.ts'
import {
  cache,
  extras,
  exposures,
  inventoryRevision,
  selectionMemory,
} from './store.ts'
import {
  selectSession,
  selectionContext,
  type SessionRequest,
} from './selection.ts'
import { audioKey, synth, promptAudioReady } from './speech.ts'
import { backgroundAllowed, bankWorkAllowed } from './work.ts'

const bundled = resolve(existsSync('prompts') ? 'prompts' : '.work/prompts')
function findPrompt(key: string, requireCurrent = false) {
  const file = key + '.wav'
  const local = join(cache, file)
  const packaged = join(bundled, file)
  if (promptAudioReady(local, true)) return local
  if (promptAudioReady(packaged, true)) return packaged
  if (!requireCurrent) {
    if (promptAudioReady(local)) return local
    if (promptAudioReady(packaged)) return packaged
  }
}
export const promptPath = (key: string) => findPrompt(key) ?? join(cache, key + '.wav')
export const audioReady = (q: Item) =>
  !q.speech || !!findPrompt(audioKey(q))
interface ReadyPlan {
  request: SessionRequest
  seed: number
  stages?: Stage[]
  state: 'ready' | 'material' | 'audio'
  missing: string[]
}
let version = '',
  cached = new Map<string, ReadyPlan>()
export function invalidateInventory() {
  version = ''
}
function plans() {
  const next = inventoryRevision() + ':' + Math.floor(Date.now() / 60000)
  if (version === next) return cached
  const context = selectionContext(),
    result = new Map<string, ReadyPlan>()
  const cachedContext = {
    ...context,
    memory: { ...context.memory, outcomes: { ...context.memory.outcomes } },
  }
  for (const q of [...bank, ...context.extra])
    if (!audioReady(q))
      cachedContext.memory.outcomes[q.id] = { at: Date.now(), score: 1 }
  const requests: SessionRequest[] = [
    { mode: 'full', focus: 'Full mock' },
    ...sections.map((focus) => ({ mode: 'section' as const, focus })),
    ...Object.keys(catalog).flatMap((focus) =>
      (['short', 'standard', 'long'] as const).map((length) => ({
        mode: 'drill' as const,
        focus,
        length,
      })),
    ),
  ]
  for (const request of requests) {
    const seed = randomBytes(4).readUInt32LE()
    try {
      let stages: Stage[]
      try {
        stages = selectSession(request, seed, cachedContext).stages
      } catch (error) {
        if (!(error instanceof MaterialShortage)) throw error
        stages = selectSession(request, seed, context).stages
      }
      result.set(sessionKey(request.mode, request.focus, request.length), {
        request,
        seed,
        stages,
        state: stages
          .flatMap((s) => [...s.items, ...(s.upper ?? [])])
          .every(audioReady)
          ? 'ready'
          : 'audio',
        missing: [],
      })
    } catch (error) {
      if (!(error instanceof MaterialShortage)) throw error
      result.set(sessionKey(request.mode, request.focus, request.length), {
        request,
        seed,
        state: 'material',
        missing: error.tasks,
      })
    }
  }
  version = next
  cached = result
  return cached
}
export function availability() {
  return Object.fromEntries(
    [...plans()].map(([key, p]) => [
      key,
      { state: p.state, missing: p.missing },
    ]),
  )
}
export function readySession(request: SessionRequest) {
  const plan = plans().get(
    sessionKey(request.mode, request.focus, request.length),
  )
  if (!plan?.stages)
    throw new MaterialShortage(
      (plan?.missing ?? []) as import('../core/types.ts').Task[],
      'This session is being replenished in the background. Available sessions can be started now.',
    )
  assertSelection(plan.stages, {
    ...emptyTrend(),
    ...selectionMemory(
      plan.stages.flatMap((s) => [...s.items, ...(s.upper ?? [])]),
    ),
  })
  if (
    !plan.stages
      .flatMap((s) => [...s.items, ...(s.upper ?? [])])
      .every(audioReady)
  )
    throw Error(
      'Audio is still being prepared in the background. This session will become available automatically.',
    )
  return { seed: plan.seed, stages: structuredClone(plan.stages) }
}
let stockVersion = -1,
  stock: ReturnType<typeof reserveStock> = []
export function inventoryStock() {
  if (stockVersion !== inventoryRevision()) {
    stock = reserveStock([...bank, ...extras()], {
      ...emptyTrend(),
      lastUsed: exposures(),
    })
    stockVersion = inventoryRevision()
  }
  return stock
}
let warming = false,
  audioRetry = 0,
  checkedStock = -1,
  checkedAt = 0
let audioError = ''
export const audioStatus = () => ({ error: audioError, active: warming })
export async function warmStockAudio() {
  if (warming || Date.now() < audioRetry || !bankWorkAllowed()) return
  const revision = inventoryRevision()
  if (revision === checkedStock && Date.now() - checkedAt < 60_000) return
  const candidates = [...bank, ...extras()].filter((q) => q.speech)
  candidates.sort((a, b) => Number(b.task === 'repeat') - Number(a.task === 'repeat'))
  // Fill gaps before refreshing usable recordings from an older voice pack.
  const missing = candidates.find((q) => !audioReady(q))
  if (!missing && !backgroundAllowed()) return
  const q = missing ?? candidates.find((q) => !findPrompt(audioKey(q), true))
  if (!q) {
    checkedStock = revision
    checkedAt = Date.now()
    return
  }
  warming = true
  try {
    await synth(q, cache, () => {
      if (!(missing ? bankWorkAllowed() : backgroundAllowed()))
        throw Error('Waiting for grading or trainer conversation.')
    })
    audioError = ''
    invalidateInventory()
  } catch (e) {
    audioError = (e as Error).message
    audioRetry = Date.now() + 60000
  } finally {
    warming = false
  }
}
