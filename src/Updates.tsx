import { useEffect, useState } from 'react'
import { api } from './api.ts'
import type { Component, UpdatesStatus } from '../core/updates.ts'

const componentNames = {
  app: 'En-GYM',
  phonon: 'Practice voices',
  whisper: 'Speech recognition',
}
const size = (bytes: number) =>
  new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(
    bytes / 1048576,
  ) + ' MiB'

export function Updates() {
  const [status, setStatus] = useState<UpdatesStatus>()
  const [unchecked, setUnchecked] = useState<Component[]>([])
  const [error, setError] = useState('')
  const [requesting, setRequesting] = useState<'check' | 'install'>()
  const polling =
    status?.state === 'checking' || status?.state === 'downloading'
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const next = await api<UpdatesStatus>('updates/status')
        if (active) {
          setStatus(next)
          setError('')
        }
      } catch (e) {
        if (active)
          setError(
            polling
              ? 'Open En-GYM from the tray to check the update.'
              : (e as Error).message,
          )
        return
      }
      if (active && polling) timer = setTimeout(refresh, 800)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [polling])
  async function run(action: 'check' | 'install') {
    setRequesting(action)
    setError('')
    try {
      if (action === 'check') setUnchecked([])
      setStatus(
        await api<UpdatesStatus>(
          'updates/' + action,
          action === 'check' ? {} : { components: selected },
        ),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRequesting(undefined)
    }
  }
  const busy = !!requesting || polling || status?.state === 'restarting'
  const selected = (status?.changes ?? [])
    .map((c) => c.component)
    .filter((c) => !unchecked.includes(c))
  return (
    <section className="panel updatesPanel">
      <h2>Updates</h2>
      {status && <p>En-GYM {status.appVersion}</p>}
      {!!status?.changes.length && (
        <ul className="componentUpdates">
          {status.changes.map((c) => (
            <li key={c.component}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(c.component)}
                  disabled={busy}
                  onChange={(e) =>
                    setUnchecked((prev) =>
                      e.target.checked
                        ? prev.filter((id) => id !== c.component)
                        : [...prev, c.component],
                    )
                  }
                />
                {componentNames[c.component]} · {c.version}
              </label>
              <span>{size(c.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {status?.state === 'downloading' && (
        <progress
          aria-label="Update download"
          value={status.done}
          max={status.total || 1}
        />
      )}
      <p role="status">{status?.message}</p>
      {status?.state === 'restarting' && (
        <p>Open En-GYM from the tray when the update finishes.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {status?.state !== 'unsupported' && (
        <div className="row">
          <button
            disabled={busy || (!status && !error)}
            onClick={() => void run('check')}
          >
            {requesting === 'check' || status?.state === 'checking'
              ? 'Checking…'
              : 'Check for updates'}
          </button>
          {status?.state === 'available' && (
            <button
              className="primary"
              disabled={busy || !selected.length}
              onClick={() => void run('install')}
            >
              Update and restart
            </button>
          )}
        </div>
      )}
    </section>
  )
}
