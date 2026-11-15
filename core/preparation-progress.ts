import { catalog, sections, type Task } from './types.ts'
import type { reserveStock } from './reserve.ts'

export type ReserveStock = ReturnType<typeof reserveStock>
export interface PreparationSample {
  task: Task
  source: string
  elapsedMs: number
  units: number
}
export interface TimeEstimate {
  minMinutes: number
  maxMinutes: number
}

// Use completed work from this task and model only. Queue waits and offline time
// are excluded; retries within a batch are included in its measured work time.
export function estimatePreparation(
  stock: ReserveStock,
  samples: PreparationSample[],
  source: string,
): TimeEstimate | undefined {
  let total = 0
  for (const item of stock.filter((s) => s.deficit > 0)) {
    const size = item.task === 'reply' || item.task === 'sentence' ? 5 : 1
    const recent = samples
      .filter(
        (s) =>
          s.task === item.task &&
          s.source === source &&
          Number.isFinite(s.elapsedMs) &&
          s.elapsedMs > 0 &&
          s.units === size,
      )
      .slice(0, 6)
      .map((s) => s.elapsedMs)
      .sort((a, b) => a - b)
    if (recent.length < 2) return undefined
    const mid = Math.floor(recent.length / 2)
    const median =
      recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2
    total += Math.ceil(item.deficit / size) * median
  }
  if (!total) return undefined
  // A deliberately approximate range, not a statistical confidence interval.
  const round = (n: number) =>
    n < 10 ? Math.max(1, Math.ceil(n)) : Math.ceil(n / 5) * 5
  return {
    minMinutes: round((total / 60000) * 0.75),
    maxMinutes: round((total / 60000) * 1.5),
  }
}

const amount = (n: number, unit: string) =>
  n ? `${n} ${unit}${n === 1 ? '' : 's'}` : ''
export function preparationSections(stock: ReserveStock) {
  return sections.map((section) => {
    const items = stock.filter((s) => catalog[s.task][0] === section)
    const total = items.reduce((n, s) => n + s.target, 0)
    const filled = items.reduce((n, s) => n + Math.min(s.fresh, s.target), 0)
    const left = (task: Task) =>
      items.find((s) => s.task === task)?.deficit ?? 0
    const remaining =
      section === 'Reading'
        ? [
            amount(
              items.reduce((n, s) => n + s.deficit, 0),
              'text',
            ),
          ]
        : section === 'Listening'
          ? [
              amount(left('reply'), 'question'),
              amount(
                left('conversation') + left('announcement') + left('talk'),
                'recording',
              ),
            ]
          : section === 'Speaking'
            ? [
                amount(left('repeat') * 7, 'sentence'),
                amount(left('interview') * 4, 'interview question'),
              ]
            : [
                amount(
                  items.reduce((n, s) => n + s.deficit, 0),
                  'task',
                ),
              ]
    const count = remaining.filter(Boolean).join(' · ')
    return {
      section,
      items,
      percent: total ? Math.floor((filled / total) * 100) : 0,
      remaining: count ? count + ' left' : 'Reserve full',
    }
  })
}

export function materialCount(task: Task, count: number) {
  const size = task === 'repeat' ? 7 : task === 'interview' ? 4 : 1
  const unit = ['words', 'daily', 'passage'].includes(task)
    ? 'text'
    : ['conversation', 'announcement', 'talk'].includes(task)
      ? 'recording'
      : task === 'repeat'
        ? 'sentence'
        : ['email', 'discussion'].includes(task)
          ? 'writing task'
          : 'question'
  return `${count * size} ${unit}${count * size === 1 ? '' : 's'}`
}
