import assert from 'node:assert/strict'
import test from 'node:test'
import { silentRecording } from '../server/recording.ts'

test('silence earns zero but a brief audible response remains gradable', () => {
  const pcm = Buffer.alloc(32000)
  assert.ok(silentRecording(pcm, 16000))
  for (let i = 31360; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 160 : -160, i)
  assert.equal(silentRecording(pcm, 16000), false)
})
