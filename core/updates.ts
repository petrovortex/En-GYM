import { createHash, createPublicKey, verify } from 'node:crypto'

export const catalogUrl =
  'https://github.com/petrovortex/En-GYM/releases/latest/download/catalog.json'
export const componentIds = ['app', 'phonon', 'whisper'] as const
export type Component = (typeof componentIds)[number]
export interface ReleaseFile {
  name: string
  url: string
  bytes: number
  sha256: string
}
export interface ComponentRelease {
  version: string
  minApp: string
  files: ReleaseFile[]
  requires?: { phonon: string; whisper: string }
}
export interface Catalog {
  schema: 1
  sequence: number
  expires: number
  components: Record<Component, ComponentRelease>
}
export interface SignedBytes {
  payload: string
  signature: string
}
export interface Envelope {
  delegation: SignedBytes
  catalog: SignedBytes
}
export interface Watermark {
  authority: number
  sequence: number
  digest: string
}
export interface UpdatesStatus {
  state:
    | 'unsupported'
    | 'idle'
    | 'checking'
    | 'available'
    | 'current'
    | 'downloading'
    | 'restarting'
    | 'error'
  appVersion: string
  changes: { component: Component; version: string; bytes: number; minApp?: string }[]
  done: number
  total: number
  message: string
}
// Logical file names are chosen by this client. No remote path or command is executed.
export const componentFiles: Record<Component, string[]> = {
  app: ['En-GYM-Setup.exe'],
  phonon: [
    'model.q8.gguf',
    'tokenizer.json',
    'config.json',
    'preston-voice.safetensors',
    'hadley-voice.safetensors',
    'default-voice.safetensors',
  ].map((n) => 'phonon-31m-en/' + n),
  whisper: [
    'ggml-base.en-q5_1.bin',
    ...[
      'whisper-cli.exe',
      'whisper.dll',
      'ggml.dll',
      'ggml-cpu.dll',
      'ggml-base.dll',
      'SDL2.dll',
    ].map((n) => 'asr/' + n),
  ],
}
const repoAsset =
  /^https:\/\/github\.com\/petrovortex\/En-GYM\/releases\/download\/[\w.-]{1,96}\/[\w.-]{1,128}$/
const semver = /^(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})$/
export function compareVersions(a: string, b: string) {
  if (!semver.test(a) || !semver.test(b)) throw Error('Invalid release version.')
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
function signedJson<T>(signed: SignedBytes, pem: string): T {
  if (
    !signed ||
    typeof signed.payload !== 'string' ||
    signed.payload.length > 65536 ||
    typeof signed.signature !== 'string' ||
    signed.signature.length !== 88
  )
    throw Error('Update signature is missing or invalid.')
  const key = createPublicKey(pem),
    data = Buffer.from(signed.payload, 'base64')
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, data, key, Buffer.from(signed.signature, 'base64'))
  )
    throw Error('Update signature could not be verified.')
  return JSON.parse(data.toString('utf8'))
}
export function verifyCatalog(
  env: Envelope,
  root: string,
  previous?: Watermark,
  now = Date.now(),
) {
  const authority = signedJson<{
    schema: number
    generation: number
    expires: number
    key: string
  }>(env.delegation, root)
  if (
    authority.schema !== 1 ||
    !Number.isSafeInteger(authority.generation) ||
    authority.generation < 1 ||
    !Number.isSafeInteger(authority.expires) ||
    authority.expires <= now
  )
    throw Error('The update signing authorization expired or is invalid.')
  const catalog = signedJson<Catalog>(env.catalog, authority.key)
  if (
    catalog.schema !== 1 ||
    !Number.isSafeInteger(catalog.sequence) ||
    catalog.sequence <= 0 ||
    !Number.isSafeInteger(catalog.expires) ||
    catalog.expires <= now ||
    catalog.expires > authority.expires
  )
    throw Error('The update catalog expired or is invalid. Check the clock and retry.')
  const digest = createHash('sha256').update(env.catalog.payload).digest('hex')
  if (
    previous &&
    (authority.generation < previous.authority ||
      catalog.sequence < previous.sequence ||
      (catalog.sequence === previous.sequence && previous.digest !== digest))
  )
    throw Error('This update catalog is older than the one already verified.')
  for (const id of componentIds) {
    const value = catalog.components?.[id]
    if (
      !value ||
      !semver.test(value.version) ||
      !semver.test(value.minApp) ||
      compareVersions(value.minApp, catalog.components.app.version) > 0 ||
      !Array.isArray(value.files) ||
      value.files.length !== componentFiles[id].length
    )
      throw Error('Incompatible or incomplete update catalog.')
    const names = new Set(componentFiles[id])
    let size = 0
    for (const f of value.files) {
      if (
        !f ||
        !names.delete(f.name) ||
        !repoAsset.test(f.url) ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 1 ||
        f.bytes > 512 * 1024 * 1024
      )
        throw Error('An update file failed validation.')
      size += f.bytes
    }
    if (size > 1024 ** 3) throw Error('Update exceeds the supported package size.')
  }
  const requirements = catalog.components.app.requires
  if (
    !requirements ||
    ['phonon', 'whisper'].some((id) => {
      const key = id as 'phonon' | 'whisper'
      return (
        !semver.test(requirements[key]) ||
        compareVersions(requirements[key], catalog.components[key].version) > 0
      )
    })
  )
    throw Error('Invalid speech compatibility requirements.')
  return {
    catalog,
    watermark: { authority: authority.generation, sequence: catalog.sequence, digest },
  }
}
