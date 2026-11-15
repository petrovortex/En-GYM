import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright-core'
import { wave } from '../server/speech.ts'

const root = mkdtempSync(join(tmpdir(), 'en-gym-browser-'))
const reserved = createServer()
reserved.listen(0, '127.0.0.1')
await once(reserved, 'listening')
const port = reserved.address().port
await new Promise((done) => reserved.close(done))
const origin = 'http://127.0.0.1:' + port
const env = { ...process.env, EN_GYM_INSTALLED: '1', LOCALAPPDATA: root,
  FIELDWORK_PORT: String(port), FIELDWORK_SPEECH: join(root, 'speech-fixture') }
const identity = '54b7dd5f-4c4e-4c20-b5a1-cdb1701552c1'
const attempt = {
  id: 'private-speaking', mode: 'drill', focus: 'repeat', rules: 1,
  seed: 1, started: 1000, ended: 3000, stage: 0, index: 0,
  deadline: 0, itemStarted: 0, bands: {}, messages: [],
  stages: [{ section: 'Speaking', name: 'Speaking', minutes: 0, items: [{
    id: 'spoken', level: 2, title: 'Session test', task: 'repeat', prompt: 'Listen and repeat.',
  }] }], answers: { spoken: { clip: identity, elapsed: 2 } },
}
let browser, child, lines, exit
async function start() {
  child = spawn(process.execPath, ['server/main.ts'], { env, stdio: 'pipe', windowsHide: true })
  exit = once(child, 'exit')
  lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  assert.equal((await lines.next()).value, 'EN_GYM_READY')
}
async function open() {
  child.stdin.write('OPEN\n')
  const line = (await lines.next()).value
  assert.ok(line.startsWith('EN_GYM_OPEN ' + origin + '/launch#'))
  return line.slice('EN_GYM_OPEN '.length)
}
async function quit() {
  if (!child || child.exitCode !== null) return
  child.stdin.write('QUIT\n')
  assert.equal((await exit)[0], 0)
}
try {
  execFileSync(process.execPath, ['--input-type=module','-e',
    "import {save} from './server/store.ts'; save(" + JSON.stringify(attempt) + ')'], { env, windowsHide: true })
  writeFileSync(join(root, 'En-GYM', 'user', 'recordings', identity + '.wav'), wave(Buffer.alloc(32_000), 16_000))
  // Ensure a candidate can migrate/check its own profile without a listening server.
  execFileSync(process.execPath, ['server/main.ts', '--verify-update'], { env, windowsHide: true })
  await start()
  browser = await chromium.launch({ headless: true, executablePath: process.env.FIELDWORK_CHROME ??
    'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.setDefaultTimeout(12000)
  const openUrl = await open()
  await page.goto(openUrl)
  await page.waitForURL(origin + '/')
  const authHistory = () => page.evaluate(async () => {
    const r = await fetch('/api/history', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('en-gym-session') } })
    return r.status
  })
  assert.equal(await authHistory(), 200)
  await page.reload()
  assert.equal(await authHistory(), 200)
  await page.goto(origin + '/#attempt/private-speaking?item=spoken')
  await page.getByRole('button', { name: 'Play your recording' }).click()
  const audio = page.getByLabel('Your recording', { exact: true })
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => a.readyState >= 2 && a.src.startsWith('blob:')))
  assert.ok(await audio.evaluate((a) => a.duration > 0))
  const guest = await ctx.newPage()
  await guest.goto(origin + '/')
  assert.equal(await guest.evaluate(async () => (await fetch('/api/history')).status), 401)
  await guest.goto(openUrl)
  await guest.getByText(/desktop shortcut or tray icon/).waitFor()
  await quit()
  await start()
  assert.equal(await authHistory(), 401)
  await page.goto(await open())
  await page.waitForURL(origin + '/')
  assert.equal(await authHistory(), 200)
  console.log('Installed session passed: private launch, reload, audio playback, one-use tickets, fresh credentials after restart.')
} finally {
  await browser?.close()
  await quit()
  assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()))
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}
