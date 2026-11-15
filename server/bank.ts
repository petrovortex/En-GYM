import { randomUUID } from 'node:crypto'
import { bank, learnerTrend } from '../core/exam.ts'
import { catalog, type Item, type Task, type Stage } from '../core/types.ts'
import { practiceSets } from '../core/material.ts'
import { author, fingerprint, type AuthorProgress } from './author.ts'
import {
  extras,
  archivedGeneratedMaterial,
  addItem,
  setting,
  configure,
  jobs,
  jobById,
  completedBankJobs,
  saveJob,
  bankUsage,
  spendBank,
  transaction,
  load,
  save,
  recent,
} from './store.ts'
import { preparationModels, ProviderError } from './provider.ts'
import { AUDIT_SPEC_VERSION } from '../core/task-specs.ts'
import { backgroundAllowed, bankWorkAllowed } from './work.ts'
import { QualityError } from '../core/quality.ts'
import { gameRefillDue, replenishGames } from './games.ts'
import { inventoryStock } from './inventory.ts'
import {
  estimatePreparation,
  type PreparationSample,
} from '../core/preparation-progress.ts'

export const MAX_QUALITY_ATTEMPTS = 3

export interface BankJob {
  id: string
  task: Task
  personal: boolean
  attempt?: string
  brief: string
  state: 'queued' | 'working' | 'paused' | 'done'
  retryAfter: number
  error?: string
  slots: Item[]
  progress: AuthorProgress
  started?: boolean
  manualStarted?: boolean
  failureKind?: 'quality' | 'other'
  qualityFailures?: number
  priority?: number
  cycles?: number
  workMs?: number
  workSource?: string
  timingComplete?: boolean
  metrics?: {
    timings?: AuthorProgress['timings']
    inputChars?: AuthorProgress['inputChars']
    elapsedMs?: number
    source?: string
    units?: number
  }
}
let working = false
let activeJobId: string | undefined
class Paused extends Error {}
export function bankEnabled() {
  return setting('automatic-bank') !== 'off'
}
export function setBankEnabled(enabled: boolean) {
  configure('automatic-bank', enabled ? 'on' : 'off')
}
export function bankStatus() {
  const stock = inventoryStock(),
    needed = new Set(stock.filter((s) => s.deficit).map((s) => s.task))
  const pending = jobs<BankJob>(true).filter(
    (j) =>
      j.state !== 'done' &&
      (j.personal || needed.has(j.task) || j.progress.audited),
  )
  const blockedUntil = Number(setting('bank-backoff')) || 0
  const jobRetry = pending.some((j) => j.retryAfter <= Date.now())
    ? 0
    : Math.min(...pending.map((j) => j.retryAfter))
  const nextRetry = Math.max(
    blockedUntil,
    Number.isFinite(jobRetry) ? jobRetry : 0,
  )
  const selected = preparationModels()
  const active = working ? pending.find((j) => j.id === activeJobId) : undefined
  const waitReason = !bankEnabled()
    ? 'off'
    : !selected.configured
      ? 'connection'
      : !bankWorkAllowed()
        ? 'foreground'
        : !working && nextRetry > Date.now()
          ? 'retry'
          : undefined
  const samples: PreparationSample[] = completedBankJobs<BankJob>()
    .filter(
      (j) =>
        !j.personal &&
        j.metrics?.elapsedMs &&
        j.metrics.source &&
        j.metrics.units,
    )
    .map((j) => ({
      task: j.task,
      elapsedMs: j.metrics!.elapsedMs!,
      source: j.metrics!.source!,
      units: j.metrics!.units!,
    }))
  return {
    enabled: bankEnabled(),
    ...bankUsage(),
    onDemandRequests: bankUsage(Date.now(), true).requests,
    pending: pending.length,
    targetSessions: 3,
    stock,
    waitReason,
    estimate:
      !waitReason && !pending.some((j) => j.error)
        ? estimatePreparation(stock, samples, selected.source)
        : undefined,
    nextRetry: nextRetry > Date.now() ? nextRetry : undefined,
    activeTask: active?.task,
    phase: active?.progress.phase,
    state: !bankEnabled()
      ? 'Off'
      : !preparationModels().configured
        ? 'Connect AI to add fresh material'
        : !bankWorkAllowed()
          ? 'Waiting for grading or trainer conversation'
          : working
            ? 'Preparing fresh material'
            : pending.some(
                  (j) =>
                    j.failureKind === 'quality' &&
                    (j.qualityFailures ?? 0) >= MAX_QUALITY_ATTEMPTS,
                )
              ? 'Replacing a rejected set; retrying automatically'
              : Number(setting('bank-backoff')) > Date.now() ||
                  pending.some((j) => j.retryAfter > Date.now())
                ? 'Waiting to retry automatically'
                : pending.length
                  ? 'Queued'
                  : 'Bank ready',
    error: pending.find((j) => j.error)?.error,
  }
}
export function slotsFor(task: Task, personal: boolean) {
  const sets = practiceSets(bank, task)
  const size = sets[0].length
  const counts = bank
    .concat(extras())
    .filter((q) => q.task === task && !q.personal)
  const levels = [1, 2, 3].sort(
    (a, b) =>
      counts.filter((q) => q.level === a).length -
      counts.filter((q) => q.level === b).length,
  )
  const chosen = sets[Math.floor(Math.random() * sets.length)]
  return (
    size > 1
      ? chosen
      : task === 'reply' || task === 'sentence'
        ? sets.slice(0, 5).flat()
        : chosen
  ).map((q) => ({
    ...q,
    personal,
    level:
      task === 'repeat' || task === 'interview'
        ? q.level
        : personal
          ? learnerTrend(recent(), task).level
          : levels[0],
  }))
}
export function queueMaterial(task: Task) {
  const pending = jobs<BankJob>(true).find(
    (j) => j.task === task && !j.personal && j.state !== 'done',
  )
  if (pending) return pending.id
  const job: BankJob = {
    id: randomUUID(),
    task,
    personal: false,
    brief:
      'Create fresh original material with a different topic, purpose and reasoning from the existing bank. This is neutral exam material; do not tailor it to learner scores.',
    state: 'queued',
    retryAfter: 0,
    slots: slotsFor(task, false),
    progress: {},
  }
  saveJob(job)
  return job.id
}
export function resetQualityRetries(task?: string) {
  for (const job of jobs<BankJob>(true))
    if (
      !job.personal &&
      job.task === task &&
      job.state === 'paused' &&
      job.failureKind === 'quality'
    ) {
      job.qualityFailures = 0
      job.retryAfter = 0
      saveJob(job)
    }
}
export function enqueuePersonal(attempt: string, task: Task, brief: string) {
  const id = 'personal-' + attempt
  if (jobById(id)) return
  saveJob({
    id,
    task,
    personal: true,
    attempt,
    brief,
    state: 'queued',
    retryAfter: 0,
    slots: slotsFor(task, true),
    progress: {},
  } as BankJob)
}
export function replenish(now = Date.now()) {
  if (!bankEnabled() || !preparationModels().configured) return
  const source = preparationModels().source
  const oldSource = setting('bank-source')
  if (oldSource && oldSource !== source) {
    configure('bank-backoff', '0')
    configure('bank-provider-failures', '0')
    for (const job of jobs<BankJob>(true))
      if (job.failureKind === 'other') {
        job.retryAfter = 0
        saveJob(job)
      }
  }
  if (
    setting('reserve-policy') !== '3' ||
    setting('bank-source') !== source ||
    setting('bank-audit-version') !== AUDIT_SPEC_VERSION
  ) {
    for (const job of jobs<BankJob>(true).filter((j) => j.state !== 'done')) {
      if (job.failureKind === 'quality') {
        job.qualityFailures = 0
        job.retryAfter = 0
        if (job.progress.audit)
          job.progress.feedback = {
            stage: 'audit-format',
            issues: [
              'Recheck the saved draft using the current review contract. Author-only fields are intentionally withheld; masked cloze text is intentional. Validate each quoted evidence fragment separately.',
            ],
          }
        saveJob(job)
      }
    }
    configure('reserve-policy', '3')
    configure('bank-source', source)
    configure('bank-audit-version', AUDIT_SPEC_VERSION)
  }
  for (const stock of inventoryStock()) {
    if (!stock.deficit) continue
    const id = queueMaterial(stock.task)
    const job = jobById<BankJob>(id)!
    const priority =
      (stock.fresh < stock.perSession ? 1000 : 0) +
      (1 - stock.fresh / stock.target) * 100
    if (job.priority !== priority) {
      job.priority = priority
      saveJob(job)
    }
  }
}
export async function runGameBank(now = Date.now()) {
  if (working || !preparationModels().configured || Number(setting('bank-backoff')) > now || !gameRefillDue(now)) return
  working = true
  try {
    await replenishGames()
  } finally {
    working = false
  }
}
export async function runBank(
  write: typeof author = author,
  now = Date.now(),
  manual?: { id: string; active: () => boolean },
) {
  if (
    working ||
    (!manual && !bankEnabled()) ||
    !preparationModels().configured ||
    !(manual ? backgroundAllowed() : bankWorkAllowed())
  )
    return
  if (!manual && Number(setting('bank-backoff')) > now) return
  const deficits = new Set(
    inventoryStock()
      .filter((s) => s.deficit)
      .map((s) => s.task),
  )
  const job = jobs<BankJob>(true)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .find(
      (j) =>
        j.state !== 'done' &&
        (manual
          ? j.id === manual.id
          : j.retryAfter <= now &&
            (j.personal || deficits.has(j.task) || j.progress.audited)),
    )
  if (!job) return
  if (!manual && (job.qualityFailures ?? 0) >= MAX_QUALITY_ATTEMPTS) {
    // Retire only the rejected draft, and try a genuinely new context after a cooling-off interval.
    job.progress = {}
    job.qualityFailures = 0
    job.started = false
  }
  working = true
  activeJobId = job.id
  let measuredAt = Date.now()
  const selected = preparationModels()
  const workSource = selected.source
  if (job.workSource !== workSource) {
    job.workMs = 0
    // Old, partially prepared drafts have no complete timing history.
    job.timingComplete =
      !job.progress.raw ||
      job.progress.source !==
        selected.generation.provider + ':' + selected.generation.model
  }
  const recordWork = () => {
    const time = Date.now()
    job.workMs = (job.workMs ?? 0) + Math.max(0, time - measuredAt)
    measuredAt = time
  }
  job.workSource = workSource
  job.state = 'working'
  job.error = undefined
  if (manual ? !job.manualStarted : !job.started) {
    spendBank(manual ? 'manual-batch' : 'batch', now)
    if (manual) job.manualStarted = true
    else job.started = true
  }
  saveJob(job)
  try {
    const result = await write(
      job.slots,
      job.personal,
      bank.concat(extras()),
      job.brief,
      {
        progress: job.progress,
        persist: () => {
          recordWork()
          saveJob(job)
        },
        checkpoint: (request) => {
          if (
            (!manual && !bankEnabled()) ||
            !(manual ? backgroundAllowed() : bankWorkAllowed()) ||
            (manual && !manual.active())
          )
            throw new Paused('Waiting until practice and AI work finish.')
          if (request) {
            spendBank(manual ? 'manual-request' : 'request')
          }
        },
      },
    )
    if (manual && !manual.active())
      throw new Paused('Session preparation cancelled.')
    recordWork()
    transaction(() => {
      for (const q of result) addItem(q, fingerprint(q))
      const completed: BankJob = {
        ...job,
        state: 'done',
        progress: {},
        slots: [],
        failureKind: undefined,
        metrics: {
          timings: job.progress.timings,
          inputChars: job.progress.inputChars,
          elapsedMs: job.timingComplete ? job.workMs : undefined,
          source: workSource,
          units:
            job.task === 'reply' || job.task === 'sentence' ? result.length : 1,
        },
      }
      saveJob(completed)
      if (job.attempt) {
        const a = load(job.attempt)
        a.followUp = {
          reason: 'Targeted practice is ready.',
          task: job.task,
          item: result[0].id,
        }
        save(a)
      }
    })
    configure('bank-provider-failures', '0')
    configure('bank-backoff', '0')
  } catch (error) {
    recordWork()
    job.state = 'paused'
    job.error = (error as Error).message
    if (error instanceof QualityError) {
      job.failureKind = 'quality'
      job.qualityFailures = (job.qualityFailures ?? 0) + 1
      if (job.qualityFailures >= MAX_QUALITY_ATTEMPTS)
        job.cycles = (job.cycles ?? 0) + 1
      job.retryAfter =
        Date.now() +
        (job.qualityFailures >= MAX_QUALITY_ATTEMPTS
          ? Math.min(3600000, 600000 * 2 ** Math.min(3, (job.cycles ?? 1) - 1))
          : 1000)
      // Keep only the latest draft/audit and its concrete feedback, never an archive of revisions.
      job.progress.feedback = { stage: error.stage, issues: error.issues }
      if (error.stage !== 'audit-format') {
        job.started = false
        job.manualStarted = false
      }
    } else if (
      !(error instanceof Paused) &&
      job.progress.audited &&
      job.progress.phase === 'audio'
    ) {
      // Local speech trouble must not stop generation of Reading/Writing material.
      job.failureKind = 'other'
      job.retryAfter = Date.now() + 60000
    } else if (!(error instanceof Paused)) {
      job.failureKind = 'other'
      const failures = Number(setting('bank-provider-failures') || 0) + 1
      const delay =
        error instanceof ProviderError && error.kind === 'quota'
          ? Math.min(3600000, 900000 * 2 ** Math.min(2, failures - 1))
          : Math.min(900000, 60000 * 2 ** Math.min(4, failures - 1))
      job.retryAfter = Math.max(
        Date.now() + delay,
        error instanceof ProviderError && Number.isFinite(error.retryAt)
          ? error.retryAt!
          : 0,
      )
      configure('bank-provider-failures', String(failures))
      configure('bank-backoff', String(job.retryAfter))
      // Preserve completed generation/auditing across transport or local-audio failures.
      if (!job.progress.audited) {
        job.started = false
        job.manualStarted = false
      }
    } else job.retryAfter = Date.now() + 15000
    saveJob(job)
  } finally {
    working = false
    activeJobId = undefined
  }
  return jobById<BankJob>(job.id)?.state
}
export function migratePreparedMaterial() {
  if (setting('prepared-bank-migrated')) return
  const raw = setting('prepared-mock-v1')
  const draft = raw
    ? (JSON.parse(raw) as { stages: Stage[]; done: number })
    : undefined
  // Generated IDs identify batches already validated by the old preparer; untouched slots retain starter IDs.
  const items = [
    ...(draft?.stages
      .flatMap((s) => [...s.items, ...(s.upper ?? [])])
      .filter((q) => q.id.startsWith('gen-')) ?? []),
    ...archivedGeneratedMaterial(),
  ]
  const known = new Set(extras().map(fingerprint))
  transaction(() => {
    for (const q of items)
      if (!known.has(fingerprint(q))) {
        addItem(q, fingerprint(q))
        known.add(fingerprint(q))
      }
    configure('prepared-bank-migrated', 'yes')
    configure('prepared-mock-v1', '')
  })
}
