// Capture the real interface using a disposable database containing sample practice.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright-core'

const stamp = Date.UTC(2026, 10, 1, 10)
const clip = '10000000-0000-4000-8000-000000000001'
const qa = resolve('.work/qa')
if (process.argv.includes('--seed')) {
  const data = process.env.FIELDWORK_DATA
  assert.ok(data && process.env.EN_GYM_INSTALLED !== '1', 'Start the screenshot script without --seed.')
  const actual = realpathSync(data)
  assert.ok(dirname(actual) === realpathSync(qa) && /^site-[\w-]+$/.test(basename(actual)) &&
    readdirSync(actual).length === 0, 'Screenshot fixtures require a new, empty QA directory.')
  const { save, putVocabularyWord, clips } = await import('../server/store.ts')
  const { wave } = await import('../server/speech.ts')
  const items = ['The campus library', 'Weekend study groups', 'Choosing an elective', 'A new volunteer role'].map((title, i) => ({
    id: 'speaking-' + i, task: 'interview', title, level: 2,
    prompt: i === 0 ? 'Where do you prefer to study, and why?' : 'Give a reason and an example from your experience.',
  }))
  const answer = 'I study in the campus library. The quiet reading room helps me concentrate, especially when I have a deadline.'
  const a = { id: 'speaking-example', mode: 'drill', focus: 'interview', rules: 1, seed: 1, started: stamp,
    ended: stamp + 180000, stage: 0, index: 0, deadline: 0, itemStarted: 0,
    stages: [{ section: 'Speaking', name: 'Take an Interview', minutes: 0, items }],
    answers: Object.fromEntries(items.map((q, i) => [q.id, { clip, transcript: answer,
      seconds: 23, elapsed: 31, score: i === 2 ? 0.6 : .8, reviewed: true, note: 'Clear preference and a concrete reason.' }])),
    bands: {}, messages: [] }
  save(a)
  writeFileSync(join(clips, clip + '.wav'), wave(Buffer.alloc(16000 * 2 * 23), 16000))
  for (const [term, context] of [
    ['concentrate', 'The quiet reading room helps me concentrate.'],
    ['elective', 'Choosing an elective gave me time to try a new subject.'],
    ['deadline', 'We have a deadline for submitting the proposal.'],
  ]) putVocabularyWord(crypto.randomUUID(), term, { item: items[0].id, attempt: a.id, title: items[0].title, context, saved: stamp })
} else {
  mkdirSync(qa, { recursive: true })
  const data = mkdtempSync(join(qa, 'site-'))
  const env = { ...process.env, EN_GYM_INSTALLED: '0', FIELDWORK_DATA: data, FIELDWORK_PORT: '43395' }
  const origin = 'http://127.0.0.1:' + env.FIELDWORK_PORT
  const assets = resolve('site/assets')
  let browser, server
  try {
    execFileSync(process.execPath, [process.argv[1], '--seed'], { env, windowsHide: true })
    server = spawn(process.execPath, ['server/main.ts'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    const output = createInterface({ input: server.stdout })
    let ready = false
    try {
      for await (const line of output) {
        if (line === 'En-GYM is ready at ' + origin) { ready = true; break }
      }
      assert.ok(ready, 'The screenshot server could not start.')
    } finally { output.close() }
    mkdirSync(assets, { recursive: true })
    copyFileSync('public/en-gym.svg', join(assets, 'en-gym.svg'))
    browser = await chromium.launch({ executablePath: process.env.FIELDWORK_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
    const page = await browser.newPage({ viewport: { width: 1160, height: 850 }, deviceScaleFactor: 1.5 })
    await page.goto(origin)
    await page.locator('.hero').waitFor()
    const main = await page.locator('main').boundingBox()
    await page.screenshot({ path: join(assets, 'practice.png'), clip: { x:main.x, y:main.y, width:main.width, height:440 } })
    await page.goto(origin + '/#attempt/speaking-example?item=speaking-0')
    const audio = page.getByLabel('Your recording')
    await audio.evaluate(async (el) => {
      el.preload = 'metadata'
      el.load()
      if (!el.readyState) await new Promise((ok, reject) => { el.onloadedmetadata = ok; el.onerror = reject })
    })
    const detail = page.locator('.responseDetail')
    const frame = await detail.boundingBox()
    const top = await detail.locator('.detailBody small').first().boundingBox()
    const transcript = await detail.locator('.excerpt').last().boundingBox()
    const scrollY = await page.evaluate(() => window.scrollY)
    await page.screenshot({ path: join(assets, 'speaking.png'), clip: {
      x: frame.x + 2, y: top.y + scrollY - 16, width: frame.width - 4,
      height: transcript.y + transcript.height - top.y + 32,
    } })
    await page.locator('.reviewWorkspace').screenshot({ path: join(assets, 'report.png') })
    await page.goto(origin + '/#vocabulary')
    await page.getByLabel('Select deadline', { exact: true }).waitFor()
    await page.locator('.wordCollection').screenshot({ path: join(assets, 'words.png') })
  } finally {
    await browser?.close()
    if (server && server.exitCode === null && server.signalCode === null)
      await new Promise((ok) => { server.once('exit', ok); server.kill() })
    assert.equal(resolve(data, '..'), qa)
    rmSync(data, { recursive: true, maxRetries: 5, retryDelay: 200 })
  }
}
