import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export function signBytes(value, privateKey) {
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Use an Ed25519 release key.')
  const data = Buffer.from(JSON.stringify(value))
  return {
    payload: data.toString('base64'),
    signature: sign(null, data, key).toString('base64'),
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [operation, directory, generation = '1'] = process.argv.slice(2)
  if (!directory || !['init', 'delegate', 'rotate'].includes(operation))
    throw Error(
      'Usage: node scripts/release-keys.mjs init|delegate|rotate <private directory outside checkout> [generation]',
    )
  const destination = resolve(directory),
    child = relative(process.cwd(), destination)
  if (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
    throw Error('Keep signing keys outside the repository.')
  const gen = Number(generation)
  if (!Number.isSafeInteger(gen) || gen < 1 || (operation === 'rotate' && gen < 2))
    throw Error('Use a positive signing generation, starting rotation at 2.')
  if (operation === 'init' && gen !== 1)
    throw Error('Initialize signing at generation 1.')
  const roleName = gen > 1 ? 'release-' + gen : 'release'
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const current = await readFile(join(destination, 'delegation.b64'), 'utf8').catch(
    (e) => {
      if (e.code !== 'ENOENT') throw e
    },
  )
  if (current) {
    const cert = JSON.parse(Buffer.from(current, 'base64').toString())
    const last = JSON.parse(Buffer.from(cert.payload, 'base64').toString()).generation
    if (gen < last || (operation === 'rotate' && gen === last))
      throw Error(
        'The signing generation must be current for renewal, or higher for rotation.',
      )
  }
  for (const role of operation === 'init'
    ? ['root', 'release']
    : operation === 'rotate'
      ? [roleName]
      : []) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    await writeFile(
      join(destination, role + '.pem'),
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600, flag: 'wx' },
    )
    await writeFile(
      join(destination, role + '.pub'),
      publicKey.export({ format: 'pem', type: 'spki' }),
      { flag: 'wx' },
    )
  }
  const privateKey = await readFile(join(destination, 'root.pem'), 'utf8')
  const signer = createPublicKey(
    await readFile(join(destination, roleName + '.pub'), 'utf8'),
  )
  const signed = signBytes(
    {
      schema: 1,
      generation: gen,
      expires: Date.now() + 365 * 86400000,
      key: signer.export({ format: 'pem', type: 'spki' }).toString(),
    },
    privateKey,
  )
  // This value is public. No private key is ever written to stdout.
  await writeFile(
    join(destination, 'delegation.b64'),
    Buffer.from(JSON.stringify(signed)).toString('base64'),
  )
  console.log(
    'Public delegation saved. Store the private directory outside source control.',
  )
}
