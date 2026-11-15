import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { starterCards } from '../core/game-bank.ts'
import {
  drawCards,
  gradeCard,
  prepGroups,
  ruleFamilies,
  tracks,
  type GameCard,
} from '../core/games.ts'
import { wordsFromMock } from '../core/mock-words.ts'
import type { Attempt } from '../core/types.ts'

process.env.FIELDWORK_DATA = mkdtempSync(join(tmpdir(), 'toefl-games-'))
const { startGame, validDraft, replenishGames } =
  await import('../server/games.ts')
const store = await import('../server/store.ts')
const work = await import('../server/work.ts')

test('offline banks support every difficulty, scope and three distinct rounds of ordinary practice', () => {
  assert.equal(
    new Set(starterCards.map((c) => c.id)).size,
    starterCards.length,
  )
  for (const track of tracks) {
    const cards = starterCards.filter((c) => c.track === track)
    for (const c of cards)
      assert.equal(gradeCard(c, c.answers[0], 1), 'correct')
    if (track !== 'prepositions') assert.ok(cards.length >= 15)
    for (const level of ['Guided', 'Standard', 'Challenge'] as const) {
      const r = startGame(track, level)
      assert.equal(new Set(r.cards.map((c) => c.term)).size, r.cards.length)
      assert.ok(r.seconds >= 40)
    }
  }
  assert.equal(
    new Set(
      starterCards
        .filter((c) => c.track === 'prepositions')
        .map((c) => c.family),
    ).size,
    ruleFamilies.length,
  )
  for (const focus of Object.keys(
    prepGroups,
  ) as (keyof typeof prepGroups)[]) {
    const r = startGame('prepositions', 'Standard', focus)
    assert.equal(r.cards.length, 5)
    assert.ok(
      r.cards.every((c) => prepGroups[focus].some((f) => f === c.family)),
    )
  }
  assert.throws(() =>
    startGame('match', 'Standard', 'Words with prepositions'),
  )
})
test('draw mixes saved terms with fresh new topics and avoids immediate repeats', () => {
  const pool = starterCards.filter((c) => c.track === 'match')
  const draw = drawCards(
    pool,
    'match',
    5,
    ['resilient', 'trade-off', 'threshold'],
    {},
  )
  assert.equal(
    draw.filter((c) =>
      ['resilient', 'trade-off', 'threshold'].includes(c.term),
    ).length,
    2,
  )
  const next = drawCards(
    pool,
    'match',
    5,
    [],
    Object.fromEntries(draw.map((c) => [c.id, 1])),
  )
  assert.ok(next.every((c) => !draw.includes(c)))
  assert.ok(new Set(draw.map((c) => c.family)).size >= 3)
  const r = starterCards.find((c) => c.track === 'relations')!
  assert.equal(
    gradeCard(r, r.answers[0] + ', ' + r.answers[0], 2),
    'incorrect',
  )
  assert.equal(
    gradeCard(r, r.answers.slice(0, 2).join(';'), 2),
    'correct',
  )
  assert.equal(gradeCard(r, 'another suggestion', 1), 'incorrect')
  assert.equal(gradeCard(r, r.distractors[0], 1), 'incorrect')
})
test('on first completion, harvest whole words instead of cloze suffixes and preserve their exact source', () => {
  const a: Attempt = {
    id: 'mock-games',
    mode: 'section',
    focus: 'Reading',
    rules: 1,
    started: 1,
    stage: 0,
    index: 0,
    deadline: 0,
    itemStarted: 0,
    seed: 1,
    messages: [],
    bands: {},
    stages: [
      {
        section: 'Reading',
        name: 'Reading',
        minutes: 1,
        items: [
          {
            id: 'item',
            task: 'words',
            level: 1,
            title: 'Reading a graph',
            prompt: 'Complete the words.',
            passage:
              'The same pattern keeps recurring. The new meas{0} suggest a steady decrease.',
            keys: ['urements'],
          },
        ],
      },
    ],
    answers: { item: { text: 'ures', score: 0 } },
  }
  store.save(a)
  assert.equal(store.vocabularyTerms().length, 0)
  a.ended = 2
  assert.equal(wordsFromMock(a)[0].term, 'measurements')
  store.save(a)
  const word = store
    .vocabularyWords()
    .find((w) => w.term === 'measurements')!
  assert.equal(word.sources[0].item, 'item')
  assert.match(word.sources[0].context, /new measurements/)
  const round = startGame('vocabulary', 'Standard')
  assert.ok(
    round.cards.some(
      (c) => c.term === 'measurements' && c.prompt.includes('new ___'),
    ),
  )
  store.removeVocabularyWord(word.id)
  store.save(a)
  assert.ok(!store.vocabularyTerms().includes('measurements'))
})
test('background game bank keeps a paused draft, uses independent review, enforces the daily budget and rejects duplicates', async () => {
  store.configure('provider', 'openai')
  store.configure('openai-model', 'test-model')
  store.configure('openai-secret', 'fixture-present')
  for (const c of starterCards.filter((c) => c.track === 'prepositions'))
    store.seeGameCards([c])
  const draft: GameCard = {
    track: 'prepositions',
    id: 'unused',
    family: 'Verb patterns',
    term: 'insist on',
    prompt:
      'Our guide insisted ___ counting everyone before leaving the cave.',
    answers: ['on', 'upon'],
    distractors: ['at', 'for'],
    note: 'Insist on takes an -ing form.',
  }
  assert.equal(
    validDraft(
      [draft, { ...draft, prompt: 'missing gap' }, draft],
      'prepositions',
      [],
    ).length,
    1,
  )
  const roles: string[] = []
  let generatedTrack: GameCard['track'] = 'prepositions'
  const generate = async (
    _p: string,
    _i: string,
    _t?: number,
    role?: 'trainer' | 'generation' | 'review',
  ) => {
    roles.push(role!)
    if (role === 'generation') {
      work.examActivity(true, 'games-test')
      generatedTrack = JSON.parse(_i).track
      assert.ok(
        generatedTrack === 'prepositions' ||
          generatedTrack === 'vocabulary',
      )
      return JSON.stringify([{ ...draft, track: generatedTrack }])
    }
    return '{"approved":[0]}'
  }
  await replenishGames(generate)
  assert.deepEqual(roles, ['generation'])
  assert.ok(store.setting('game-draft'))
  await replenishGames(generate)
  assert.equal(roles.length, 1)
  work.examActivity(false, 'games-test')
  await replenishGames(generate)
  assert.deepEqual(roles, ['generation', 'review'])
  const fresh = store.gameExtras(generatedTrack)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].term, draft.term)
  assert.equal(
    validDraft([{ ...draft, track: generatedTrack }], generatedTrack, fresh)
      .length,
    0,
  )
  store.configure(
    'game-call-times',
    JSON.stringify(Array(8).fill(Date.now())),
  )
  await replenishGames(generate)
  assert.equal(roles.length, 2)
})
