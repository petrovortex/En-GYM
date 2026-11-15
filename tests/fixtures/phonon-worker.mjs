import { parentPort } from 'node:worker_threads'
let count = 0
parentPort.on('message', ({ id, text }) => {
  if (text === 'hang') return
  if (text === 'crash') process.exit(1)
  if (text === 'error')
    return parentPort.postMessage({ id, error: 'Fixture synthesis failure' })
  parentPort.postMessage({ id, pcm: new Uint8Array([++count, 0]) })
})
