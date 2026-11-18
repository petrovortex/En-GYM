// Windows release gate. All mutable state and both independently built installers live
// under one disposable checkout. Only the transport is substituted with signed fixtures.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  appendFile,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { componentFiles, verifyCatalog } from '../core/updates.ts'
import { atomicJson, installedApp, jsonFile, releaseDigest } from '../server/updates.ts'
import { applyPrepared, installedHealth } from './release-apply.mjs'
import { signBytes } from './release-keys.mjs'

if (process.platform !== 'win32')
  throw Error('Run the native release gate on Windows x64.')
const buildOnly = process.argv.includes('--build-only')
const project = resolve('.'),
  work = join(project, '.work')
const folder = await mkdtemp(join(work, 'release-check-'))
const checkout = join(folder, 'checkout'),
  app = join(folder, 'Installed app')
const local = join(folder, 'LocalAppData'),
  workArea = join(local, 'En-GYM')
const paths = {
  app,
  speech: join(workArea, 'components', 'speech'),
  work: join(workArea, 'updates'),
}
const profile = join(workArea, 'user'),
  dbPath = join(profile, 'practice.sqlite')
const speakingAttempt = {
  id: 'release-speaking', mode: 'drill', focus: 'repeat', rules: 1,
  seed: 1, started: 1000, ended: 3000, stage: 0, index: 0,
  deadline: 0, itemStarted: 0, bands: {}, messages: [],
  stages: [{ section: 'Speaking', name: 'Speaking', minutes: 0, items: [{
    id: 'spoken', level: 2, title: 'Saved speaking response', task: 'repeat',
    prompt: 'Listen and repeat.', speech: 'We study English at the library every day.',
  }] }],
  answers: { spoken: {
    clip: '54b7dd5f-4c4e-4c20-b5a1-cdb1701552c1', seconds: 1, elapsed: 2,
    transcript: 'We study English at the library every day.',
  } },
}
const recordingPath = join(profile, 'recordings', speakingAttempt.answers.spoken.clip + '.wav')
let savedRecording
const installedEnv = {
  ...process.env,
  LOCALAPPDATA: local,
  FIELDWORK_INSTALL_ROOT: app,
  FIELDWORK_SPEECH: paths.speech,
  EN_GYM_INSTALLED: '1',
}
const node = join(work, 'node-win', 'node.exe'),
  compiler = join(work, 'inno6', 'ISCC.exe')
const fixtureKey = () =>
  generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  })
const root = fixtureKey(),
  release = fixtureKey()
const delegation = signBytes(
  { schema: 1, generation: 1, expires: Date.now() + 86400000, key: release.publicKey },
  root.privateKey,
)
const installedNode = join(app, 'runtime', 'node.exe')
function run(exe, args, options = {}, expected = 0) {
  const result = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: 600000,
    windowsHide: true,
    ...options,
  })
  if (result.error) throw result.error
  assert.equal(
    result.status,
    expected,
    (result.stdout ?? '') + '\n' + (result.stderr ?? ''),
  )
}
function install(exe) {
  console.log('Starting the isolated installer.')
  run(
    exe,
    [
      '/SANDBOXINSTALL',
      '/CURRENTUSER',
      '/UPDATE',
      '/NOAUTOOPEN',
      '/NOICONS',
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/DIR=' + app,
    ],
    { cwd: folder, env: installedEnv },
  )
  console.log('The isolated installer finished.')
}
const fixtureSpeech = join(checkout, '.work', 'release', 'speech')
const windowsPowerShell = join(
  process.env.SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
)
const issue = async (version, speechVersion, appBuild = true) => {
  const pkg = await jsonFile(join(checkout, 'package.json'))
  await atomicJson(join(checkout, 'package.json'), { ...pkg, version })
  await atomicJson(join(checkout, 'scripts', 'release-versions.json'), {
    phonon: { version: speechVersion, minApp: '98.1.0' },
    whisper: { version: '1.0.0', minApp: '98.1.0' },
    requires: { phonon: '1.0.0', whisper: '1.0.0' },
  })
  if (appBuild)
    run(
      join(windowsPowerShell, 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(checkout, 'scripts', 'package-windows.ps1'),
        '-NodePath',
        node,
        '-CompilerPath',
        compiler,
        '-SkipBuild',
      ],
      {
        cwd: checkout,
        env: { ...process.env, PSModulePath: join(windowsPowerShell, 'Modules') },
      },
    )
  const tag = appBuild ? 'v' + version : 'speech-test'
  run(node, [join(checkout, 'scripts', 'release-catalog.mjs')], {
    cwd: checkout,
    env: {
      ...process.env,
      RELEASE_KIND: appBuild ? 'app' : 'speech',
      RELEASE_TAG: tag,
      EN_GYM_ROOT_PUBLIC_KEY: root.publicKey,
      EN_GYM_RELEASE_PRIVATE_KEY: release.privateKey,
      EN_GYM_DELEGATION_B64: Buffer.from(JSON.stringify(delegation)).toString('base64'),
    },
  })
  const out = join(folder, tag)
  await rename(join(checkout, '.work', 'publish'), out)
  const envelope = await jsonFile(join(out, 'catalog.json'))
  const { catalog } = verifyCatalog(envelope, root.publicKey)
  const prior = join(checkout, '.work', 'previous')
  await mkdir(prior, { recursive: true })
  await copyFile(join(out, 'catalog.json'), join(prior, 'catalog.json'))
  await copyFile(join(out, 'En-GYM-Setup.exe'), join(prior, 'En-GYM-Setup.exe'))
  await atomicJson(join(prior, 'metadata.json'), {
    published_at: new Date().toISOString(),
  })
  return { out, catalog }
}
try {
  for (const name of [
    'scripts',
    'packaging',
    'server',
    'core',
    'dist',
    'LICENSE',
    'THIRD-PARTY.md',
    'package.json',
    'node_modules/jose',
    'node_modules/phonon-tts',
    'node_modules/react/LICENSE',
    'node_modules/react-dom/LICENSE',
    'node_modules/scheduler/LICENSE',
  ]) {
    await mkdir(dirname(join(checkout, name)), { recursive: true })
    await cp(join(project, name), join(checkout, name), { recursive: true })
  }
  await atomicJson(join(checkout, 'scripts', 'release-trust.json'), {
    schema: 1,
    root: root.publicKey,
  })
  for (const name of [...componentFiles.phonon, ...componentFiles.whisper]) {
    for (const target of [join(fixtureSpeech, name), join(paths.speech, name)]) {
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(work, 'speech', name), target)
    }
  }
  console.log('Building the first isolated Windows package.')
  const first = await issue('98.1.0', '1.0.0')
  if (!buildOnly) {
    console.log('Installing the first package and checking its database.')
    install(join(first.out, 'En-GYM-Setup.exe'))
    const receipts = {}
    for (const id of ['phonon', 'whisper'])
      receipts[id] = { version: '1.0.0', digest: releaseDigest(first.catalog, id) }
    await atomicJson(join(paths.work, 'installed.json'), receipts)
    run(installedNode, ['server/main.ts', '--verify-update'], {
      cwd: app,
      env: installedEnv,
    })
    console.log('Saving a Speaking response and recording in the first installation.')
    run(installedNode, ['--input-type=module', '-e', `
      import {save, clips} from './server/store.ts'
      import {wave} from './server/speech.ts'
      import {writeFileSync} from 'node:fs'
      import {join} from 'node:path'
      const attempt = JSON.parse(process.argv[1])
      save(attempt)
      const pcm = Buffer.alloc(32000)
      for (let i = 0; i < 16000; i++)
        pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 4000), i * 2)
      writeFileSync(join(clips, attempt.answers.spoken.clip + '.wav'), wave(pcm, 16000))
    `, JSON.stringify(speakingAttempt)], { cwd: app, env: installedEnv })
    savedRecording = await readFile(recordingPath)
    const db = new DatabaseSync(dbPath)
    db.exec(
      "CREATE TABLE release_probe(value TEXT); INSERT INTO release_probe VALUES('retained')",
    )
    db.close()
  }
  // This check exists only in the second disposable build. A failed migration
  // must restore the original DB along with the old program and speech files.
  const entry = join(checkout, 'server', 'main.ts')
  await writeFile(
    entry,
    `import {existsSync as probeExists} from 'node:fs'
    import {DatabaseSync as ProbeDb} from 'node:sqlite'
    import {join as probeJoin} from 'node:path'
    if(process.argv.includes('--verify-update') && probeExists(probeJoin(process.env.FIELDWORK_INSTALL_ROOT,'.fail-health'))) {
      const probe=new ProbeDb(probeJoin(process.env.LOCALAPPDATA,'En-GYM','user','practice.sqlite'))
      probe.exec('DROP TABLE release_probe'); probe.close(); process.exit(80)
    }\n` + (await readFile(entry, 'utf8')),
  )
  const config = componentFiles.phonon.find((n) => n.endsWith('config.json'))
  await appendFile(join(fixtureSpeech, config), '\n')
  console.log('Building the second isolated Windows package.')
  const second = await issue('98.2.0', '1.1.0')
  assert.notEqual(
    first.catalog.components.app.files[0].sha256,
    second.catalog.components.app.files[0].sha256,
  )
  assert.notEqual(
    releaseDigest(first.catalog, 'phonon'),
    releaseDigest(second.catalog, 'phonon'),
  )
  if (!buildOnly) {
    const stage = () => {
      // Use the actual installed update module and restart exit code. Its immutable
      // GitHub URLs resolve to the equivalent local signed release directory in this child.
      run(
        installedNode,
        [
          '--input-type=module',
          '-e',
          `
      import {openAsBlob} from 'node:fs'
      import {join} from 'node:path'
      const [folder,catalog]=process.argv.slice(1)
      globalThis.fetch=async url=>{
        const parts=new URL(url).pathname.split('/')
        return new Response(await openAsBlob(parts.at(-1)==='catalog.json'?catalog:join(folder,parts.at(-2),parts.at(-1))))
      }
      const u=await import('./server/updates.ts')
      const status=await u.checkUpdates()
      if(status.state!=='available')throw Error(JSON.stringify(status))
      await u.installUpdates(()=>true)
      const t=setInterval(()=>{const s=u.updateStatus();if(s.state==='error'){clearInterval(t);throw Error(s.message)}},100)
    `,
          folder,
          join(second.out, 'catalog.json'),
        ],
        { cwd: app, env: installedEnv },
        75,
      )
    }
    // The external helper runs while no installed Node or tray executable is open.
    for (const [k, v] of Object.entries(installedEnv))
      if (k.startsWith('FIELDWORK_') || k === 'EN_GYM_INSTALLED' || k === 'LOCALAPPDATA')
        process.env[k] = v
    const options = {
      profile,
      install,
      health: (changed) => installedHealth(paths, changed),
    }
    const preserved = async () => {
      const check = new DatabaseSync(dbPath, { readOnly: true })
      try {
        assert.equal(
          check.prepare('SELECT value FROM release_probe').get().value,
          'retained',
        )
        const saved = check.prepare('SELECT snapshot FROM attempts WHERE id=?').get(speakingAttempt.id)
        assert.ok(saved, 'The saved Speaking attempt must survive the update.')
        assert.deepEqual(JSON.parse(saved.snapshot), speakingAttempt)
      } finally {
        check.close()
      }
      assert.deepEqual(await readFile(recordingPath), savedRecording,
        'The saved Speaking recording must remain byte-for-byte intact.')
    }
    await writeFile(join(app, '.fail-health'), 'fixture')
    console.log('Preparing the update for the forced-failure check.')
    stage()
    // Confirm the health check actually exercised the modified SQLite database.
    console.log('Applying the update and verifying rollback after a failed health check.')
    await assert.rejects(applyPrepared(paths, options), (err) => err.code === 80)
    assert.equal(await installedApp(paths), '98.1.0')
    assert.equal(
      (await jsonFile(join(paths.work, 'installed.json'))).phonon.version,
      '1.0.0',
    )
    assert.deepEqual(
      await readFile(join(paths.speech, config)),
      await readFile(join(work, 'speech', config)),
    )
    await preserved()
    await rm(join(app, '.fail-health'))
    console.log('Preparing and applying the successful update.')
    stage()
    assert.equal(await applyPrepared(paths, options), 'installed')
    assert.equal(await installedApp(paths), '98.2.0')
    assert.equal(
      (await jsonFile(join(paths.work, 'installed.json'))).phonon.version,
      '1.1.0',
    )
    assert.deepEqual(
      await readFile(join(paths.speech, config)),
      await readFile(join(fixtureSpeech, config)),
    )
    await preserved()
    console.log('Checking upgraded speech and two authenticated server restarts.')
    run(installedNode, [join(checkout, 'packaging', 'check-installed.mjs')], {
      cwd: app,
      env: installedEnv,
    })
  }
  console.log('Checking speech-only publication with the existing installer.')
  const modelOnly = await issue('98.2.0', '1.1.0', false)
  assert.equal(
    modelOnly.catalog.components.app.files[0].sha256,
    second.catalog.components.app.files[0].sha256,
  )
  console.log(
    buildOnly
      ? 'Built two distinct Windows installers and verified their signed catalogs, speech diff and identical speech-only installer reattachment.'
      : 'Two native installer builds passed update, rollback, speech, database, saved Speaking response and recording, authenticated relaunch and speech-only publication checks.',
  )
} finally {
  console.log('Cleaning up the isolated release-check files.')
  if (
    dirname(folder) !== work ||
    !basename(folder).startsWith('release-check-') ||
    (await lstat(folder)).isSymbolicLink()
  )
    throw Error('Unexpected staging directory.')
  await rm(folder, { recursive: true, force: true })
}
