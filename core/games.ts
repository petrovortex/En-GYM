export const tracks = [
  'match',
  'vocabulary',
  'prepositions',
  'relations',
] as const
export type Track = (typeof tracks)[number]
export const gameNames: Record<Track, string> = {
  match: 'Word Match',
  vocabulary: 'Missing Word',
  prepositions: 'Missing Word',
  relations: 'Synonyms & Antonyms',
}
export type Level = 'Guided' | 'Standard' | 'Challenge'
export interface GameCard {
  id: string
  track: Track
  family: string
  term: string
  prompt: string
  answers: string[]
  distractors: string[]
  note: string
  relation?: 'synonym' | 'antonym'
}
export interface GameRound {
  track: Track
  level: Level
  cards: GameCard[]
  required: number
  seconds: number
  focus?: PrepFocus
}
export const ruleFamilies = [
  'Time & dates',
  'Duration & deadlines',
  'Position & space',
  'Movement & direction',
  'Media & transport',
  'Means & agency',
  'Adjective patterns',
  'Verb patterns',
  'Noun patterns',
  'Purpose & recipient',
  'Cause & contrast',
  'Fixed phrases',
  'No preposition',
  'Regional variants',
  'Preposition + -ing',
  'Complex prepositions',
] as const
export const prepGroups = {
  'Time, place & movement': [
    'Time & dates',
    'Duration & deadlines',
    'Position & space',
    'Movement & direction',
  ],
  'Words with prepositions': [
    'Adjective patterns',
    'Verb patterns',
    'Noun patterns',
    'Preposition + -ing',
  ],
  'Means, purpose & cause': [
    'Media & transport',
    'Means & agency',
    'Purpose & recipient',
    'Cause & contrast',
  ],
  'Expressions & exceptions': [
    'Fixed phrases',
    'No preposition',
    'Regional variants',
    'Complex prepositions',
  ],
} as const
export type PrepFocus = keyof typeof prepGroups
export function inPrepFocus(c: GameCard, focus?: PrepFocus) {
  return !focus || prepGroups[focus].some((f) => f === c.family)
}
export function roundRules(track: Track, level: Level) {
  const guided = level === 'Guided',
    hard = level === 'Challenge'
  if (track === 'match') {
    const count = guided ? 4 : hard ? 7 : 5
    return {
      count,
      required: 1,
      seconds: count * (hard ? 8 : guided ? 12 : 9),
    }
  }
  if (track === 'relations')
    return {
      count: 4,
      required: hard ? 2 : 1,
      seconds: guided ? 60 : hard ? 120 : 80,
    }
  return { count: 5, required: 1, seconds: guided ? 60 : hard ? 100 : 90 }
}
export const normalizeGame = (s: string) =>
  s.toLowerCase().trim().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')
export function responseParts(value: string) {
  return [
    ...new Set(
      value
        .split(/[;,\n]/)
        .map(normalizeGame)
        .filter(Boolean),
    ),
  ]
}
export function gradeCard(
  card: GameCard,
  value: string,
  required: number,
) {
  const parts = responseParts(value)
  if (!parts.length) return 'skipped'
  const known = card.answers.map(normalizeGame)
  if (parts.length === required && parts.every((p) => known.includes(p)))
    return 'correct'
  return 'incorrect'
}
export function shuffle<T>(values: readonly T[]): T[] {
  const list = [...values]
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}
export function drawCards(
  pool: GameCard[],
  track: Track,
  count: number,
  words: string[],
  seen: Record<string, number>,
) {
  const saved = new Set(words.map(normalizeGame))
  const related = (c: GameCard) =>
    saved.has(normalizeGame(c.term)) ||
    c.answers.some((w) => saved.has(normalizeGame(w)))
  const candidates = shuffle(pool.filter((c) => c.track === track))
  const picked: GameCard[] = []
  const used = new Set<string>(),
    prompts = new Set<string>(),
    families = new Set<string>()
  while (picked.length < count) {
    const personalSlot = picked.length % 3 === 0
    const rank = (c: GameCard) => [
      Number(Boolean(seen[c.id])),
      Number(related(c) !== personalSlot),
      Number(families.has(c.family)),
      seen[c.id] ?? 0,
    ]
    const best = candidates
      .filter(
        (c) =>
          !used.has(normalizeGame(c.term)) &&
          !prompts.has(normalizeGame(c.prompt)),
      )
      .map((c) => ({ card: c, rank: rank(c) }))
      .sort((a, b) => {
        const x = a.rank,
          y = b.rank
        for (let i = 0; i < x.length; i++)
          if (x[i] !== y[i]) return x[i] - y[i]
        return 0
      })[0]?.card
    if (!best) break
    picked.push(best)
    used.add(normalizeGame(best.term))
    prompts.add(normalizeGame(best.prompt))
    families.add(best.family)
  }
  return picked
}
