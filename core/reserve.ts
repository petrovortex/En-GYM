import {
  catalog,
  emptyTrend,
  type Item,
  type Task,
  type Trend,
  type Mode,
  type PracticeLength,
} from './types.ts'
import {
  lastUsed,
  materialKeys,
  practiceSets,
  practiceSize,
} from './material.ts'

export const RESERVE_SESSIONS = 3
export const sessionKey = (
  mode: Mode,
  focus: string,
  length: PracticeLength = 'standard',
) =>
  mode === 'full'
    ? 'full'
    : mode + ':' + focus + (mode === 'drill' ? ':' + length : '')
export interface SessionAvailability {
  state: 'ready' | 'material' | 'audio'
  missing: string[]
}
// Whole stimulus sets needed by the largest route. Daily-life sets may contain only two questions.
export const fullDemand: Record<Task, number> = {
  words: 3,
  daily: 6,
  passage: 2,
  reply: 19,
  conversation: 5,
  announcement: 5,
  talk: 4,
  sentence: 10,
  email: 1,
  discussion: 1,
  repeat: 1,
  interview: 1,
}
export function reserveStock(pool: Item[], history: Trend = emptyTrend()) {
  return (Object.keys(catalog) as Task[]).map((task) => {
    const seen = new Set<string>()
    const fresh = practiceSets(
      pool.filter((q) => !q.personal),
      task,
    ).filter((set) => {
      const keys = set.flatMap(materialKeys)
      if (lastUsed(set, history) || keys.some((key) => seen.has(key)))
        return false
      keys.forEach((key) => seen.add(key))
      return true
    }).length
    const perSession = Math.max(fullDemand[task], practiceSize(task, 'long'))
    const target = RESERVE_SESSIONS * perSession
    return {
      task,
      fresh,
      target,
      perSession,
      deficit: Math.max(0, target - fresh),
    }
  })
}
