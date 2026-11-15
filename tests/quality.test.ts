import assert from 'node:assert/strict'
import test from 'node:test'
import { bank } from '../core/exam.ts'
import {
  createCloze,
  validateAudit,
  validateTaskSet,
} from '../core/task-specs.ts'
import type { Item } from '../core/types.ts'
import { QualityError } from '../core/quality.ts'

const paragraph =
  'Urban gardens provide more than fresh vegetables. Their roots absorb heavy rainfall while their leaves offer welcome shade during the hottest summer months. Local residents often share tools and exchange practical advice about growing healthy plants in limited spaces. These small green areas can also support insects that carry pollen between flowers. Researchers therefore study gardens as connected parts of city environments rather than isolated patches of soil. Careful planning helps communities maintain these benefits throughout the changing seasons.'
test('review errors distinguish formatting from ambiguity and keep concrete explanations', () => {
  const q = {
    ...bank.find((q) => q.task === 'reply')!,
    speech: "It's ready for collection.",
    options: [
      'Thanks, I will collect it.',
      'At noon yesterday.',
      'It belongs to my sister.',
      'The train is late.',
    ],
    keys: ['Thanks, I will collect it.'],
  }
  const audit = {
    checks: {
      format: true,
      relevance: true,
      naturalEnglish: true,
      difficulty: true,
      diversity: true,
    },
    issues: [],
    answers: [
      {
        index: 0,
        valid: true,
        unique: true,
        solutions: q.keys,
        support: '“It’s ready for collection.”',
        rationale:
          'The speaker announces availability, so acknowledging collection is appropriate.',
        distractors: q.options.slice(1).map((option) => ({
          option,
          reason:
            'This answer does not respond to the availability announcement.',
        })),
      },
    ],
  }
  assert.doesNotThrow(() => validateAudit([q], audit))
  audit.answers[0].support = 'An invented sentence absent from the recording.'
  assert.throws(
    () => validateAudit([q], audit),
    (e: unknown) =>
      e instanceof QualityError &&
      e.stage === 'audit-format' &&
      /Question 1.*actual phrase/.test(e.message),
  )
  audit.answers[0].unique = false
  assert.throws(
    () => validateAudit([q], audit),
    (e: unknown) =>
      e instanceof QualityError &&
      e.stage === 'audit-content' &&
      /more than one answer/.test(e.message),
  )
  const failed = {
    ...audit,
    checks: { ...audit.checks, relevance: false },
    issues: [
      'Both accepting and refusing the request are legitimate responses.',
    ],
  }
  assert.throws(() => validateAudit([q], failed), /Both accepting and refusing/)
  const contradictory = {
    ...audit,
    answers: [{ ...audit.answers[0], unique: true }],
    issues: ['Broader conversational functions could improve coverage.'],
  }
  assert.throws(
    () => validateAudit([q], contradictory),
    (e: unknown) =>
      e instanceof QualityError &&
      e.stage === 'audit-format' &&
      /contradiction/.test(e.message),
  )
  const editorial = {
    ...audit,
    issues: [],
    suggestions: ['Broader topics would be useful in later sets.'],
    answers: [
      {
        ...audit.answers[0],
        unique: true,
        support: "It's ready for collection.",
      },
    ],
  }
  assert.doesNotThrow(() => validateAudit([q], editorial))
})
test('cloze construction preserves the complete text and masks ten alternating half-words after the opening sentence', () => {
  const result = createCloze(paragraph)
  assert.equal(result.keys.length, 10)
  assert.equal(
    result.passage.replace(/\{(\d+)\}/g, (_, i) => result.keys[Number(i)]),
    paragraph,
  )
  assert.equal(result.passage.split('.')[0], paragraph.split('.')[0])
  assert.match(result.passage, /Their ro\{0\} absorb he\{1\} rainfall wh\{2\}/)
  assert.deepEqual(result.keys.slice(0, 3), ['ots', 'avy', 'ile'])
  assert.throws(() => createCloze('A short paragraph.'), /70–100/)
})

test('independent solution must agree with keys and justify every distractor', () => {
  const q: Item = {
    ...bank.find((q) => q.task === 'daily')!,
    passage: 'The library closes at six today.',
    options: ['Six', 'Seven', 'Eight', 'Nine'],
    keys: ['Six'],
  }
  const audit = () => ({
    checks: {
      format: true,
      relevance: true,
      naturalEnglish: true,
      difficulty: true,
      diversity: true,
    },
    issues: [],
    answers: [
      {
        index: 0,
        valid: true,
        unique: true,
        solutions: ['Six'],
        support: 'closes at six',
        rationale: 'The stated closing time directly supports this answer.',
        distractors: q.options!.slice(1).map((option) => ({
          option,
          reason: 'This time is not the closing time in the notice.',
        })),
      },
    ],
  })
  assert.doesNotThrow(() => validateAudit([q], audit()))
  for (const change of [
    (a: ReturnType<typeof audit>) => (a.answers[0].solutions = ['Seven']),
    (a: ReturnType<typeof audit>) => (a.answers[0].unique = false),
    (a: ReturnType<typeof audit>) => (a.checks.relevance = false),
    (a: ReturnType<typeof audit>) =>
      (a.answers[0].support = 'unrelated invented quote'),
    (a: ReturnType<typeof audit>) => a.answers[0].distractors.pop(),
  ]) {
    const a = audit()
    change(a)
    assert.throws(() => validateAudit([q], a), /independent review/)
  }
  assert.throws(() => validateAudit([q], 'PASS'), /independent review/)
})

test('task contracts reject missing communicative goals, absent discussion participants and spoken labels', () => {
  const email = {
    ...bank.find((q) => q.task === 'email')!,
    prompt: 'Write an email to your professor about a missed seminar.',
    passage: '- Explain the absence.\n- Ask for notes.\n- Suggest a meeting.',
  }
  assert.doesNotThrow(() => validateTaskSet([email]))
  assert.throws(
    () => validateTaskSet([{ ...email, passage: 'Just write something.' }]),
    /three communicative goals/,
  )
  assert.throws(
    () =>
      validateTaskSet([
        { ...bank.find((q) => q.task === 'discussion')!, passage: paragraph },
      ]),
    /professor and two student/,
  )
  assert.throws(
    () =>
      validateTaskSet([
        {
          ...bank.find((q) => q.task === 'conversation')!,
          group: undefined,
          speech: 'Student: ' + paragraph,
        },
      ]),
    /speaker labels/,
  )
})
