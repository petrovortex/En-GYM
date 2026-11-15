import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { verifyCatalog, catalogUrl } from '../core/updates.ts'

const publicDownload =
  'https://github.com/petrovortex/En-GYM/releases/latest/download/En-GYM-Setup.exe'
const tested = (process.env.TESTED_INSTALLER_SHA256 || '').toLowerCase()
assert.match(
  tested,
  /^[a-f0-9]{64}$/,
  'Provide the SHA-256 from the Windows download test.',
)
const catalogResponse = await fetch(catalogUrl, {
  signal: AbortSignal.timeout(30000),
})
assert.equal(
  catalogResponse.status,
  200,
  'The public catalog must be available.',
)
const trust = JSON.parse(await readFile('scripts/release-trust.json', 'utf8'))
const { catalog } = verifyCatalog(await catalogResponse.json(), trust.root)
const setup = catalog.components.app.files.find(
  (file) => file.name === 'En-GYM-Setup.exe',
)
assert.equal(
  setup.sha256,
  tested,
  'The tested installer differs from the signed catalog.',
)
for (const download of [publicDownload, setup.url]) {
  const response = await fetch(download, {
    signal: AbortSignal.timeout(300000),
  })
  assert.equal(response.status, 200, 'The public installer must be available.')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    assert.ok(bytes <= setup.bytes, 'The download exceeds the signed size.')
    hash.update(chunk)
  }
  assert.equal(bytes, setup.bytes)
  assert.equal(
    hash.digest('hex'),
    tested,
    'The public download differs from the tested installer.',
  )
}

const output = '.work/pages'
await cp('site', output, { recursive: true })
const index = await readFile(output + '/index.html', 'utf8')
const size = new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(
  setup.bytes / 1048576,
)
await writeFile(
  output + '/index.html',
  index
    .replace(publicDownload, setup.url)
    .replace('<span data-setup-size></span>', ' · ' + size + ' MiB'),
)
const guide = await readFile(output + '/guide.html', 'utf8')
await writeFile(
  output + '/guide.html',
  guide
    .replace(publicDownload, setup.url)
    .replace(
      '<!-- verified-installer -->',
      '<details><summary>Installer version and checksum</summary><p>En-GYM ' +
        catalog.components.app.version +
        ' · ' +
        size +
        ' MiB</p><p>SHA-256<br><code>' +
        tested +
        '</code></p></details>',
    ),
)
console.log(
  'Verified the public download for En-GYM ' +
    catalog.components.app.version +
    '.',
)
