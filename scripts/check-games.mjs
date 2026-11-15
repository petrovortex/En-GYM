import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function checkGames(page, origin, qa) {
  let appeals = 0
  await page.route('**/api/prefs', (r) =>
    r.fulfill({ json: { configured: true } }),
  )
  await page.route('**/api/games/check', (r) => {
    const { answers } = r.request().postDataJSON()
    assert.equal(answers.length, 1)
    appeals++
    return r.fulfill({
      json: {
        [answers[0].id]: {
          correct: appeals === 1,
          note:
            appeals === 1
              ? 'This variant also fits.'
              : 'The meaning differs.',
        },
      },
    })
  })
  await page.goto(origin + '/#vocabulary')
  const button = (name) => page.getByRole('button', { name, exact: true })
  await button('Games').click()
  await page.getByRole('heading', { name: 'Choose a game' }).waitFor()
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.screenshot({ path: join(qa, 'games-desktop.png') })
  const start = async (endless = false) => {
    const response = page.waitForResponse((r) =>
      r.url().endsWith('/api/games/start'),
    )
    await button(endless ? 'Start practice' : 'Start round').click()
    const round = await (await response).json()
    assert.ok(round.cards?.length)
    return round
  }
  const round = await start()
  const { words } = await (await fetch(origin + '/api/vocabulary')).json()
  const first = round.cards.find((c) => !words.some((w) => w.term.toLowerCase() === c.term.toLowerCase()))
  const wordButton = button(first.term)
  await wordButton.scrollIntoViewIfNeeded()
  const pos = await wordButton.evaluate((b) => {
    const range = document.createRange()
    range.selectNodeContents(b)
    const { left, right, y, height } = range.getBoundingClientRect()
    return { left, right, y: y + height / 2 }
  })
  await page.mouse.move(pos.left, pos.y)
  await page.mouse.down()
  await page.mouse.move(pos.right + 1, pos.y, { steps: 10 })
  await page.mouse.up()
  await button('Save to vocabulary').click()
  await page
    .getByRole('status')
    .filter({ hasText: /Saved to vocabulary|Already saved/ })
    .waitFor()
  assert.equal(await wordButton.getAttribute('aria-pressed'), 'false')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Words / }).click()
  const entry = page
    .locator('.wordList > li')
    .filter({ hasText: first.prompt })
  assert.ok(
    (await entry.locator('.wordTerm').innerText())
      .toLowerCase()
      .startsWith(first.term.toLowerCase()),
  )
  assert.equal(await entry.locator('a[href^="#attempt/?"]').count(), 0)
  await button('Games').click()
  for (const c of round.cards) {
    await button(c.term).click()
    await button(c.prompt).click()
  }
  await button('See results').click()
  await page.getByText('5 / 5', { exact: true }).waitFor()
  await button('Choose a game').click()
  await page
    .getByRole('button', { name: /^Missing Word Complete/ })
    .click()
  await button('Prepositions').click()
  await page
    .getByLabel('Topic', { exact: true })
    .selectOption('Expressions & exceptions')
  await button('Guided').click()
  await button('Timed round').click()
  await page.setViewportSize({ width: 390, height: 780 })
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  )
  await page.screenshot({
    path: join(qa, 'games-mobile.png'),
    fullPage: true,
  })
  const gaps = await start()
  assert.equal(gaps.focus, 'Expressions & exceptions')
  for (let i = 0; i < gaps.cards.length; i++) {
    await button(gaps.cards[i].answers[0]).click()
    await button(
      i === gaps.cards.length - 1 ? 'See results' : 'Continue',
    ).click()
    if (i === 0) {
      const deadline = await page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem('vocabulary-game-v1'))
            .deadline,
      )
      await page.reload()
      await page.getByText('Question 2 of 5').waitFor()
      assert.equal(
        await page.evaluate(
          () =>
            JSON.parse(sessionStorage.getItem('vocabulary-game-v1'))
              .deadline,
        ),
        deadline,
      )
    }
  }
  await page.getByText('5 / 5', { exact: true }).waitFor()
  await button('Choose a game').click()
  await page
    .getByRole('button', { name: /^Synonyms & Antonyms Find/ })
    .click()
  await button('Challenge').click()
  await button('Round').click()
  const rel = await start()
  for (const [i, c] of rel.cards.entries()) {
    const input = page.getByRole('textbox', { name: /Your answers/ })
    await page.waitForFunction(() =>
      document.activeElement?.matches('.gameAnswer input'),
    )
    await input.fill(c.answers[0] + ', ' + c.answers[0])
    assert.ok(await button('Check answer').isDisabled())
    await input.fill(c.answers.slice(0, 2).join(', '))
    await page.keyboard.press('Enter')
    await button(i === 3 ? 'See results' : 'Continue').waitFor()
    await page.keyboard.press('Enter')
  }
  await page.getByText('4 / 4', { exact: true }).waitFor()
  await button('Choose a game').click()
  await button('Endless').click()
  const endless = await start(true)
  assert.equal(await page.getByRole('timer').count(), 0)
  let prepared
  const quotaMessage = 'The provider usage limit was reached. Try again later.'
  for (const [i, c] of endless.cards.entries()) {
    const missed = i === 0 || i === endless.cards.length - 1
    const value =
      missed
        ? c.distractors.slice(0, 2).join(', ')
        : c.answers.slice(0, 2).join(', ')
    await page.getByRole('textbox', { name: /Your answers/ }).fill(value)
    await button('Check answer').click()
    if (i === 0) {
      await page.locator('.answerFeedback.incorrect').waitFor()
      await page.reload()
      await page.locator('.answerFeedback.incorrect').waitFor()
    }
    if (missed) {
      await page.route('**/api/games/check', (r) => r.fulfill({
        status: 400, json: { error: quotaMessage },
      }), { times: 1 })
      await button('Check my wording with trainer').click()
      await page.getByRole('alert').filter({ hasText: quotaMessage }).waitFor()
    }
    if (i === 0) {
      await page.locator('.answerFeedback.incorrect').waitFor()
      assert.ok(
        (await page.locator('.answerFeedback').innerText()).includes(
          c.answers[0],
        ),
      )
      await page.screenshot({
        path: join(qa, 'games-endless-feedback.png'),
        fullPage: true,
      })
    }
    if (i === endless.cards.length - 1) {
      await page.route(
        '**/api/games/start',
        async (route) => {
          prepared = await (await route.fetch()).json()
          await route.fulfill({
            status: 503,
            json: { error: 'Retry local connection' },
          })
        },
        { times: 1 },
      )
      await button('Continue').click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Retry local connection' })
        .waitFor()
    }
    await button('Continue').click()
    await page.getByRole('alert').filter({ hasText: quotaMessage }).waitFor({ state: 'detached' })
  }
  await page.getByText('Question 5', { exact: true }).waitFor()
  const nextBatch = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('vocabulary-game-v1')),
  )
  assert.equal(nextBatch.prior.correct, 2)
  assert.equal(nextBatch.events.length, 0)
  assert.deepEqual(nextBatch.round.cards, prepared.cards)
  assert.ok(
    nextBatch.round.cards.some((c) => c.id === endless.cards[0].id),
  )
  await button('Finish practice').click()
  await page.getByText('2 / 4', { exact: true }).waitFor()
  await button('Choose a game').click()
  await page.getByRole('button', { name: /^Word Match Pair/ }).click()
  const board = await start(true)
  for (const [i, c] of board.cards.entries()) {
    await button(c.term).click()
    await button(i === 0 ? board.cards[1].prompt : c.prompt).click()
    if (i === 0) await page.locator('.answerFeedback.incorrect').waitFor()
  }
  await button('Continue').click()
  await page.waitForFunction(
    () =>
      JSON.parse(sessionStorage.getItem('vocabulary-game-v1')).prior
        .played > 0,
  )
  await button('Finish practice').click()
  await button('Choose a game').click()
  await page
    .getByRole('button', { name: /^Missing Word Complete/ })
    .click()
  await button('Guided').click()
  const gapPack = await start(true)
  for (const c of gapPack.cards) {
    await button(c.answers[0]).click()
    await page.locator('.answerFeedback.correct').waitFor()
    await button('Continue').click()
  }
  await page.getByText('Question 6', { exact: true }).waitFor()
  await button('Finish practice').click()
  await button('Choose a game').click()
  await button('Standard').click()
  await start(true)
  for (let i = 0; i < 3; i++) {
    await page.waitForFunction(() =>
      document.activeElement?.matches('.gameAnswer input'),
    )
    await page.keyboard.type('alternative wording')
    await page.keyboard.press('Enter')
    await page.locator('.answerFeedback.incorrect').waitFor()
    assert.equal(appeals, i > 0 ? 1 : 0)
    if (i === 0) {
      await button('Check my wording with trainer').click()
      await page.locator('.answerFeedback.correct').waitFor()
      assert.equal(
        await page.locator('.gameSolution').innerText(),
        'alternative wording',
      )
      await page.locator('.gameSolution').evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      })
      const saved = page.waitForResponse((r) =>
        r.url().endsWith('/api/vocabulary/add'),
      )
      await button('Save to vocabulary').click()
      const { word } = await (await saved).json()
      assert.equal(word.term, 'alternative wording')
      assert.ok(
        word.sources.some(
          (s) =>
            s.title === 'Missing Word' && s.context.includes(word.term),
        ),
      )
      await page.keyboard.press('Escape')
      await button('Continue').focus()
    }
    if (i < 2) await page.keyboard.press('Enter')
    else {
      await page.route('**/api/games/check', (r) => r.abort('internetdisconnected'), { times: 1 })
      await button('Check my wording with trainer').click()
      await page.getByText('Check your connection and try again.').waitFor()
      await button('Finish practice').click()
      await page.getByText('1 / 3', { exact: true }).waitFor()
      assert.equal(await page.getByRole('alert').count(), 0)
      assert.equal(await page.locator('.gameOutcome.incorrect').count(), 2)
    }
  }
  await button('Practice missed items').click()
  await page.waitForFunction(() =>
    document.activeElement?.matches('.gameAnswer input'),
  )
  await page.keyboard.type('another alternative')
  await page.keyboard.press('Enter')
  await button('End round').click()
  await button('Check other answers with trainer').click()
  await page.getByText('The meaning differs.', { exact: true }).waitFor()
  assert.equal(appeals, 2)
  assert.equal(await button('Check other answers with trainer').count(), 0)
  await button('Choose a game').click()
  await page
    .getByRole('button', { name: /^Synonyms & Antonyms Find/ })
    .click()
  await button('Timed round').click()
  await page.clock.install()
  await start()
  await page.clock.fastForward(121000)
  await page.getByRole('heading', { name: 'Round complete' }).waitFor()
  assert.equal(await page.getByText('Skipped', { exact: true }).count(), 4)
  console.log(
    'All three games, keyboard-accessible choices, mobile layout, focused prepositions, distinct synonyms, timed expiry and refresh passed.',
  )
}
