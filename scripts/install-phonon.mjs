import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const scripts = dirname(fileURLToPath(import.meta.url))
const manifestBytes = await readFile(join(scripts, 'phonon-assets.json'))
const manifest = JSON.parse(manifestBytes)
const targetIndex = process.argv.indexOf('--target')
if (targetIndex >= 0 && !process.argv[targetIndex + 1])
  throw Error('--target needs a directory.')
const speech = resolve(
  targetIndex >= 0
    ? process.argv[targetIndex + 1]
    : join(scripts, '../.work/speech'),
)
const folder = join(speech, manifest.folder),
  run = promisify(execFile)
async function hash(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
await mkdir(folder, { recursive: true })
for (const file of manifest.files) {
  const path = join(folder, file.name)
  if ((await hash(path).catch(() => '')) === file.sha256) continue
  if (process.argv.includes('--check'))
    throw Error('Phonon installation needs repair: ' + file.name)
  console.log('Downloading local English speech: ' + file.name)
  const temp = path + '.' + randomUUID() + '.download'
  try {
    await run(
      'curl.exe',
      [
        '-fL',
        '--silent',
        '--show-error',
        '--retry',
        '3',
        '--retry-all-errors',
        '--connect-timeout',
        '20',
        '--max-time',
        '600',
        '-o',
        temp,
        file.url,
      ],
      { windowsHide: true, timeout: 650000, maxBuffer: 1e6 },
    )
    if ((await hash(temp)) !== file.sha256)
      throw Error('Phonon download failed verification: ' + file.name)
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}
await writeFile(
  join(speech, 'phonon-assets.sha256'),
  createHash('sha256').update(manifestBytes).digest('hex'),
)
console.log('Local Phonon voices are verified and ready.')
