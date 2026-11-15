import assert from 'node:assert/strict'
import { wave, wavInfo } from '../server/speech.ts'

export async function checkSpeakingHandoff(browser, origin) {
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  try {
    const page = await ctx.newPage()
    page.setDefaultTimeout(12000)
    // Observe the native recorder, tracks and player without changing their timing.
    await page.addInitScript(() => {
      const log = window.mediaLog = { starts: [], releases: [], plays: [], stops: [] }
      const start = MediaRecorder.prototype.start
      MediaRecorder.prototype.start = function (...args) {
        log.starts.push(performance.now())
        return start.apply(this, args)
      }
      const stop = MediaRecorder.prototype.stop
      MediaRecorder.prototype.stop = function () {
        log.stops.push(performance.now())
        return stop.call(this)
      }
      const release = MediaStreamTrack.prototype.stop
      MediaStreamTrack.prototype.stop = function () {
        release.call(this)
        log.releases.push({ at: performance.now(), state: this.readyState })
      }
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function () {
        log.plays.push(performance.now())
        return play.call(this)
      }
    })
    let index = 0, mode = 'section'
    const view = () => ({
      id: 'handoff', mode, section: 'Speaking', count: 4, index,
      itemStarted: Date.now(), answer: {}, limit: 10, played: false,
      item: { id: 'q' + index, task: 'repeat', prompt: 'Repeat this sentence.' },
      audio: '/fixture.wav', deadline: 0, responseUntil: 0,
    })
    const clips = []
    await page.route('**/fixture.wav', (r) =>
      r.fulfill({ contentType: 'audio/wav', body: wave(Buffer.alloc(4800), 16000) }))
    await page.route('**/api/attempt/handoff', (r) => r.fulfill({ json: view() }))
    await page.route('**/api/play', (r) => r.fulfill({ json: view() }))
    await page.route('**/api/response', (r) => r.fulfill({ json: {
      ...view(), responseUntil: Date.now() + (index === 1 ? 1400 : 15000),
    } }))
    await page.route('**/api/record?*', (r) => {
      const { pcm, rate } = wavInfo(r.request().postDataBuffer())
      clips.push(pcm.length / 2 / rate * 1000)
      return r.fulfill({ json: { answer: { clip: 'saved-response' } } })
    })
    await page.route('**/api/next', (r) => { index++; return r.fulfill({ json: view() }) })
    await page.goto(origin + '/#attempt/handoff')
    const finish = page.getByRole('button', { name: 'Finish recording' })
    await finish.waitFor()
    await page.waitForFunction(() => performance.now() - window.mediaLog.starts[0] > 650)
    await finish.click()
    // The second response expires by timer, then the third prompt starts.
    await page.waitForFunction(() => window.mediaLog.starts.length === 3)
    const log = await page.evaluate(() => window.mediaLog)
    assert.equal(log.plays.length, 3)
    assert.equal(log.releases.length, 2)
    const gaps = log.releases.map((r, i) => {
      assert.equal(r.state, 'ended')
      assert.ok(r.at >= log.stops[i] && r.at - log.stops[i] < 100)
      assert.ok(clips[i] >= log.stops[i] - log.starts[i] - 200, 'Saved response includes its ending')
      const gap = log.plays[i + 1] - r.at
      assert.ok(gap >= 1200, 'Playback started before the microphone settled')
      return Math.round(gap)
    })
    await page.waitForFunction(() => performance.now() - window.mediaLog.starts[2] > 500)
    await finish.click()
    await page.getByText('Question 4 of 4').waitFor()
    await page.evaluate(() => { location.hash = 'history' })
    await page.waitForFunction(() => performance.now() - window.mediaLog.releases[2].at > 1350)
    assert.equal(await page.evaluate(() => window.mediaLog.plays.length), 3)

    mode = 'drill'
    index = 0
    await page.goto(origin + '/#attempt/handoff')
    await page.getByRole('button', { name: 'Play prompt' }).click()
    await finish.waitFor()
    await page.waitForFunction(() => performance.now() - window.mediaLog.starts.at(-1) > 650)
    await finish.click()
    await page.getByText('Recording saved', { exact: true }).waitFor()
    const playCount = await page.evaluate(() => window.mediaLog.plays.length)
    await page.getByRole('button', { name: 'Replay prompt' }).click()
    await page.waitForFunction((before) => window.mediaLog.plays.length > before, playCount)
    const replayGap = await page.evaluate(() => window.mediaLog.plays.at(-1) - window.mediaLog.releases.at(-1).at)
    assert.ok(replayGap >= 1200)
    console.log('Microphone release to playback (finish / timer / replay), ms:', ...gaps, Math.round(replayGap))
  } finally {
    await ctx.close()
  }
}
