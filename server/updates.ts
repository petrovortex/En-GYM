import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, parse, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  catalogUrl,
  compareVersions,
  componentIds,
  verifyCatalog,
  type Catalog,
  type Component,
  type Envelope,
  type ReleaseFile,
  type UpdatesStatus,
  type Watermark,
} from '../core/updates.ts'

export interface UpdatePaths {
  app: string
  speech: string
  work: string
}
export function updatePaths(): UpdatePaths {
  const local = process.env.LOCALAPPDATA
  if (!local || !process.env.FIELDWORK_INSTALL_ROOT)
    throw Error('Updates are available in the installed Windows app.')
  const base = join(local, 'En-GYM')
  return {
    app: resolve(process.env.FIELDWORK_INSTALL_ROOT),
    speech: resolve(process.env.FIELDWORK_SPEECH || join(base, 'components', 'speech')),
    work: join(base, 'updates'),
  }
}
export async function jsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}
export async function assertLocalPath(path: string) {
  const absolute = resolve(path),
    root = parse(absolute).root
  let current = root
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error('A link is not allowed in update storage.')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
  }
}
export async function atomicJson(path: string, value: unknown) {
  await assertLocalPath(path)
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}
// SQLite owns the inter-process lock. Windows releases it immediately on process
// death, so recovery never has to guess whether a stale PID was reused.
export async function withUpdateLock<T>(work: string, action: () => Promise<T>) {
  const path = join(work, 'activation.sqlite')
  await assertLocalPath(path)
  await mkdir(work, { recursive: true })
  const mutex = new DatabaseSync(path)
  try {
    try {
      mutex.exec('BEGIN IMMEDIATE')
    } catch (e) {
      if ((e as { errcode?: number }).errcode === 5)
        throw Error('Another update is already in progress.')
      throw e
    }
    return await action()
  } finally {
    mutex.close()
  }
}
export async function requireClearActivation(paths: UpdatePaths) {
  for (const name of ['pending.json', 'recovery.json']) {
    if ((await jsonFile(join(paths.work, name))) !== undefined)
      throw Error(
        'Restart the installed app to finish its pending update before running setup.',
      )
  }
}
export async function matches(path: string, file: ReleaseFile) {
  await assertLocalPath(path)
  const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
  })
  if (!stat?.isFile() || stat.size !== file.bytes) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex') === file.sha256
}
type Fetch = typeof fetch
export class CatalogUnavailable extends Error {}
async function remote(url: string, signal: AbortSignal, get: Fetch) {
  for (let i = 0; i < 5; i++) {
    const u = new URL(url)
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      ![
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
      ].includes(u.hostname)
    )
      throw Error('Untrusted update download host.')
    const response = await get(url, {
      redirect: 'manual',
      signal,
      credentials: 'omit',
      headers: { 'accept-encoding': 'identity' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const destination = response.headers.get('location')
      if (!destination) throw Error('Invalid update redirect.')
      url = new URL(destination, url).href
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new CatalogUnavailable('Update download unavailable. Try again later.')
    }
    return response.body.getReader()
  }
  throw Error('Too many update redirects.')
}
async function streamRemote(
  url: string,
  maximum: number,
  get: Fetch,
  consume: (bytes: Uint8Array) => Promise<void>,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10 * 60_000)
  try {
    const reader = await remote(url, controller.signal, get)
    let total = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maximum) throw Error('Update download exceeded its declared size.')
        await consume(value)
      }
      return total
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } finally {
    controller.abort()
    clearTimeout(timer)
  }
}
export async function checkedEnvelope(paths: UpdatePaths, envelope: Envelope) {
  const trust = await jsonFile<{ root: string }>(
    join(paths.app, 'scripts', 'release-trust.json'),
  )
  if (!trust?.root) throw Error('This build is not configured for signed updates.')
  return verifyCatalog(
    envelope,
    trust.root,
    await jsonFile<Watermark>(join(paths.work, 'watermark.json')),
  )
}
export async function fetchCatalog(paths: UpdatePaths, get: Fetch = fetch) {
  const chunks: Buffer[] = []
  try {
    await streamRemote(catalogUrl, 128 * 1024, get, async (v) => {
      chunks.push(Buffer.from(v))
    })
  } catch (e) {
    if (e instanceof TypeError || (e instanceof Error && e.name === 'AbortError'))
      throw new CatalogUnavailable('Check your connection and try again.')
    throw e
  }
  const envelope: Envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const { catalog, watermark } = await checkedEnvelope(paths, envelope)
  await atomicJson(join(paths.work, 'watermark.json'), watermark)
  return { envelope, catalog }
}
export async function installedApp(paths: UpdatePaths) {
  const version = (await jsonFile<{ version: string }>(join(paths.app, 'package.json')))
    ?.version
  if (!version) throw Error('Could not read installed app version.')
  compareVersions(version, version)
  return version
}
interface LocalRelease {
  version: string
  digest: string
}
export type SpeechReceipts = Partial<Record<'phonon' | 'whisper', LocalRelease>>
export function releaseDigest(catalog: Catalog, id: Component) {
  return createHash('sha256')
    .update(
      JSON.stringify(catalog.components[id].files.map((f) => [f.name, f.sha256]).sort()),
    )
    .digest('hex')
}
export async function planUpdate(
  paths: UpdatePaths,
  catalog: Catalog,
  speechOnly = false,
) {
  const version = await installedApp(paths)
  const receipts =
    (await jsonFile<SpeechReceipts>(join(paths.work, 'installed.json'))) ?? {}
  const changes: UpdatesStatus['changes'] = []
  for (const id of componentIds) {
    const component = catalog.components[id]
    if (id === 'app') {
      if (!speechOnly && compareVersions(component.version, version) > 0)
        changes.push({
          component: id,
          version: component.version,
          bytes: component.files[0].bytes,
        })
      continue
    }
    const target =
      speechOnly || compareVersions(version, catalog.components.app.version) >= 0
        ? version
        : catalog.components.app.version
    if (compareVersions(component.minApp, target) > 0)
      throw Error('Download the current installer to use these speech models.')
    const receipt = receipts[id]
    if (receipt && compareVersions(component.version, receipt.version) < 0)
      throw Error('The catalog would downgrade an installed speech component.')
    let bytes = 0
    for (const file of component.files)
      if (!(await matches(join(paths.speech, file.name), file))) bytes += file.bytes
    if (
      bytes ||
      !receipt ||
      receipt.version !== component.version ||
      receipt.digest !== releaseDigest(catalog, id)
    )
      changes.push({
        component: id,
        version: component.version,
        bytes,
        minApp: component.minApp,
      })
  }
  return changes
}
export async function selectChanges(
  paths: UpdatePaths,
  catalog: Catalog,
  available: UpdatesStatus['changes'],
  selected?: unknown,
) {
  if (
    selected !== undefined &&
    (!Array.isArray(selected) ||
      !selected.length ||
      selected.length !== new Set(selected).size ||
      !selected.every((c) => componentIds.includes(c)))
  )
    throw Error('Choose the components to update.')
  const changes = selected
    ? available.filter((c) => (selected as unknown[]).includes(c.component))
    : available
  if (!changes.length) return changes
  const includeApp = changes.some((c) => c.component === 'app')
  const app = includeApp ? catalog.components.app.version : await installedApp(paths)
  if (changes.some((c) => c.minApp && compareVersions(c.minApp, app) > 0))
    throw Error(
      'Select the app update as well. These speech components require a newer app.',
    )
  if (includeApp) {
    const receipts = await jsonFile<SpeechReceipts>(join(paths.work, 'installed.json'))
    for (const id of ['phonon', 'whisper'] as const) {
      const version = changes.some((c) => c.component === id)
        ? catalog.components[id].version
        : receipts?.[id]?.version
      if (!version || compareVersions(version, catalog.components.app.requires![id]) < 0)
        throw Error(
          'Select the ' +
            id +
            ' update as well. This app version requires newer speech components.',
        )
    }
  }
  return changes
}
export const stageFile = (paths: UpdatePaths, file: ReleaseFile) =>
  join(paths.work, 'staging', file.sha256)
export async function stageUpdate(
  paths: UpdatePaths,
  catalog: Catalog,
  changes: UpdatesStatus['changes'],
  progress: (bytes: number) => void,
  get: Fetch = fetch,
) {
  const stage = join(paths.work, 'staging')
  await assertLocalPath(stage)
  await mkdir(stage, { recursive: true })
  const valid = new Set(
    componentIds.flatMap((id) => catalog.components[id].files.map((f) => f.sha256)),
  )
  for (const entry of await readdir(stage, { withFileTypes: true })) {
    const oldBlob = /^[0-9a-f]{64}$/.test(entry.name) && !valid.has(entry.name)
    const partial = /^[0-9a-f]{64}\.[0-9a-f-]{36}\.part$/.test(entry.name)
    if (!entry.isFile() || (!oldBlob && !partial)) continue
    const path = join(stage, entry.name)
    await assertLocalPath(path)
    if (oldBlob || Date.now() - (await lstat(path)).mtimeMs > 3600000)
      await rm(path, { force: true })
  }
  const missing = []
  for (const { component } of changes)
    for (const file of catalog.components[component].files) {
      if (component !== 'app' && (await matches(join(paths.speech, file.name), file)))
        continue
      if (await matches(stageFile(paths, file), file)) {
        progress(file.bytes)
        continue
      }
      missing.push(file)
    }
  const volume = await statfs(stage)
  if (
    volume.bavail * volume.bsize <
    missing.reduce((n, f) => n + f.bytes, 0) + 10 * 1024 * 1024
  )
    throw Error('Not enough disk space for this update.')
  for (const file of missing) {
    const target = stageFile(paths, file)
    const tmp = target + '.' + randomUUID() + '.part'
    const out = await open(tmp, 'wx', 0o600)
    try {
      const hash = createHash('sha256')
      const size = await streamRemote(file.url, file.bytes, get, async (bytes) => {
        await out.writeFile(bytes)
        hash.update(bytes)
        progress(bytes.length)
      })
      if (size !== file.bytes || hash.digest('hex') !== file.sha256)
        throw Error(
          'Update verification failed. Your existing installation is unchanged.',
        )
      await out.sync()
      await out.close()
      await rename(tmp, target)
    } finally {
      await out.close()
      await rm(tmp, { force: true })
    }
  }
}
export interface Pending {
  envelope: Envelope
  speechOnly: boolean
  selected?: Component[]
}
const source = fileURLToPath(new URL('../package.json', import.meta.url))
let status: UpdatesStatus = {
  state: process.env.FIELDWORK_INSTALL_ROOT ? 'idle' : 'unsupported',
  appVersion:
    (await jsonFile<{ version: string }>(source).catch(() => undefined))?.version ?? '',
  changes: [],
  done: 0,
  total: 0,
  message: '',
}
if (status.state === 'idle' && process.env.LOCALAPPDATA) {
  const last = await jsonFile<{ message: string }>(
    join(updatePaths().work, 'outcome.json'),
  ).catch(() => undefined)
  if (last) {
    status.state = 'error'
    status.message = 'The last update could not be applied. Check for updates to retry.'
  }
}
let known: Awaited<ReturnType<typeof fetchCatalog>> | undefined
export const updateStatus = (): UpdatesStatus => ({
  ...status,
  changes: [...status.changes],
})
const updating = () => ['checking', 'downloading', 'restarting'].includes(status.state)
const friendly = (e: unknown) =>
  e instanceof TypeError || (e instanceof Error && e.name === 'AbortError')
    ? 'Check your connection and try again.'
    : e instanceof Error
      ? e.message
      : 'The update could not be completed.'
export async function checkUpdates() {
  if (updating() || status.state === 'unsupported') return updateStatus()
  known = undefined
  status = { ...status, state: 'checking', changes: [], message: '', done: 0, total: 0 }
  try {
    const paths = updatePaths()
    const candidate = await withUpdateLock(paths.work, async () => {
      await requireClearActivation(paths)
      const candidate = await fetchCatalog(paths)
      status.changes = await planUpdate(paths, candidate.catalog)
      return candidate
    })
    await rm(join(paths.work, 'outcome.json'), { force: true })
    known = candidate
    status.total = status.changes.reduce((n, c) => n + c.bytes, 0)
    status.state = status.changes.length ? 'available' : 'current'
  } catch (e) {
    status.state = 'error'
    status.message = friendly(e)
  }
  return updateStatus()
}
export async function installUpdates(safeToRestart: () => boolean, components?: unknown) {
  if (!known || !status.changes.length || updating()) return updateStatus()
  const candidate = known
  if (!safeToRestart())
    throw Error('Finish your current practice or AI request before updating.')
  status = { ...status, state: 'downloading', message: '', done: 0 }
  const paths = updatePaths()
  void withUpdateLock(paths.work, async () => {
    await requireClearActivation(paths)
    await checkedEnvelope(paths, candidate.envelope)
    const changes = await selectChanges(
      paths,
      candidate.catalog,
      status.changes,
      components,
    )
    if (!changes.length) throw Error('Choose an available update.')
    status.total = changes.reduce((total, c) => total + c.bytes, 0)
    await stageUpdate(paths, candidate.catalog, changes, (bytes) => {
      status.done += bytes
    })
    if (!safeToRestart())
      throw Error('Your download is ready. Finish your practice and retry.')
    await atomicJson(join(paths.work, 'pending.json'), {
      envelope: candidate.envelope,
      speechOnly: false,
      selected: changes.map((c) => c.component),
    })
    if (!safeToRestart()) {
      await rm(join(paths.work, 'pending.json'), { force: true })
      throw Error('Finish practice and retry.')
    }
    status.state = 'restarting'
    setTimeout(() => process.exit(75), 350)
  }).catch((e) => {
    status.state = 'error'
    status.message = friendly(e)
  })
  return updateStatus()
}
