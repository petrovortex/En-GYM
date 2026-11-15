import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  componentFiles,
  componentIds,
  compareVersions,
  verifyCatalog,
} from '../core/updates.ts'
import { signBytes } from './release-keys.mjs'

const {
  RELEASE_TAG: tag,
  RELEASE_KIND: kind,
  EN_GYM_ROOT_PUBLIC_KEY: root,
  EN_GYM_DELEGATION_B64: authorization,
  EN_GYM_RELEASE_PRIVATE_KEY: privateKey,
} = process.env
if (
  !root ||
  !authorization ||
  !privateKey ||
  !['app', 'speech'].includes(kind) ||
  !/^[a-zA-Z0-9.-]+$/.test(tag)
)
  throw Error('Release signing environment is incomplete.')
const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
const previousRelease = await read('.work/previous/metadata.json').catch((e) => {
  if (e.code !== 'ENOENT') throw e
})
const verifiedPrevious =
  previousRelease &&
  verifyCatalog(
    await read('.work/previous/catalog.json'),
    root,
    undefined,
    Date.parse(previousRelease.published_at),
  )
const previous = verifiedPrevious?.catalog
if (kind === 'speech' && !previous) throw Error('Publish an application release first.')
const version = (await read('package.json')).version
if (
  kind === 'app' &&
  (tag !== 'v' + version ||
    (previous && compareVersions(version, previous.components.app.version) <= 0))
)
  throw Error('Set the package version higher than the current stable release.')
const revisions = await read('scripts/release-versions.json')
const output = '.work/publish'
await mkdir(output, { recursive: true })
async function describe(component, name, source) {
  const asset = component === 'app' ? name : component + '-' + basename(name)
  const h = createHash('sha256')
  for await (const chunk of createReadStream(source)) h.update(chunk)
  const file = {
    name,
    url: 'https://github.com/petrovortex/En-GYM/releases/download/' + tag + '/' + asset,
    bytes: (await stat(source)).size,
    sha256: h.digest('hex'),
  }
  // Don't rehost unchanged speech binaries. Keep their immutable original URLs.
  const old = previous?.components[component].files.find(
    (f) => f.name === name && f.sha256 === file.sha256,
  )
  if (old && component !== 'app') return old
  await copyFile(source, join(output, asset))
  return file
}
const components = {}
for (const id of componentIds) {
  const spec =
    id === 'app'
      ? {
          version: kind === 'app' ? version : previous.components.app.version,
          minApp: '0.0.0',
          requires:
            kind === 'app' ? revisions.requires : previous.components.app.requires,
        }
      : revisions[id]
  const files = []
  for (const name of componentFiles[id]) {
    const source =
      id === 'app'
        ? join(kind === 'app' ? '.work/release' : '.work/previous', name)
        : join('.work/release/speech', name)
    files.push(await describe(id, name, source))
  }
  if (
    kind === 'speech' &&
    id === 'app' &&
    files[0].sha256 !== previous.components.app.files[0].sha256
  )
    throw Error(
      'The reattached installer does not match the last verified public installer.',
    )
  if (id !== 'app' && previous) {
    const old = previous.components[id],
      cmp = compareVersions(spec.version, old.version)
    if (
      cmp < 0 ||
      (!cmp &&
        files.some(
          (f) => !old.files.some((o) => o.name === f.name && o.sha256 === f.sha256),
        ))
    )
      throw Error('Increase the component version for changed ' + id + ' files.')
  }
  components[id] = { ...spec, files }
}
const delegation = JSON.parse(Buffer.from(authorization, 'base64').toString('utf8'))
const auth = JSON.parse(Buffer.from(delegation.payload, 'base64').toString('utf8'))
const envelope = {
  delegation,
  catalog: signBytes(
    {
      schema: 1,
      sequence: Math.max(Date.now(), (verifiedPrevious?.watermark.sequence ?? 0) + 1),
      expires: Math.min(auth.expires, Date.now() + 90 * 86400000),
      components,
    },
    privateKey,
  ),
}
verifyCatalog(envelope, root, verifiedPrevious?.watermark)
await writeFile(join(output, 'catalog.json'), JSON.stringify(envelope))
