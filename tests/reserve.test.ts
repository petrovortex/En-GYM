import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bank, RULES } from '../core/exam.ts'
import { reserveStock, RESERVE_SESSIONS, fullDemand } from '../core/reserve.ts'
import { materialKeys, practiceSize } from '../core/material.ts'
import { catalog, emptyTrend, type Attempt, type Item } from '../core/types.ts'
import type { BankJob } from '../server/bank.ts'
import { QualityError } from '../core/quality.ts'
import {
  estimatePreparation,
  preparationSections,
  materialCount,
} from '../core/preparation-progress.ts'
process.env.FIELDWORK_DATA = mkdtempSync(join(tmpdir(), 'toefl-reserve-'))
const store = await import('../server/store.ts')
const inventory = await import('../server/inventory.ts')
const { replenish, runBank, enqueuePersonal } =
  await import('../server/bank.ts')
const { setProvider, ProviderError } = await import('../server/provider.ts')
const { examActivity, foregroundWork } = await import('../server/work.ts')

test('reserve covers every mode and longest drill for three sessions using shared, unfamiliar stimuli', () => {
  const stock = reserveStock(bank)
  assert.equal(stock.length, 12)
  assert.equal(RESERVE_SESSIONS, 3)
  for (const s of stock) {
    assert.ok(s.target >= fullDemand[s.task] * 3)
    assert.ok(s.target >= practiceSize(s.task, 'long') * 3)
  }
  const passage = bank.find((q) => q.task === 'passage')!
  const seen = {
    ...emptyTrend(),
    lastUsed: Object.fromEntries(
      materialKeys(passage).map((key) => [key, Date.now()]),
    ),
  }
  assert.equal(
    reserveStock(bank, seen).find((s) => s.task === 'passage')!.fresh,
    stock.find((s) => s.task === 'passage')!.fresh - 1,
  )
  assert.deepEqual(
    reserveStock(bank.concat([{ ...passage, id: 'personal', personal: true }])),
    stock,
  )
})

test('available sessions stay open below reserve target; mastery disables only affected modes', () => {
  const initial = inventory.availability()
  assert.equal(initial['section:Writing'].state, 'ready')
  assert.ok(inventory.inventoryStock().some((s) => s.deficit > 0))
  const reading = bank.filter((q) => catalog[q.task][0] === 'Reading')
  const a: Attempt = {
    id: randomUUID(),
    started: Date.now() - 1000,
    ended: Date.now(),
    mode: 'section',
    focus: 'Reading',
    seed: 4,
    rules: RULES,
    stage: 0,
    index: 0,
    deadline: 0,
    itemStarted: 0,
    stages: [
      { section: 'Reading', name: 'Fixture', minutes: 0, items: reading },
    ],
    answers: Object.fromEntries(
      reading.map((q) => [q.id, { text: 'Fixture', score: 1 }]),
    ),
    messages: [],
    bands: {},
  }
  store.save(a)
  const next = inventory.availability()
  assert.equal(next.full.state, 'material')
  assert.equal(next['section:Reading'].state, 'material')
  assert.equal(next['section:Writing'].state, 'ready')
  assert.equal(next['drill:email:short'].state, 'ready')
  assert.ok(
    inventory.readySession({ mode: 'section', focus: 'Writing' }).stages.length,
  )
})

test('startup replenishes all twelve types, deduplicates jobs and stops a task at its reserve target', async () => {
  setProvider('openai', 'reserve-model-fixture', 'fixture-key')
  replenish()
  replenish()
  const pending = () => store.jobs<BankJob>().filter((j) => j.state !== 'done')
  assert.equal(new Set(pending().map((j) => j.task)).size, 12)
  assert.equal(pending().length, 12)
  let calls = 0
  const writer: typeof import('../server/author.ts').author = async (
    slots,
    personal,
    _previous,
    _brief,
    control,
  ) => {
    control!.checkpoint(true)
    control!.checkpoint(true)
    calls++
    return slots.map((q) => ({
      ...q,
      id: randomUUID(),
      group: undefined,
      prompt: randomUUID(),
      passage: randomUUID(),
      personal,
    }))
  }
  for (let n = 0; n < 20; n++) {
    replenish()
    for (const j of pending()) {
      j.retryAfter = j.task === 'email' ? 0 : Date.now() + 86400000
      store.saveJob(j)
    }
    if (!inventory.inventoryStock().find((s) => s.task === 'email')!.deficit)
      break
    await runBank(writer)
  }
  assert.ok(calls > 0)
  assert.equal(
    inventory.inventoryStock().find((s) => s.task === 'email')!.deficit,
    0,
  )
  const done = calls
  replenish()
  for (const j of pending()) {
    j.retryAfter = Date.now() + 86400000
    store.saveJob(j)
  }
  await runBank(writer)
  assert.equal(calls, done)
})

function onlyTask(task: string) {
  for (const j of store.jobs<BankJob>().filter((j) => j.state !== 'done')) {
    j.retryAfter = j.task === task ? 0 : Date.now() + 86400000
    store.saveJob(j)
  }
}
test('quota waits survive reopening and resume automatically after Retry-After without a probe request', async (t) => {
  onlyTask('reply')
  const retryAt = Date.now() + 20 * 60000
  let calls = 0
  await runBank(async (_s, _p, _old, _b, c) => {
    calls++
    c!.checkpoint(true)
    throw new ProviderError('Quota fixture', 'quota', retryAt)
  })
  assert.equal(calls, 1)
  assert.ok(Number(store.setting('bank-backoff')) >= retryAt)
  const { spawnSync } = await import('node:child_process')
  const reopened = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const s=await import("./server/store.ts");console.log(s.setting("bank-backoff"))',
    ],
    { env: process.env, encoding: 'utf8', windowsHide: true },
  )
  assert.equal(reopened.status, 0, reopened.stderr)
  assert.equal(Number(reopened.stdout), Number(store.setting('bank-backoff')))
  const writer: typeof import('../server/author.ts').author = async (
    slots,
    _p,
    _old,
    _b,
    c,
  ) => {
    calls++
    c!.checkpoint(true)
    return slots.map((q) => ({
      ...q,
      id: randomUUID(),
      speech: randomUUID(),
      prompt: randomUUID(),
    }))
  }
  await runBank(writer)
  assert.equal(calls, 1)
  t.mock.method(Date, 'now', () => retryAt + 1)
  examActivity()
  await foregroundWork(() => runBank(writer))
  assert.equal(calls, 1)
  await runBank(writer)
  assert.equal(calls, 2) // continues during an exam, but yields to grading/chat
  examActivity(false)
  assert.equal(store.setting('bank-backoff'), '0')
})

test('repeated quality failures cool down, then retire the rejected draft and resume without a user click', async (t) => {
  onlyTask('sentence')
  let now = Date.now(),
    calls = 0
  t.mock.method(Date, 'now', () => now)
  const reject: typeof import('../server/author.ts').author = async (
    _s,
    _p,
    _old,
    _b,
    c,
  ) => {
    calls++
    c!.checkpoint(true)
    c!.progress.raw = { invalid: 'draft' }
    throw new QualityError('draft', ['Ambiguous fixture.'])
  }
  for (let n = 0; n < 3; n++) {
    await runBank(reject)
    now += 1100
  }
  assert.equal(calls, 3)
  const failed = store
    .jobs<BankJob>()
    .find((j) => j.task === 'sentence' && j.state === 'paused')!
  assert.ok(failed.retryAfter > now)
  await runBank(reject)
  assert.equal(calls, 3)
  now = failed.retryAfter + 1
  await runBank(async (slots, _p, _old, _b, c) => {
    calls++
    assert.equal(c!.progress.raw, undefined)
    return slots.map((q) => ({ ...q, id: randomUUID(), prompt: randomUUID() }))
  })
  assert.equal(calls, 4)
})

test('local audio failure preserves audited work without blocking other material or charging AI again', async () => {
  onlyTask('conversation')
  let calls = 0
  await runBank(async (_slots, _p, _old, _brief, control) => {
    control!.progress.audited = true
    control!.progress.phase = 'audio'
    throw Error('Local speech fixture unavailable')
  })
  const saved = store
    .jobs<BankJob>(true)
    .find((j) => j.task === 'conversation')!
  assert.equal(saved.state, 'paused')
  assert.equal(saved.progress.audited, true)
  assert.ok(saved.retryAfter > Date.now())
  assert.equal(store.setting('bank-backoff'), '0')
  onlyTask('daily')
  await runBank(async (slots, _p, _old, _brief, control) => {
    control!.checkpoint(true)
    calls++
    return slots.map((q) => ({ ...q, id: randomUUID(), passage: randomUUID() }))
  })
  assert.equal(calls, 1)
})

test('reopening a recommendation cannot regenerate its already completed personal practice', () => {
  const attempt = randomUUID(),
    id = 'personal-' + attempt
  const completed: BankJob = {
    id,
    task: 'email',
    personal: true,
    attempt,
    brief: 'Original recommendation',
    state: 'done',
    retryAfter: 0,
    slots: [],
    progress: {},
  }
  store.saveJob(completed)
  enqueuePersonal(attempt, 'email', 'Repeated analysis')
  assert.deepEqual(store.jobById(id), completed)
})

test('time estimates require matching observations and account for whole batches, not individual requests', () => {
  const stock = reserveStock(bank).map((s) => ({
    ...s,
    deficit: s.task === 'reply' ? 6 : 0,
  }))
  const sample = {
    task: 'reply' as const,
    source: 'openai:fixture',
    elapsedMs: 100000,
    units: 5,
  }
  assert.equal(estimatePreparation(stock, [sample], sample.source), undefined)
  assert.equal(
    estimatePreparation(
      stock,
      [sample, { ...sample, source: 'openai:other' }],
      sample.source,
    ),
    undefined,
  )
  assert.deepEqual(
    estimatePreparation(stock, [sample, sample], sample.source),
    { minMinutes: 3, maxMinutes: 5 },
  )
  assert.equal(
    estimatePreparation(
      stock.map((s) => ({ ...s, deficit: 0 })),
      [sample, sample],
      sample.source,
    ),
    undefined,
  )
  const unmeasured = stock.map((s) => ({
    ...s,
    deficit: s.task === 'talk' ? 1 : s.deficit,
  }))
  assert.equal(
    estimatePreparation(unmeasured, [sample, sample], sample.source),
    undefined,
  )
})

test('reserve progress caps surplus and reports material in understandable units', () => {
  const stock = reserveStock(bank).map((s) => ({
    ...s,
    fresh: s.target + 5,
    deficit: 0,
  }))
  assert.ok(
    preparationSections(stock).every(
      (s) => s.percent === 100 && s.remaining === 'Reserve full',
    ),
  )
  const repeat = stock.find((s) => s.task === 'repeat')!
  repeat.fresh = repeat.target - 1
  repeat.deficit = 1
  assert.equal(
    preparationSections(stock).find((s) => s.section === 'Speaking')!.remaining,
    '7 sentences left',
  )
  assert.equal(materialCount('interview', 2), '8 questions')
  assert.equal(materialCount('talk', 1), '1 recording')
})

test('completed timing includes retries but excludes time waiting offline', async (t) => {
  onlyTask('talk')
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  await runBank(async (_slots, _p, _old, _brief, control) => {
    control!.checkpoint(true)
    now += 2000
    control!.persist()
    assert.equal(
      store.jobs<BankJob>(true).find((j) => j.task === 'talk')!.workMs,
      2000,
    )
    throw new ProviderError('Offline fixture', 'network')
  })
  const paused = store.jobs<BankJob>(true).find((j) => j.task === 'talk')!
  assert.equal(paused.workMs, 2000)
  now = paused.retryAfter + 600000
  await runBank(async (slots, _p, _old, _brief, control) => {
    control!.checkpoint(true)
    now += 3000
    return slots.map((q) => ({ ...q, id: randomUUID(), speech: randomUUID() }))
  })
  const done = store.jobById<BankJob>(paused.id)!
  assert.equal(done.state, 'done')
  assert.equal(done.metrics!.elapsedMs, 5000)
  assert.equal(done.metrics!.source, 'openai:reserve-model-fixture')
  assert.equal(done.metrics!.units, 1)
})
