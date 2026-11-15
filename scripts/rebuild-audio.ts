import { DatabaseSync } from 'node:sqlite'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { bank } from '../core/exam.ts'
import type { Item, Stage } from '../core/types.ts'
import {
  audioKey,
  synth,
  closeSpeech,
  promptAudioReady,
  inspectPromptAudio,
} from '../server/speech.ts'
import { PHONON_PACK } from '../server/phonon.ts'

// Maintenance only: the learner database is opened read-only; no providers or app store are imported.
const local = process.env.LOCALAPPDATA ?? homedir()
const legacy = join(local, 'Fieldwork Trainer'),
  current = join(local, 'TOEFL Trainer')
const home = resolve(
  process.env.FIELDWORK_DATA ??
    (existsSync(join(legacy, 'practice.sqlite')) &&
    !existsSync(join(current, 'practice.sqlite'))
      ? legacy
      : current),
)
const bundled = resolve(existsSync('prompts') ? 'prompts' : '.work/prompts'),
  personal = join(home, 'prompts')
const reportDir = resolve('.work/audio-rebuild')
for (const dir of [bundled, personal, reportDir])
  mkdirSync(dir, { recursive: true })
const items = new Map<string, { item: Item; folder: string }>()
function add(q: Item, folder: string) {
  if (typeof q.speech !== 'string' || !q.speech.trim()) return
  const key = audioKey(q)
  if (!items.has(key)) items.set(key, { item: q, folder })
}
for (const q of bank) add(q, bundled)
function stages(value: { stages?: Stage[] }) {
  for (const s of value.stages ?? [])
    for (const q of [...s.items, ...(s.upper ?? [])]) add(q, personal)
}
const dbPath = join(home, 'practice.sqlite')
const db = existsSync(dbPath)
  ? new DatabaseSync(dbPath, { readOnly: true })
  : undefined
function historyHash() {
  return createHash('sha256')
    .update(
      JSON.stringify(
        db?.prepare('SELECT id,snapshot FROM attempts ORDER BY id').all() ?? [],
      ),
    )
    .digest('hex')
}
const historyBefore = historyHash()
if (db) {
  for (const row of db.prepare('SELECT item FROM generated').all())
    add(JSON.parse(String(row.item)), personal)
  for (const row of db.prepare('SELECT snapshot FROM attempts').all())
    stages(JSON.parse(String(row.snapshot)))
  for (const row of db.prepare('SELECT snapshot FROM bank_jobs').all()) {
    const job = JSON.parse(String(row.snapshot))
    if (job.progress?.audited)
      for (const q of job.progress.items ?? []) add(q, personal)
  }
  const preparation = db
    .prepare("SELECT value FROM settings WHERE key='session-preparation-v1'")
    .get()
  if (preparation) stages(JSON.parse(String(preparation.value)))
}
const auditBefore = [bundled, personal].map((folder) => {
  let total = 0
  const invalid: { file: string; reason: string }[] = []
  for (const file of readdirSync(folder))
    if (/^[a-f0-9]{64}\.wav$/.test(file)) {
      total++
      try {
        inspectPromptAudio(readFileSync(join(folder, file)))
      } catch (error) {
        invalid.push({ file, reason: (error as Error).message })
      }
    }
  return { folder, total, invalid }
})
const list = [...items.entries()]
const report = {
  pack: PHONON_PACK,
  started: new Date().toISOString(),
  finished: '',
  total: list.length,
  completed: 0,
  generated: 0,
  reused: 0,
  pruned: 0,
  historyUnchanged: false,
  before: auditBefore,
  items: [] as {
    key: string
    task: string
    folder: string
    duration: number
    bytes: number
    elapsedMs: number
  }[],
  failures: [] as { key: string; task: string; message: string }[],
}
function saveReport() {
  const path = join(reportDir, 'progress.json')
  writeFileSync(path + '.tmp', JSON.stringify(report, null, 2))
  renameSync(path + '.tmp', path)
}
console.log(
  `Preparing ${list.length} unique prompts with Phonon. Database is read-only; speaking recordings are not touched.`,
)
saveReport()
try {
  for (const [key, { item, folder }] of list) {
    const path = join(folder, key + '.wav'),
      start = Date.now()
    const cached = !process.argv.includes('--force') && promptAudioReady(path)
    try {
      await synth(item, folder, undefined, {
        force: process.argv.includes('--force'),
      })
      const audio = inspectPromptAudio(readFileSync(path), item.speech)
      report.items.push({
        key,
        task: item.task,
        folder,
        duration: audio.duration,
        bytes: audio.bytes,
        elapsedMs: Date.now() - start,
      })
      report.completed++
      if (cached) report.reused++
      else report.generated++
      console.log(
        `[${report.completed}/${list.length}] ${item.task}: ${audio.duration.toFixed(1)}s audio, ${((Date.now() - start) / 1000).toFixed(1)}s preparation${cached ? ' (already Phonon)' : ''}`,
      )
    } catch (error) {
      report.failures.push({
        key,
        task: item.task,
        message: (error as Error).message,
      })
      console.error(`Failed ${item.task} ${key}: ${(error as Error).message}`)
    }
    saveReport()
  }
  if (!report.failures.length && process.argv.includes('--prune')) {
    // Only prompt caches, only hash-named WAVs, and only after every replacement has passed validation.
    for (const folder of [bundled, personal]) {
      if (realpathSync(folder) !== resolve(folder))
        throw Error('Refusing to prune a redirected prompt cache.')
      const keep = new Set(
        list
          .filter(([, value]) => value.folder === folder)
          .map(([key]) => key + '.wav'),
      )
      for (const file of readdirSync(folder))
        if (/^[a-f0-9]{64}\.wav$/.test(file) && !keep.has(file)) {
          unlinkSync(join(folder, file))
          report.pruned++
        }
    }
  }
  report.historyUnchanged = historyHash() === historyBefore
  report.finished = new Date().toISOString()
  saveReport()
  if (report.failures.length) {
    console.error(
      `${report.failures.length} prompts need attention. Completed audio is saved; rerun to resume.`,
    )
    process.exitCode = 1
  } else
    console.log(
      `Finished: ${report.completed} checked prompts. History unchanged: ${report.historyUnchanged}. Old prompt files removed: ${report.pruned}.`,
    )
} finally {
  closeSpeech()
  db?.close()
}
