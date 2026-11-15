import { bank, buildStages, learnerTrend } from '../core/exam.ts'
import { assertSelection, coolingDown, familiar } from '../core/selection.ts'
import {
  catalog,
  emptyTrend,
  type Attempt,
  type Item,
  type Mode,
  type PracticeLength,
  type Task,
} from '../core/types.ts'
import { extras, load, recent, selectionMemory } from './store.ts'
export interface SessionRequest {
  mode: Mode
  focus: string
  length?: PracticeLength
  retry?: { id: string; item: string }
  followUp?: string
}
export function selectionContext() {
  const extra = extras()
  return {
    extra,
    memory: selectionMemory([...bank, ...extra]),
    attempts: recent(),
  }
}
export function selectSession(
  request: SessionRequest,
  seed: number,
  context = selectionContext(),
) {
  const { mode, focus } = request
  if (!['full', 'section', 'drill'].includes(mode))
    throw Error('Unknown practice mode.')
  const extra = context.extra,
    pool = [...bank, ...extra]
  let retryOf: Attempt['retryOf'], chosen: Item[] | undefined
  if (mode === 'drill' && request.retry) {
    const original = load(request.retry.id),
      q = original.stages
        .flatMap((s) => s.items)
        .find((q) => q.id === request.retry!.item)
    if (!original.ended || !q || q.task !== focus)
      throw Error('Choose a saved response to retry.')
    retryOf = { id: original.id, item: q.id }
    chosen = [q]
  } else if (mode === 'drill' && request.followUp) {
    const recommended = load(request.followUp).followUp
    const q = extra.find((q) => q.id === recommended?.item && q.task === focus)
    if (!q) throw Error('Recommended practice is not ready yet.')
    chosen = q.group ? extra.filter((x) => x.group === q.group) : [q]
  }
  const history = {
    ...(mode === 'full' ? emptyTrend() : learnerTrend(context.attempts, focus)),
    ...(chosen ? selectionMemory([...pool, ...chosen]) : context.memory),
  }
  let stages
  if (chosen) {
    if (chosen.some((q) => coolingDown(q, history)))
      throw Error(
        'This response was already mastered. It becomes eligible again 30 days after completion; choose fresh practice for now.',
      )
    if (chosen.some((q) => familiar(q, history))) {
      // A deliberate retry is also a session: pair old material with a wholly unfamiliar set.
      const onlyFresh = extra.filter((q) => !familiar(q, history))
      const memory = { ...history, outcomes: { ...history.outcomes } }
      for (const q of pool)
        if (familiar(q, history))
          memory.outcomes[q.id] = { at: Date.now(), score: 1 }
      const fresh = buildStages(
        'drill',
        focus,
        seed,
        memory,
        onlyFresh,
        'short',
      )[0].items
      chosen = [...chosen, ...fresh]
    }
    stages = [
      {
        section: catalog[focus as Task][0],
        name: retryOf ? 'Retry with fresh practice' : 'Trainer follow-up',
        minutes: 0,
        items: chosen,
      },
    ]
  } else stages = buildStages(mode, focus, seed, history, extra, request.length)
  assertSelection(stages, history)
  return { stages, retryOf }
}
