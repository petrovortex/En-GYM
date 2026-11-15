import { useState } from 'react'
import { promptUrl } from '../core/speech.ts'
import { api } from './api.ts'
import { SessionAudio } from './SessionAudio.tsx'
import { AISettings } from './AISettings.tsx'
import { Updates } from './Updates.tsx'
import { microphone, stopStream } from './audio.ts'
import { StockStatus, type StockState } from './StockStatus.tsx'
export function Settings({
  stock,
  onBankChange,
}: {
  stock?: StockState
  onBankChange: (bank: StockState['bank']) => void
}) {
  const bank = stock?.bank
  const [bankBusy, setBankBusy] = useState(false),
    [bankNote, setBankNote] = useState(''),
    [pendingEnabled, setPendingEnabled] = useState<boolean>(),
    [micNote, setMicNote] = useState(''),
    [checkingMic, setCheckingMic] = useState(false)
  return (
    <>
      <div className="pagehead">
        <h1>Settings</h1>
      </div>
      <div className="settingsList">
        <AISettings />
        <section className="panel">
          <h2>Automatic preparation</h2>
          <label className="toggleLabel">
            <input
              type="checkbox"
              checked={pendingEnabled ?? bank?.enabled ?? true}
              disabled={!bank || bankBusy}
              onChange={async (e) => {
                const enabled = e.target.checked
                setPendingEnabled(enabled)
                setBankBusy(true)
                setBankNote('')
                try {
                  onBankChange(
                    await api<NonNullable<typeof bank>>('bank', { enabled }),
                  )
                } catch (e) {
                  setBankNote((e as Error).message)
                } finally {
                  setBankBusy(false)
                  setPendingEnabled(undefined)
                }
              }}
            />{' '}
            Prepare fresh exercises in the background
          </label>
          {bankNote && <p role="alert">{bankNote}</p>}
          <p>
            The app prepares exercises before you need them and stops when the
            reserve is full. Creation and review use the models chosen above and
            their plan allowance or API credit.
          </p>
          <p>
            You can close the browser while En-GYM is running. If you go
            offline or reach your AI limit, the app waits and retries
            automatically.
          </p>
          <StockStatus stock={stock} embedded />
          {bank && (
            <small className="stockUsage">
              AI requests for preparation in the last 24 hours:{' '}
              {bank.requests + bank.onDemandRequests}
            </small>
          )}
        </section>
        <section className="panel">
          <h2>Microphone and sound</h2>
          <p>Test the microphone you’ll use for speaking.</p>
          <button
            disabled={checkingMic}
            onClick={async () => {
              setCheckingMic(true)
              try {
                const stream = await microphone()
                const label = stream.getAudioTracks()[0]?.label
                stopStream(stream)
                setMicNote(
                  label ? 'Microphone ready · ' + label : 'Microphone ready.',
                )
              } catch (e) {
                setMicNote((e as Error).message)
              } finally {
                setCheckingMic(false)
              }
            }}
          >
            Check microphone
          </button>
          {micNote && <p role="status">{micNote}</p>}
          <label>
            Listen to a sample prompt
            <SessionAudio
              src={promptUrl('/api/voice-preview')}
              label="Preview local voices"
            />
          </label>
        </section>
        <Updates />
      </div>
    </>
  )
}
