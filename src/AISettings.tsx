import { useEffect, useState } from 'react'
import { api, type Prefs } from './api.ts'
import {
  providers,
  aiRoles,
  type AIRole,
  type Provider,
  type ModelSelection,
} from '../core/ai.ts'

type Choices = Record<AIRole, ModelSelection>
export function AISettings() {
  const [prefs, setPrefs] = useState<Prefs>()
  const [connection, setConnection] = useState<Provider>('chatgpt')
  const [testModel, setTestModel] = useState('')
  const [key, setKey] = useState('')
  const [choices, setChoices] = useState<Choices>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    api<Prefs>('prefs')
      .then((p) => {
        setPrefs(p)
        setChoices(p.roles)
        setConnection(p.roles.generation.provider)
        setTestModel(p.connections[p.roles.generation.provider].model)
      })
      .catch((e) => setNote(e.message))
  }, [])
  async function run(action: () => Promise<string>) {
    setBusy(true)
    setNote('')
    try {
      setNote(await action())
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function modelInput(
    provider: Provider,
    model: string,
    change: (value: string) => void,
    label: string,
  ) {
    const catalog = prefs?.connections[provider].models ?? []
    return provider === 'chatgpt' && catalog.length ? (
      <select
        aria-label={label}
        value={model}
        disabled={busy || !prefs}
        onChange={(e) => change(e.target.value)}
      >
        {!model && <option value="">Choose a model</option>}
        {[...new Set([model, ...catalog].filter(Boolean))].map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
    ) : (
      <input
        aria-label={label}
        value={model}
        disabled={busy || !prefs}
        placeholder={providers[provider].defaultModel || 'Model ID'}
        onChange={(e) => change(e.target.value)}
      />
    )
  }
  return (
    <section className="panel aiSettings">
      <h2>AI trainer</h2>
      <p>
        Connect your accounts, then choose a model for each task. Recordings
        stay on this computer.
      </p>
      <div className="aiConnection">
        <h3>Connections</h3>
        <label>
          Provider
          <select
            value={connection}
            disabled={busy || !prefs}
            onChange={(e) => {
              const p = e.target.value as Provider
              setConnection(p)
              setTestModel(
                prefs?.connections[p].model || providers[p].defaultModel,
              )
              setKey('')
              setNote('')
            }}
          >
            {(Object.keys(providers) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {providers[p].label}
              </option>
            ))}
          </select>
        </label>
        <small>
          {prefs?.connections[connection].configured
            ? 'Connection saved'
            : 'Not connected'}
        </small>
        {connection === 'chatgpt' ? (
          <button
            className="primary"
            data-oai-siwc-button=""
            disabled={busy || !prefs}
            onClick={() =>
              run(async () => {
                const r = await api<{ url: string }>('connect', {})
                window.location.assign(r.url)
                return 'Opening sign-in…'
              })
            }
          >
            Continue with ChatGPT
          </button>
        ) : (
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              disabled={busy}
              placeholder={
                prefs?.connections[connection].configured
                  ? 'Key saved — leave blank to keep it'
                  : 'Paste your API key'
              }
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        )}
        {(connection !== 'chatgpt' ||
          prefs?.connections.chatgpt.configured) && (
          <>
            <label>
              Model for connection test
              {modelInput(
                connection,
                testModel,
                setTestModel,
                'Connection test model',
              )}
            </label>
            <div className="row">
              <button
                disabled={busy || !testModel.trim()}
                onClick={() =>
                  run(async () => {
                    setPrefs(
                      await api<Prefs>('connections', {
                        provider: connection,
                        model: testModel.trim(),
                        key,
                      }),
                    )
                    setKey('')
                    setPrefs(
                      await api<Prefs>('verify', { provider: connection }),
                    )
                    return 'Connected. A test request completed. Choose where to use this model below.'
                  })
                }
              >
                Save and test connection
              </button>
              {prefs?.connections[connection].configured && (
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setPrefs(
                        await api<Prefs>('disconnect', {
                          provider: connection,
                        }),
                      )
                      return 'Connection removed. Model choices have been kept.'
                    })
                  }
                >
                  Disconnect
                </button>
              )}
            </div>
          </>
        )}
        {connection === 'chatgpt' && prefs?.connections.chatgpt.configured && (
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
          >
            Manage ChatGPT usage ↗
          </a>
        )}
      </div>
      <div className="aiAssignments">
        <h3>Models by task</h3>
        <p>
          Use the same model everywhere, or choose a different model for review.
        </p>
        {choices &&
          (Object.keys(aiRoles) as AIRole[]).map((role) => {
            const choice = choices[role]
            return (
              <fieldset className="aiRole" key={role}>
                <legend>{aiRoles[role]}</legend>
                <div className="aiRoleFields">
                  <label>
                    Provider
                    <select
                      disabled={busy}
                      aria-label={`${aiRoles[role]} provider`}
                      value={choice.provider}
                      onChange={(e) => {
                        const p = e.target.value as Provider
                        setChoices({
                          ...choices,
                          [role]: {
                            provider: p,
                            model:
                              prefs?.connections[p].model ||
                              providers[p].defaultModel,
                          },
                        })
                      }}
                    >
                      {(Object.keys(providers) as Provider[]).map((p) => (
                        <option key={p} value={p}>
                          {providers[p].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Model
                    {modelInput(
                      choice.provider,
                      choice.model,
                      (model) =>
                        setChoices({
                          ...choices,
                          [role]: { ...choice, model },
                        }),
                      `${aiRoles[role]} model`,
                    )}
                  </label>
                </div>
                {!prefs?.connections[choice.provider].configured && (
                  <small>
                    Connect {providers[choice.provider].label} above to use this
                    choice.
                  </small>
                )}
              </fieldset>
            )
          })}
        <button
          disabled={
            busy ||
            !choices ||
            Object.values(choices).some((c) => !c.model.trim())
          }
          onClick={() =>
            run(async () => {
              const roles = Object.fromEntries(
                Object.entries(choices!).map(([role, c]) => [
                  role,
                  { provider: c.provider, model: c.model.trim() },
                ]),
              )
              const p = await api<Prefs>('models', { roles })
              setPrefs(p)
              setChoices(p.roles)
              return 'Model choices saved.'
            })
          }
        >
          Save model choices
        </button>
      </div>
      {(busy || note) && (
        <p role="status">{busy ? 'Saving and checking…' : note}</p>
      )}
    </section>
  )
}
