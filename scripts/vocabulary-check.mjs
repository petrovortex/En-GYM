import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { checkGames } from './check-games.mjs'
import { checkSpeakingHandoff } from './check-speaking-handoff.mjs'
const qa = resolve('.work/qa')
mkdirSync(qa, { recursive: true })
assert.equal(realpathSync(qa), join(realpathSync('.'), '.work', 'qa'))
const data = mkdtempSync(join(qa, 'vocabulary-'))
const origin = 'http://127.0.0.1:43284'
const env = {
  ...process.env,
  FIELDWORK_DATA: data,
  FIELDWORK_PORT: '43284',
}
const passage =
  'Resilient communities turn neglected spaces into gardens. Their biodiversity can flourish when residents take into account the needs of local wildlife.'
const attempt = {
  id: 'vocabulary-qa',
  mode: 'drill',
  focus: 'passage',
  rules: 1,
  seed: 1,
  started: Date.now() - 120000,
  ended: Date.now(),
  stage: 0,
  index: 0,
  deadline: 0,
  itemStarted: 0,
  stages: [
    {
      section: 'Reading',
      name: 'Reading',
      minutes: 0,
      items: [
        {
          id: 'garden-1',
          task: 'passage',
          title: 'Gardens in the city',
          level: 2,
          passage,
          prompt: 'What helps an urban garden support local wildlife?',
          options: ['Careful planning', 'Removing plants'],
          keys: ['Careful planning'],
        },
      ],
    },
  ],
  answers: {
    'garden-1': { text: 'Careful planning', score: 1, elapsed: 21 },
  },
  messages: [],
  bands: {},
}
let server, browser
async function start() {
  server = spawn(process.execPath, ['server/main.ts'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  let connectionError = ''
  server.stdout.on('data', (b) => { errors += b })
  server.stderr.on('data', (b) => (errors += b))
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin + '/api/status')).ok) return
    } catch (e) { connectionError = String(e.cause ?? e) }
    await delay(100)
  }
  throw Error('Server did not start: ' + errors + connectionError)
}
async function stop() {
  if (!server || server.exitCode !== null) return
  const s = server
  await new Promise((r) => {
    s.once('exit', r)
    s.kill()
  })
}
async function post(path, input) {
  const response = await fetch(origin + '/api/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fieldwork': 'local' },
    body: JSON.stringify(input),
  })
  const result = await response.json()
  assert.ok(response.ok, JSON.stringify(result))
  return result
}
try {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {save} from './server/store.ts'; save(${JSON.stringify(attempt)})`,
    ],
    { env, windowsHide: true },
  )
  await start()
  browser = await chromium.launch({
    executablePath:
      process.env.FIELDWORK_CHROME ??
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  })
  const errors = [],
    outbound = []
  await ctx.route(/.*/, (route) => {
    if (route.request().url().startsWith(origin)) return route.continue()
    outbound.push(route.request().url())
    return route.abort()
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(12000)
  await page.goto(origin)
  await page
    .getByRole('heading', { name: 'Full-length mock test' })
    .waitFor()
  assert.equal(
    await page.getByText('Practice desk', { exact: true }).count(),
    0,
  )
  assert.equal(await page.locator('.stockStatus').count(), 0)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  assert.equal(
    Math.round((await page.locator('.appHeader').boundingBox()).y),
    0,
  )
  await page.screenshot({
    path: join(qa, 'vocabulary-home.png'),
    fullPage: true,
  })
  await page.getByRole('link', { name: 'Vocabulary', exact: true }).click()
  await page.getByRole('heading', { name: 'Start with a word.' }).waitFor()
  await page.goto(origin + '/#attempt/vocabulary-qa?item=garden-1')
  await page.locator('.detailBody .excerpt').first().waitFor()
  await page
    .locator('.detailBody .excerpt')
    .first()
    .evaluate((p) => {
      const range = document.createRange()
      range.setStart(p.firstChild, 0)
      range.setEnd(p.firstChild, 9)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
  const save = page.getByRole('button', {
    name: 'Save to vocabulary',
    exact: true,
  })
  await save.waitFor()
  await save.focus()
  await page.keyboard.press('Enter')
  await page.getByText('Saved to vocabulary', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  for (const term of ['biodiversity', 'flourish', 'take into account'])
    await post('vocabulary/add', {
      term,
      attempt: attempt.id,
      item: 'garden-1',
      context: passage,
    })
  await page.getByRole('link', { name: 'Vocabulary', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Select Resilient', exact: true })
    .waitFor()
  await page.getByLabel('New word or phrase').fill('resilient')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByText('This word is already in your vocabulary.', { exact: true })
    .waitFor()
  assert.equal(await page.locator('.wordList > li').count(), 4)
  await page.getByLabel('Search vocabulary').fill('flora')
  await page.getByText('No matching words.', { exact: true }).waitFor()
  await page.getByLabel('Search vocabulary').fill('')
  await page
    .getByRole('button', { name: 'Select all', exact: true })
    .click()
  await page
    .getByLabel('Topic', { exact: true })
    .fill('How a shared garden changes a neighborhood')
  assert.equal(
    await page
      .getByRole('button', { name: 'Write a text', exact: true })
      .isDisabled(),
    true,
  )
  await page.screenshot({
    path: join(qa, 'vocabulary-desktop.png'),
    fullPage: true,
  })
  await page.getByRole('link', { name: 'Resilient', exact: false }).click()
  assert.match(page.url(), /attempt\/vocabulary-qa\?item=garden-1/)
  await page.reload()
  await page
    .getByRole('heading', { name: 'Gardens in the city', exact: true })
    .waitFor()
  await stop()
  await start()
  await page.goto(origin + '/#vocabulary')
  await page
    .getByRole('checkbox', { name: 'Select Resilient', exact: true })
    .waitFor()
  assert.equal(await page.locator('.wordList > li').count(), 4)
  await page.route('**/api/prefs', (r) =>
    r.fulfill({
      json: { configured: true, model: 'trainer-test', provider: 'openai' },
    }),
  )
  await page.reload()
  await page
    .getByRole('button', { name: 'Select all', exact: true })
    .click()
  await page
    .getByLabel('Topic', { exact: true })
    .fill('How a shared garden changes a neighborhood')
  await page.getByLabel('Target length').fill('150')
  let generated
  // Provider calls are isolated unit-tested; this fixture exercises the complete presentation path without spending credits.
  const text =
    'Resilient neighborhoods make room for nature. A shared garden can flourish when residents take into account the needs of local birds and insects. Its biodiversity gives people something new to notice on every visit.\n\nThe first volunteers begin with a patch of unused land. They choose plants together and share responsibility for watering. Over time, neighbors who once passed each other in silence begin exchanging stories as they work.'
  await page.route('**/api/vocabulary/text', async (route) => {
    const request = route.request().postDataJSON()
    assert.equal(request.ids.length, 4)
    assert.equal(request.length, 150)
    generated = {
      id: 'text-qa',
      created: Date.now(),
      topic: request.topic,
      length: request.length,
      title: 'A Garden Between Neighbors',
      text,
      words: ['Resilient', 'biodiversity', 'flourish', 'take into account'],
      model: 'trainer-test',
    }
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {saveVocabularyText} from './server/store.ts'; saveVocabularyText(${JSON.stringify(generated)})`,
      ],
      { env, windowsHide: true },
    )
    await route.fulfill({ json: generated })
  })
  await page
    .getByRole('button', { name: 'Write a text', exact: true })
    .click()
  await page
    .getByRole('heading', { name: 'A Garden Between Neighbors' })
    .waitFor()
  assert.equal(await page.locator('.vocabularyProse mark').count(), 4)
  await page.screenshot({
    path: join(qa, 'vocabulary-text-desktop.png'),
    fullPage: true,
  })
  // The phrase crosses from a highlighted word into an ordinary text node.
  const phrase = 'flourish when residents'
  const capturePhrase = async () => {
    await page.locator('.vocabularyProse mark').filter({ hasText: /^flourish$/ }).evaluate((mark) => {
      const range = document.createRange()
      range.setStart(mark.firstChild, 0)
      range.setEnd(mark.nextSibling, ' when residents'.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await save.click()
  }
  await capturePhrase()
  await page.getByText('Saved to vocabulary', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Words 5$/ }).click()
  const entry = page.locator('.wordList > li').filter({
    has: page.getByRole('checkbox', { name: 'Select ' + phrase, exact: true }),
  })
  assert.equal(await entry.locator('.wordContext').innerText(),
    'A shared garden can flourish when residents take into account the needs of local birds and insects.')
  await entry.getByRole('button', { name: phrase, exact: true }).click()
  await page.getByRole('heading', { name: generated.title }).waitFor()
  await capturePhrase()
  await page.getByText('Already saved', { exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: /^Texts/ }).click()
  await page
    .getByRole('heading', { name: 'A Garden Between Neighbors' })
    .waitFor()
  for (const width of [390, 760, 900]) {
    await page.setViewportSize({ width, height: 850 })
    for (const tab of ['Words', 'Texts']) {
      await page
        .getByRole('button', { name: new RegExp('^' + tab + ' ') })
        .click()
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        'No horizontal overflow at ' + width + ' ' + tab,
      )
      await page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      )
      assert.equal(
        Math.round((await page.locator('.appHeader').boundingBox()).y),
        0,
      )
      if (width === 390)
        await page.screenshot({
          path: join(qa, 'vocabulary-' + tab.toLowerCase() + '-mobile.png'),
          fullPage: true,
        })
    }
  }
  await page.getByRole('button', { name: /^Words / }).click()
  await page
    .getByRole('button', { name: 'Remove flourish', exact: true })
    .click()
  await page
    .getByRole('checkbox', { name: 'Select flourish', exact: true })
    .waitFor({ state: 'detached' })
  await page.getByRole('button', { name: /^Texts / }).click()
  assert.equal(await page.locator('.vocabularyProse mark').count(), 4)
  await page.getByRole('button', { name: 'Remove text', exact: true }).click()
  await page.getByRole('heading', { name: 'Words become stories.' }).waitFor()
  await page.getByRole('button', { name: /^Words / }).click()
  assert.equal(await entry.locator('.wordTerm').innerText(), phrase)
  assert.equal(await entry.getByTitle('Open source text').count(), 0)
  assert.ok((await entry.locator('.wordContext').innerText()).includes(phrase))
  const after = await (
    await fetch(origin + '/api/attempt/vocabulary-qa')
  ).json()
  assert.deepEqual(after.answers, attempt.answers)
  assert.equal(after.deadline, attempt.deadline)
  await page.unroute('**/api/prefs')
  await page.goto(origin + '/#practice')
  await page.getByRole('heading', { name: 'Exercise practice' }).waitFor()
  assert.equal(await page.locator('.stockStatus').count(), 0)
  // A learner can install a voice update independently of an available app update.
  let selectedComponents
  const updateStatus = {
    appVersion: '1.5.0', changes: [
      { component: 'app', version: '1.5.1', bytes: 1000000 },
      { component: 'phonon', version: '1.1.0', bytes: 2000000 },
    ], done: 0, total: 3000000, message: '', state: 'available',
  }
  await page.route('**/api/updates/status', (route) => route.fulfill({ json: updateStatus }))
  await page.route('**/api/updates/install', async (route) => {
    selectedComponents = route.request().postDataJSON().components
    await route.fulfill({ json: { ...updateStatus, state: 'restarting' } })
  })
  await page.goto(origin + '/#settings')
  await page.locator('.stockStatus').waitFor()
  await page.getByRole('checkbox', { name: 'En-GYM · 1.5.1' }).uncheck()
  await page.getByRole('button', { name: 'Update and restart' }).click()
  await page.getByText('Open En-GYM from the tray when the update finishes.').waitFor()
  assert.deepEqual(selectedComponents, ['phonon'])
  await checkGames(page, origin, qa)
  await checkSpeakingHandoff(browser, origin)
  assert.equal(errors.length, 0, errors.join('\n'))
  assert.equal(outbound.length, 0, outbound.join('\n'))
  console.log(
    'Vocabulary browser checks passed: selection, keyboard save, duplicate prevention, source deep links, restart persistence, text generation UI, highlighting, mobile, deletion, fixed header and Settings-only preparation.',
  )
} finally {
  await browser?.close()
  await stop()
  assert.equal(dirname(realpathSync(data)), realpathSync(qa))
  rmSync(data, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  })
}
