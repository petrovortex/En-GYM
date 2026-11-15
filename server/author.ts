import { createHash, randomInt, randomUUID } from 'node:crypto'
import { bank, learnerTrend, normalize } from '../core/exam.ts'
import { catalog, type Item, type Task } from '../core/types.ts'
import { extras, addItem, recent, cache } from './store.ts'
import { complete, modelFor } from './provider.ts'
import {
  taskSpecs,
  TASK_SPEC_VERSION,
  AUDIT_SPEC_VERSION,
  reviewContract,
  generationPrompt,
  auditPrompt,
  createCloze,
  validateTaskSet,
  validateAudit,
} from '../core/task-specs.ts'
import { synth } from './speech.ts'
import { QualityError, type QualityStage } from '../core/quality.ts'

export function json(text: string) {
  return JSON.parse(
    text
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/, '')
      .replace(/\x60\x60\x60$/, ''),
  )
}
export const fingerprint = (q: Item) =>
  createHash('sha256')
    .update(
      normalize([q.task, q.prompt, q.speech ?? '', q.passage ?? ''].join('|')),
    )
    .digest('hex')
function stimulus(q: Item) {
  return q.speech || q.passage || q.prompt
}
function grams(text: string) {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []
  return new Set(words.slice(2).map((_, i) => words.slice(i, i + 3).join(' ')))
}
function overlaps(a: string, b: string) {
  if (normalize(a) === normalize(b)) return true
  const left = grams(a),
    right = grams(b)
  return (
    Math.min(left.size, right.size) >= 8 &&
    [...left].filter((s) => right.has(s)).length /
      Math.min(left.size, right.size) >
      0.52
  )
}
const groupedQuestions = new Set<Task>([
  'daily',
  'passage',
  'conversation',
  'announcement',
  'talk',
])
function item(
  raw: Record<string, unknown>,
  slot: Item,
  personal: boolean,
): Item {
  if (
    !raw ||
    typeof raw.title !== 'string' ||
    typeof raw.prompt !== 'string' ||
    !raw.prompt.trim()
  )
    throw Error('Generated item lacks a prompt.')
  const q: Item = {
    id: 'gen-' + randomUUID(),
    task: slot.task,
    level: slot.level,
    title: raw.title,
    prompt: raw.prompt,
    personal,
  }
  for (const field of ['passage', 'speech', 'evidence'] as const)
    if (slot[field]) {
      const v = raw[field]
      if (typeof v !== 'string' || !v.trim() || v.length > 7000)
        throw Error('Invalid ' + field + '.')
      q[field] = v.trim()
    }
  for (const field of ['keys', 'chunks', 'options'] as const)
    if (slot[field]) {
      const v = raw[field]
      if (
        !Array.isArray(v) ||
        !v.every((s) => typeof s === 'string' && s.trim()) ||
        (field === 'chunks'
          ? v.length < 3 || v.length > 12
          : v.length !== slot[field]!.length)
      )
        throw Error('Invalid ' + field + ' in generated item.')
      q[field] = v.map((s) => s.trim())
    }
  if (
    q.options &&
    (!q.options.includes(q.keys![0]) ||
      new Set(q.options.map(normalize)).size !== q.options.length)
  )
    throw Error('Ambiguous answer key.')
  if (
    q.chunks &&
    (q.chunks.join(' ') !== q.keys![0] ||
      new Set(q.chunks).size !== q.chunks.length)
  )
    throw Error('Sentence pieces disagree with the key or repeat.')
  if (
    q.task === 'words' &&
    (q.passage!.match(/\{\d+\}/g)?.length !== 10 ||
      q.keys!.some(
        (key, i) =>
          !/^\p{L}+$/u.test(key) ||
          q.passage!.split('{' + i + '}').length !== 2,
      ))
  )
    throw Error('Invalid cloze passage or keys.')
  return q
}
export interface AuthorProgress {
  raw?: unknown
  items?: Item[]
  audited?: boolean
  source?: string
  reviewSource?: string
  reviewVersion?: string
  version?: string
  audit?: unknown
  feedback?: { stage: QualityStage; issues: string[] }
  phase?: 'authoring' | 'reviewing' | 'audio'
  timings?: Partial<Record<'authoring' | 'reviewing' | 'audio', number>>
  inputChars?: Partial<Record<'authoring' | 'reviewing', number>>
}
export interface AuthorControl {
  progress: AuthorProgress
  persist: () => void
  checkpoint: (request: boolean) => void
}
export async function author(
  slots: Item[],
  personal: boolean,
  previous: Item[],
  brief: string,
  control?: AuthorControl,
): Promise<Item[]> {
  const state = control ?? {
    progress: {},
    persist: () => {},
    checkpoint: () => {},
  }
  try {
    return await authorPass(slots, personal, previous, brief, state)
  } catch (error) {
    if (error instanceof QualityError) {
      state.progress.feedback = { stage: error.stage, issues: error.issues }
      state.persist()
    }
    throw error
  }
}
function validateDraft<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof QualityError) throw error
    throw new QualityError('draft', [(error as Error).message])
  }
}
async function authorPass(
  slots: Item[],
  personal: boolean,
  previous: Item[],
  brief: string,
  control: AuthorControl,
): Promise<Item[]> {
  const task = slots[0].task,
    group = slots[0].group ? 'set-' + randomUUID() : undefined
  const example = slots[0]
  const shape = Object.keys(example).filter((k) =>
    [
      'title',
      'prompt',
      'passage',
      'speech',
      'keys',
      'chunks',
      'options',
      'evidence',
    ].includes(k),
  )
  const shared = !!group && groupedQuestions.has(task)
  const different = previous.filter((q) => q.task === task)
  const input = {
    task: catalog[task][1],
    count: slots.length,
    levels: slots.map((q) => q.level),
    fields:
      task === 'words' ? shape.filter((field) => field !== 'keys') : shape,
    format: taskSpecs[task].instructions,
    brief,
    sharedStimulus: shared,
    outputShape: shared
      ? '{stimulus:string,items:[{title,prompt,options,keys,evidence}]} — shared text once in stimulus; omit speech/passage from items'
      : 'JSON array of items',
    functions:
      task === 'reply'
        ? [
            'request information',
            'suggest a next step',
            'clarify a reference',
            'respond to a polite request',
            'interpret an indirect remark',
          ].slice(0, slots.length)
        : undefined,
    avoidTopics: [...new Set(different.map((q) => q.title))].slice(-60),
    avoidStems: [...new Set(different.map((q) => q.prompt))].slice(-25),
  }
  const progress = control?.progress ?? {}
  const selected = modelFor('generation'),
    source = selected.provider + ':' + selected.model
  const reviewer = modelFor('review'),
    reviewSource = reviewer.provider + ':' + reviewer.model
  if (
    progress.raw &&
    (progress.source !== source || progress.version !== TASK_SPEC_VERSION)
  ) {
    delete progress.raw
    delete progress.items
    delete progress.audited
    delete progress.audit
    delete progress.feedback
  }
  progress.source = source
  progress.version = TASK_SPEC_VERSION
  if (
    progress.reviewSource !== reviewSource ||
    progress.reviewVersion !== AUDIT_SPEC_VERSION
  ) {
    delete progress.audit
    delete progress.audited
    if (progress.feedback?.stage.startsWith('audit')) delete progress.feedback
  }
  progress.reviewSource = reviewSource
  progress.reviewVersion = AUDIT_SPEC_VERSION
  const checkpoint = (request: boolean) => {
    const current = modelFor('generation'),
      currentReview = modelFor('review')
    if (
      current.provider + ':' + current.model !== source ||
      currentReview.provider + ':' + currentReview.model !== reviewSource
    )
      throw Error(
        'The selected AI models changed. Preparation will resume with the new choices; unchanged generation work is kept.',
      )
    control?.checkpoint(request)
  }
  const reviseDraft =
    progress.feedback && progress.feedback.stage !== 'audit-format'
  if (!progress.raw || reviseDraft) {
    checkpoint(true)
    progress.phase = 'authoring'
    control.persist()
    const inputText = JSON.stringify({
      ...input,
      revision: reviseDraft
        ? { previous: progress.raw, issues: progress.feedback!.issues }
        : undefined,
    })
    progress.inputChars = {
      ...progress.inputChars,
      authoring: inputText.length,
    }
    const started = Date.now()
    const written = await complete(
      generationPrompt +
        ' Follow outputShape: shared sets use one stimulus plus an items array; otherwise return an array. Strings for text fields, string arrays for keys/chunks/options. Multiple choice has four options and one exact key. If revision is provided, correct the specific defects and return the entire set; do not merely change a key while leaving ambiguity.',
      inputText,
      300000,
      'generation',
    )
    progress.timings = { ...progress.timings, authoring: Date.now() - started }
    progress.raw = validateDraft(() => json(written))
    delete progress.items
    delete progress.audited
    delete progress.audit
    delete progress.feedback
    control?.persist()
  }
  const result = validateDraft(() => {
    const raw = progress.raw as any
    const expanded =
      shared &&
      raw &&
      !Array.isArray(raw) &&
      Array.isArray(raw.items) &&
      typeof raw.stimulus === 'string'
        ? raw.items.map((obj: any) => ({
            ...obj,
            [taskSpecs[task].context]: raw.stimulus,
          }))
        : raw
    const objects = Array.isArray(expanded) ? expanded : [expanded]
    if (objects.length !== slots.length)
      throw Error('Incorrect number of items returned.')
    const result =
      progress.items ??
      objects.map((obj, i) => ({
        ...item(
          task === 'words'
            ? { ...obj, ...createCloze(String(obj.passage ?? '')) }
            : obj,
          slots[i],
          personal,
        ),
        group,
      }))
    validateTaskSet(result)
    for (const [i, q] of result.entries()) {
      if (shared && stimulus(q) !== stimulus(result[0]))
        throw Error('Questions in a set must share one stimulus.')
      if (
        [...bank, ...extras(), ...previous].some(
          (p) =>
            p.task === task &&
            (fingerprint(q) === fingerprint(p) ||
              overlaps(stimulus(q), stimulus(p))),
        )
      )
        throw Error('Duplicate or near-duplicate exercise rejected.')
      if (
        result
          .slice(0, i)
          .some((p) =>
            shared
              ? normalize(p.prompt) === normalize(q.prompt)
              : overlaps(stimulus(p), stimulus(q)),
          )
      )
        throw Error('Repeated material inside a generated set.')
    }
    return result
  })
  progress.items = result
  control?.persist()
  if (!progress.audited) {
    checkpoint(true)
    progress.phase = 'reviewing'
    control.persist()
    const contexts: Record<string, string> = {},
      knownContexts = new Map<string, string>()
    const auditInput = JSON.stringify({
      contract: reviewContract(task),
      auditCorrections:
        progress.feedback?.stage === 'audit-format'
          ? progress.feedback.issues
          : undefined,
      items: result.map(({ keys, evidence, quality, ...q }, index) => {
        // The author returns chunks in answer order. Hide that order from the independent solver.
        const chunks = q.chunks?.slice()
        if (chunks)
          for (let i = chunks.length - 1; i > 0; i--) {
            const j = randomInt(i + 1)
            ;[chunks[i], chunks[j]] = [chunks[j], chunks[i]]
          }
        const stimulus = q.passage || q.speech
        let contextId: string | undefined
        if (stimulus) {
          contextId = knownContexts.get(stimulus) ?? 'c' + knownContexts.size
          knownContexts.set(stimulus, contextId)
          contexts[contextId] = stimulus
        }
        return {
          task: q.task,
          level: q.level,
          title: q.title,
          prompt: q.prompt,
          options: q.options,
          contextId,
          chunks,
          index,
          gapLengths:
            task === 'words' ? keys?.map((key) => key.length) : undefined,
        }
      }),
      contexts,
      avoidTopics: input.avoidTopics,
      avoidStems: input.avoidStems,
    })
    progress.inputChars = {
      ...progress.inputChars,
      reviewing: auditInput.length,
    }
    const reviewedAt = Date.now()
    const audit = await complete(auditPrompt, auditInput, 300000, 'review')
    progress.timings = {
      ...progress.timings,
      reviewing: Date.now() - reviewedAt,
    }
    let checked: unknown
    progress.audit = audit.slice(0, 60000)
    control.persist()
    try {
      checked = json(audit)
    } catch {
      throw new QualityError('audit-format', [
        'The independent audit must return a valid JSON object with structured evidence.',
      ])
    }
    progress.audit = checked
    control.persist()
    validateAudit(result, checked)
    for (const q of result)
      q.quality = {
        version: AUDIT_SPEC_VERSION,
        provider: reviewer.provider,
        model: reviewer.model,
        author: { provider: selected.provider, model: selected.model },
        checkedAt: Date.now(),
      }
    progress.audited = true
    delete progress.feedback
    control?.persist()
  }
  progress.phase = 'audio'
  control.persist()
  const audioAt = Date.now()
  for (const q of result)
    if (q.speech) {
      checkpoint(false)
      await synth(q, cache, () => checkpoint(false))
    }
  progress.timings = { ...progress.timings, audio: Date.now() - audioAt }
  checkpoint(false)
  return result
}
export async function generate(
  task: Task,
  personal: boolean,
  brief = '',
  fixedId?: string,
) {
  if (!catalog[task]) throw Error('Unknown task.')
  const existing = fixedId && extras().find((q) => q.id === fixedId)
  if (existing) return { title: existing.title, id: existing.id }
  const templates = bank.filter((q) => q.task === task)
  const slot = {
    ...templates[randomInt(templates.length)],
    group: undefined,
    level: personal ? learnerTrend(recent(), task).level : 2,
  }
  const [q] = await author(
    [slot],
    personal,
    extras(),
    brief ||
      'Build a fresh exercise using a different context from the existing bank.',
  )
  if (fixedId) q.id = fixedId
  addItem(q, fingerprint(q))
  return { title: q.title, id: q.id }
}
