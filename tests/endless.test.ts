import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { starterCards } from '../core/game-bank.ts'
import {
  emptyPractice,
  learnFromBatch,
  practiceBatch,
  type PlayedCard,
} from '../core/game-practice.ts'
import type { GameCard } from '../core/games.ts'
process.env.FIELDWORK_DATA = mkdtempSync(join(tmpdir(), 'toefl-endless-'))
const store = await import('../server/store.ts')
const { startGame, recordGameProgress, replenishGames } =
  await import('../server/games.ts')

test('a miss comes back after intervening answers alongside new topics, and two spaced successes retire it', () => {
  const pool = starterCards.filter((c) => c.track === 'prepositions')
  const [target, ...others] = pool,
    memory = emptyPractice(),
    token = randomUUID()
  const events: PlayedCard[] = [{ id: target.id, result: 'incorrect' }]
  const seen = { [target.id]: 1 }
  learnFromBatch(memory, token, events, pool)
  assert.ok(
    !practiceBatch(pool, 'prepositions', 5, [], seen, memory).includes(
      target,
    ),
  )
  events.push(
    ...others
      .slice(0, 3)
      .map((c) => ({ id: c.id, result: 'correct' as const })),
  )
  learnFromBatch(memory, token, events, pool)
  learnFromBatch(memory, token, events, pool)
  const pack = practiceBatch(pool, 'prepositions', 5, [], seen, memory)
  assert.equal(memory.step, 4)
  assert.ok(pack.includes(target))
  assert.ok(pack.some((c) => c !== target && c.family === target.family))
  assert.equal(new Set(pack.map((c) => c.term)).size, 5)
  learnFromBatch(
    memory,
    randomUUID(),
    [{ id: target.id, result: 'correct' }],
    pool,
  )
  assert.equal(memory.review[0].due, memory.step + 12)
  for (const c of others.slice(0, 12))
    learnFromBatch(
      memory,
      randomUUID(),
      [{ id: c.id, result: 'correct' }],
      pool,
    )
  assert.ok(
    practiceBatch(pool, 'prepositions', 5, [], seen, memory).includes(
      target,
    ),
  )
  learnFromBatch(
    memory,
    randomUUID(),
    [{ id: target.id, result: 'correct' }],
    pool,
  )
  assert.equal(memory.review.length, 0)
})
test('legacy deferred verdicts, retries and long offline sessions use bounded memory', () => {
  const c = starterCards.find((c) => c.track === 'relations')!,
    batch = randomUUID()
  recordGameProgress('relations', batch, [
    { id: c.id, result: 'unlisted' },
  ])
  const read = () => JSON.parse(store.setting('game-practice-relations'))
  assert.equal(read().review.length, 0)
  const checked: PlayedCard[] = [
    { id: c.id, result: 'unlisted' },
    { id: c.id, result: 'incorrect', correction: true },
  ]
  recordGameProgress('relations', batch, checked)
  recordGameProgress('relations', batch, checked)
  assert.equal(read().step, 1)
  assert.equal(read().review[0].misses, 1)
  for (let i = 0; i < 80; i++) {
    const r = startGame('relations', 'Challenge', undefined, true)
    assert.equal(r.cards.length, 4)
    recordGameProgress(
      'relations',
      randomUUID(),
      r.cards.map((c) => ({ id: c.id, result: 'incorrect' })),
    )
  }
  assert.ok(read().receipts.length <= 64 && read().review.length <= 32)
  assert.equal(store.gameExtras('relations').length, 0)
})
test('upholding an appeal reverses just that mistake and preserves earlier spaced practice', () => {
  const card = starterCards[0]
  const memory = emptyPractice()
  const events: PlayedCard[] = [{ id: card.id, result: 'incorrect' }]
  const overturned: PlayedCard[] = [
    ...events,
    { id: card.id, result: 'correct', correction: true },
  ]
  learnFromBatch(memory, 'first', events, [card])
  assert.equal(memory.review[0].misses, 1)
  learnFromBatch(memory, 'first', overturned, [card])
  assert.equal(memory.review.length, 0)
  assert.equal(memory.step, 1)
  learnFromBatch(memory, 'second', events, [card])
  learnFromBatch(memory, 'third', events, [card])
  learnFromBatch(memory, 'third', overturned, [card])
  assert.equal(memory.review[0].misses, 1)
  assert.equal(memory.review[0].successes, 1)
  learnFromBatch(memory, 'fourth', overturned, [card])
  assert.equal(memory.review.length, 0)
  assert.equal(memory.step, 4)
})
test('one creation and one independent review can prepare a targeted batch, rotating served cards at capacity', async () => {
  store.configure('provider', 'openai')
  store.configure('openai-model', 'fixture')
  store.configure('openai-secret', 'test-present')
  const track = 'prepositions',
    pool = starterCards.filter((c) => c.track === track)
  const draft: GameCard = {
    ...pool[0],
    id: 'new',
    term: 'insist on',
    family: 'Verb patterns',
    prompt:
      'The curator insisted ___ inspecting the silk in daylight before the auction.',
    answers: ['on', 'upon'],
    distractors: ['at', 'to'],
    note: 'Insist on takes an -ing form.',
  }
  const extras = Array.from({ length: 192 }, (_, i) => ({
    ...draft,
    id: 'game-old-' + i,
    term: 'old example ' + i,
    prompt: 'A previously served exercise number ' + i + ' with a ___.',
  }))
  store.transaction(() => {
    for (const c of extras) store.storeGameCard(c)
    store.seeGameCards(extras.concat(pool))
  })
  startGame(track, 'Standard', undefined, true)
  recordGameProgress(
    track,
    randomUUID(),
    pool.slice(0, 2).map((c) => ({ id: c.id, result: 'incorrect' })),
  )
  const roles: string[] = []
  await replenishGames(async (_prompt, input, _timeout, role) => {
    roles.push(role!)
    if (role === 'generation') {
      const brief = JSON.parse(input)
      assert.equal(brief.track, track)
      assert.equal(brief.revisit.length, 2)
      assert.ok(
        brief.revisit.every(
          (r: { previousPrompt: string }) => r.previousPrompt,
        ),
      )
      assert.ok(!input.includes('learnerAnswer'))
      return JSON.stringify([draft])
    }
    return '{"approved":[0]}'
  })
  assert.deepEqual(roles, ['generation', 'review'])
  assert.equal(store.gameExtras(track).length, 192)
  assert.ok(store.gameExtras(track).some((c) => c.prompt === draft.prompt))
})
