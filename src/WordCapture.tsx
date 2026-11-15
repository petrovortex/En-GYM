import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  cleanTerm,
  type TextSelection,
  type VocabularyWord,
} from '../core/vocabulary.ts'
import { api } from './api.ts'

export function WordCapture({
  attempt,
  item,
  children,
  className,
  games,
  textId,
  onSaved,
}: (
  | {
      games: true
      textId?: never
      attempt?: never
      item?: never
    }
  | {
      textId: string
      games?: never
      attempt?: never
      item?: never
    }
  | {
      games?: false
      textId?: never
      attempt: string
      item: string
    }
) & {
  children: ReactNode
  className?: string
  onSaved?: (word: VocabularyWord) => void
}) {
  const root = useRef<HTMLDivElement>(null),
    toolbar = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{
    term: string
    context: string
    item?: string
    game?: string
    textSelection?: TextSelection
    left: number
    top: number
  }>()
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('')
  useEffect(() => {
    let frame = 0
    function read() {
      if (toolbar.current?.contains(document.activeElement)) return
      const selected = window.getSelection()
      if (!selected?.rangeCount || selected.isCollapsed) {
        setSelection(undefined)
        return
      }
      const range = selected.getRangeAt(0)
      if (
        !root.current?.contains(range.startContainer) ||
        !root.current.contains(range.endContainer)
      ) {
        setSelection(undefined)
        return
      }
      const elementFor = (n: Node) =>
        n instanceof Element ? n : n.parentElement
      const element = elementFor(range.startContainer)
      const card = games
        ? element?.closest<HTMLElement>('[data-game-item]')
        : undefined
      const choice = element?.closest('[data-word-choice]')
      if (
        (games &&
          (!card ||
            card !==
              elementFor(range.endContainer)?.closest(
                '[data-game-item]',
              ))) ||
        (!choice &&
          element?.closest(
            'button,input,textarea,select,a,summary,[contenteditable]',
          ))
      ) {
        setSelection(undefined)
        return
      }
      try {
        const raw = textId ? range.toString() : selected.toString()
        const selectedText = raw.trim()
        const term = cleanTerm(selectedText)
        let textSelection: TextSelection | undefined
        if (textId) {
          const paragraph = element?.closest<HTMLElement>(
            '[data-text-paragraph]',
          )
          if (!paragraph || !paragraph.contains(range.endContainer)) {
            setSelection(undefined)
            return
          }
          const prefix = range.cloneRange()
          prefix.selectNodeContents(paragraph)
          prefix.setEnd(range.startContainer, range.startOffset)
          textSelection = {
            id: textId,
            paragraph:
              paragraph.dataset.textParagraph === 'title'
                ? 'title'
                : Number(paragraph.dataset.textParagraph),
            offset:
              prefix.toString().length +
              raw.length -
              raw.trimStart().length,
            length: selectedText.length,
          }
        }
        const block = element?.closest(
          'p,li,.prose,h2,h3,.gapAnswers,span',
        )
        const example = card?.dataset.gameContext
        const useExample =
          example &&
          (choice ||
            example.toLowerCase().includes(selectedText.toLowerCase()))
        const sourceText = useExample
          ? example
          : (block?.textContent ?? example ?? selectedText)
        const text = sourceText.replace(/\s+/g, ' ').trim()
        const offset = Math.max(
          0,
          text.toLowerCase().indexOf(selectedText.toLowerCase()),
        )
        const start = Math.max(0, offset - 180)
        const context = text.slice(start, start + 560)
        const rect = range.getBoundingClientRect()
        setSelection({
          term,
          context,
          item: card?.dataset.gameItem ?? item,
          game: card?.dataset.gameTrack,
          textSelection,
          left: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
          top: Math.max(
            8,
            Math.min(rect.bottom + 9, window.innerHeight - 150),
          ),
        })
        setMessage('')
        setError('')
      } catch {
        setSelection(undefined)
      }
    }
    const changed = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(read)
    }
    const hide = () => {
      if (!toolbar.current?.contains(document.activeElement))
        setSelection(undefined)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelection(undefined)
        window.getSelection()?.removeAllRanges()
      }
    }
    document.addEventListener('selectionchange', changed)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    document.addEventListener('keydown', escape)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', changed)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      document.removeEventListener('keydown', escape)
    }
  }, [attempt, item, games, textId])
  async function save() {
    if (!selection || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<{ word: VocabularyWord; created: boolean }>(
        'vocabulary/add',
        {
          term: selection.term,
          context: selection.textSelection ? undefined : selection.context,
          attempt,
          item: selection.item,
          game: selection.game,
          textSelection: selection.textSelection,
        },
      )
      if (result.created) onSaved?.(result.word)
      setMessage(
        result.created
          ? 'Saved to vocabulary'
          : 'Already saved',
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div
        ref={root}
        className={className}
        onClickCapture={
          games
            ? (e) => {
                const choice = (e.target as Element).closest(
                  '[data-word-choice]',
                )
                const selection = window.getSelection()
                if (
                  e.detail &&
                  choice &&
                  selection &&
                  !selection.isCollapsed &&
                  choice.contains(selection.anchorNode) &&
                  choice.contains(selection.focusNode)
                ) {
                  e.preventDefault()
                  e.stopPropagation()
                }
              }
            : undefined
        }
      >
        {children}
      </div>
      {selection &&
        createPortal(
          <div
            className="wordCapture"
            ref={toolbar}
            style={{ left: selection.left, top: selection.top }}
            aria-label="Save selected word"
          >
            <div className="wordCaptureTop">
              <strong>{selection.term}</strong>
              <button
                type="button"
                aria-label="Dismiss word selection"
                onClick={() => setSelection(undefined)}
              >
                ×
              </button>
            </div>
            {message ? (
              <span role="status">{message}</span>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void save()}
              >
                {busy ? 'Saving…' : 'Save to vocabulary'}
              </button>
            )}
            {error && <small role="alert">{error}</small>}
          </div>,
          document.body,
        )}
    </>
  )
}
