import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync, backup } from 'node:sqlite'
import { copyFile, cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { componentFiles } from '../core/updates.ts'
import {
  assertLocalPath,
  atomicJson,
  checkedEnvelope,
  installedApp,
  jsonFile,
  matches,
  planUpdate,
  releaseDigest,
  selectChanges,
  stageFile,
  updatePaths,
  withUpdateLock,
} from '../server/updates.ts'

const run = promisify(execFile)
const appEntries = [
  'En-GYM.exe',
  'runtime',
  'dist',
  'server',
  'core',
  'node_modules',
  'scripts',
  'package.json',
  'LICENSE',
  'THIRD-PARTY.md',
  'licenses',
]
async function exists(file) {
  try {
    await lstat(file)
    return true
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return false
  }
}
async function copyOwned(from, to) {
  await assertLocalPath(from)
  await assertLocalPath(to)
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    filter: async (p) => {
      if ((await lstat(p)).isSymbolicLink())
        throw Error('A link was found in managed program files.')
      return true
    },
  })
}
// All snapshot and restoration destinations come from local allowlists. No paths in a
// downloaded catalog or journal are used as executable names or arbitrary destinations.
function protectedFiles(paths, appChanged, speechNames) {
  return [
    ...(appChanged ? appEntries.map((n) => [join(paths.app, n), 'app/' + n]) : []),
    ...speechNames.map((n) => [join(paths.speech, n), 'speech/' + n]),
    [join(paths.work, 'installed.json'), 'installed.json'],
  ]
}
export async function applyPrepared(paths, options = {}) {
  return withUpdateLock(paths.work, async () => {
    try {
      return await applyPreparedLocked(paths, options)
    } catch (err) {
      if (
        options.retireFailedPending &&
        !(await exists(join(paths.work, 'recovery.json')))
      ) {
        await rm(join(paths.work, 'pending.json'), { force: true })
      }
      throw err
    }
  })
}
export async function applyPreparedLocked(paths, options = {}) {
  const recovery = join(paths.work, 'recovery.json'),
    pendingPath = join(paths.work, 'pending.json')
  const snapshot = join(paths.work, 'recovery'),
    staging = join(paths.work, 'staging')
  const dbPath = join(
    options.profile ?? join(process.env.LOCALAPPDATA, 'En-GYM', 'user'),
    'practice.sqlite',
  )
  const allSpeech = [...componentFiles.phonon, ...componentFiles.whisper]
  const clean = async () => {
    // Remove the recovery marker only once program, speech and DB are consistent.
    await rm(recovery, { force: true })
    await rm(pendingPath, { force: true })
    await rm(snapshot, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
  }
  const restore = async (journal) => {
    if (
      journal?.schema !== 1 ||
      typeof journal.appChanged !== 'boolean' ||
      !Array.isArray(journal.speech) ||
      journal.speech.some((n) => !allSpeech.includes(n))
    )
      throw Error('The update recovery record is invalid.')
    const saved = await jsonFile(join(snapshot, 'snapshot.json'))
    if (
      !saved ||
      JSON.stringify(saved.journal) !== JSON.stringify(journal) ||
      !Array.isArray(saved.entries) ||
      typeof saved.database !== 'boolean'
    )
      throw Error(
        'The update snapshot is incomplete. Existing files have been preserved.',
      )
    for (const [target, name] of protectedFiles(
      paths,
      journal.appChanged,
      journal.speech,
    )) {
      if (saved.entries.includes(name) && !(await exists(join(snapshot, name))))
        throw Error('The update snapshot is incomplete.')
      await assertLocalPath(target)
    }
    if (saved.database && !(await exists(join(snapshot, 'practice.sqlite'))))
      throw Error('The database backup is missing.')
    for (const [target, name] of protectedFiles(
      paths,
      journal.appChanged,
      journal.speech,
    )) {
      await assertLocalPath(target)
      await rm(target, { recursive: true, force: true })
      if (await exists(join(snapshot, name)))
        await copyOwned(join(snapshot, name), target)
    }
    if (journal.appChanged) {
      await assertLocalPath(dbPath)
      for (const ext of ['-wal', '-shm', '-journal'])
        await rm(dbPath + ext, { force: true })
      if (await exists(join(snapshot, 'practice.sqlite')))
        await copyOwned(join(snapshot, 'practice.sqlite'), dbPath)
      else await rm(dbPath, { force: true })
    }
    await clean()
  }
  const previous = await jsonFile(recovery)
  if (previous) {
    await restore(previous)
    return 'recovered'
  }
  const pending = await jsonFile(pendingPath)
  if (!pending) throw Error('No verified update is ready.')
  const { catalog } = await checkedEnvelope(paths, pending.envelope)
  const available = await planUpdate(paths, catalog, pending.speechOnly)
  const changes = await selectChanges(paths, catalog, available, pending.selected)
  const appChanged = changes.some((c) => c.component === 'app')
  const replacements = []
  for (const { component } of changes)
    for (const file of catalog.components[component].files) {
      if (component !== 'app' && (await matches(join(paths.speech, file.name), file)))
        continue
      if (!(await matches(stageFile(paths, file), file)))
        throw Error('The staged update was modified. Download it again.')
      replacements.push({ component, file })
    }
  const journal = {
    schema: 1,
    appChanged,
    speech: replacements.filter((x) => x.component !== 'app').map((x) => x.file.name),
  }
  await assertLocalPath(snapshot)
  await rm(snapshot, { recursive: true, force: true })
  await mkdir(snapshot, { recursive: true })
  const saved = { journal, entries: [], database: appChanged && (await exists(dbPath)) }
  for (const [target, name] of protectedFiles(paths, appChanged, journal.speech)) {
    if (await exists(target)) {
      await copyOwned(target, join(snapshot, name))
      saved.entries.push(name)
    }
  }
  if (saved.database) {
    await assertLocalPath(dbPath)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      await backup(db, join(snapshot, 'practice.sqlite'))
    } finally {
      db.close()
    }
  }
  await atomicJson(join(snapshot, 'snapshot.json'), saved)
  await atomicJson(recovery, journal)
  try {
    for (const { component, file } of replacements) {
      const staged = stageFile(paths, file)
      if (component === 'app') {
        // Keep .exe extension for Win32 installer discovery, then verify that exact executable.
        const installer = join(staging, 'En-GYM-Setup.exe')
        await copyFile(staged, installer)
        if (!(await matches(installer, file))) throw Error('The installer is damaged.')
        await (
          options.install ??
          ((p) =>
            run(
              p,
              [
                '/CURRENTUSER',
                '/UPDATE',
                '/NOAUTOOPEN',
                '/VERYSILENT',
                '/SUPPRESSMSGBOXES',
                '/NORESTART',
              ],
              { windowsHide: true, cwd: staging, timeout: 300000 },
            ))
        )(installer)
        if ((await installedApp(paths)) !== catalog.components.app.version)
          throw Error('The new app version did not install.')
      } else {
        const target = join(paths.speech, file.name)
        await assertLocalPath(target)
        await mkdir(dirname(target), { recursive: true })
        await rename(staged, target)
        if (!(await matches(target, file)))
          throw Error('An updated speech file did not pass verification.')
      }
    }
    if (changes.length && options.health) await options.health(appChanged)
    const receipts = (await jsonFile(join(paths.work, 'installed.json'))) ?? {}
    for (const { component, version } of changes)
      if (component !== 'app')
        receipts[component] = { version, digest: releaseDigest(catalog, component) }
    await atomicJson(join(paths.work, 'installed.json'), receipts)
  } catch (err) {
    await restore(journal)
    throw err
  }
  await clean()
  return 'installed'
}
export async function installedHealth(paths, appChanged) {
  const node = join(paths.app, 'runtime', 'node.exe')
  const options = { cwd: paths.app, timeout: 120000, windowsHide: true }
  if (appChanged)
    await run(node, [join(paths.app, 'server', 'main.ts'), '--verify-update'], options)
  const sample = await mkdtemp(join(paths.work, 'health-'))
  try {
    await run(
      node,
      [
        '--input-type=module',
        '-e',
        `
      import {synth,audioKey,transcribe,closeSpeech,wavInfo,wave} from './server/speech.ts'
      import {readFile,writeFile} from 'node:fs/promises'
      import {join} from 'node:path'
      const item={id:'update-health',task:'repeat',speech:'We study English at the library every day.'}
      try {
        await synth(item,process.argv[1])
        const {pcm,rate}=wavInfo(await readFile(join(process.argv[1],audioKey(item)+'.wav')))
        const mic=Buffer.alloc(2*Math.floor(pcm.length/2*16000/rate))
        for(let i=0;i<mic.length/2;i++) mic.writeInt16LE(pcm.readInt16LE(2*Math.floor(i*rate/16000)),2*i)
        const recording=join(process.argv[1],'microphone.wav')
        await writeFile(recording,wave(mic,16000))
        if (!/study|english|library/i.test(await transcribe(recording))) throw Error('Speech model check failed')
      } finally { closeSpeech() }`,
        sample,
      ],
      options,
    )
  } finally {
    await rm(sample, { recursive: true, force: true })
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const paths = updatePaths()
  let failed = false
  try {
    const result = await applyPrepared(paths, {
      retireFailedPending: true,
      health: (changed) => installedHealth(paths, changed),
    })
    if (result === 'recovered')
      await atomicJson(join(paths.work, 'outcome.json'), {
        message: 'The previous version was restored after an interrupted update.',
      })
    else await rm(join(paths.work, 'outcome.json'), { force: true })
  } catch (err) {
    failed = true
    await atomicJson(join(paths.work, 'outcome.json'), {
      message: 'The update could not be applied. Check for updates to retry.',
    })
    console.error(err.message)
  }
  // A surviving journal means restoration itself needs attention. Never open a mixed install.
  await rm(join(paths.work, 'native-helper.json'), { force: true })
  if (!(await exists(join(paths.work, 'recovery.json'))))
    spawn(join(paths.app, 'En-GYM.exe'), [], {
      cwd: paths.app,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  if (failed) process.exitCode = 1
}
