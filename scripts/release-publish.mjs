import { execFileSync } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const repo = 'petrovortex/En-GYM'
const gh = (...args) => execFileSync('gh', args, { stdio: 'inherit', windowsHide: true })
const read = async (resource) => {
  const res = await fetch('https://api.github.com/repos/' + repo + '/' + resource, {
    headers: {
      authorization: 'Bearer ' + process.env.GH_TOKEN,
      accept: 'application/vnd.github+json',
    },
  })
  if (res.status === 404) return undefined
  if (!res.ok)
    throw Error('Could not confirm GitHub release state (HTTP ' + res.status + ').')
  return res.json()
}
if (
  process.env.GITHUB_REPOSITORY?.toLowerCase() !== repo.toLowerCase() ||
  process.env.GITHUB_REF !== 'refs/heads/main'
)
  throw Error('Publish from the official main branch.')
const mode = process.argv[2]
if (mode === 'previous') {
  const p = await read('releases/latest')
  if (p) {
    await mkdir('.work/previous', { recursive: true })
    await writeFile(
      '.work/previous/metadata.json',
      JSON.stringify({ published_at: p.published_at }),
    )
    gh(
      'release',
      'download',
      p.tag_name,
      '--repo',
      repo,
      '--dir',
      '.work/previous',
      '--pattern',
      'catalog.json',
    )
    if (process.env.RELEASE_KIND === 'speech')
      gh(
        'release',
        'download',
        p.tag_name,
        '--repo',
        repo,
        '--dir',
        '.work/previous',
        '--pattern',
        'En-GYM-Setup.exe',
      )
  }
} else if (mode === 'publish') {
  const tag = process.env.RELEASE_TAG,
    sha = process.env.GITHUB_SHA
  if (!/^[\w.-]+$/.test(tag) || !/^[a-f0-9]{40}$/.test(sha))
    throw Error('Invalid release ref.')
  const prior = await read('releases/tags/' + tag)
  if (prior && (!prior.draft || prior.target_commitish !== sha))
    throw Error('This release tag is already in use.')
  if (!prior)
    gh(
      'release',
      'create',
      tag,
      '--repo',
      repo,
      '--draft',
      '--target',
      sha,
      '--title',
      'En-GYM ' + tag,
      '--generate-notes',
    )
  const files = await readdir('.work/publish')
  gh(
    'release',
    'upload',
    tag,
    '--repo',
    repo,
    '--clobber',
    ...files.map((f) => join('.work/publish', f)),
  )
  gh('release', 'edit', tag, '--repo', repo, '--draft=false', '--latest')
} else throw Error('Expected previous or publish.')
