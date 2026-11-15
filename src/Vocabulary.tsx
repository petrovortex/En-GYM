import { useEffect, useRef, useState } from 'react'
import { api, date, type Prefs } from './api.ts'
import { Games } from './Games.tsx'
import { WordCapture } from './WordCapture.tsx'
import {
  wordPattern,
  wordCount,
  textParagraphs,
  textSourceKey,
  type VocabularyData,
  type VocabularyText,
  type VocabularyWord,
} from '../core/vocabulary.ts'

function Highlighted({ text, words }: { text: string; words: string[] }) {
  return text
    .split(wordPattern(words, true))
    .map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))
}
export function Vocabulary() {
  const [data, setData] = useState<VocabularyData>({
    words: [],
    texts: [],
  })
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [query, setQuery] = useState(''),
    [term, setTerm] = useState(''),
    [selected, setSelected] = useState<string[]>([])
  const [topic, setTopic] = useState(''),
    [length, setLength] = useState(250),
    [busy, setBusy] = useState(false),
    [adding, setAdding] = useState(false)
  const [tab, setTab] = useState<'Words' | 'Games' | 'Texts'>(() =>
      sessionStorage.getItem('vocabulary-view') === 'Games'
        ? 'Games'
        : 'Words',
    ),
    [open, setOpen] = useState(''),
    [prefs, setPrefs] = useState<Prefs>()
  const [deleting, setDeleting] = useState('')
  const mounted = useRef(true)
  const reader = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    sessionStorage.setItem('vocabulary-view', tab)
  }, [tab])
  useEffect(() => {
    mounted.current = true
    void api<VocabularyData>('vocabulary')
      .then((v) => {
        if (mounted.current) setData(v)
      })
      .catch((e) => {
        if (mounted.current) setError(e.message)
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
    void api<Prefs>('prefs')
      .then((v) => {
        if (mounted.current) setPrefs(v)
      })
      .catch(() => {})
    return () => {
      mounted.current = false
    }
  }, [])
  const visible = data.words.filter((w) =>
    w.term.toLowerCase().includes(query.toLowerCase().trim()),
  )
  const chosen = data.words.filter((w) => selected.includes(w.id))
  const current = data.texts.find((t) => t.id === open) ?? data.texts[0]
  const textIds = new Map(
    data.texts.map((t) => [textSourceKey(t.id), t.id]),
  )
  function openText(id: string) {
    setOpen(id)
    setTab('Texts')
    requestAnimationFrame(() => reader.current?.focus())
  }
  function toggle(id: string) {
    setSelected((value) =>
      value.includes(id)
        ? value.filter((x) => x !== id)
        : value.length < 20
          ? [...value, id]
          : value,
    )
  }
  function rememberWord(word: VocabularyWord) {
    setData((d) => ({
      ...d,
      words: [word, ...d.words.filter((w) => w.id !== word.id)],
    }))
  }
  async function add() {
    if (adding) return
    setAdding(true)
    setError('')
    setNotice('')
    try {
      const result = await api<{ word: VocabularyWord; created: boolean }>(
        'vocabulary/add',
        { term },
      )
      if (result.created) {
        rememberWord(result.word)
        setTerm('')
      }
      setNotice(
        result.created
          ? 'Word saved.'
          : 'This word is already in your vocabulary.',
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }
  async function remove(id: string, text = false) {
    setDeleting(id)
    setError('')
    try {
      await api(text ? 'vocabulary/remove-text' : 'vocabulary/remove', {
        id,
      })
      if (text)
        setData((d) => ({
          ...d,
          texts: d.texts.filter((t) => t.id !== id),
        }))
      else {
        setData((d) => ({
          ...d,
          words: d.words.filter((w) => w.id !== id),
        }))
        setSelected((s) => s.filter((x) => x !== id))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting('')
    }
  }
  async function generate() {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const text = await api<VocabularyText>('vocabulary/text', {
        ids: selected,
        topic,
        length,
      })
      if (!mounted.current) return
      setData((d) => ({ ...d, texts: [text, ...d.texts] }))
      openText(text.id)
    } catch (e) {
      if (mounted.current) setError((e as Error).message)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <>
      <div className="pagehead vocabularyHeading">
        <h1>Vocabulary</h1>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <div className="tabs vocabularyTabs" aria-label="Vocabulary view">
        <button
          className={tab === 'Words' ? 'on' : ''}
          aria-pressed={tab === 'Words'}
          onClick={() => setTab('Words')}
        >
          Words <span>{data.words.length}</span>
        </button>
        <button
          className={tab === 'Games' ? 'on' : ''}
          aria-pressed={tab === 'Games'}
          onClick={() => setTab('Games')}
        >
          Games
        </button>
        <button
          className={tab === 'Texts' ? 'on' : ''}
          aria-pressed={tab === 'Texts'}
          onClick={() => setTab('Texts')}
        >
          Texts <span>{data.texts.length}</span>
        </button>
      </div>
      {tab === 'Games' ? (
        <WordCapture games onSaved={rememberWord}>
          <Games connected={!!prefs?.configured} />
        </WordCapture>
      ) : loading ? (
        <p role="status">Opening your vocabulary…</p>
      ) : tab === 'Words' ? (
        <div className="vocabularyLayout">
          <section className="wordCollection" aria-label="Saved words">
            <div className="wordCollectionTools">
              <input
                type="search"
                aria-label="Search vocabulary"
                placeholder="Find a word…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void add()
                }}
              >
                <input
                  aria-label="New word or phrase"
                  placeholder="Add a word or phrase"
                  maxLength={80}
                  value={term}
                  onChange={(e) => {
                    setTerm(e.target.value)
                    setNotice('')
                  }}
                />
                <button disabled={adding || !term.trim()}>
                  {adding ? 'Saving…' : 'Add'}
                </button>
              </form>
            </div>
            {notice && <p className="vocabularyNotice" role="status">{notice}</p>}
            {!data.words.length ? (
              <div className="vocabularyEmpty">
                <span aria-hidden="true">Aa</span>
                <h2>Start with a word.</h2>
                <p>
                  Highlight a word or phrase during practice or in a saved
                  response, then choose <b>Save to vocabulary</b>.
                </p>
                <p>Its original context stays with it.</p>
                <a href="#history">Browse your results →</a>
              </div>
            ) : (
              <>
                <div className="wordSelectionBar">
                  <span>
                    {selected.length
                      ? `${selected.length} selected`
                      : `${visible.length} ${visible.length === 1 ? 'word' : 'words'}`}
                  </span>
                  <button
                    className="textLink"
                    disabled={!visible.length || busy}
                    onClick={() =>
                      setSelected(
                        [
                          ...new Set([
                            ...selected,
                            ...visible.map((w) => w.id),
                          ]),
                        ].slice(0, 20),
                      )
                    }
                  >
                    Select {visible.length > 20 ? 'first 20' : 'all'}
                  </button>
                  {selected.length > 0 && (
                    <button
                      className="textLink"
                      disabled={busy}
                      onClick={() => setSelected([])}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {!visible.length && (
                  <p className="vocabularyNoMatch">No matching words.</p>
                )}
                <ul className="wordList">
                  {visible.map((w) => {
                    const responseSource = w.sources.find(
                      (source) => source.attempt,
                    )
                    const textSource = w.sources.find(
                      (s) => !s.attempt && textIds.has(s.item),
                    )
                    return (
                      <li
                        key={w.id}
                        className={
                          selected.includes(w.id) ? 'wordSelected' : ''
                        }
                      >
                        <input
                          type="checkbox"
                          aria-label={'Select ' + w.term}
                          checked={selected.includes(w.id)}
                          disabled={
                            busy ||
                            (!selected.includes(w.id) &&
                              selected.length >= 20)
                          }
                          onChange={() => toggle(w.id)}
                        />
                        <div className="wordEntry">
                          {responseSource ? (
                            <a
                              className="wordTerm"
                              title="Open source response"
                              href={
                                '#attempt/' +
                                responseSource.attempt +
                                '?item=' +
                                encodeURIComponent(responseSource.item)
                              }
                            >
                              {w.term}
                              <span aria-hidden="true">↗</span>
                            </a>
                          ) : textSource ? (
                            <button
                              className="wordTerm openWordText"
                              title="Open source text"
                              onClick={() =>
                                openText(textIds.get(textSource.item)!)
                              }
                            >
                              {w.term}
                              <span aria-hidden="true">↗</span>
                            </button>
                          ) : (
                            <strong className="wordTerm">{w.term}</strong>
                          )}
                          {w.sources[0]?.context && (
                            <p className="wordContext">
                              <Highlighted
                                text={w.sources[0].context}
                                words={[w.term]}
                              />
                            </p>
                          )}
                          {w.sources[0]?.title && (
                            <small>{w.sources[0].title}</small>
                          )}
                          {w.sources.length > 1 && (
                            <details className="wordSources">
                              <summary>
                                {w.sources.length} saved sources
                              </summary>
                              {w.sources.map((s) =>
                                s.attempt ? (
                                  <a
                                    key={s.attempt + s.item}
                                    href={
                                      '#attempt/' +
                                      s.attempt +
                                      '?item=' +
                                      encodeURIComponent(s.item)
                                    }
                                  >
                                    {s.title} · {date(s.saved)}
                                  </a>
                                ) : textIds.has(s.item) ? (
                                  <button
                                    key={s.item}
                                    className="textLink"
                                    onClick={() =>
                                      openText(textIds.get(s.item)!)
                                    }
                                  >
                                    {s.title} · {date(s.saved)}
                                  </button>
                                ) : (
                                  <p key={s.item}>
                                    {s.title} · {s.context}
                                  </p>
                                ),
                              )}
                            </details>
                          )}
                        </div>
                        <button
                          className="wordRemove"
                          aria-label={'Remove ' + w.term}
                          title="Remove word"
                          disabled={!!deleting || busy}
                          onClick={() => void remove(w.id)}
                        >
                          ×
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </section>
          <aside className="vocabularyComposer">
            <span className="eyebrow">LEARN IN CONTEXT</span>
            <h2>A text with your words</h2>
            <p>Choose up to 20 words, then give the trainer a topic.</p>
            <div className="chosenWords" aria-label="Selected words">
              {chosen.length ? (
                chosen.map((w) => (
                  <button
                    key={w.id}
                    disabled={busy}
                    onClick={() => toggle(w.id)}
                    aria-label={'Deselect ' + w.term}
                  >
                    {w.term} <span aria-hidden="true">×</span>
                  </button>
                ))
              ) : (
                <span>Your selected words will appear here.</span>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void generate()
              }}
            >
              <label htmlFor="vocabulary-topic">
                Topic
                <input
                  id="vocabulary-topic"
                  placeholder="e.g. How cities can stay cool"
                  maxLength={200}
                  value={topic}
                  disabled={busy}
                  onChange={(e) => setTopic(e.target.value)}
                  required
                />
              </label>
              <label htmlFor="vocabulary-length">
                Target length <span>words</span>
                <input
                  id="vocabulary-length"
                  type="number"
                  min={100}
                  max={1000}
                  step={1}
                  value={length || ''}
                  disabled={busy}
                  onChange={(e) => setLength(Number(e.target.value))}
                  required
                />
              </label>
              <div className="lengthPresets">
                {[150, 250, 500].map((n) => (
                  <button
                    type="button"
                    key={n}
                    disabled={busy}
                    className={length === n ? 'on' : ''}
                    aria-pressed={length === n}
                    onClick={() => setLength(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                className="primary"
                disabled={
                  busy ||
                  !chosen.length ||
                  !topic.trim() ||
                  length < 100 ||
                  length > 1000 ||
                  !prefs?.configured
                }
              >
                {busy ? 'Writing your text…' : 'Write a text'}
              </button>
            </form>
            {busy ? (
              <p role="status">
                The trainer is writing. Your text will be saved here when
                it is ready.
              </p>
            ) : prefs?.configured ? (
              <small className="vocabularyModel">
                Trainer · {prefs.model}
              </small>
            ) : (
              <p className="vocabularyConnection">
                <a href="#settings">Connect your trainer in Settings</a> to
                write texts. Saving words works offline.
              </p>
            )}
          </aside>
        </div>
      ) : !current ? (
        <div className="vocabularyEmpty textEmpty">
          <h2>Words become stories.</h2>
          <p>
            Select words from your collection to create your first text.
          </p>
          <button onClick={() => setTab('Words')}>Choose words →</button>
        </div>
      ) : (
        <div className="vocabularyReading">
          <aside
            className="savedTexts"
            aria-label="Saved vocabulary texts"
          >
            {data.texts.map((t) => (
              <button
                key={t.id}
                className={current.id === t.id ? 'on' : ''}
                aria-current={current.id === t.id ? 'true' : undefined}
                onClick={() => setOpen(t.id)}
              >
                <strong>{t.title}</strong>
                <small>
                  {wordCount(t.text)} words · {date(t.created)}
                </small>
              </button>
            ))}
          </aside>
          <article className="vocabularyArticle">
            <div className="vocabularyArticleMeta">
              <span>
                {wordCount(current.text)} words · {current.words.length}{' '}
                saved words
              </span>
              <button
                className="textLink"
                disabled={!!deleting}
                onClick={() => void remove(current.id, true)}
              >
                Remove text
              </button>
            </div>
            <WordCapture
              key={current.id}
              textId={current.id}
              onSaved={rememberWord}
            >
              <h2 ref={reader} tabIndex={-1} data-text-paragraph="title">
                {current.title}
              </h2>
              <p className="vocabularyArticleTopic">{current.topic}</p>
              <div className="vocabularyProse">
                {textParagraphs(current.text).map((p, i) => (
                  <p key={i} data-text-paragraph={i}>
                    <Highlighted text={p} words={current.words} />
                  </p>
                ))}
              </div>
            </WordCapture>
            <div className="usedWords">
              {current.words.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
          </article>
        </div>
      )}
    </>
  )
}
