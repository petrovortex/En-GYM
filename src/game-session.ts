import {
  gradeCard,
  shuffle,
  type GameCard,
  type GameRound,
} from '../core/games.ts'
import type { GameResult, PlayedCard } from '../core/game-practice.ts'

export type Checks = Record<string, { correct: boolean; note: string }>
export const gameStorage = 'vocabulary-game-v1'
export interface GameTotals {
  played: number
  correct: number
}
export interface Session {
  round: GameRound
  deadline: number
  done: boolean
  index: number
  answers: Record<string, string>
  options: Record<string, string[]>
  right: string[]
  checks: Checks
  endless: boolean
  batch: string
  events: PlayedCard[]
  feedback?: string
  prior: GameTotals
}
export const clock = (s: number) =>
  Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
export function makeSession(
  round: GameRound,
  timed: boolean,
  endless = false,
  prior: GameTotals = { played: 0, correct: 0 },
): Session {
  return {
    round,
    deadline: timed && !endless ? Date.now() + round.seconds * 1000 : 0,
    done: false,
    index: 0,
    answers: {},
    checks: {},
    options: Object.fromEntries(
      round.cards.map((c) => [
        c.id,
        shuffle([c.answers[0], ...c.distractors.slice(0, 2)]),
      ]),
    ),
    right: shuffle(round.cards.map((c) => c.id)),
    endless,
    batch: crypto.randomUUID(),
    events: [],
    prior,
  }
}
export function restored(): Session | undefined {
  try {
    const old = JSON.parse(sessionStorage.getItem(gameStorage) || 'null')
    if (!old?.round?.cards?.length) return
    if (old.batch) {
      const s = old as Session
      for (const e of s.events.filter((e) => e.result === 'unlisted')) {
        if (
          !s.checks[e.id] &&
          !s.events.some((v) => v.id === e.id && v.correction)
        )
          s.events.push({
            id: e.id,
            result: 'incorrect',
            correction: true,
          })
      }
      return s
    }
    const s: Session = { ...makeSession(old.round, false), ...old }
    s.round.cards.forEach((c, i) => {
      if (
        (s.done || (s.round.track !== 'match' && i < s.index)) &&
        s.answers[c.id]
      )
        s.events.push({
          id: c.id,
          result: s.checks[c.id]
            ? s.checks[c.id].correct
              ? 'correct'
              : 'incorrect'
            : resultFor(s, c, s.answers[c.id]),
        })
    })
    return s
  } catch {
    return undefined
  }
}
function resultFor(s: Session, c: GameCard, answer: string): GameResult {
  return gradeCard(c, answer, s.round.required)
}
export function outcome(s: Session, c: GameCard): GameResult {
  const check = s.checks[c.id]
  if (check) return check.correct ? 'correct' : 'incorrect'
  const result = s.events.find((e) => e.id === c.id)?.result ?? 'skipped'
  return result === 'unlisted' ? 'incorrect' : result
}
export function canAppeal(s: Session, c: GameCard) {
  return (
    s.round.level !== 'Guided' &&
    s.round.track !== 'match' &&
    !s.checks[c.id] &&
    outcome(s, c) === 'incorrect'
  )
}
export function submitCard(
  s: Session,
  c: GameCard,
  answer: string,
): Session {
  if (s.events.some((e) => e.id === c.id)) return s
  return {
    ...s,
    answers: { ...s.answers, [c.id]: answer },
    feedback: c.id,
    events: [...s.events, { id: c.id, result: resultFor(s, c, answer) }],
  }
}
export function checkedCards(s: Session) {
  return s.round.cards.filter((c) => s.events.some((e) => e.id === c.id))
}
export function totals(s: Session): GameTotals {
  const totals = { played: s.prior.played, correct: s.prior.correct }
  for (const c of checkedCards(s)) {
    totals.played++
    const result = outcome(s, c)
    if (result === 'correct') totals.correct++
  }
  return totals
}
export function applyChecks(s: Session, checks: Checks): Session {
  const resolved: PlayedCard[] = Object.keys(checks)
    .filter((id) => !s.checks[id] && checks[id].correct)
    .map((id) => ({
      id,
      result: 'correct',
      correction: true,
    }))
  return {
    ...s,
    checks: { ...s.checks, ...checks },
    events: s.events.concat(resolved),
  }
}
