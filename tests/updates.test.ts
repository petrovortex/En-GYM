import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  componentFiles,
  componentIds,
  verifyCatalog,
  type Catalog,
  type SignedBytes,
} from '../core/updates.ts'
import {
  atomicJson,
  fetchCatalog,
  jsonFile,
  planUpdate,
  selectChanges,
  stageFile,
  stageUpdate,
} from '../server/updates.ts'
const { applyPrepared } = await import(
  new URL('../scripts/release-apply.mjs', import.meta.url).href
)
const keys = () => generateKeyPairSync('ed25519')
const root = keys(),
  signer = keys(),
  now = Date.now(),
  expiry = now + 86400000
const publicKey = (pair: ReturnType<typeof keys>) =>
  String(pair.publicKey.export({ format: 'pem', type: 'spki' }))
const signed = (pair: ReturnType<typeof keys>, object: unknown): SignedBytes => {
  const bytes = Buffer.from(JSON.stringify(object))
  return {
    payload: bytes.toString('base64'),
    signature: sign(null, bytes, pair.privateKey).toString('base64'),
  }
}
const delegation = signed(root, {
  schema: 1,
  generation: 1,
  expires: expiry + 86400000,
  key: publicKey(signer),
})
const data = (version: string, name: string) =>
  Buffer.from(version + ' fixture for ' + name)
function catalog(sequence: number, version = '1.5.0') {
  const components = Object.fromEntries(
    componentIds.map((id) => [
      id,
      {
        version,
        minApp: id === 'app' ? '0.0.0' : '1.5.0',
        ...(id === 'app' ? { requires: { phonon: '1.5.0', whisper: '1.5.0' } } : {}),
        files: componentFiles[id].map((name) => {
          const bytes = data(version, name)
          return {
            name,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            url: `https://github.com/petrovortex/En-GYM/releases/download/v${version}/${id}-${name.split('/').at(-1)}`,
          }
        }),
      },
    ]),
  ) as Catalog['components']
  return { schema: 1 as const, sequence, expires: expiry, components }
}
const envelope = (c: Catalog) => ({ delegation, catalog: signed(signer, c) })
async function fixture() {
  const qa = resolve('.work/qa')
  await mkdir(qa, { recursive: true })
  const base = await mkdtemp(join(qa, 'en-gym-update-'))
  const paths = {
    app: join(base, 'program'),
    speech: join(base, 'speech'),
    work: join(base, 'updates'),
  }
  const profile = join(base, 'user')
  await mkdir(profile, { recursive: true })
  await atomicJson(join(paths.app, 'scripts', 'release-trust.json'), {
    schema: 1,
    root: publicKey(root),
  })
  await atomicJson(join(paths.app, 'package.json'), { version: '1.5.0' })
  const initial = catalog(1)
  for (const id of ['phonon', 'whisper'] as const)
    for (const file of initial.components[id].files) {
      const target = join(paths.speech, file.name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data('1.5.0', file.name))
    }
  const e = envelope(initial)
  await atomicJson(join(paths.work, 'pending.json'), { envelope: e, speechOnly: true })
  await applyPrepared(paths, { profile })
  return { base, paths, profile }
}
test('root delegation, rotation, expiry, replay, path and dependency checks', () => {
  const initial = catalog(1),
    env = envelope(initial)
  const { watermark } = verifyCatalog(env, publicKey(root))
  assert.throws(
    () => verifyCatalog({ ...env, catalog: signed(root, initial) }, publicKey(root)),
    /signature/,
  )
  assert.throws(
    () => verifyCatalog(env, publicKey(root), undefined, expiry + 5),
    /expired/,
  )
  assert.throws(
    () => verifyCatalog(env, publicKey(root), { ...watermark, sequence: 2 }),
    /older/,
  )
  const newer = {
    ...env,
    delegation: signed(root, {
      schema: 1,
      generation: 2,
      expires: expiry + 1000,
      key: publicKey(signer),
    }),
  }
  const rotated = verifyCatalog(newer, publicKey(root), watermark)
  assert.throws(() => verifyCatalog(env, publicKey(root), rotated.watermark), /older/)
  const invalid = catalog(2)
  invalid.components.whisper.files[0].name = '../private.sqlite'
  assert.throws(() => verifyCatalog(envelope(invalid), publicKey(root)), /file failed/)
  const incompatible = catalog(2)
  incompatible.components.phonon.minApp = '9.0.0'
  assert.throws(
    () => verifyCatalog(envelope(incompatible), publicKey(root)),
    /Incompatible/,
  )
})
test('failed downloads and corrupted staging leave previous build playable; only selected components apply', async () => {
  const { base, paths, profile } = await fixture()
  try {
    const next = catalog(2, '1.6.0'),
      e = envelope(next)
    const get: typeof fetch = async (url) => {
      const file = componentIds
        .flatMap((c) => next.components[c].files)
        .find((f) => f.url === url)
      return new Response(file ? data('1.6.0', file.name) : JSON.stringify(e))
    }
    const fetched = await fetchCatalog(paths, get)
    const available = await planUpdate(paths, fetched.catalog)
    assert.deepEqual(
      available.map((c) => c.component),
      componentIds,
    )
    const phonon = await selectChanges(paths, next, available, ['phonon'])
    await assert.rejects(
      stageUpdate(
        paths,
        next,
        phonon,
        () => {},
        async () => new Response('bad'),
      ),
      /verification/,
    )
    await stageUpdate(paths, next, phonon, () => {}, get)
    const file = next.components.phonon.files[0]
    await writeFile(stageFile(paths, file), 'bad')
    await atomicJson(join(paths.work, 'pending.json'), {
      envelope: e,
      speechOnly: false,
      selected: ['phonon'],
    })
    await assert.rejects(applyPrepared(paths, { profile }), /staged update/)
    await stageUpdate(paths, next, phonon, () => {}, get)
    await applyPrepared(paths, { profile })
    assert.deepEqual(
      await readFile(join(paths.speech, file.name)),
      data('1.6.0', file.name),
    )
    assert.deepEqual(
      (await planUpdate(paths, next)).map((c) => c.component),
      ['app', 'whisper'],
    )
    const requiresApp = catalog(3, '1.6.0')
    requiresApp.components.whisper.minApp = '1.6.0'
    await assert.rejects(
      selectChanges(paths, requiresApp, await planUpdate(paths, requiresApp), [
        'whisper',
      ]),
      /app update/,
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
test('two signed builds activate together and roll back matching SQLite snapshot on failed startup', async () => {
  const { base, paths, profile } = await fixture()
  try {
    const dbpath = join(profile, 'practice.sqlite')
    const db = new DatabaseSync(dbpath)
    db.exec("CREATE TABLE history(answer TEXT); INSERT INTO history VALUES('keep me')")
    db.close()
    const next = catalog(2, '1.6.0'),
      e = envelope(next)
    const changes = await planUpdate(paths, next)
    const files = componentIds.flatMap((id) => next.components[id].files)
    const stage = async () => {
      await stageUpdate(
        paths,
        next,
        changes,
        () => {},
        async (url) =>
          new Response(data('1.6.0', files.find((f) => f.url === url)!.name)),
      )
      await atomicJson(join(paths.work, 'pending.json'), {
        envelope: e,
        speechOnly: false,
      })
    }
    const install = async () =>
      atomicJson(join(paths.app, 'package.json'), { version: '1.6.0' })
    await stage()
    await assert.rejects(
      applyPrepared(paths, {
        profile,
        install,
        health: async () => {
          const changed = new DatabaseSync(dbpath)
          changed.exec('DROP TABLE history')
          changed.close()
          throw Error('fixture boot failed')
        },
      }),
      /fixture boot failed/,
    )
    assert.deepEqual(await jsonFile(join(paths.app, 'package.json')), {
      version: '1.5.0',
    })
    const recovered = new DatabaseSync(dbpath)
    assert.equal(recovered.prepare('SELECT answer FROM history').get()?.answer, 'keep me')
    recovered.close()
    assert.deepEqual(
      (await planUpdate(paths, next)).map((c) => c.component),
      componentIds,
    )
    await stage()
    assert.equal(
      await applyPrepared(paths, { profile, install, health: async () => {} }),
      'installed',
    )
    assert.deepEqual(await planUpdate(paths, next), [])
    assert.equal(await jsonFile(join(paths.work, 'pending.json')), undefined)
    assert.equal(await jsonFile(join(paths.work, 'recovery.json')), undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
test('restart after process loss during activation recovers program and database', async () => {
  const { base, paths, profile } = await fixture()
  try {
    const dbPath = join(profile, 'practice.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE attempts(id INTEGER); INSERT INTO attempts VALUES(71)')
    db.close()
    const next = catalog(2, '1.6.0')
    const files = componentIds.flatMap((id) => next.components[id].files)
    await stageUpdate(
      paths,
      next,
      await planUpdate(paths, next),
      () => {},
      async (url) => {
        const bytes = data('1.6.0', files.find((f) => f.url === url)!.name)
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes.subarray(0, 3))
              c.enqueue(bytes.subarray(3))
              c.close()
            },
          }),
        )
      },
    )
    await atomicJson(join(paths.work, 'pending.json'), {
      envelope: envelope(next),
      speechOnly: false,
    })
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {applyPrepared} from './scripts/release-apply.mjs'
      import {DatabaseSync} from 'node:sqlite'
      import {writeFile} from 'node:fs/promises'
      import {join} from 'node:path'
      const [paths,profile]=JSON.parse(process.argv[1])
      await applyPrepared(paths,{profile,install:async()=>{
        await writeFile(join(paths.app,'package.json'),JSON.stringify({version:'1.6.0'}))
        const db=new DatabaseSync(join(profile,'practice.sqlite'))
        db.exec('DROP TABLE attempts');db.close();process.exit(91)
      }})
    `,
        JSON.stringify([paths, profile]),
      ],
      { windowsHide: true, encoding: 'utf8' },
    )
    assert.equal(child.status, 91, child.stderr)
    assert.equal(await applyPrepared(paths, { profile }), 'recovered')
    assert.deepEqual(await jsonFile(join(paths.app, 'package.json')), {
      version: '1.5.0',
    })
    const recovered = new DatabaseSync(dbPath)
    assert.equal(recovered.prepare('SELECT id FROM attempts').get()?.id, 71)
    recovered.close()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
