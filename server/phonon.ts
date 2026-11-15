import { Worker } from 'node:worker_threads'

import { PHONON_VOICES, type PhononVoice } from '../core/speech.ts'
export { PHONON_PACK, PHONON_VOICES, type PhononVoice } from '../core/speech.ts'

/** One warm, isolated model. Idle CLI processes may exit without keeping it alive. */
export class PhononEngine {
  private worker?: Worker
  private idle?: NodeJS.Timeout
  private pending?: {
    id: number
    resolve: (value: Buffer) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }
  private sequence = 0
  private readonly root: string
  private readonly options: {
    workerUrl?: URL
    timeoutMs?: number
    idleMs?: number
  }

  constructor(
    root: string,
    options: { workerUrl?: URL; timeoutMs?: number; idleMs?: number } = {},
  ) {
    this.root = root
    this.options = options
  }

  private start() {
    if (this.worker) return this.worker
    const worker = new Worker(
      this.options.workerUrl ?? new URL('./phonon-worker.ts', import.meta.url),
      {
        workerData: { root: this.root },
        // A parent launched with `node --input-type=module -e ...` cannot pass that flag to a file worker.
        execArgv: [],
      },
    )
    this.worker = worker
    worker.on(
      'message',
      (message: { id: number; pcm?: Uint8Array; error?: string }) => {
        if (this.worker !== worker || message.id !== this.pending?.id) return
        if (message.error || !(message.pcm instanceof Uint8Array)) {
          this.fail(new Error(message.error || 'Phonon returned no audio.'))
          return
        }
        const pending = this.pending
        this.pending = undefined
        clearTimeout(pending.timeout)
        worker.unref()
        this.idle = setTimeout(() => this.close(), this.options.idleMs ?? 60000)
        this.idle.unref()
        pending.resolve(Buffer.from(message.pcm))
      },
    )
    worker.on('error', (error) => {
      if (this.worker === worker) this.fail(error)
    })
    worker.on('exit', () => {
      if (this.worker === worker)
        this.fail(
          new Error(
            'The local Phonon worker stopped. Try preparing the audio again.',
          ),
        )
    })
    return worker
  }

  private fail(error: Error) {
    const pending = this.pending
    this.pending = undefined
    if (pending) clearTimeout(pending.timeout)
    clearTimeout(this.idle)
    const worker = this.worker
    this.worker = undefined
    if (worker) void worker.terminate()
    pending?.reject(error)
  }

  generate(text: string, voice: PhononVoice): Promise<Buffer> {
    if (!text.trim() || text.length > 12000)
      return Promise.reject(
        new Error('The speech prompt is empty or too long.'),
      )
    if (!PHONON_VOICES.includes(voice))
      return Promise.reject(new Error('Unknown Phonon voice.'))
    if (this.pending)
      return Promise.reject(
        new Error('The local voice worker is already busy.'),
      )
    clearTimeout(this.idle)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      try {
        const worker = this.start()
        const timeout = setTimeout(
          () =>
            this.fail(
              new Error(
                'Local voice preparation timed out. Try again when the computer is less busy.',
              ),
            ),
          this.options.timeoutMs ?? 180000,
        )
        this.pending = { id, resolve, reject, timeout }
        worker.ref()
        worker.postMessage({ id, text, voice })
      } catch (error) {
        this.fail(error as Error)
        reject(error)
      }
    })
  }

  close() {
    this.fail(new Error('Local voice preparation was stopped.'))
  }
}
