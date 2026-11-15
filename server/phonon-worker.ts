import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initSync, Model } from 'phonon-tts/raw'
import { PHONON_VOICES, type PhononVoice } from './phonon.ts'

// The official WASM model runs directly in Node, so no browser, Python or native TTS executable is needed.
let model: Model | undefined
const voices = new Map<PhononVoice, number>()
const root = workerData.root as string
async function load() {
  if (model) return model
  const wasm = fileURLToPath(
    import.meta.resolve('phonon-tts/wasm/phonon_tts_bg.wasm'),
  )
  const read = async (file: string) => {
    try {
      return new Uint8Array(await readFile(join(root, file)))
    } catch {
      throw new Error(
        'The local practice voices are missing or unreadable. Run En-GYM Setup again to restore them.',
      )
    }
  }
  const [weights, tokenizer, config] = await Promise.all([
    read('model.q8.gguf'),
    read('tokenizer.json'),
    read('config.json'),
  ])
  initSync({ module: new Uint8Array(await readFile(wasm)) })
  model = await Model.load(
    weights,
    tokenizer,
    config,
    'q8',
    'en',
    'all',
    undefined,
    'cpu',
  )
  if (model.sample_rate() !== 24000)
    throw new Error(
      'Unexpected Phonon audio sample rate. Reopen the launcher to check the installation.',
    )
  return model
}

parentPort!.on(
  'message',
  async ({
    id,
    text,
    voice,
  }: {
    id: number
    text: string
    voice: PhononVoice
  }) => {
    try {
      if (!PHONON_VOICES.includes(voice))
        throw new Error('Unknown Phonon voice.')
      const engine = await load()
      if (!voices.has(voice)) {
        const bytes = await readFile(join(root, voice + '-voice.safetensors'))
        voices.set(voice, engine.add_voice(new Uint8Array(bytes)))
        await engine.flush()
      }
      const chunks: Buffer[] = []
      let samples = 0,
        energy = 0
      engine.start_generation(voices.get(voice)!, text, 0.3, 4242424242424242n)
      try {
        while (engine.next_chunk() !== undefined) {
          for (;;) {
            const frame = (await engine.generation_step()) as
              Float32Array | undefined
            if (frame === undefined) break
            samples += frame.length
            if (samples > 24000 * 300)
              throw new Error('Phonon exceeded the maximum prompt duration.')
            const pcm = Buffer.allocUnsafe(frame.length * 2)
            for (let i = 0; i < frame.length; i++) {
              if (!Number.isFinite(frame[i]))
                throw new Error('Phonon produced invalid audio samples.')
              const n = Math.max(-1, Math.min(1, frame[i]))
              energy += n * n
              // Match the official Phonon WAV writer; do not change playback speed or loudness.
              pcm.writeInt16LE(Math.trunc(n * 32767), i * 2)
            }
            chunks.push(pcm)
          }
        }
      } finally {
        engine.stop_generation()
      }
      if (samples < 2400 || energy / samples < 1e-8)
        throw new Error('Phonon produced an empty or silent prompt.')
      const pcm = Uint8Array.from(Buffer.concat(chunks))
      parentPort!.postMessage({ id, pcm }, [pcm.buffer])
    } catch (error) {
      parentPort!.postMessage({ id, error: (error as Error).message })
    }
  },
)
