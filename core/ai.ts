export const providers = {
  chatgpt: { label: 'ChatGPT plan', defaultModel: '' },
  openai: { label: 'OpenAI API', defaultModel: '' },
  gemini: { label: 'Gemini API', defaultModel: '' },
  mercury: { label: 'Mercury (Inception API)', defaultModel: 'mercury-3' },
} as const
export type Provider = keyof typeof providers
export const aiRoles = {
  trainer: 'Trainer & grading',
  generation: 'Create exercises',
  review: 'Review exercises',
} as const
export type AIRole = keyof typeof aiRoles
export interface ModelSelection {
  provider: Provider
  model: string
}
export interface ModelPreferences extends ModelSelection {
  configured: boolean
  models: string[]
}
export interface AIPreferences extends ModelPreferences {
  roles: Record<AIRole, ModelPreferences>
  connections: Record<
    Provider,
    { configured: boolean; model: string; models: string[] }
  >
}
