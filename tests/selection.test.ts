import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bank, buildStages, learnerTrend, RULES } from '../core/exam.ts'
import { materialKeys, materialSets } from '../core/material.ts'
import { QualityError } from '../core/quality.ts'
import {
  assertSelection,
  coolingDown,
  familiar,
  MaterialShortage,
  routes,
  SUCCESS_COOLDOWN,
} from '../core/selection.ts'
import {
  catalog,
  emptyTrend,
  type Attempt,
  type Item,
  type Stage,
} from '../core/types.ts'

process.env.FIELDWORK_DATA = mkdtempSync(join(tmpdir(), 'toefl-selection-'))
const store = await import('../server/store.ts')
const { selectSession } = await import('../server/selection.ts')
const prep = await import('../server/preparation.ts')
const { practicePlan, consumePlan } = await import('../server/practice.ts')
const { setProvider } = await import('../server/provider.ts')
const { setBankEnabled } = await import('../server/bank.ts')
const { examActivity, foregroundWork } = await import('../server/work.ts')
const stage = (items: Item[]): Stage => ({
  section: catalog[items[0].task][0],
  name: 'Fixture',
  minutes: 0,
  items,
})
function attempt(items: Item[], score?: number, ended = Date.now()): Attempt {
  return {
    id: randomUUID(),
    mode: 'drill',
    focus: items[0].task,
    rules: RULES,
    seed: 42,
    started: ended - 1000,
    ended,
    stages: [stage(items)],
    stage: 0,
    index: 0,
    deadline: 0,
    itemStarted: 0,
    bands: {},
    messages: [],
    answers: Object.fromEntries(
      items.map((q) => [q.id, { text: 'Saved response', score }]),
    ),
  }
}

test('only maximum scores trigger 30 days, measured from completion rather than grading time', () => {
  const q = bank[0],
    now = Date.now()
  for (const score of [0, 0.5, 0.9, undefined]) {
    const trend = learnerTrend([attempt([q], score, now - 1000)], q.task)
    assert.equal(coolingDown(q, trend, now), false)
  }
  const success = attempt([q], 1, now - SUCCESS_COOLDOWN + 1)
  const history = learnerTrend([attempt([q], 0, now), success], q.task)
  assert.equal(coolingDown(q, history, now), true)
  assert.equal(coolingDown(q, history, now + 1), false)
})

test('every adaptive route must pass both response and cloze-gap familiarity limits', () => {
  const old = bank.find((q) => q.task === 'words')!,
    fresh = bank.filter((q) => q.task === 'sentence').slice(0, 3)
  const history = { ...emptyTrend(), seen: [old.id] }
  assert.throws(
    () => assertSelection([stage([old, ...fresh])], history),
    MaterialShortage,
  )
  const seen = fresh[0]
  assert.doesNotThrow(() =>
    assertSelection([stage(fresh.slice(0, 2))], {
      ...emptyTrend(),
      seen: [seen.id],
    }),
  )
  const adaptive = [{ ...stage(fresh.slice(1)), upper: [seen] }]
  assert.throws(
    () => assertSelection(adaptive, { ...emptyTrend(), seen: [seen.id] }),
    MaterialShortage,
  )
  assert.equal(routes(buildStages('full', '', 1)).length, 4)
})

test('full mocks, sections and drills refuse exhausted banks; eligible errors may recur with fresh material', () => {
  const history = { ...emptyTrend(), seen: bank.map((q) => q.id) }
  for (const [mode, focus] of [
    ['full', ''],
    ['section', 'Reading'],
    ['drill', 'words'],
  ] as const)
    assert.throws(() => buildStages(mode, focus, 23, history), MaterialShortage)
  const sets = materialSets(bank.filter((q) => q.task === 'passage'))
  const lastUsed = Object.fromEntries(
    sets
      .slice(1)
      .flatMap((set, i) =>
        set.flatMap((q) => materialKeys(q).map((k) => [k, i + 1])),
      ),
  )
  const selected = buildStages(
    'drill',
    'passage',
    23,
    { ...emptyTrend(), lastUsed },
    [],
    'standard',
  )[0].items
  assert.deepEqual(
    new Set(selected.map((q) => q.group)),
    new Set([sets[0][0].group, sets[1][0].group]),
  )
})

test('indexed history protects identical content with a new ID and preserves snapshots atomically', () => {
  const q = bank.find((q) => q.task === 'discussion')!,
    a = attempt([q], 1)
  store.save(a)
  const renamed = { ...q, id: 'new-id', group: 'new-group' }
  const memory = { ...emptyTrend(), ...store.selectionMemory([renamed]) }
  assert.equal(coolingDown(renamed, memory), true)
  assert.equal(familiar(renamed, memory), true)
  assert.equal(store.responseHistory('Writing', 'discussion').length, 1)
  store.save(a)
  assert.equal(store.responseHistory('Writing', 'discussion').length, 1)
  const fail = attempt([q], 0, a.ended! + 1)
  store.save(fail)
  assert.equal(
    coolingDown(q, { ...emptyTrend(), ...store.selectionMemory([q]) }),
    true,
  )
  const rollback = attempt([q], 0)
  assert.throws(() =>
    store.transaction(() => {
      store.save(rollback)
      throw Error('rollback')
    }),
  )
  assert.throws(() => store.load(rollback.id), /not found/)
  assert.equal(store.responseHistory('Writing', 'discussion').length, 2)
  assert.deepEqual(store.load(a.id).answers, a.answers)
})

test('stale previews cannot bypass a new maximum score; eligible retries include fresh practice', () => {
  const preview = practicePlan('sentence', 'short')
  // Completing every sentence invalidates any frozen preview regardless of its seed.
  store.save(
    attempt(
      bank.filter((q) => q.task === 'sentence'),
      1,
    ),
  )
  assert.throws(() => consumePlan(preview.planId, 'sentence'), MaterialShortage)
  const q = bank.find((q) => q.task === 'email')!,
    failed = attempt([q], 0)
  store.save(failed)
  const result = selectSession(
    { mode: 'drill', focus: 'email', retry: { id: failed.id, item: q.id } },
    42,
  )
  assert.equal(result.stages[0].items.length, 2)
  assert.equal(result.stages[0].items[0].id, q.id)
  assert.notEqual(result.stages[0].items[1].id, q.id)
  const success = attempt([q], 1)
  store.save(success)
  assert.throws(
    () =>
      selectSession(
        { mode: 'drill', focus: 'email', retry: { id: failed.id, item: q.id } },
        42,
      ),
    /mastered/,
  )
})

test('on-demand preparation exceeds background budget, pauses for exams/chat, survives restart and consumes once', async () => {
  setProvider('openai', 'selected-astra-fixture', 'fixture-only-key')
  setBankEnabled(false)
  store.save(
    attempt(
      bank.filter((q) => q.task === 'email'),
      1,
    ),
  )
  for (let i = 0; i < 4; i++) store.spendBank('batch')
  for (let i = 0; i < 8; i++) store.spendBank('request')
  const request = {
    mode: 'drill' as const,
    focus: 'email',
    length: 'standard' as const,
  }
  const p = prep.prepareSession(request)
  assert.equal(p.state, 'preparing')
  assert.equal(prep.prepareSession(request).id, p.id)
  let calls = 0
  const writer: typeof import('../server/author.ts').author = async (
    slots,
    personal,
    _previous,
    _brief,
    control,
  ) => {
    calls++
    control!.checkpoint(true)
    control!.checkpoint(true)
    return slots.map((q) => ({
      ...q,
      id: randomUUID(),
      prompt: randomUUID(),
      passage: randomUUID(),
      personal,
    }))
  }
  const count = store.history().length
  examActivity()
  await prep.continuePreparation(writer)
  assert.equal(calls, 0)
  examActivity(false)
  await foregroundWork(() => prep.continuePreparation(writer))
  assert.equal(calls, 0)
  await Promise.all([
    prep.continuePreparation(writer),
    prep.continuePreparation(writer),
  ])
  assert.equal(calls, 2)
  assert.equal(store.history().length, count) // preparation never starts a timed attempt
  assert.equal(prep.preparationStatus(p.id).state, 'ready')
  assert.deepEqual(store.bankUsage(), { batches: 4, requests: 8 })
  assert.deepEqual(store.bankUsage(Date.now(), true), {
    batches: 2,
    requests: 4,
  })
  const { spawnSync } = await import('node:child_process')
  const reopened = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const p=await import("./server/preparation.ts"); console.log(JSON.stringify(p.currentPreparation()))',
    ],
    { env: process.env, encoding: 'utf8', windowsHide: true },
  )
  assert.equal(reopened.status, 0, reopened.stderr)
  assert.equal(JSON.parse(reopened.stdout).id, p.id)
  const frozen = prep.readyPreparation(p.id)
  const saved = attempt(
    frozen.stages.flatMap((s) => s.items),
    0,
  )
  prep.completePreparation(p.id, () => store.save(saved))
  assert.equal(prep.preparationStatus(p.id).state, 'consumed')
  assert.throws(
    () => prep.completePreparation(p.id, () => store.save(saved)),
    /not ready/,
  )
})

test('preparation cancels at request boundaries and failures do not retry or charge in a loop', async () => {
  const master = () =>
    store.save(
      attempt(
        [...bank, ...store.extras()].filter((q) => q.task === 'email'),
        1,
      ),
    )
  master()
  const p = prep.prepareSession({
    mode: 'drill',
    focus: 'email',
    length: 'short',
  })
  let calls = 0
  await prep.continuePreparation(
    async (_slots, _personal, _previous, _brief, control) => {
      calls++
      control!.checkpoint(true)
      prep.cancelPreparation(p.id)
      control!.checkpoint(true)
      throw Error('unreachable')
    },
  )
  assert.equal(prep.preparationStatus(p.id).state, 'cancelled')
  const before = store.bankUsage(Date.now(), true).requests
  const retry = prep.prepareSession({
    mode: 'drill',
    focus: 'email',
    length: 'short',
  })
  await prep.continuePreparation(
    async (_slots, _personal, _previous, _brief, control) => {
      calls++
      control!.checkpoint(true)
      throw Error('Network fixture unavailable')
    },
  )
  assert.equal(prep.preparationStatus(retry.id).state, 'failed')
  await prep.continuePreparation()
  assert.equal(calls, 2)
  assert.equal(store.bankUsage(Date.now(), true).requests, before + 1)
})

test('quality rejection repairs twice, stops at three, and explicit retry preserves completed sets', async () => {
  store.save(
    attempt(
      [...bank, ...store.extras()].filter((q) => q.task === 'email'),
      1,
    ),
  )
  const p = prep.prepareSession({
    mode: 'drill',
    focus: 'email',
    length: 'standard',
  })
  let calls = 0
  const writer: typeof import('../server/author.ts').author = async (
    slots,
    personal,
    _previous,
    _brief,
    control,
  ) => {
    control!.checkpoint(true)
    calls++
    if (calls > 1 && calls < 5)
      throw new QualityError('audit-content', [
        'Two plausible replies need disambiguation.',
      ])
    return slots.map((q) => ({
      ...q,
      id: randomUUID(),
      prompt: randomUUID(),
      passage: randomUUID(),
      personal,
    }))
  }
  const before = store.extras().length
  await prep.continuePreparation(writer)
  assert.equal(calls, 4) // one accepted set, three rejected attempts
  const failed = prep.preparationStatus(p.id)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.checkedSets, 1)
  assert.match(failed.detail!, /Two plausible replies/)
  assert.equal(prep.currentPreparation()!.id, p.id)
  assert.equal(store.extras().length, before + 1)
  await prep.continuePreparation(writer)
  assert.equal(calls, 4)
  prep.retryPreparation(p.id)
  await prep.continuePreparation(writer)
  const ready = prep.preparationStatus(p.id)
  assert.equal(calls, 5)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.checkedSets, 2)
  assert.equal(store.extras().length, before + 2)
})
