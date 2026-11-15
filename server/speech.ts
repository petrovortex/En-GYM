import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Item } from '../core/types.ts'
import { ORIGINAL_PROMPT_PACK } from '../core/speech.ts'
import { PHONON_PACK, PHONON_VOICES, PhononEngine } from './phonon.ts'
const run = promisify(execFile)
export const speechRoot = resolve(
  process.env.FIELDWORK_SPEECH ??
    (existsSync('speech') ? 'speech' : '.work/speech'),
)
const model = join(speechRoot, 'phonon-31m-en')
const phonon = new PhononEngine(model)
const asr = join(speechRoot, 'asr', 'whisper-cli.exe')
const installed = process.env.EN_GYM_INSTALLED === '1'
const cacheSlot = installed ? ORIGINAL_PROMPT_PACK : PHONON_PACK
export function promptPack(receiptFile: string) {
  try {
    const { phonon } = JSON.parse(readFileSync(receiptFile, 'utf8'))
    if (phonon === undefined) return PHONON_PACK
    if (!/^[a-f0-9]{64}$/.test(phonon?.digest ?? '')) throw Error('Invalid Phonon receipt.')
    return PHONON_PACK + '-' + phonon.digest
  } catch (e) {
    // Local builds can use the pinned baseline without a release receipt.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return PHONON_PACK
    throw Error('The installed voice receipt is unreadable. Run En-GYM Setup to repair it.')
  }
}
export const voicePack = installed
  ? promptPack(join(process.env.LOCALAPPDATA!, 'En-GYM', 'updates', 'installed.json'))
  : PHONON_PACK
const packDigest = (pack: string) => createHash('sha256').update(pack).digest()
const unmarkedVersion = packDigest(cacheSlot).toString('hex')
export function promptVoice(q: Item, line: number) {
  const seed = createHash('sha256')
    .update(q.group ?? q.speech ?? q.title)
    .digest()[0]
  if (q.task === 'conversation') return (line + seed) % 2 ? 'preston' : 'hadley'
  return PHONON_VOICES[seed % PHONON_VOICES.length]
}
export const audioKey = (q: Item) =>
  createHash('sha256')
    .update(
      [cacheSlot, q.task, promptVoice(q, 0), promptVoice(q, 1), q.speech].join(
        '|',
      ),
    )
    .digest('hex')
export function wave(pcm: Buffer, rate: number, pack?: string) {
  const h = Buffer.alloc(44)
  // A private RIFF chunk associates the namespace with the exact PCM bytes.
  // Normal WAV players skip it; one atomic rename publishes both together.
  const tag = Buffer.alloc(pack ? 40 : 0)
  if (pack) {
    tag.write('egvp')
    tag.writeUInt32LE(32, 4)
    packDigest(pack).copy(tag, 8)
  }
  h.write('RIFF')
  h.writeUInt32LE(36 + pcm.length + tag.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm, tag])
}
export function wavInfo(b: Buffer) {
  if (
    b.length < 44 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE' ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    throw Error('Invalid WAV recording.')
  let rate = 0
  let pcm: Buffer | undefined
  let version: string | undefined
  for (let pos = 12; pos + 8 <= b.length;) {
    const n = b.readUInt32LE(pos + 4),
      tag = b.toString('ascii', pos, pos + 4),
      end = pos + 8 + n
    if (end > b.length) throw Error('Truncated WAV chunk.')
    if (
      tag === 'fmt ' &&
      n >= 16 &&
      b.readUInt16LE(pos + 8) === 1 &&
      b.readUInt16LE(pos + 10) === 1 &&
      b.readUInt16LE(pos + 22) === 16 &&
      b.readUInt16LE(pos + 20) === 2 &&
      b.readUInt32LE(pos + 16) === b.readUInt32LE(pos + 12) * 2
    )
      rate = b.readUInt32LE(pos + 12)
    if (tag === 'data' && n > 0 && n % 2 === 0) pcm = b.subarray(pos + 8, end)
    if (tag === 'egvp' && n === 32) version = b.toString('hex', pos + 8, end)
    pos = end + (n % 2)
    if (pos < b.length && pos + 8 > b.length)
      throw Error('Truncated WAV chunk header.')
  }
  if (rate >= 8000 && rate <= 192000 && pcm) return { rate, pcm, version }
  throw Error('Expected mono 16-bit PCM audio.')
}
export function inspectPromptAudio(b: Buffer, text?: string) {
  const { rate, pcm, version } = wavInfo(b)
  if (rate !== 24000) throw Error('Expected a 24 kHz speech prompt.')
  const samples = pcm.length / 2,
    duration = samples / rate
  let energy = 0,
    peak = 0
  for (let i = 0; i < pcm.length; i += 2) {
    const n = pcm.readInt16LE(i) / 32768
    energy += n * n
    peak = Math.max(peak, Math.abs(n))
  }
  const rms = Math.sqrt(energy / samples)
  if (duration < 0.1 || rms < 0.0001)
    throw Error('The speech prompt is empty or silent.')
  if (text) {
    const words = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
    if (
      duration < Math.max(0.1, words / 9 - 0.5) ||
      duration > Math.max(12, words * 1.5 + 8)
    )
      throw Error(
        'The generated audio duration does not match the prompt. Please prepare it again.',
      )
  }
  return { duration, rate, rms, peak, bytes: b.length, version }
}
const checkedAudio = new Map<string, { stamp: string; version?: string }>()
const currentVersion = packDigest(voicePack).toString('hex')
export function promptAudioReady(path: string, requireCurrent = false) {
  try {
    const s = statSync(path)
    const stamp = `${s.size}:${s.mtimeMs}:${s.ctimeMs}`
    let checked = checkedAudio.get(path)
    if (checked?.stamp !== stamp) {
      checked = { stamp }
      try {
        checked.version = inspectPromptAudio(readFileSync(path)).version ?? unmarkedVersion
      } catch {}
      if (checkedAudio.size > 10000) checkedAudio.clear()
      checkedAudio.set(path, checked)
    }
    return requireCurrent ? checked.version === currentVersion : !!checked.version
  } catch {
    checkedAudio.delete(path)
    return false
  }
}
const jobs = new Map<string, Promise<void>>()
let audioWorker: Promise<unknown> = Promise.resolve()
export function closeSpeech() {
  phonon.close()
}
export async function synth(
  q: Item,
  cache: string,
  checkpoint?: () => void,
  options: { force?: boolean } = {},
) {
  const key = audioKey(q),
    path = join(cache, key + '.wav')
  if (!options.force && promptAudioReady(path, true)) return
  if (jobs.has(path)) return jobs.get(path)
  async function generate() {
    if (!existsSync(join(model, 'model.q8.gguf')))
      throw Error(
        'The local practice voices are missing. Run En-GYM Setup again to restore them.',
      )
    mkdirSync(cache, { recursive: true })
    const segments: Buffer[] = []
    let rate = 24000
    const lines =
      q.speech
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean) ?? []
    if (!lines.length)
      throw Error('There is no text to prepare for this audio prompt.')
    for (const [i, line] of lines.entries()) {
      const sid = promptVoice(q, i)
      const hash = createHash('sha256')
        .update(cacheSlot + '|' + sid + '|' + line)
        .digest('hex')
      const single = lines.length === 1 ? path : join(cache, hash + '.wav')
      if (options.force || !promptAudioReady(single, true)) {
        checkpoint?.()
        const tmp = single + '.' + randomUUID() + '.wav'
        try {
          const pcm = await phonon.generate(line, sid)
          writeFileSync(tmp, wave(pcm, 24000, voicePack))
          inspectPromptAudio(readFileSync(tmp), line)
          renameSync(tmp, single)
        } finally {
          if (existsSync(tmp)) unlinkSync(tmp)
        }
      }
      const wav = wavInfo(readFileSync(single))
      rate = wav.rate
      if (i) segments.push(Buffer.alloc(Math.round(rate * 0.22) * 2))
      segments.push(wav.pcm)
    }
    if (lines.length === 1) return
    checkpoint?.()
    const tmp = path + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(tmp, wave(Buffer.concat(segments), rate, voicePack))
      inspectPromptAudio(readFileSync(tmp), q.speech)
      renameSync(tmp, path)
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp)
    }
  }
  // One local synthesizer at a time, including reserve warm-up and newly authored audio.
  const work = audioWorker.then(generate).finally(() => jobs.delete(path))
  audioWorker = work.catch(() => {})
  jobs.set(path, work)
  return work
}
export async function transcribe(path: string) {
  if (!existsSync(asr))
    throw Error('The offline transcription engine is missing.')
  const { stdout } = await run(
    asr,
    [
      '-m',
      join(speechRoot, 'ggml-base.en-q5_1.bin'),
      '-f',
      path,
      '-l',
      'en',
      '-nt',
      '-np',
      '-t',
      '3',
    ],
    { windowsHide: true, timeout: 120000, maxBuffer: 2e6 },
  )
  return stdout.trim().replace(/\s+/g, ' ')
}
