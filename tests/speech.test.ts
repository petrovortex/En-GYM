import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import {
  mkdtempDisposableSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PhononEngine, PHONON_PACK } from '../server/phonon.ts'
import {
  wave,
  wavInfo,
  inspectPromptAudio,
  promptAudioReady,
  audioKey,
  promptVoice,
  promptPack,
} from '../server/speech.ts'
import type { Item } from '../core/types.ts'
import { promptUrl } from '../core/speech.ts'

const q: Item = {
  id: 'test',
  task: 'conversation',
  level: 1,
  title: 'Conversation',
  prompt: 'Listen.',
  group: 'shared-text',
  speech:
    'Could you help me find this book?\nOf course. Let me check the catalog.',
}
const pcm = Buffer.alloc(24000 * 2)
for (let i = 0; i < 24000; i++)
  pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 4000), i * 2)

test('voice selection keeps speakers consistent within a passage and changes old cache keys', () => {
  assert.notEqual(promptVoice(q, 0), promptVoice(q, 1))
  assert.equal(promptVoice(q, 0), promptVoice(q, 2))
  assert.equal(
    audioKey(q),
    audioKey({ ...q, id: 'another-question', title: 'Different question' }),
  )
  assert.notEqual(
    audioKey(q),
    audioKey({ ...q, speech: q.speech + ' More text.' }),
  )
  assert.match(PHONON_PACK, /^phonon-/)
  assert.match(promptUrl('/api/voice-preview'), /\?voice=phonon-/)
  assert.match(
    promptUrl('/api/reference?id=example'),
    /\?id=example&voice=phonon-/,
  )
})

test('prompt validation rejects truncated, silent and implausibly short output', () => {
  const valid = wave(pcm, 24000)
  assert.equal(inspectPromptAudio(valid).duration, 1)
  assert.throws(
    () => wavInfo(valid.subarray(0, valid.length - 2)),
    /Invalid WAV/,
  )
  assert.throws(
    () => inspectPromptAudio(wave(Buffer.alloc(48000), 24000)),
    /silent/,
  )
  assert.throws(
    () => inspectPromptAudio(valid, 'word '.repeat(100)),
    /duration/,
  )
  assert.throws(() => inspectPromptAudio(wave(pcm, 16000)), /24 kHz/)
  const bad = Buffer.from(valid)
  bad.writeUInt32LE(pcm.length + 200, 40)
  assert.throws(() => wavInfo(bad), /Truncated/)
})

test('readiness rechecks damaged or repaired audio instead of trusting file existence', (t) => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'toefl-wave-'))
  t.after(() => temp.remove())
  const path = join(temp.path, 'clip.wav')
  assert.equal(promptAudioReady(path), false)
  writeFileSync(path, wave(pcm, 24000))
  assert.equal(promptAudioReady(path), true)
  writeFileSync(path, Buffer.alloc(100))
  assert.equal(promptAudioReady(path), false)
  writeFileSync(path, wave(pcm, 24000))
  assert.equal(promptAudioReady(path), true)
})

test('only a change to voice bytes or synthesis settings makes a playable WAV stale', (t) => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'en-gym-voice-'))
  t.after(() => temp.remove())
  const dir = join(temp.path, 'En-GYM', 'updates')
  mkdirSync(dir, { recursive: true })
  const receipt = join(dir, 'installed.json')
  assert.equal(promptPack(receipt), PHONON_PACK)
  const phonon = { version: '1.0.0', digest: '1'.repeat(64) }
  writeFileSync(receipt, JSON.stringify({ phonon }))
  const first = promptPack(receipt)
  writeFileSync(receipt, JSON.stringify({ phonon, whisper: { version: '2.0.0', digest: '2'.repeat(64) } }))
  assert.equal(promptPack(receipt), first)

  const path = join(temp.path, audioKey(q) + '.wav')
  const old = wave(pcm, 24000, first)
  writeFileSync(path, old)
  writeFileSync(receipt, JSON.stringify({ phonon: { version: '1.1.0', digest: '3'.repeat(64) } }))
  assert.notEqual(promptPack(receipt), first)
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    import { readFileSync, writeFileSync } from 'node:fs'
    import { synth, audioKey, voicePack, promptAudioReady, wavInfo, wave } from './server/speech.ts'
    const [dir, item] = process.argv.slice(1)
    const q = JSON.parse(item)
    const path = join(dir, audioKey(q) + '.wav')
    const old = readFileSync(path)
    assert.ok(promptAudioReady(path))
    assert.equal(promptAudioReady(path, true), false)
    await assert.rejects(synth(q, dir), /voices are missing/)
    assert.deepEqual(readFileSync(path), old)
    writeFileSync(path, wave(wavInfo(old).pcm, 24000, voicePack))
    assert.ok(promptAudioReady(path, true))
    await synth(q, dir)
  `, temp.path, JSON.stringify(q)], { windowsHide: true, env: { ...process.env,
    LOCALAPPDATA: temp.path, EN_GYM_INSTALLED: '1', FIELDWORK_SPEECH: join(temp.path, 'missing-voices') } })
  assert.equal(readdirSync(temp.path).filter((s) => s.endsWith('.wav')).length, 1)
  if (process.env.FIELDWORK_REAL_SPEECH === '1') {
    // Boot the real synthesizer twice as the installed launcher would,
    // keeping the same cache and changing only the signed voice receipt.
    writeFileSync(path, old)
    for (const digit of ['4', '5']) {
      writeFileSync(receipt, JSON.stringify({ phonon: { version: '1.2.0', digest: digit.repeat(64) } }))
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict'
        import { join } from 'node:path'
        import { synth, closeSpeech, audioKey, promptAudioReady } from './server/speech.ts'
        const [dir, item] = process.argv.slice(1)
        const q = JSON.parse(item), path = join(dir, audioKey(q) + '.wav')
        assert.ok(promptAudioReady(path))
        assert.equal(promptAudioReady(path, true), false)
        try { await synth(q, dir) } finally { closeSpeech() }
        assert.ok(promptAudioReady(path, true))
      `, temp.path, JSON.stringify(q)], { windowsHide: true, env: { ...process.env,
        LOCALAPPDATA: temp.path, EN_GYM_INSTALLED: '1', FIELDWORK_SPEECH: resolve('.work/speech') } })
      assert.equal(readdirSync(temp.path).filter((s) => s.endsWith('.wav')).length, 3)
    }
  }
})

test('Phonon worker reuses its model and recovers after errors, exits and a timeout', async () => {
  const engine = new PhononEngine('unused', {
    workerUrl: new URL('./fixtures/phonon-worker.mjs', import.meta.url),
    timeoutMs: 700,
  })
  try {
    assert.equal((await engine.generate('one', 'default'))[0], 1)
    assert.equal((await engine.generate('two', 'hadley'))[0], 2)
    await assert.rejects(engine.generate('error', 'default'), /Fixture/)
    assert.equal((await engine.generate('new worker', 'preston'))[0], 1)
    await assert.rejects(engine.generate('crash', 'default'), /stopped/)
    assert.equal((await engine.generate('recovered', 'default'))[0], 1)
    const pending = engine.generate('hang', 'default')
    await assert.rejects(engine.generate('overlap', 'default'), /busy/)
    await assert.rejects(pending, /timed out/)
    assert.equal((await engine.generate('after timeout', 'default'))[0], 1)
  } finally {
    engine.close()
  }
})

test(
  'real Phonon prepares a two-voice conversation once, reuses it, and repairs corruption',
  { skip: process.env.FIELDWORK_REAL_SPEECH !== '1' },
  async (t) => {
    const { synth, closeSpeech } = await import('../server/speech.ts')
    const temp = mkdtempDisposableSync(join(tmpdir(), 'toefl-phonon-'))
    t.after(() => temp.remove())
    const dir = temp.path
    try {
      await Promise.all([synth(q, dir), synth(q, dir)])
      const path = join(dir, audioKey(q) + '.wav'),
        original = readFileSync(path)
      assert.ok(inspectPromptAudio(original, q.speech).duration > 2)
      assert.equal(readdirSync(dir).filter((f) => f.endsWith('.wav')).length, 3)
      await synth(q, dir, () => {
        throw Error('Cached audio must not synthesize again')
      })
      writeFileSync(path, Buffer.alloc(12))
      await synth(q, dir)
      assert.deepEqual(readFileSync(path), original)
      let regenerated = false
      await synth(
        q,
        dir,
        () => {
          regenerated = true
        },
        { force: true },
      )
      assert.ok(regenerated)
      assert.deepEqual(readFileSync(path), original)
      assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0)
    } finally {
      closeSpeech()
    }
  },
)

test(
  'a warm Phonon model resets generation state across voices',
  { skip: process.env.FIELDWORK_REAL_SPEECH !== '1' },
  async () => {
    const engine = new PhononEngine(resolve('.work/speech/phonon-31m-en'))
    try {
      const text = 'Please leave your books on the table.'
      const first = await engine.generate(text, 'default')
      const other = await engine.generate(text, 'preston')
      const again = await engine.generate(text, 'default')
      assert.notDeepEqual(other, first)
      assert.deepEqual(again, first)
      assert.ok(inspectPromptAudio(wave(first, 24000), text).duration > 1)
    } finally {
      engine.close()
    }
  },
)
