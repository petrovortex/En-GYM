import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const { installedHealth } = await import(pathToFileURL(join(process.cwd(), 'scripts/release-apply.mjs')))
const { checkedEnvelope, jsonFile, planUpdate, updatePaths } = await import(pathToFileURL(join(process.cwd(), 'server/updates.ts')))
const paths = updatePaths()
mkdirSync(paths.work, { recursive: true })
const signed = await jsonFile(join(paths.work, 'bootstrap-catalog.json'))
let catalog
if (signed) {
  catalog = (await checkedEnvelope(paths, signed)).catalog
} else {
  const versions = JSON.parse(readFileSync(new URL('../scripts/release-versions.json', import.meta.url)))
  const { componentFiles } = await import(pathToFileURL(join(process.cwd(), 'core/updates.ts')))
  const components = { app: { version } }
  for (const id of ['phonon', 'whisper']) {
    const files = componentFiles[id].map(name => {
      const data = readFileSync(join(paths.speech, name))
      return { name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    })
    components[id] = { ...versions[id], files }
  }
  catalog = { components }
}
assert.deepEqual(await planUpdate(paths, catalog, true), [], 'Verified speech must already be current.')
await installedHealth(paths, false)
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const { port } = reservation.address()
await new Promise((resolve) => reservation.close(resolve))
const origin = 'http://127.0.0.1:' + port
for (let i = 0; i < 2; i++) {
  const local = spawn(process.execPath, ['server/main.ts'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FIELDWORK_PORT: String(port) },
  })
  const ended = once(local, 'exit')
  const timeout = setTimeout(() => local.kill(), 20000)
  const output = createInterface({ input: local.stdout })[Symbol.asyncIterator]()
  try {
    assert.equal((await output.next()).value, 'EN_GYM_READY')
    assert.equal((await fetch(origin + '/api/history')).status, 401)
    local.stdin.write('OPEN\n')
    const handoff = (await output.next()).value
    assert.ok(handoff.startsWith('EN_GYM_OPEN ' + origin + '/launch#'))
    const ticket = handoff.split('#')[1]
    const exchange = () => fetch(origin + '/api/local-session', {
      method: 'POST', headers: { Origin: origin, 'x-fieldwork': 'local', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    const result = await exchange()
    assert.equal(result.status, 200)
    const { session } = await result.json()
    assert.equal((await exchange()).status, 403)
    const status = await fetch(origin + '/api/status', { headers: { Authorization: 'Bearer ' + session } })
    assert.equal((await status.json()).release, version)
  } finally {
    local.stdin.end('QUIT\n')
    const [code] = await ended
    clearTimeout(timeout)
    assert.equal(code, 0, 'The installed service must shut down cleanly.')
  }
}
