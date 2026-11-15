import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { setting, configure, transaction } from './store.ts'
import {
  providers,
  aiRoles,
  type Provider,
  type AIRole,
  type ModelSelection,
  type ModelPreferences,
  type AIPreferences,
} from '../core/ai.ts'
const issuer = 'https://auth.openai.com',
  resource = 'https://api.openai.com/v1'
const jwks = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'))
const scope =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
interface Credential {
  access_token: string
  refresh_token: string
  id_token: string
  scope: string
  expires: number
  sub: string
  client: string
}
function protect(value: string, decode = false) {
  // Standard input keeps credentials out of command-line arguments and logs.
  const ps =
    'Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ' +
    (decode
      ? '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,0))'
      : '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,0))')
  const result = spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { input: value, encoding: 'utf8', windowsHide: true, timeout: 10000 },
  )
  if (result.status !== 0)
    throw Error('Windows could not access the protected credential store.')
  return result.stdout.trim()
}
const secret = (key: string) => {
  const data = setting(key)
  return data ? protect(data, true) : ''
}
const put = (key: string, v: string) => configure(key, v ? protect(v) : '')
const provider = () => (setting('provider') || 'chatgpt') as Provider
export function modelFor(role: AIRole = 'trainer'): ModelPreferences {
  const saved = setting('ai-role-' + role)
  const chosen: ModelSelection = saved
    ? JSON.parse(saved)
    : { provider: provider(), model: setting(provider() + '-model') }
  const p = chosen.provider
  return {
    provider: p,
    model: chosen.model,
    configured: !!setting(p + '-secret'),
    models:
      p === 'chatgpt'
        ? (JSON.parse(setting('chatgpt-models') || '[]') as string[])
        : [],
  }
}
export function preferences(): AIPreferences {
  return {
    ...modelFor('trainer'),
    roles: Object.fromEntries(
      Object.keys(aiRoles).map((role) => [role, modelFor(role as AIRole)]),
    ) as AIPreferences['roles'],
    connections: Object.fromEntries(
      Object.keys(providers).map((p) => [
        p,
        {
          configured: !!setting(p + '-secret'),
          model: setting(p + '-model') || providers[p as Provider].defaultModel,
          models:
            p === 'chatgpt'
              ? JSON.parse(setting('chatgpt-models') || '[]')
              : [],
        },
      ]),
    ) as AIPreferences['connections'],
  }
}
function validateSelection(p: Provider, model: string, allowEmpty = false) {
  if (!Object.hasOwn(providers, p)) throw Error('Unknown provider.')
  if (
    typeof model !== 'string' ||
    (!allowEmpty && !model) ||
    model.length > 100 ||
    !/^[-\w./]*$/.test(model)
  )
    throw Error('Enter a valid model ID.')
}
export function saveConnection(
  p: Provider,
  model: string,
  key?: string,
  preserveChoices = true,
) {
  validateSelection(p, model, p === 'chatgpt')
  if (key !== undefined && (typeof key !== 'string' || key.length > 16000))
    throw Error('Invalid API key.')
  const inherited = (Object.keys(aiRoles) as AIRole[])
    .filter(
      (role) =>
        preserveChoices && !setting('ai-role-' + role) && modelFor(role).model,
    )
    .map((role) => ({ role, choice: modelFor(role) }))
  transaction(() => {
    for (const { role, choice } of inherited)
      configure(
        'ai-role-' + role,
        JSON.stringify({ provider: choice.provider, model: choice.model }),
      )
    if (key?.trim() && p !== 'chatgpt') put(p + '-secret', key.trim())
    configure(p + '-model', model)
  })
}
export function setModels(roles: Record<AIRole, ModelSelection>) {
  for (const role of Object.keys(aiRoles) as AIRole[]) {
    if (!roles?.[role]) throw Error('Choose a model for each task.')
    validateSelection(roles[role].provider, roles[role].model)
  }
  transaction(() => {
    for (const role of Object.keys(aiRoles) as AIRole[])
      configure(
        'ai-role-' + role,
        JSON.stringify({
          provider: roles[role].provider,
          model: roles[role].model,
        }),
      )
  })
}
export function preparationModels() {
  const generation = modelFor('generation'),
    review = modelFor('review')
  const source = generation.provider + ':' + generation.model
  const reviewSource = review.provider + ':' + review.model
  return {
    generation,
    review,
    configured:
      generation.configured &&
      review.configured &&
      !!generation.model &&
      !!review.model,
    source: source === reviewSource ? source : source + '|' + reviewSource,
  }
}
export function setProvider(p: Provider, model: string, key?: string) {
  saveConnection(p, model, key, false)
  configure('provider', p)
}
export function disconnect(p: Provider = modelFor().provider) {
  validateSelection(p, '', true)
  put(p + '-secret', '')
  if (p === 'chatgpt') pending = undefined
}
type Pending = {
  state: string
  nonce: string
  verifier: string
  redirect: string
  until: number
  client: string
}
let pending: Pending | undefined
export function authorize(origin: string) {
  const host = setting('host') || 'urn:uuid:' + randomUUID()
  configure('host', host)
  const p = (pending = {
    state: randomBytes(32).toString('base64url'),
    nonce: randomUUID(),
    verifier: randomBytes(48).toString('base64url'),
    redirect: origin + '/auth/callback',
    until: Date.now() + 600000,
    client: setting('chatgpt-client'),
  })
  const query = new URLSearchParams({
    client_id: p.client || 'dynamic_agent_client',
    ext_agent_host_id: host,
    scope,
    resource,
    response_type: 'code',
    redirect_uri: p.redirect,
    state: p.state,
    nonce: p.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(p.verifier).digest('base64url'),
  })
  if (!p.client) query.set('agent_name_hint', 'En-GYM')
  return issuer + '/api/accounts/authorize?' + query
}
export class ProviderError extends Error {
  kind: 'quota' | 'access' | 'network'
  retryAt?: number
  constructor(
    message: string,
    kind: 'quota' | 'access' | 'network',
    retryAt?: number,
  ) {
    super(message)
    this.kind = kind
    this.retryAt = retryAt
  }
}
const quotaMessage = 'The provider usage limit was reached. Try again later.'
async function request(url: string, init: RequestInit, timeout = 90000) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) {
    if ([402, 429].includes(response.status))
      throw new ProviderError(
        quotaMessage,
        'quota',
        response.headers.get('retry-after')
          ? /^\d+$/.test(response.headers.get('retry-after')!)
            ? Date.now() + Number(response.headers.get('retry-after')) * 1000
            : Date.parse(response.headers.get('retry-after')!)
          : undefined,
      )
    if ([401, 403].includes(response.status))
      throw new ProviderError(
        'The provider denied access. Reconnect the account or check the key and model.',
        'access',
      )
    throw Error(
      'The AI provider could not complete this request (HTTP ' +
        response.status +
        ').',
    )
  }
  return response
}
async function token(params: Record<string, string>) {
  return (
    await request(issuer + '/api/accounts/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ ...params, resource }),
    })
  ).json()
}
export async function callback(params: URLSearchParams) {
  const p = pending
  if (!p || p.until < Date.now() || params.get('state') !== p.state)
    throw Error('Sign-in has expired. Start again from Settings.')
  pending = undefined
  if (params.has('error')) throw Error('ChatGPT sign-in was declined.')
  const client = params.get('client_id') || p.client
  if (
    !client ||
    client === 'dynamic_agent_client' ||
    (p.client && p.client !== client) ||
    !params.get('code')
  )
    throw Error('Invalid client registration.')
  configure('chatgpt-client', client)
  const t = await token({
    client_id: client,
    code: params.get('code')!,
    code_verifier: p.verifier,
    redirect_uri: p.redirect,
    grant_type: 'authorization_code',
  })
  const { payload } = await jwtVerify(t.id_token, jwks, {
    issuer,
    audience: client,
    requiredClaims: ['exp', 'sub', 'nonce'],
  })
  if (
    payload.nonce !== p.nonce ||
    !t.scope?.split(' ').includes('chatgpt.tokens.use.direct')
  )
    throw Error('Grant permission to use your ChatGPT plan, then try again.')
  const prev = secret('chatgpt-secret')
  if (prev && JSON.parse(prev).sub !== payload.sub)
    throw Error('The account does not match the saved connection.')
  put(
    'chatgpt-secret',
    JSON.stringify({
      ...t,
      sub: payload.sub,
      client,
      expires: Date.now() + t.expires_in * 1000,
    }),
  )
  if (!setting('provider')) configure('provider', 'chatgpt')
  await verify('chatgpt')
}
let renewing: Promise<string> | undefined
async function access() {
  const v = secret('chatgpt-secret')
  if (!v) throw Error('Connect ChatGPT in Settings to use AI coaching.')
  const c: Credential = JSON.parse(v)
  if (c.expires > Date.now() + 60000) return c.access_token
  if (!renewing)
    renewing = (async () => {
      const t = await token({
        grant_type: 'refresh_token',
        refresh_token: c.refresh_token,
        client_id: c.client,
      })
      if (t.scope && !t.scope.split(' ').includes('chatgpt.tokens.use.direct'))
        throw Error('Reconnect ChatGPT and allow plan usage.')
      put(
        'chatgpt-secret',
        JSON.stringify({
          ...c,
          ...t,
          refresh_token: t.refresh_token || c.refresh_token,
          expires: Date.now() + t.expires_in * 1000,
        }),
      )
      return t.access_token as string
    })().finally(() => {
      renewing = undefined
    })
  return renewing
}
export async function completionText(response: Response) {
  let text = '',
    done = false,
    buffer = ''
  const reader = response.body!.getReader(),
    decoder = new TextDecoder()
  function line(s: string) {
    if (!s.startsWith('data:')) return
    const data = s.slice(5).trim()
    if (!data || data === '[DONE]') return
    const event = JSON.parse(data)
    if (event.type === 'response.output_text.delta') text += event.delta
    if (event.type === 'response.completed') done = true
    if (
      ['response.failed', 'response.incomplete', 'error'].includes(event.type)
    ) {
      const code = String(
        event.error?.code ?? event.response?.error?.code ?? '',
      )
      if (/quota|rate_limit|usage_limit/.test(code))
        throw new ProviderError(
          quotaMessage,
          'quota',
        )
      throw Error('The AI response was interrupted. Retry from this attempt.')
    }
  }
  for (;;) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value, { stream: !chunk.done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const l of lines) line(l)
    if (chunk.done) break
  }
  line(buffer)
  if (!done || !text.trim())
    throw Error('The AI response was incomplete. Retry when connected.')
  return text.trim()
}
export async function complete(
  instructions: string,
  input: string,
  timeout = 90000,
  role: AIRole = 'trainer',
) {
  try {
    return await completeWith(modelFor(role), instructions, input, timeout)
  } catch (e) {
    if ((e instanceof TypeError && (e.cause || e.message === 'fetch failed')) ||
        (e instanceof Error && ['AbortError', 'TimeoutError'].includes(e.name)))
      throw new ProviderError('Check your connection and try again.', 'network')
    throw e
  }
}
async function completeWith(
  selection: ModelSelection,
  instructions: string,
  input: string,
  timeout = 90000,
) {
  const { provider: p, model } = selection
  if (!model)
    throw Error('Choose a model and verify your AI connection in Settings.')
  const key = p === 'chatgpt' ? await access() : secret(p + '-secret')
  if (!key) throw Error('Connect your AI provider in Settings.')
  if (p === 'mercury') {
    const response = await request(
      'https://api.inceptionlabs.ai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: input },
          ],
          stream: false,
          max_completion_tokens: 16384,
        }),
      },
      timeout,
    )
    const result = await response.json(),
      choice = result.choices?.[0]
    if (
      choice?.finish_reason !== 'stop' ||
      typeof choice?.message?.content !== 'string' ||
      !choice.message.content.trim()
    )
      throw Error(
        'Mercury returned an incomplete response. Your work is saved; retry or check the selected model.',
      )
    return choice.message.content.trim()
  }
  if (p === 'gemini') {
    const response = await request(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) +
        ':generateContent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: input }] }],
        }),
      },
      timeout,
    )
    const r = await response.json(),
      c = r.candidates?.[0]
    const text = c?.content?.parts
      ?.filter((p: { thought?: boolean }) => !p.thought)
      .map((p: { text: string }) => p.text)
      .join('')
    if (c?.finishReason !== 'STOP' || !text)
      throw Error('Gemini returned an incomplete response.')
    return text
  }
  const response = await request(
    resource + '/responses',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions,
        input: [{ role: 'user', content: input }],
        stream: true,
        store: false,
      }),
    },
    timeout,
  )
  return completionText(response)
}
export async function verify(p: Provider = modelFor().provider) {
  validateSelection(p, '', true)
  if (p === 'chatgpt') {
    const response = await request(resource + '/models', {
      headers: { Authorization: 'Bearer ' + (await access()) },
    })
    const catalog = (await response.json()).models
      ?.filter((m: { visibility: string }) => m.visibility === 'list')
      .map((m: { slug: string }) => m.slug)
    if (!catalog?.length) throw Error('No models are available on this plan.')
    configure('chatgpt-models', JSON.stringify(catalog))
    const selected = setting('chatgpt-model')
    if (selected && !catalog.includes(selected))
      throw Error(
        'The selected model is unavailable on this account. Choose another model in Settings; it has not been changed automatically.',
      )
    if (!selected) configure('chatgpt-model', catalog[0])
  }
  await completeWith(
    { provider: p, model: setting(p + '-model') || providers[p].defaultModel },
    'Answer briefly.',
    'Reply with the word ready.',
  )
  return preferences()
}
