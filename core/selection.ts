import type { Item, Stage, Task, Trend } from './types.ts'
import { units } from './types.ts'
import { lastUsed } from './material.ts'

export const SUCCESS_COOLDOWN = 30 * 86400000
export class MaterialShortage extends Error {
  tasks: Task[]
  constructor(
    tasks: Task[],
    reason = 'More fresh material is needed for this session.',
  ) {
    super(
      reason +
        ' Successful responses rest for 30 days; at least half of a new session must be unfamiliar. Start preparation with a connected AI account to add missing material.',
    )
    this.tasks = tasks
  }
}
export function coolingDown(q: Item, history: Trend, now = Date.now()) {
  const result = history.outcomes?.[q.id]
  return !!result && result.score === 1 && result.at + SUCCESS_COOLDOWN > now
}
export function familiar(q: Item, history: Trend) {
  return lastUsed([q], history) > 0
}
export function routes(stages: Stage[]): Item[][] {
  let result: Item[][] = [[]]
  for (const stage of stages)
    result = result.flatMap((items) =>
      (stage.upper ? [stage.items, stage.upper] : [stage.items]).map(
        (branch) => [...items, ...branch],
      ),
    )
  return result
}
export function assertSelection(
  stages: Stage[],
  history: Trend,
  now = Date.now(),
) {
  for (const items of routes(stages)) {
    const protectedItems = items.filter((q) => coolingDown(q, history, now))
    if (protectedItems.length)
      throw new MaterialShortage([
        ...new Set(protectedItems.map((q) => q.task)),
      ])
    const old = items.filter((q) => familiar(q, history))
    // Check both response count and scored-question count (a cloze contains ten gaps).
    if (
      old.length * 2 > items.length ||
      old.reduce((n, q) => n + units(q), 0) * 2 >
        items.reduce((n, q) => n + units(q), 0)
    )
      throw new MaterialShortage([...new Set(old.map((q) => q.task))])
  }
}
