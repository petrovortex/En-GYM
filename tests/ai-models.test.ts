import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bank } from '../core/exam.ts'
import {
  createCloze,
  validateAudit,
  reviewContract,
} from '../core/task-specs.ts'
import type { AIRole, ModelSelection } from '../core/ai.ts'
process.env.FIELDWORK_DATA = mkdtempSync(join(tmpdir(), 'toefl-ai-models-'))
const {
  setProvider,
  saveConnection,
  setModels,
  modelFor,
  preferences,
  complete,
  verify,
  preparationModels,
  disconnect,
  ProviderError,
} = await import('../server/provider.ts')
const { author } = await import('../server/author.ts')
const { setting } = await import('../server/store.ts')
const flags = {
  format: true,
  relevance: true,
  naturalEnglish: true,
  difficulty: true,
  diversity: true,
}
const roles: Record<AIRole, ModelSelection> = {
  trainer: { provider: 'openai', model: 'trainer-fixture' },
  generation: { provider: 'openai', model: 'astra-fixture' },
  review: { provider: 'mercury', model: 'mercury-3' },
}
const stream = (text: string) =>
  new Response(
    'data: ' +
      JSON.stringify({ type: 'response.output_text.delta', delta: text }) +
      '\n\ndata: {"type":"response.completed"}\n\n',
  )
const mercury = (content: string, finish = 'stop') =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finish, message: { content } }],
    }),
  )
const paragraph =
  'Urban gardens provide more than fresh vegetables. Their roots absorb heavy rainfall while their leaves offer welcome shade during the hottest summer months. Local residents often share tools and exchange practical advice about growing healthy plants in limited spaces. These small green areas can also support insects that carry pollen between flowers. Researchers therefore study gardens as connected parts of city environments rather than isolated patches of soil. Careful planning helps communities maintain these benefits throughout the changing seasons.'

test('old settings keep their models when adding a connection; keys never appear in preferences', () => {
  setProvider('openai', 'legacy-fixture', 'fixture-openai-secret')
  assert.ok(
    Object.values(preferences().roles).every(
      (r) => r.model === 'legacy-fixture',
    ),
  )
  saveConnection('mercury', 'mercury-3', 'fixture-mercury-secret')
  saveConnection('openai', 'connection-test-model')
  assert.ok(
    Object.values(preferences().roles).every(
      (r) => r.model === 'legacy-fixture',
    ),
  )
  assert.equal(preferences().connections.mercury.configured, true)
  assert.equal(
    JSON.stringify(preferences()).includes('fixture-mercury-secret'),
    false,
  )
  assert.equal(
    setting('mercury-secret').includes('fixture-mercury-secret'),
    false,
  )
  setModels(roles)
  assert.equal(
    preparationModels().source,
    'openai:astra-fixture|mercury:mercury-3',
  )
})

test('generation, review and trainer route independently to the assigned provider and model', async (t) => {
  setModels(roles)
  const seen: string[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      seen.push(body.model)
      if (String(url).includes('inceptionlabs')) {
        assert.equal(
          String(url),
          'https://api.inceptionlabs.ai/v1/chat/completions',
        )
        assert.equal(
          (init!.headers as any).Authorization,
          'Bearer fixture-mercury-secret',
        )
        assert.equal(body.messages[0].role, 'system')
        assert.equal(body.stream, false)
        return mercury('review ready')
      }
      assert.equal(String(url), 'https://api.openai.com/v1/responses')
      assert.equal(
        (init!.headers as any).Authorization,
        'Bearer fixture-openai-secret',
      )
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      return stream('ready')
    },
  )
  await complete('Create', 'Prompt', 90000, 'generation')
  assert.equal(
    await complete('Review', 'Prompt', 90000, 'review'),
    'review ready',
  )
  await complete('Coach', 'Prompt')
  await verify('mercury')
  assert.deepEqual(seen, [
    'astra-fixture',
    'mercury-3',
    'trainer-fixture',
    'mercury-3',
  ])
  assert.equal(modelFor('generation').model, 'astra-fixture')
})

test('Mercury truncation and exhausted credit are errors without fallback to another account', async (t) => {
  let mode = 'length',
    count = 0
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    count++
    assert.match(String(url), /inceptionlabs/)
    return mode === 'length'
      ? mercury('partial JSON', 'length')
      : new Response('', { status: 402 })
  })
  await assert.rejects(
    complete('Review', 'Prompt', 90000, 'review'),
    /incomplete/,
  )
  mode = 'quota'
  await assert.rejects(
    complete('Review', 'Prompt', 90000, 'review'),
    (e: unknown) => e instanceof ProviderError && e.kind === 'quota',
  )
  assert.equal(count, 2)
})

test('changing only the reviewer reuses the paid draft and records both models', async (t) => {
  setModels(roles)
  let generations = 0,
    reviews = 0
  const progress: import('../server/author.ts').AuthorProgress = {}
  const control = { progress, persist: () => {}, checkpoint: () => {} }
  t.mock.method(
    globalThis,
    'fetch',
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)),
        remote = String(url).includes('inceptionlabs')
      const instructions = remote
        ? request.messages[0].content
        : request.instructions
      if (instructions.startsWith('Independently')) {
        reviews++
        const input = JSON.parse(
          remote ? request.messages[1].content : request.input[0].content,
        )
        assert.match(
          input.contract,
          /Private assessment notes are intentionally withheld/,
        )
        assert.equal(input.items[0].evidence, undefined)
        if (reviews === 1)
          return mercury(
            JSON.stringify({ checks: flags, issues: [], answers: [] }),
          )
        assert.equal(request.model, 'fast-review-fixture')
        return stream(
          JSON.stringify({
            checks: flags,
            issues: [],
            answers: [
              {
                index: 0,
                valid: true,
                unique: true,
                solutions: null,
                support: [],
                rationale:
                  'A feasible request with three clear and distinct communication goals.',
                distractors: [],
              },
            ],
          }),
        )
      }
      generations++
      assert.equal(request.model, 'astra-fixture')
      return stream(
        JSON.stringify([
          {
            title: 'Borrowing a campus display case',
            prompt:
              'Write an email to the facilities coordinator to borrow a display case for a student geology exhibit.',
            passage:
              '- Explain the exhibit and its dates.\n- Describe the size of case you need.\n- Ask how to arrange collection and return.',
            evidence: 'Address all three goals clearly with a polite request.',
          },
        ]),
      )
    },
  )
  const slots = [bank.find((q) => q.task === 'email')!]
  await assert.rejects(
    author(slots, false, [], 'Original fixture', control),
    /exactly 1 answer/,
  )
  setModels({
    ...roles,
    review: { provider: 'openai', model: 'fast-review-fixture' },
  })
  const result = await author(slots, false, [], 'Original fixture', control)
  assert.equal(generations, 1)
  assert.equal(reviews, 2)
  assert.equal(result[0].quality!.model, 'fast-review-fixture')
  assert.equal(result[0].quality!.author!.model, 'astra-fixture')
})

test('cloze review gets the masked form and an explicit solver contract, never the hidden key', async (t) => {
  setModels({ ...roles, review: roles.generation })
  const cloze = createCloze(paragraph)
  let calls = 0
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls++
      const request = JSON.parse(String(init?.body)),
        input = JSON.parse(request.input[0].content)
      if (calls === 1)
        return stream(
          JSON.stringify([
            {
              title: 'Community growing plots',
              prompt: 'Complete the missing letters.',
              passage: paragraph,
              evidence:
                'Reconstruct each suffix from its grammatical and semantic context.',
            },
          ]),
        )
      assert.match(input.contract, /intentionally masked/)
      assert.match(Object.values(input.contexts).join(''), /\{0\}/)
      assert.equal(input.items[0].keys, undefined)
      assert.deepEqual(
        input.items[0].gapLengths,
        cloze.keys.map((s) => s.length),
      )
      return stream(
        JSON.stringify({
          checks: flags,
          issues: [],
          answers: [
            {
              index: 0,
              valid: true,
              unique: true,
              solutions: cloze.keys,
              support: [],
              rationale:
                'The prefix and surrounding grammar determine these missing suffixes.',
              distractors: [],
            },
          ],
        }),
      )
    },
  )
  const result = await author(
    [bank.find((q) => q.task === 'words')!],
    false,
    [],
    'Original fixture',
  )
  assert.equal(result.length, 1)
  assert.equal(calls, 2)
  assert.match(reviewContract('sentence'), /intentionally shuffles/)
})

test('multiple exact citations and quoted evidence with commentary pass; invented quotations still fail', () => {
  const q = {
    ...bank.find((q) => q.task === 'daily')!,
    passage:
      'This is an estimate, not a new fixed rate. Any adjustment will appear later.',
    options: [
      'An estimate',
      'A fixed rate',
      'A refund today',
      'A cancelled charge',
    ],
    keys: ['An estimate'],
  }
  const make = (support: unknown) => ({
    checks: flags,
    issues: [],
    answers: [
      {
        index: 0,
        valid: true,
        unique: true,
        solutions: q.keys,
        support,
        rationale:
          'The notice explicitly distinguishes an estimate from a fixed charge.',
        distractors: q.options.slice(1).map((option) => ({
          option,
          reason:
            'This interpretation contradicts the stated billing arrangement.',
        })),
      },
    ],
  })
  for (const support of [
    ['This is an estimate', 'Any adjustment will appear later'],
    '“This is an estimate”; “Any adjustment will appear later.”',
    'The notice says "This is an estimate" and explains "Any adjustment will appear later."',
  ])
    assert.doesNotThrow(() => validateAudit([q], make(support)))
  for (const support of [
    ['This is an estimate', 'Invented unsupported evidence'],
    'The notice says "This is an estimate" and "all charges are cancelled"',
    'An unsupported paraphrase without a quotation',
  ])
    assert.throws(() => validateAudit([q], make(support)), /actual phrases/)
})

test('disconnecting Mercury keeps other accounts and model choices intact', async (t) => {
  setModels(roles)
  disconnect('mercury')
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('No request should be made without the selected key')
  })
  assert.equal(preferences().connections.openai.configured, true)
  assert.equal(modelFor('review').model, 'mercury-3')
  assert.equal(modelFor('review').configured, false)
  assert.equal(preparationModels().configured, false)
  await assert.rejects(
    complete('Review', 'Prompt', 90000, 'review'),
    /Connect your AI provider/,
  )
})
