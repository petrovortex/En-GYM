// Runs under Setup's extracted, pinned Node runtime.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const speech = process.env.FIELDWORK_SPEECH
if (!speech) throw Error('Missing speech component location.')
const json = async (name) => JSON.parse(await readFile(join(root, name), 'utf8'))
const trust = await json('scripts/release-trust.json')
if (trust.root) {
  const child = spawn(process.execPath, [join(root, 'scripts/release-bootstrap.mjs')], { windowsHide: true, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  // The signed bootstrap permits this only for the first install when the
  // public catalog is unavailable. Signature or validation errors are fatal.
  if (code === 20) await prepareBaseline()
  else if (code !== 0) throw Error('Could not verify the official component catalog.')
} else {
  await prepareBaseline()
}

async function matches(path, sha256) {
  try {
    const info = await lstat(path)
    if (!info.isFile()) return false
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    return hash.digest('hex') === sha256
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

async function download(url, path, maximum) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600000) })
  if (!response.ok || !response.body) throw Error('Could not download the speech component. Check your connection and retry.')
  let received = 0
  await pipeline(response.body, async function* (stream) {
    for await (const part of stream) {
      received += part.length
      if (received > maximum) throw Error('Component exceeds its download limit.')
      yield part
    }
  }, createWriteStream(path, { flags: 'wx' }))
}

async function prepareBaseline() {
  const phonon = await json('scripts/phonon-assets.json')
  const asr = await json('packaging/speech-baseline.json')
  const files = [
    ...phonon.files.map((f) => ({ ...f, path: join(phonon.folder, f.name) })),
    asr.model,
    ...Object.entries(asr.engineFiles).map(([name, sha256]) => ({ path: join('asr', name), sha256 })),
  ]
  // Reject a redirected download/activation directory before writing anything.
  for (const dir of [dirname(dirname(speech)), dirname(speech), speech, join(speech, phonon.folder), join(speech, 'asr')]) {
    await mkdir(dir, { recursive: true })
    if (!(await lstat(dir)).isDirectory()) throw Error('The component folder must be a regular directory.')
  }
  const stage = await mkdtemp(join(speech, '.setup-'))
  try {
    let members
    const verified = []
    const tar = join(process.env.SystemRoot, 'System32', 'tar.exe')
    const archive = join(stage, 'whisper.zip')
    for (const [index, file] of files.entries()) {
      console.log(`${index}/${files.length} ${basename(file.path)}`)
      const target = join(speech, file.path)
      if (await matches(target, file.sha256)) continue
      const temp = join(stage, randomUUID())
      if (file.url) {
        await download(file.url, temp, file.size ?? 70 * 1024 * 1024)
      } else {
        if (!members) {
          await download(asr.engineArchive.url, archive, 100 * 1024 * 1024)
          if (!await matches(archive, asr.engineArchive.sha256)) throw Error('Speech engine package failed verification.')
          members = execFileSync(tar, ['-tf', archive], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)
        }
        const names = members.filter((p) => p.split('/').pop() === basename(file.path))
        if (names.length !== 1) throw Error('Unexpected speech engine package contents.')
        const child = spawn(tar, ['-xOf', archive, names[0]], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        await Promise.all([pipeline(child.stdout, createWriteStream(temp, { flags: 'wx' })),
          new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', (code) => code === 0 ? resolve() : reject(Error('Could not unpack the speech engine.')))
          })])
      }
      if (!await matches(temp, file.sha256)) throw Error('Speech component failed verification: ' + basename(file.path))
      verified.push({ temp, target })
    }
    for (const file of verified) await rename(file.temp, file.target)
    console.log(`${files.length}/${files.length} English speech is ready`)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
