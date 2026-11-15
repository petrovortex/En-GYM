import {
  drawCards,
  normalizeGame,
  shuffle,
  type GameCard,
  type Track,
} from './games.ts'

export type GameResult = 'correct' | 'incorrect' | 'skipped'
export interface PlayedCard {
  id: string
  result: GameResult | 'unlisted' // Older sessions could defer a verdict.
  correction?: boolean
}
interface ReviewItem {
  id: string
  term: string
  family: string
  due: number
  successes: number
  misses: number
  appeal?: { batch: string; step: number; priorSuccesses?: number }
}
export interface PracticeMemory {
  step: number
  review: ReviewItem[]
  receipts: { batch: string; count: number }[]
}
export const emptyPractice = (): PracticeMemory => ({
  step: 0,
  review: [],
  receipts: [],
})

// A batch reports its submitted prefix. Overlapping saves and refreshes apply each answer once.
export function learnFromBatch(
  memory: PracticeMemory,
  batch: string,
  events: PlayedCard[],
  cards: GameCard[],
) {
  let receipt = memory.receipts.find((r) => r.batch === batch)
  if (!receipt) {
    receipt = { batch, count: 0 }
    memory.receipts.push(receipt)
    memory.receipts = memory.receipts.slice(-64)
  }
  for (const event of events.slice(receipt.count)) {
    const card = cards.find((c) => c.id === event.id)
    if (!event.correction) memory.step++
    if (!card) continue
    const idx = memory.review.findIndex((r) => r.id === card.id)
    const previous = memory.review[idx]
    if (event.result === 'unlisted') {
      if (previous) previous.due = Math.max(previous.due, memory.step + 3)
      continue
    }
    if (event.correction) {
      if (previous?.appeal?.batch === batch) {
        if (event.result === 'correct') {
          const { priorSuccesses } = previous.appeal
          memory.review.splice(idx, 1)
          if (priorSuccesses === 0) {
            // This was already a review before the disputed answer.
            memory.review.push({
              id: card.id,
              term: card.term,
              family: card.family,
              misses: previous.misses - 1,
              successes: 1,
              due: previous.appeal.step + 12,
            })
          }
        }
        continue
      }
      // Older clients reported an unlisted answer without recording a miss.
      if (!events.some((e) => e.id === card.id && e.result === 'unlisted'))
        continue
    }
    if (idx >= 0) memory.review.splice(idx, 1)
    if (
      event.result === 'correct' &&
      (!previous || previous.successes >= 1)
    )
      continue
    const success = event.result === 'correct'
    memory.review.push({
      id: card.id,
      term: card.term,
      family: card.family,
      successes: success ? 1 : 0,
      misses: (previous?.misses ?? 0) + (success ? 0 : 1),
      due: memory.step + (success ? 12 : 3),
      appeal:
        event.result === 'incorrect'
          ? {
              batch,
              step: memory.step,
              priorSuccesses: previous?.successes,
            }
          : undefined,
    })
  }
  memory.review = memory.review.slice(-32)
  receipt.count = Math.max(receipt.count, events.length)
}

export function practiceBatch(
  pool: GameCard[],
  track: Track,
  count: number,
  words: string[],
  seen: Record<string, number>,
  memory: PracticeMemory,
) {
  if (!memory.review.length)
    return drawCards(pool, track, count, words, seen)
  const due = memory.review
    .filter((r) => r.due <= memory.step)
    .sort((a, b) => a.due - b.due)
  const exact = due
    .map((r) => pool.find((c) => c.id === r.id))
    .find((c) => !!c)
  const reviewIds = new Set(memory.review.map((r) => r.id))
  const avoid = new Set<string>()
  const add = (c: GameCard | undefined) => {
    if (c) avoid.add(normalizeGame(c.term))
  }
  add(exact)
  const targets = memory.review.filter((r) => !r.successes)
  // When the exact term is due, a different sense of it goes on a later board.
  const related = shuffle(
    pool.filter(
      (c) =>
        !seen[c.id] &&
        !reviewIds.has(c.id) &&
        !avoid.has(normalizeGame(c.term)),
    ),
  )
  const transfer =
    related.find((c) =>
      targets.some((r) => normalizeGame(r.term) === normalizeGame(c.term)),
    ) ?? related.find((c) => targets.some((r) => r.family === c.family))
  add(transfer)
  const reviews = [exact, transfer].filter((c): c is GameCard => !!c)
  const reservedPrompts = new Set(
    reviews.map((c) => normalizeGame(c.prompt)),
  )
  const remaining = pool.filter(
    (c) =>
      !avoid.has(normalizeGame(c.term)) &&
      !reservedPrompts.has(normalizeGame(c.prompt)),
  )
  const regular = drawCards(
    remaining.filter((c) => !reviewIds.has(c.id)),
    track,
    count - reviews.length,
    words,
    seen,
  )
  for (const c of regular) {
    add(c)
    reservedPrompts.add(normalizeGame(c.prompt))
  }
  const fill = count - reviews.length - regular.length
  const fallback = fill
    ? drawCards(
        remaining.filter(
          (c) =>
            !avoid.has(normalizeGame(c.term)) &&
            !reservedPrompts.has(normalizeGame(c.prompt)),
        ),
        track,
        fill,
        words,
        seen,
      )
    : []
  return shuffle([...reviews, ...regular, ...fallback])
}
