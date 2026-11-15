import { useEffect, useRef, useState } from 'react'
import { browserSession, localAudioUrl } from './api.ts'

// Load private media on demand. Native audio controls can't set an Authorization header.
export function SessionAudio({ src, label }: { src: string; label: string }) {
  if (!browserSession()) return <audio controls preload="none" aria-label={label} src={src} />
  return <PrivateAudio key={src} src={src} label={label} />
}

function PrivateAudio({ src, label }: { src: string; label: string }) {
  const player = useRef<HTMLAudioElement>(null)
  const controller = useRef<AbortController | null>(null)
  const objectUrl = useRef('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => () => {
    controller.current?.abort()
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
  }, [])
  async function play() {
    if (busy) return
    const request = new AbortController()
    controller.current = request
    setBusy(true)
    setError('')
    try {
      const url = await localAudioUrl(src, request.signal)
      if (!player.current || request.signal.aborted) {
        URL.revokeObjectURL(url)
        return
      }
      objectUrl.current = url
      player.current.src = url
      setReady(true)
      await player.current.play()
    } catch (e) {
      if (!request.signal.aborted) setError((e as Error).message)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  return <>
    {!ready && <button type="button" disabled={busy} onClick={() => void play()}>
      {busy ? 'Loading audio…' : 'Play ' + label.toLowerCase()}
    </button>}
    <audio hidden={!ready} ref={player} controls preload="none" aria-label={label} />
    {error && <small role="alert">{error}</small>}
  </>
}
