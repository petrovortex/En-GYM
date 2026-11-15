import { randomBytes } from 'node:crypto'

const minute = 60_000

// Only the child process and the tray share the pipe that issues launch tickets.
// Browser credentials are separate, tab-scoped, and never accepted in URL parameters.
export class LocalSessions {
  private tickets = new Map<string, number>()
  private sessions = new Map<string, number>()

  private issue(entries: Map<string, number>, ttl: number) {
    const now = Date.now()
    for (const [value, until] of entries) if (until <= now) entries.delete(value)
    if (entries.size >= 64) entries.delete(entries.keys().next().value!)
    const value = randomBytes(32).toString('hex')
    entries.set(value, now + ttl)
    return value
  }

  ticket() {
    return this.issue(this.tickets, minute)
  }

  exchange(ticket: unknown) {
    if (typeof ticket !== 'string') return
    const until = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (until && until > Date.now()) return this.issue(this.sessions, 24 * 60 * minute)
  }

  authenticated(header?: string) {
    if (!header?.startsWith('Bearer ')) return false
    const token = header.slice(7)
    const until = this.sessions.get(token)
    if (!until || until <= Date.now()) return false
    this.sessions.delete(token)
    this.sessions.set(token, Date.now() + 24 * 60 * minute)
    return true
  }
}

export const launchPage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>En-GYM</title><p id="status" role="status">Opening En-GYM…</p><script src="/launch.js" defer></script></html>`

export const launchScript = `(async () => {
  const ticket = location.hash.slice(1)
  history.replaceState(null, '', '/launch')
  try {
    const r = await fetch('/api/local-session', {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Fieldwork': 'local' },
      body: JSON.stringify({ticket})
    })
    if (!r.ok) throw Error()
    const {session} = await r.json()
    sessionStorage.setItem('en-gym-session', session)
    location.replace('/')
  } catch {
    document.getElementById('status').textContent = 'Open En-GYM from its desktop shortcut or tray icon to start a new session.'
  }
})()`
