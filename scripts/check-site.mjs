import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { basename, resolve } from 'node:path'
import { chromium } from 'playwright-core'

// Serve the same project subpath as GitHub Pages, using only the site's static files.
const files = [
  'index.html',
  'guide.html',
  'site.css',
  'assets/en-gym.png',
  ...['speaking', 'practice', 'report', 'words'].map(
    (n) => 'assets/' + n + '.png',
  ),
]
const types = {
  html: 'text/html',
  css: 'text/css',
  png: 'image/png',
  svg: 'image/svg+xml',
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const name =
    path === '/En-GYM/' ? 'index.html' : path.slice('/En-GYM/'.length)
  if (!path.startsWith('/En-GYM/') || !files.includes(name)) {
    res.writeHead(404).end()
    return
  }
  try {
    const data = await readFile(resolve('site', name))
    res
      .writeHead(200, { 'Content-Type': types[name.split('.').pop()] })
      .end(data)
  } catch {
    res.writeHead(500).end()
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = 'http://127.0.0.1:' + server.address().port + '/En-GYM/'
let browser
try {
  await mkdir('.work/qa', { recursive: true })
  browser = await chromium.launch({
    executablePath:
      process.env.FIELDWORK_CHROME ??
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
  })
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } })
    for (const href of ['', 'guide.html']) {
      await page.goto(base + href)
      assert.equal(await page.locator('h1').count(), 1)
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
      const images = page.locator('img')
      for (const img of await images.all()) {
        await img.scrollIntoViewIfNeeded()
        await img.evaluate((el) => el.decode())
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({
        path:
          '.work/qa/site-' + (basename(href) || 'home') + '-' + width + '.png',
      })
    }
    await page.goto(base)
    assert.equal(
      await page
        .getByRole('link', { name: 'Download for Windows' })
        .getAttribute('href'),
      'https://github.com/petrovortex/En-GYM/releases/latest/download/En-GYM-Setup.exe',
    )
    await page.getByRole('link', { name: /Review your answers/ }).click()
    assert.equal(page.url(), base + 'guide.html#review')
    assert.ok(await page.locator('section:target').isVisible())
    await page.close()
  }
  console.log('Landing page and guide passed at desktop and mobile widths.')
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
