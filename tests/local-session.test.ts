import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { LocalSessions } from '../server/local-session.ts'

test('launch credentials are separate, short-lived and single-use', (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const sessions = new LocalSessions()
  const ticket = sessions.ticket()
  assert.equal(sessions.authenticated('Bearer ' + ticket), false)
  const session = sessions.exchange(ticket)
  assert.ok(session)
  assert.equal(sessions.exchange(ticket), undefined)
  assert.equal(sessions.authenticated('Bearer ' + session), true)
  const unused = sessions.ticket()
  now += 61_000
  assert.equal(sessions.exchange(unused), undefined)
  now += 24 * 60 * 60 * 1000
  assert.equal(sessions.authenticated('Bearer ' + session), false)
})

test('installed mode authorizes API and media through the tray and isolates its profile', { timeout: 25_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'en-gym-session-'))
  const reserved = createServer()
  reserved.listen(0, '127.0.0.1')
  await once(reserved, 'listening')
  const port = (reserved.address() as AddressInfo).port
  await new Promise<void>((done) => reserved.close(() => done()))
  const origin = 'http://127.0.0.1:' + port
  const legacy = join(root, 'source')
  const child = spawn(process.execPath, ['server/main.ts'], {
    windowsHide: true, stdio: 'pipe',
    env: { ...process.env, EN_GYM_INSTALLED: '1', FIELDWORK_PORT: String(port),
      LOCALAPPDATA: root, FIELDWORK_DATA: legacy, FIELDWORK_SPEECH: join(root, 'speech') },
  })
  const exited = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
    assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()))
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let diagnostic = ''
  child.stderr.on('data', (s) => { diagnostic += s })
  assert.equal((await lines.next()).value, 'EN_GYM_READY', diagnostic)
  assert.ok(existsSync(join(root, 'En-GYM', 'user', 'practice.sqlite')))
  assert.equal(existsSync(legacy), false)
  for (const path of ['/api/status', '/api/history', '/api/prefs', '/api/updates/status',
    '/api/stimulus', '/audio/sample.wav', '/clips/sample.wav'])
    assert.equal((await fetch(origin + path)).status, 401, path)

  child.stdin.write('OPEN\n')
  const open = String((await lines.next()).value)
  assert.ok(open.startsWith('EN_GYM_OPEN ' + origin + '/launch#'))
  const ticket = open.split('#')[1]
  assert.match(ticket, /^[a-f\d]{64}$/)
  const post = (path: string, requestOrigin: string, value: object, auth = '') =>
    fetch(origin + path, { method: 'POST', headers: { origin: requestOrigin,
      'content-type': 'application/json', 'x-fieldwork': 'local', authorization: auth },
      body: JSON.stringify(value) })
  assert.equal((await post('/api/local-session', 'http://other.invalid', { ticket })).status, 403)
  const first = await post('/api/local-session', origin, { ticket })
  assert.equal(first.status, 200)
  const auth = 'Bearer ' + (await first.json()).session
  assert.equal((await post('/api/local-session', origin, { ticket })).status, 403)
  assert.equal((await fetch(origin + '/api/history', { headers: { authorization: auth } })).status, 200)
  assert.equal((await post('/api/activity', 'http://other.invalid', {}, auth)).status, 403)
  assert.equal((await post('/api/activity', origin, { active: false }, auth)).status, 200)
  assert.equal((await post('/api/activity', origin, { active: false })).status, 401)
  const upload = request(origin + '/api/activity', { method: 'POST', headers: {
    origin, authorization: auth, 'x-fieldwork': 'local', expect: '100-continue',
  } })
  const admitted = once(upload, 'continue')
  const finished = once(upload, 'response')
  upload.flushHeaders()
  await admitted
  try {
    const blocked = await post('/api/updates/install', origin, { components: ['phonon'] }, auth)
    assert.equal(blocked.status, 400)
    assert.match((await blocked.json()).error, /Finish your current activity/)
  } finally {
    upload.end(JSON.stringify({ active: false }))
    const [reply] = await finished
    reply.resume()
    assert.equal(reply.statusCode, 200)
  }
  assert.equal((await post('/api/updates/install', origin, { components: ['phonon'] }, auth)).status, 200)
  child.stdin.write('QUIT\n')
  assert.equal((await exited)[0], 0, diagnostic)
})
