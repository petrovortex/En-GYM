import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { resolve, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { wordsFromMock } from '../core/mock-words.ts'
import type { GameCard, Track } from '../core/games.ts'
import type {
  VocabularyWord,
  VocabularyText,
  WordSource,
} from '../core/vocabulary.ts'
import type { Attempt, HistoryRow, Item } from '../core/types.ts'
import { reconcileWriting } from '../core/exam.ts'
import { materialKeys } from '../core/material.ts'
const localAppData = process.env.LOCALAPPDATA ?? homedir()
const installed = process.env.EN_GYM_INSTALLED === '1'
if (installed && (!process.env.LOCALAPPDATA || !isAbsolute(localAppData)))
  throw Error('Windows local application data is unavailable.')
const oldHome = join(localAppData, 'Fieldwork Trainer')
const newHome = join(localAppData, 'TOEFL Trainer')
// The installed app starts with a separate profile. Source checkouts retain their existing data.
export const home = resolve(
  installed ? join(localAppData, 'En-GYM', 'user') : process.env.FIELDWORK_DATA ??
    (existsSync(join(oldHome, 'practice.sqlite')) &&
    !existsSync(join(newHome, 'practice.sqlite'))
      ? oldHome
      : newHome),
)
export const clips = join(home, 'recordings'),
  cache = join(home, 'prompts')
if (installed) {
  for (const path of [join(localAppData, 'En-GYM'), home, clips, cache,
    ...['practice.sqlite', 'practice.sqlite-wal', 'practice.sqlite-shm'].map((name) => join(home, name))])
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw Error('The installed profile must use regular local files and directories.')
}
for (const dir of [home, clips, cache]) mkdirSync(dir, { recursive: true })
const db = new DatabaseSync(join(home, 'practice.sqlite'))
export function verifyProfile() {
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
    throw Error('The profile database failed its integrity check.')
}
export function timedExamInProgress() {
  return !!db.prepare("SELECT 1 FROM attempts WHERE ended IS NULL AND json_extract(snapshot,'$.deadline') > ? LIMIT 1").get(Date.now())
}
let materialRevision = 0
export const inventoryRevision = () => materialRevision
let transactionDepth = 0
export function transaction(action: () => void) {
  if (transactionDepth) {
    action()
    return
  }
  db.exec('BEGIN IMMEDIATE')
  transactionDepth++
  try {
    action()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    transactionDepth--
  }
}
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000')
const version = Number(
  db.prepare('PRAGMA user_version').get()?.user_version,
)
if (version > 5)
  throw Error('This database needs a newer version of En-GYM.')
if (!version)
  db.exec(`BEGIN;
 CREATE TABLE attempts(id TEXT PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER, focus TEXT, mode TEXT, bands TEXT, snapshot TEXT NOT NULL);
 CREATE INDEX chronological ON attempts(started DESC);
 CREATE TABLE generated(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, item TEXT NOT NULL);
 CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 PRAGMA user_version=1; COMMIT;`)
if (version < 2)
  transaction(() => {
    db.exec(`CREATE TABLE exposure(key TEXT PRIMARY KEY, task TEXT NOT NULL, used INTEGER NOT NULL);
    CREATE TABLE bank_jobs(id TEXT PRIMARY KEY, state TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE bank_usage(time INTEGER NOT NULL, kind TEXT NOT NULL);
    CREATE INDEX bank_usage_time ON bank_usage(time);`)
    for (const row of db.prepare('SELECT snapshot FROM attempts').all())
      recordExposure(JSON.parse(String(row.snapshot)))
    db.exec('PRAGMA user_version=2')
  })
if (version < 3)
  transaction(() => {
    db.exec(`CREATE TABLE responses(attempt TEXT NOT NULL, item TEXT NOT NULL, ordinal INTEGER NOT NULL, section TEXT NOT NULL, task TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, used INTEGER NOT NULL, finished INTEGER, score REAL, PRIMARY KEY(attempt,item));
    CREATE INDEX response_history ON responses(section,used DESC);
    CREATE INDEX response_task_history ON responses(section,task,used DESC);
    CREATE INDEX response_outcomes ON responses(content,finished DESC);`)
    for (const row of db.prepare('SELECT snapshot FROM attempts').all())
      recordResponses(JSON.parse(String(row.snapshot)))
    db.exec('PRAGMA user_version=3')
  })
if (version < 4)
  transaction(() => {
    db.exec(`CREATE TABLE vocabulary_words(id TEXT PRIMARY KEY, term TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
      CREATE TABLE vocabulary_sources(word TEXT NOT NULL, attempt TEXT NOT NULL, item TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL, saved INTEGER NOT NULL, PRIMARY KEY(word,attempt,item));
      CREATE TABLE vocabulary_texts(id TEXT PRIMARY KEY, created INTEGER NOT NULL, snapshot TEXT NOT NULL);
      PRAGMA user_version=4`)
  })

if (version < 5)
  transaction(() => {
    db.exec(`CREATE TABLE game_cards(id TEXT PRIMARY KEY, track TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX game_cards_track ON game_cards(track);
      CREATE TABLE game_seen(id TEXT PRIMARY KEY, track TEXT NOT NULL, used INTEGER NOT NULL);
      PRAGMA user_version=5`)
  })
export function gameExtras(track: Track): GameCard[] {
  return db
    .prepare('SELECT snapshot FROM game_cards WHERE track=?')
    .all(track)
    .map((r) => JSON.parse(String(r.snapshot)))
}
export function storeGameCard(c: GameCard) {
  db.prepare('INSERT INTO game_cards VALUES(?,?,?)').run(
    c.id,
    c.track,
    JSON.stringify(c),
  )
}
export function retireGameCard(id: string) {
  db.prepare('DELETE FROM game_cards WHERE id=?').run(id)
  db.prepare('DELETE FROM game_seen WHERE id=?').run(id)
}
export function gameSeen(track: Track): Record<string, number> {
  return Object.fromEntries(
    db
      .prepare('SELECT id,used FROM game_seen WHERE track=?')
      .all(track)
      .map((r) => [r.id, Number(r.used)]),
  )
}
export function seeGameCards(cards: GameCard[]) {
  const put = db.prepare('INSERT OR REPLACE INTO game_seen VALUES(?,?,?)')
  transaction(() => {
    for (const c of cards) put.run(c.id, c.track, Date.now())
  })
}
export function vocabularyTerms(): string[] {
  return db
    .prepare('SELECT term FROM vocabulary_words ORDER BY created DESC')
    .all()
    .map((r) => String(r.term))
}
export function recentWordContexts() {
  return db
    .prepare(
      `SELECT w.id,w.term,s.context FROM vocabulary_words w JOIN vocabulary_sources s ON s.word=w.id
    WHERE s.context<>'' ORDER BY s.saved DESC LIMIT 150`,
    )
    .all()
}
export function vocabularyWords(): VocabularyWord[] {
  const sources = db
    .prepare(
      'SELECT word,attempt,item,title,context,saved FROM vocabulary_sources ORDER BY saved DESC',
    )
    .all()
  return db
    .prepare(
      'SELECT id,term,created FROM vocabulary_words ORDER BY created DESC,id',
    )
    .all()
    .map((row) => ({
      id: String(row.id),
      term: String(row.term),
      created: Number(row.created),
      sources: sources
        .filter((s) => s.word === row.id)
        .map((s) => ({
          attempt: String(s.attempt),
          item: String(s.item),
          title: String(s.title),
          context: String(s.context),
          saved: Number(s.saved),
        })),
    }))
}
export function vocabularySource(attempt: string, item: string) {
  // Reading a source must never expire a timer or reconcile an old score.
  const row = db
    .prepare('SELECT snapshot FROM attempts WHERE id=?')
    .get(attempt)
  if (!row) throw Error('The source attempt was not found.')
  const a: Attempt = JSON.parse(String(row.snapshot))
  const q = a.stages.flatMap((s) => s.items).find((q) => q.id === item)
  if (!q) throw Error('The source response was not found.')
  return { a, q }
}
export function putVocabularyWord(
  id: string,
  term: string,
  source?: WordSource,
) {
  let created = false
  transaction(() => {
    const normalized = term.toLocaleLowerCase('en-US')
    const found = db
      .prepare('SELECT id FROM vocabulary_words WHERE normalized=?')
      .get(normalized)
    if (found) id = String(found.id)
    else {
      db.prepare('INSERT INTO vocabulary_words VALUES(?,?,?,?)').run(
        id,
        term,
        normalized,
        Date.now(),
      )
      created = true
    }
    if (created && source)
      db.prepare(
        'INSERT OR IGNORE INTO vocabulary_sources VALUES(?,?,?,?,?,?)',
      ).run(
        id,
        source.attempt,
        source.item,
        source.title,
        source.context,
        source.saved,
      )
  })
  const row = db
    .prepare('SELECT term,created FROM vocabulary_words WHERE id=?')
    .get(id)!
  const sources = db
    .prepare(
      'SELECT attempt,item,title,context,saved FROM vocabulary_sources WHERE word=? ORDER BY saved DESC',
    )
    .all(id)
  const word: VocabularyWord = {
    id,
    term: String(row.term),
    created: Number(row.created),
    sources: sources.map((s) => ({
      attempt: String(s.attempt),
      item: String(s.item),
      title: String(s.title),
      context: String(s.context),
      saved: Number(s.saved),
    })),
  }
  return { word, created }
}
export function removeVocabularyWord(id: string) {
  transaction(() => {
    db.prepare('DELETE FROM vocabulary_sources WHERE word=?').run(id)
    db.prepare('DELETE FROM vocabulary_words WHERE id=?').run(id)
  })
}
export function vocabularyTexts(): VocabularyText[] {
  return db
    .prepare(
      'SELECT snapshot FROM vocabulary_texts ORDER BY created DESC,id',
    )
    .all()
    .map((r) => JSON.parse(String(r.snapshot)))
}
export function vocabularyText(id: string): VocabularyText | undefined {
  const row = db.prepare('SELECT snapshot FROM vocabulary_texts WHERE id=?').get(id)
  return row && JSON.parse(String(row.snapshot))
}
export function saveVocabularyText(text: VocabularyText) {
  db.prepare('INSERT INTO vocabulary_texts VALUES(?,?,?)').run(
    text.id,
    text.created,
    JSON.stringify(text),
  )
}
export function removeVocabularyText(id: string) {
  db.prepare('DELETE FROM vocabulary_texts WHERE id=?').run(id)
}

export function questionHash(q: Item) {
  return createHash('sha256')
    .update(
      [q.task, q.prompt, q.passage ?? '', q.speech ?? '']
        .join('|')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .digest('hex')
}
function recordResponses(a: Attempt) {
  const put = db.prepare(`INSERT INTO responses VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(attempt,item) DO UPDATE SET finished=excluded.finished,score=excluded.score
    WHERE finished IS NOT excluded.finished OR score IS NOT excluded.score`)
  let ordinal = 0
  for (const stage of a.stages)
    for (const q of stage.items) {
      ordinal++
      if (!a.ended && !a.answers[q.id]) continue
      put.run(
        a.id,
        q.id,
        ordinal,
        stage.section,
        q.task,
        q.title,
        questionHash(q),
        a.started,
        a.ended ?? null,
        a.answers[q.id]?.score ?? null,
      )
    }
}
export function selectionMemory(pool: Item[]) {
  const latest = db
    .prepare(
      `SELECT content,finished,score FROM (
    SELECT content,finished,score,ROW_NUMBER() OVER (PARTITION BY content ORDER BY finished DESC,attempt DESC) AS rank
    FROM responses WHERE finished IS NOT NULL AND score=1) WHERE rank=1`,
    )
    .all()
  const byContent = new Map(
    latest.map((row) => [
      String(row.content),
      { at: Number(row.finished), score: Number(row.score) },
    ]),
  )
  const outcomes: Record<string, { at: number; score: number }> = {}
  for (const q of pool) {
    const outcome = byContent.get(questionHash(q))
    if (outcome) outcomes[q.id] = outcome
  }
  return { lastUsed: exposures(), outcomes }
}
function recordExposure(a: Attempt) {
  const insert = db.prepare(
    'INSERT INTO exposure VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET used=excluded.used WHERE excluded.used>used',
  )
  for (const [s, stage] of a.stages.entries())
    for (const [i, q] of stage.items.entries()) {
      if (
        !a.ended &&
        !a.answers[q.id] &&
        !(a.itemStarted && s === a.stage && i <= a.index)
      )
        continue
      for (const key of materialKeys(q))
        insert.run(key, q.task, a.ended ?? a.started)
    }
}
export function exposures() {
  return Object.fromEntries(
    db
      .prepare('SELECT key,used FROM exposure')
      .all()
      .map((r) => [String(r.key), Number(r.used)]),
  )
}
export function practicedTasks(since: number) {
  return db
    .prepare(
      'SELECT task,MAX(used) AS used FROM exposure WHERE used>=? GROUP BY task ORDER BY used DESC',
    )
    .all(since)
    .map((r) => String(r.task))
}
export function jobs<T>(pendingOnly = false): T[] {
  return db
    .prepare(
      'SELECT snapshot FROM bank_jobs' +
        (pendingOnly ? " WHERE state!='done'" : '') +
        ' ORDER BY rowid',
    )
    .all()
    .map((r) => JSON.parse(String(r.snapshot)))
}
export function jobById<T>(id: string): T | undefined {
  const row = db
    .prepare('SELECT snapshot FROM bank_jobs WHERE id=?')
    .get(id)
  return row ? JSON.parse(String(row.snapshot)) : undefined
}
export function completedBankJobs<T>(): T[] {
  return db
    .prepare(
      "SELECT snapshot FROM bank_jobs WHERE state='done' ORDER BY rowid DESC LIMIT 120",
    )
    .all()
    .map((r) => JSON.parse(String(r.snapshot)))
}
export function saveJob(job: { id: string; state: string }) {
  db.prepare('INSERT OR REPLACE INTO bank_jobs VALUES(?,?,?)').run(
    job.id,
    job.state,
    JSON.stringify(job),
  )
}
export function bankUsage(now = Date.now(), manual = false) {
  const rows = db
    .prepare(
      'SELECT kind,COUNT(*) AS count FROM bank_usage WHERE time>? GROUP BY kind',
    )
    .all(now - 86400000)
  return {
    batches: Number(
      rows.find((r) => r.kind === (manual ? 'manual-batch' : 'batch'))
        ?.count ?? 0,
    ),
    requests: Number(
      rows.find((r) => r.kind === (manual ? 'manual-request' : 'request'))
        ?.count ?? 0,
    ),
  }
}
export function spendBank(
  kind: 'batch' | 'request' | 'manual-batch' | 'manual-request',
  now = Date.now(),
) {
  db.prepare('INSERT INTO bank_usage VALUES(?,?)').run(now, kind)
  db.prepare('DELETE FROM bank_usage WHERE time<=?').run(now - 86400000)
}
export function save(a: Attempt) {
  materialRevision++
  transaction(() => {
    const collect =
      a.ended &&
      a.mode !== 'drill' &&
      !db.prepare('SELECT ended FROM attempts WHERE id=?').get(a.id)?.ended
    db.prepare(
      'INSERT INTO attempts VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ended=excluded.ended,bands=excluded.bands,snapshot=excluded.snapshot',
    ).run(
      a.id,
      a.started,
      a.ended ?? null,
      a.focus,
      a.mode,
      JSON.stringify(a.bands),
      JSON.stringify(a),
    )
    recordExposure(a)
    recordResponses(a)
    if (collect)
      for (const { term, item, title, context } of wordsFromMock(a))
        putVocabularyWord(randomUUID(), term, {
          attempt: a.id,
          item,
          title,
          context,
          saved: a.ended!,
        })
  })
}
export function load(id: string): Attempt {
  const row = db.prepare('SELECT snapshot FROM attempts WHERE id=?').get(id)
  if (!row) throw Error('Attempt not found.')
  const a: Attempt = JSON.parse(String(row.snapshot))
  if (reconcileWriting(a)) save(a)
  return a
}
export function history(): HistoryRow[] {
  return db
    .prepare(
      'SELECT id,mode,focus,started,ended,bands FROM attempts ORDER BY started DESC',
    )
    .all()
    .map(
      (r) => ({ ...r, bands: JSON.parse(String(r.bands)) }) as HistoryRow,
    )
}
export function responseHistory(section: string, task: string) {
  return db
    .prepare(
      `SELECT r.attempt AS id,r.used AS started,a.mode,r.item,r.title,r.task
    FROM responses r JOIN attempts a ON a.id=r.attempt
    WHERE r.finished IS NOT NULL AND r.section=? ${task ? 'AND r.task=?' : ''}
    ORDER BY r.used DESC,r.ordinal LIMIT 200`,
    )
    .all(...(task ? [section, task] : [section]))
}
export function recent(): Attempt[] {
  return db
    .prepare(
      'SELECT snapshot FROM attempts WHERE ended IS NOT NULL ORDER BY started DESC LIMIT 30',
    )
    .all()
    .map((r) => JSON.parse(String(r.snapshot)))
}
export function previousFullMocks(started: number): Attempt[] {
  return db
    .prepare(
      "SELECT snapshot FROM attempts WHERE mode='full' AND ended IS NOT NULL AND started < ? ORDER BY started DESC LIMIT 3",
    )
    .all(started)
    .map((row) => JSON.parse(String(row.snapshot)))
}
export function setting(k: string) {
  return String(
    db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ??
      '',
  )
}
export function configure(k: string, v: string) {
  db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, v)
}
export function extras(): Item[] {
  return db
    .prepare('SELECT item FROM generated')
    .all()
    .map((r) => JSON.parse(String(r.item)))
}
export function archivedGeneratedMaterial(): Item[] {
  return db
    .prepare("SELECT snapshot FROM attempts WHERE mode='full'")
    .all()
    .flatMap((row) => {
      const a: Attempt = JSON.parse(String(row.snapshot))
      return a.stages
        .flatMap((s) => [...s.items, ...(s.upper ?? [])])
        .filter((q) => q.id.startsWith('gen-') && !q.personal)
    })
}
export function addItem(q: Item, hash: string) {
  materialRevision++
  db.prepare('INSERT INTO generated VALUES(?,?,?)').run(
    q.id,
    hash,
    JSON.stringify(q),
  )
}
