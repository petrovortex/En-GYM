export interface WordSource {
  attempt: string
  item: string
  title: string
  context: string
  saved: number
}
export interface VocabularyWord {
  id: string
  term: string
  created: number
  sources: WordSource[]
}
export interface VocabularyText {
  id: string
  created: number
  topic: string
  length: number
  title: string
  text: string
  words: string[]
  model: string
}
export interface VocabularyData {
  words: VocabularyWord[]
  texts: VocabularyText[]
}
export interface TextSelection {
  id: string
  paragraph: number | 'title'
  offset: number
  length: number
}
export const textParagraphs = (text: string) => text.split(/\n\s*\n/)
export const textSourceKey = (id: string) => 'text:' + id
export function cleanTerm(value: unknown) {
  if (typeof value !== 'string')
    throw Error('Enter a word or short phrase.')
  const term = value
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[.,!?;:"“”()\[\]]+|[.,!?;:"“”()\[\]]+$/g, '')
    .trim()
  if (
    !term ||
    term.length > 80 ||
    term.split(' ').length > 8 ||
    !/\p{L}/u.test(term) ||
    /[\p{Cc}<>]/u.test(term)
  )
    throw Error('Select a word or a short phrase (up to 8 words).')
  return term
}
export function wordPattern(terms: string[], global = false) {
  const escaped = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) =>
      term
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/ /g, '\\s+')
        .replace(/'/g, "['’]"),
    )
  return new RegExp(
    '(?<![\\p{L}\\p{N}])(' + escaped.join('|') + ')(?![\\p{L}\\p{N}])',
    global ? 'giu' : 'iu',
  )
}
export const wordCount = (text: string) =>
  text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0
export function checkVocabularyText(
  raw: string,
  words: string[],
  length: number,
) {
  let result: { title?: unknown; text?: unknown }
  try {
    result = JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/```$/, ''),
    )
  } catch {
    throw Error(
      'The trainer returned an unreadable text. Please try again.',
    )
  }
  if (
    !result ||
    typeof result.title !== 'string' ||
    typeof result.text !== 'string' ||
    !result.title.trim() ||
    result.title.length > 160 ||
    result.text.length > 16000
  )
    throw Error(
      'The trainer returned an incomplete text. Please try again.',
    )
  const count = wordCount(result.text)
  const missing = words.filter(
    (word) => !wordPattern([word]).test(result.text as string),
  )
  if (missing.length)
    throw Error(
      'The trainer left out: ' + missing.join(', ') + '. Please try again.',
    )
  if (count < length * 0.8 || count > length * 1.2)
    throw Error(
      'The trainer did not follow the requested length. Please try again.',
    )
  return { title: result.title.trim(), text: result.text.trim() }
}
