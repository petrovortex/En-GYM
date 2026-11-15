import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  cleanTerm,
  wordPattern,
  checkVocabularyText,
} from '../core/vocabulary.ts'
import type { Attempt } from '../core/types.ts'
process.env.FIELDWORK_DATA = mkdtempSync(
  join(tmpdir(), 'toefl-vocabulary-'),
)
const store = await import('../server/store.ts')
const { addWord, generateVocabularyText } =
  await import('../server/vocabulary.ts')
const { setProvider, setModels } = await import('../server/provider.ts')
const { bankWorkAllowed } = await import('../server/work.ts')
const a: Attempt = {
  id: 'vocabulary-attempt',
  mode: 'drill',
  focus: 'passage',
  seed: 1,
  rules: 1,
  started: 1,
  stage: 0,
  index: 0,
  deadline: Date.now() + 60000,
  itemStarted: Date.now(),
  stages: [
    {
      section: 'Reading',
      name: 'Reading',
      minutes: 2,
      items: [
        {
          id: 'q1',
          task: 'passage',
          title: 'City gardens',
          level: 2,
          prompt: 'Why do gardens matter?',
          passage: 'Resilient gardens protect a city.',
          options: ['Shade', 'Heat'],
          keys: ['Shade'],
        },
        {
          id: 'q2',
          task: 'passage',
          title: 'New context',
          level: 2,
          prompt: 'A resilient community.',
        },
      ],
    },
  ],
  answers: { q1: { text: 'Shade', elapsed: 12 } },
  messages: [],
  bands: {},
}
test('word matching supports phrases and punctuation without partial-word matches', () => {
  assert.equal(cleanTerm('  “Take   into account” '), 'Take into account')
  assert.equal(cleanTerm('don’t'), "don't")
  assert.throws(() =>
    cleanTerm('one two three four five six seven eight nine'),
  )
  assert.throws(() => cleanTerm('<script>'))
  assert.equal(wordPattern(['art']).test('earth'), false)
  assert.equal(
    wordPattern(['take into account']).test('Take into\naccount'),
    true,
  )
  assert.equal(wordPattern(["don't"]).test('don’t'), true)
})
test('a duplicate keeps the existing word and original source, without modifying a live attempt', () => {
  store.save(a)
  const before = JSON.stringify(store.load(a.id))
  const first = addWord({
    term: 'Resilient',
    attempt: a.id,
    item: 'q1',
    context: a.stages[0].items[0].passage,
  })
  assert.equal(first.created, true)
  const second = addWord({
    term: 'resilient',
    attempt: a.id,
    item: 'q2',
    context: 'A resilient community.',
  })
  assert.equal(second.created, false)
  assert.deepEqual(first.word, second.word)
  addWord({
    term: 'resilient',
    attempt: a.id,
    item: 'q2',
    context: 'Repeated save',
  })
  assert.equal(store.vocabularyWords().length, 1)
  assert.equal(store.vocabularyWords()[0].sources.length, 1)
  assert.equal(JSON.stringify(store.load(a.id)), before)
  assert.throws(
    () => addWord({ term: 'lost', attempt: a.id, item: 'missing' }),
    /source response/,
  )
})
test('generation uses the trainer model, saves output, and excludes entire attempt data', async (t) => {
  setProvider('openai', 'default-fixture', 'fixture-key')
  setModels({
    trainer: { provider: 'openai', model: 'chosen-trainer' },
    generation: { provider: 'openai', model: 'different-generator' },
    review: { provider: 'openai', model: 'different-reviewer' },
  })
  const word = store.vocabularyWords()[0]
  const prose =
    'Resilient ' +
    'communities learn from shared experiences and work together to protect their gardens. '.repeat(
      8,
    )
  let calls = 0
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      assert.equal(body.model, 'chosen-trainer')
      assert.equal(bankWorkAllowed(), false)
      assert.ok(!JSON.stringify(body).includes('vocabulary-attempt'))
      assert.match(body.instructions, /untrusted data/)
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.output_text.delta',
            delta: JSON.stringify({
              title: 'A shared garden',
              text: prose,
            }),
          }) +
          '\n\ndata: {"type":"response.completed"}\n\n',
      )
    },
  )
  const result = await generateVocabularyText({
    ids: [word.id],
    topic: 'Community gardens',
    length: 100,
  })
  assert.equal(calls, 1)
  assert.equal(bankWorkAllowed(), true)
  assert.equal(result.model, 'chosen-trainer')
  assert.equal(store.vocabularyTexts()[0].text, prose.trim())
  const persisted = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {vocabularyWords,vocabularyTexts} from './server/store.ts'; console.log(JSON.stringify({words:vocabularyWords(),texts:vocabularyTexts()}))",
      ],
      { env: process.env, encoding: 'utf8', windowsHide: true },
    ),
  )
  assert.equal(persisted.words[0].sources.length, 1)
  assert.equal(persisted.texts[0].id, result.id)
})
test('bad output and invalid input cannot become saved texts or trigger unbounded retries', async (t) => {
  const count = store.vocabularyTexts().length
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(
      'data: ' +
        JSON.stringify({
          type: 'response.output_text.delta',
          delta: '{"title":"Bad","text":"Too short."}',
        }) +
        '\n\ndata: {"type":"response.completed"}\n\n',
    )
  })
  await assert.rejects(
    generateVocabularyText({ ids: [], topic: 'Gardens', length: 100 }),
    /Select/,
  )
  await assert.rejects(
    generateVocabularyText({
      ids: [store.vocabularyWords()[0].id],
      topic: '',
      length: 100,
    }),
    /topic/,
  )
  assert.equal(calls, 0)
  await assert.rejects(
    generateVocabularyText({
      ids: [store.vocabularyWords()[0].id],
      topic: 'Gardens',
      length: 100,
    }),
    /left out/,
  )
  assert.equal(calls, 1)
  assert.equal(store.vocabularyTexts().length, count)
  assert.equal(bankWorkAllowed(), true)
  assert.throws(
    () =>
      checkVocabularyText(
        '{"title":"Example","text":"Resilient gardens."}',
        ['resilient'],
        100,
      ),
    /length/,
  )
})
test('removing a word cleans sources but preserves saved text and original answers', () => {
  const before = JSON.stringify(store.load(a.id)),
    text = store.vocabularyTexts()[0]
  store.removeVocabularyWord(store.vocabularyWords()[0].id)
  assert.equal(store.vocabularyWords().length, 0)
  assert.deepEqual(store.vocabularyTexts()[0], text)
  assert.equal(JSON.stringify(store.load(a.id)), before)
  store.removeVocabularyText(text.id)
  assert.equal(store.vocabularyTexts().length, 0)
})
test('a text source keeps the selected occurrence and survives deletion of the original', () => {
  const paragraph =
    'Moss thrives here. Beyond the pond, moss grows slowly.'
  const text = {
    id: 'reader-test',
    created: Date.now(),
    topic: 'Wetlands',
    length: 100,
    title: 'A quiet wetland',
    text: 'An earlier paragraph.\n\n' + paragraph,
    words: ['pond'],
    model: 'fixture',
  }
  store.saveVocabularyText(text)
  const textSelection = {
    id: text.id,
    paragraph: 1,
    offset: paragraph.lastIndexOf('moss'),
    length: 4,
  }
  const input = { term: 'moss', textSelection }
  const source = addWord(input).word.sources[0]
  assert.equal(source.title, text.title)
  assert.equal(source.context, 'Beyond the pond, moss grows slowly.')
  assert.equal(addWord(input).word.sources.length, 1)
  assert.throws(
    () => addWord({ ...input, term: 'invented' }),
    /original text/,
  )
  assert.equal(
    addWord({
      term: 'wetland',
      textSelection: {
        id: text.id,
        paragraph: 'title',
        offset: 8,
        length: 7,
      },
    }).word.sources[0].context,
    text.title,
  )
  store.removeVocabularyText(text.id)
  assert.throws(() => addWord(input), /no longer saved/)
  assert.deepEqual(
    store.vocabularyWords().find((w) => w.term === 'moss')?.sources,
    [source],
  )
})
