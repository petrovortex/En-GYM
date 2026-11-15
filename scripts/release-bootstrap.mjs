import { join } from 'node:path'
import { CatalogExpired } from '../core/updates.ts'
import {
  atomicJson,
  CatalogUnavailable,
  checkedEnvelope,
  fetchCatalog,
  jsonFile,
  planUpdate,
  stageUpdate,
  updatePaths,
  requireClearActivation,
  withUpdateLock,
} from '../server/updates.ts'
import { applyPreparedLocked } from './release-apply.mjs'

const paths = updatePaths()
const code = await withUpdateLock(paths.work, async () => {
  await requireClearActivation(paths)
  // Only a previously authenticated catalog can serve as an offline first-install cache.
  let envelope
  try {
    envelope = (await fetchCatalog(paths)).envelope
  } catch (e) {
    if (!(e instanceof CatalogUnavailable || e instanceof CatalogExpired)) throw e
    envelope = await jsonFile(join(paths.work, 'bootstrap-catalog.json'))
    if (!envelope) {
      const markers = await Promise.all(
          ['watermark', 'recovery', 'pending'].map((n) =>
          jsonFile(join(paths.work, n + '.json')),
        ),
      )
      if (markers.every((v) => v === undefined)) {
        console.error(
          'Using the installer’s verified speech versions for this first installation.',
        )
        return 20
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
    await applyPreparedLocked(paths)
  }
  await atomicJson(join(paths.work, 'bootstrap-catalog.json'), envelope)
  return 0
})
process.exitCode = code
