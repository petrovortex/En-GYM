import type { Attempt } from './types.ts'
import { wordPattern } from './vocabulary.ts'
import { starterCards } from './game-bank.ts'

const vocabulary = [
  ...new Set([
    ...starterCards.map((c) => c.term),
    'in contrast',
    'in the long run',
    'at short notice',
    'reimbursement',
    'identification',
    'reservation',
    'vegetation',
    'reconstruct',
    'complemented',
    'allocate',
    'assumption',
    'discrepancy',
    'reliable',
    'distinction',
    'evidence',
    'estimate',
    'precaution',
    'alternative',
    'preliminary',
    'interpretation',
    'procedure',
    'consequence',
  ]),
]
const vocabularyPattern = wordPattern(vocabulary, true)
const canonical = new Map(
  vocabulary.map((term) => [term.toLowerCase(), term]),
)
export function wordsFromMock(a: Attempt) {
  const candidates: {
    term: string
    item: string
    title: string
    context: string
    priority: number
  }[] = []
  for (const stage of a.stages)
    for (const q of stage.items) {
      const answer = a.answers[q.id]
      if (!answer || (!answer.text?.trim() && !answer.clip)) continue
      const missed = new Set<string>()
      const filled = (q.passage ?? '').replace(
        /([a-z]+)\{(\d+)\}/gi,
        (match, start: string, n: string) => {
          const key = q.keys?.[Number(n)]
          if (!key) return match
          const term = start + key
          if (
            term.length >= 5 &&
            answer.text?.split('|')[Number(n)]?.trim().toLowerCase() !==
              key.toLowerCase()
          )
            missed.add(term)
          return term
        },
      )
      const source = [
        filled,
        q.speech,
        q.task === 'sentence' ? q.keys?.[0] : '',
        q.prompt,
      ]
        .filter(Boolean)
        .join('\n')
      const quoted = Array.from(
        q.prompt.matchAll(/[“"]([\p{L}][\p{L} ’'-]{2,40})[”"]/gu),
        (x) => x[1],
      )
      const present = Array.from(
        source.matchAll(vocabularyPattern),
        (m) => canonical.get(m[0].toLowerCase()) ?? m[0],
      )
      for (const term of new Set([...missed, ...quoted, ...present])) {
        if (term.split(/\s+/).length > 8) continue
        const hit = wordPattern([term]).exec(source)
        if (!hit) continue
        const i = hit.index,
          previous = source.slice(0, i).search(/[^.!?\n]*$/)
        const after = source.slice(i).search(/[.!?\n]/)
        candidates.push({
          term,
          item: q.id,
          title: q.title,
          context: source
            .slice(
              Math.max(previous, i - 170),
              after < 0 ? i + 300 : Math.min(i + after + 1, i + 300),
            )
            .trim(),
          priority:
            (missed.has(term) ? 8 : 0) +
            (quoted.includes(term) ? 4 : 0) +
            (answer.score !== undefined && answer.score < 1 ? 2 : 0) +
            Number(term.includes(' ')),
        })
      }
    }
  const chosen: typeof candidates = [],
    seen = new Set<string>()
  for (const c of candidates.sort((a, b) => b.priority - a.priority)) {
    if (
      seen.has(c.term.toLowerCase()) ||
      chosen.filter((x) => x.item === c.item).length >= 2
    )
      continue
    chosen.push(c)
    seen.add(c.term.toLowerCase())
    if (chosen.length === 5) break
  }
  return chosen
}
