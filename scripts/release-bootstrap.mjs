import { join } from 'node:path'
import {
  atomicJson,
  CatalogUnavailable,
  checkedEnvelope,
  fetchCatalog,
  jsonFile,
  planUpdate,
  stageUpdate,
  updatePaths,
} from '../server/updates.ts'
import { applyPrepared } from './release-apply.mjs'

const paths = updatePaths()
// Only a previously authenticated catalog can serve as an offline first-install cache.
let envelope
try {
  envelope = (await fetchCatalog(paths)).envelope
} catch (e) {
  if (!(e instanceof CatalogUnavailable)) throw e
  envelope = await jsonFile(join(paths.work, 'bootstrap-catalog.json'))
  if (!envelope) {
    const markers = await Promise.all(
      ['installed', 'watermark', 'recovery', 'pending'].map((n) =>
        jsonFile(join(paths.work, n + '.json')),
      ),
    )
    if (markers.every((v) => v === undefined)) {
      console.error(
        'The official catalog is unavailable. A first install can use the embedded verified speech versions.',
      )
      process.exit(20)
    }
    throw e
  }
}
const { catalog } = await checkedEnvelope(paths, envelope)
const changes = await planUpdate(paths, catalog, true)
if (changes.length) {
  let done = 0,
    previous = -1
  const total = changes.reduce((n, c) => n + c.bytes, 0)
  await stageUpdate(paths, catalog, changes, (bytes) => {
    done += bytes
    if (done >> 20 !== previous || done === total) {
      console.log(done + '/' + total)
      previous = done >> 20
    }
  })
  await atomicJson(join(paths.work, 'pending.json'), { envelope, speechOnly: true })
  await applyPrepared(paths)
}
await atomicJson(join(paths.work, 'bootstrap-catalog.json'), envelope)
