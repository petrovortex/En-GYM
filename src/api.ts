import type { Answer, Attempt, Item, Mode, Section } from '../core/types.ts'
export interface LiveView {
  id: string
  mode: Mode
  focus: string
  stage: number
  index: number
  deadline: number
  itemStarted: number
  stageName: string
  section: Section
  count: number
  minutes: number
  answer: Answer
  responseUntil: number
  item: Item
  audio: string | null
  played: boolean
  limit: number
  ended?: undefined
}
export type Session = LiveView | Attempt
export const isLive = (s: Session): s is LiveView => 'item' in s
export function browserSession() {
  return sessionStorage.getItem('en-gym-session')
}
export function localFetch(path: string, init?: RequestInit) {
  const url = new URL(path, window.location.origin)
  if (url.origin !== window.location.origin) throw Error('Invalid local request.')
  const headers = new Headers(init?.headers)
  const token = browserSession()
  if (token) headers.set('Authorization', 'Bearer ' + token)
  return fetch(url, { ...init, headers, redirect: 'error', cache: 'no-store' })
}
export async function localAudioUrl(path: string, signal?: AbortSignal) {
  if (!browserSession()) return path
  const response = await localFetch(path, { signal })
  if (!response.ok) throw Error('Audio is unavailable. Open En-GYM from its tray icon and try again.')
  return URL.createObjectURL(await response.blob())
}
export async function api<T>(path: string, data?: unknown): Promise<T> {
  const r = await localFetch(
    '/api/' + path,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-fieldwork': 'local',
          },
          body: JSON.stringify(data),
        },
  )
  const result = await r.json()
  if (!r.ok)
    throw Object.assign(
      Error(result.error ?? 'The local service is unavailable.'),
      { code: result.code },
    )
  return result
}
export type Prefs = import('../core/ai.ts').AIPreferences
export const date = (n: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(n)
