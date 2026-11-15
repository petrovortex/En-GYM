// Preserve this salt for installed cache slots so a voice update can replace
// a checked recording atomically and leave the previous one playable until then.
export const ORIGINAL_PROMPT_PACK =
  'phonon-31m-en-q8-92741c5-0.7.0-en-all-seed4242424242424242-v1'
export const PHONON_PACK = ORIGINAL_PROMPT_PACK
export const PHONON_VOICES = ['default', 'hadley', 'preston'] as const
export type PhononVoice = (typeof PHONON_VOICES)[number]

// Reference and preview URLs used to be cached for a year. Change their URL with the voice pack too.
export function promptUrl(path: string, pack: string = PHONON_PACK) {
  return path + (path.includes('?') ? '&' : '?') + 'voice=' + encodeURIComponent(pack)
}
