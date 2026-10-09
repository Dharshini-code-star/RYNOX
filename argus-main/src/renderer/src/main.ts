import { hasWords, MIN_UTTERANCE_MS, SILENCE_PEAK } from '../../shared/audio'
import { isBareApiKey } from '../../shared/commands'
import { isRecallQuestion } from '../../shared/recall'
import { startRecording, type Recorder } from './voice'
import { parseTeachRequest } from '../../shared/teach'
import { parseMode, type Mode } from '../../shared/types'
import {
  TUTORIAL,
  clampPage,
  isLastPage,
  parseTutorialCommand,
  tutorialFooter
} from '../../shared/tutorial'
import { filterOptions, type Option } from './options'

const input = document.querySelector<HTMLInputElement>('#input')!
const modeTalkButton = document.querySelector<HTMLButtonElement>('#mode-talk')!
const modeAgentButton = document.querySelector<HTMLButtonElement>('#mode-agent')!
const modeTeachButton = document.querySelector<HTMLButtonElement>('#mode-teach')!
const status = document.querySelector<HTMLDivElement>('#status')!
const thread = document.querySelector<HTMLDivElement>('#thread')!
const optionList = document.querySelector<HTMLUListElement>('#options')!
const closeButton = document.querySelector<HTMLButtonElement>('#close')!
const mic = document.querySelector<HTMLButtonElement>('#mic')!
const micLevel = document.querySelector<HTMLSpanElement>('#mic-level')!
const sendButton = document.querySelector<HTMLButtonElement>('#send')!
const bar = document.querySelector<HTMLElement>('#bar')!
const rec = document.querySelector<HTMLButtonElement>('#rec')!
const recLabel = document.querySelector<HTMLSpanElement>('#rec-label')!
const sidebar = document.querySelector<HTMLElement>('#sidebar')!
const sidebarToggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!
const historyList = document.querySelector<HTMLUListElement>('#history-list')!
const historySearch = document.querySelector<HTMLInputElement>('#history-search')!
const historyCount = document.querySelector<HTMLSpanElement>('#history-count')!
const newChatButton = document.querySelector<HTMLButtonElement>('#new-chat')!
const workflowsButton = document.querySelector<HTMLButtonElement>('#workflows')!

type StatusState = 'idle' | 'busy' | 'done' | 'error'

let activeThreadId: string | null = null
let savedThreads: Array<{ id: string; title: string; updatedAt: number; questions: number }> = []

/** True between hitting Enter and the answer resolving. */
let awaitingAnswer = false
/** Set once the first streamed chunk lands, so it replaces the busy message. */
let streaming = false
/** Options currently listed, and which one is highlighted (-1 = none). */
let visible: Option[] = []
let highlighted = -1
/** The answer element currently being streamed into. */
let activeAnswer: HTMLDivElement | null = null
let activeAnswerText = ''
/**
 * Set only when a mode control was clicked. Null means follow the wording, which is
 * what most requests want; an explicit choice outranks the guess.
 */
let manualMode: Mode | null = null
/**
 * Which tutorial page is showing, or -1 when it is not running.
 *
 * The tutorial is renderer-only on purpose: it never calls a model, so it is
 * the one thing that still works on a fresh install with no API key - which is
 * exactly when someone needs to be told what this app is.
 */
let tutorialPage = -1
/** Live microphone, while the button is held. */
let recorder: Recorder | null = null
let recordingStartedAt = 0
/**
 * Invalidates a start that is still opening the microphone.
 *
 * getUserMedia takes a moment, so a quick tap can release before the recorder
 * exists. Without this the teardown finds nothing to stop, the stream opens
 * immediately afterwards, and the microphone stays live with no way to close
 * it.
 */
let listenToken = 0
/** Fires the automatic stop, so a forgotten recording cannot run forever. */
let autoStop = 0

/** Longest a single recording may run before it stops itself. */
const MAX_RECORDING_MS = 60_000

function setStatus(text: string, state: StatusState = 'idle'): void {
  status.textContent = text
  status.dataset['state'] = state
  status.hidden = !text
  queueMicrotask(syncHeight)
}

/** What this request will do if sent right now. */
function currentMode(): Mode {
  return manualMode ?? parseMode(input.value).mode
}

function syncChip(): void {
  const mode = currentMode()
  const { teach } = parseTeachRequest(parseMode(input.value).prompt)
  const selectedMode = teach ? 'teach' : mode
  for (const [button, buttonMode] of [
    [modeTalkButton, 'talk'],
    [modeAgentButton, 'agent'],
    [modeTeachButton, 'teach']
  ] as const) {
    const selected = buttonMode === selectedMode
    button.setAttribute('aria-pressed', String(selected))
    button.dataset['selected'] = String(selected)
  }

  input.placeholder = teach
    ? mode === 'agent'
      ? "I'll point at each step — you do it"
      : "I'll write out the steps"
    : mode === 'agent'
      ? 'What do you want me to do?'
      : 'What do you want to know?'
}

function chooseMode(mode: Mode | 'teach'): void {
  const parsedTeach = parseTeachRequest(input.value)
  if (mode === 'teach') {
    if (!parsedTeach.teach) {
      const request = input.value.trim()
      input.value = request ? `Teach me how to ${request}` : 'Teach me how to '
    }
    manualMode = null
  } else {
    if (parsedTeach.teach) input.value = parsedTeach.topic
    manualMode = mode
  }

  syncChip()
  input.focus()
  if (mode === 'teach' && input.value.endsWith(' ')) {
    input.setSelectionRange(input.value.length, input.value.length)
  }
}

/** Appends a question to the transcript and returns its (empty) answer node. */
function appendExchange(question: string): HTMLDivElement {
  const block = document.createElement('div')
  block.className = 'turn'

  const asked = document.createElement('div')
  asked.className = 'turn-q'
  asked.textContent = question

  const answer = document.createElement('div')
  answer.className = 'turn-a'

  block.append(asked, answer)
  thread.append(block)
  bar.dataset['conversation'] = 'true'
  thread.scrollTop = thread.scrollHeight
  return answer
}

function appendInlineFormatting(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    const index = match.index
    if (index > offset) parent.append(document.createTextNode(text.slice(offset, index)))
    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.className = 'inline-code'
      code.textContent = token.slice(1, -1)
      parent.append(code)
    } else {
      const strong = document.createElement('strong')
      strong.textContent = token.slice(2, -2)
      parent.append(strong)
    }
    offset = index + token.length
  }
  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)))
}

/** Formats basic model Markdown using text nodes only; model output is never HTML. */
function renderAnswer(answer: HTMLDivElement, text: string): void {
  answer.replaceChildren()
  const lines = text.split(/\r?\n/)
  let paragraph: string[] = []
  let list: HTMLOListElement | HTMLUListElement | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const block = document.createElement('p')
    appendInlineFormatting(block, paragraph.join('\n'))
    answer.append(block)
    paragraph = []
  }
  const flushList = (): void => {
    list = null
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = line.match(/^\s*```([^\s`]*)\s*$/)
    if (fence) {
      flushParagraph()
      flushList()
      const codeLines: string[] = []
      while (++index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        codeLines.push(lines[index]!)
      }
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.className = 'code-block'
      if (fence[1]) code.dataset['language'] = fence[1]
      code.textContent = codeLines.join('\n')
      pre.append(code)
      answer.append(pre)
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }

    const item = line.match(/^\s*(?:[-*+]\s+|(\d+)[.)]\s+)(.*)$/)
    if (item) {
      flushParagraph()
      const ordered = item[1] !== undefined
      if (!list || (ordered !== (list instanceof HTMLOListElement))) {
        flushList()
        list = document.createElement(ordered ? 'ol' : 'ul')
        answer.append(list)
      }
      const entry = document.createElement('li')
      appendInlineFormatting(entry, item[2]!)
      list.append(entry)
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
}

function clearThread(): void {
  thread.replaceChildren()
  bar.dataset['conversation'] = 'false'
  activeAnswer = null
  activeAnswerText = ''
}

/**
 * Takes a failed exchange out of the transcript, question and all.
 *
 * Removing only the empty answer left the question stranded in the thread with
 * nothing under it, while the error appeared at the bottom - every failed
 * request added another orphan line.
 */
function dropExchange(answer: HTMLElement): void {
  const exchange = answer.closest('.turn') ?? answer
  exchange.remove()
}

/** Paints one tutorial page into the transcript and remembers where we are. */
function showTutorialPage(index: number): void {
  const page = clampPage(index)
  const content = TUTORIAL[page]!

  tutorialPage = page
  clearThread()

  const node = appendExchange(content.title)
  renderAnswer(node, content.tip ? `${content.body}\n\n→ ${content.tip}` : content.body)

  input.value = ''
  highlighted = -1
  syncChip()
  renderOptions()
  setStatus(tutorialFooter(page))
  input.focus()
}

/** Leaves the tutorial without dismissing the bar, so they can try something. */
function endTutorial(message: string): void {
  tutorialPage = -1
  clearThread()
  input.value = ''
  highlighted = -1
  syncChip()
  renderOptions()
  setStatus(message, 'done')
  input.focus()
}

function runTutorialCommand(command: Exclude<ReturnType<typeof parseTutorialCommand>, { kind: 'none' }>): void {
  switch (command.kind) {
    case 'start':
      showTutorialPage(0)
      return
    case 'jump':
      showTutorialPage(command.index)
      return
    case 'back':
      // Backing out of page one leaves the tutorial rather than sticking.
      if (tutorialPage <= 0) {
        endTutorial('Left the tutorial. "/tutorial" starts it again.')
        return
      }
      showTutorialPage(tutorialPage - 1)
      return
    case 'next':
      advanceTutorial()
      return
    case 'exit':
      endTutorial('Left the tutorial. "/tutorial" starts it again.')
  }
}

/** Enter on the last page finishes; anywhere else it turns the page. */
function advanceTutorial(): void {
  if (tutorialPage < 0) {
    showTutorialPage(0)
    return
  }
  if (isLastPage(tutorialPage)) {
    endTutorial('That is the tour. Ask about your screen, or say what you want done.')
    return
  }
  showTutorialPage(tutorialPage + 1)
}

/** Saved conversations, fetched on demand when the history list is asked for. */
let threadOptions: Option[] = []

function showingHistory(): boolean {
  return /^\/history\b/i.test(input.value.trim())
}

async function refreshThreads(): Promise<void> {
  const threads = await window.argus.threads()
  savedThreads = threads
  threadOptions = threads.map((thread) => ({
    id: `thread:${thread.id}`,
    label: thread.title,
    hint: `${thread.questions} question${thread.questions === 1 ? '' : 's'} · ${relativeTime(thread.updatedAt)}`,
    insert: ''
  }))

  if (threadOptions.length === 0) {
    threadOptions = [
      { id: 'thread:none', label: 'No saved chats yet', hint: '', insert: '' }
    ]
  }

  renderSidebarHistory()
  renderOptions()
}

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function renderOptions(): void {
  if (!awaitingAnswer && showingHistory()) {
    visible = threadOptions
    paintOptions()
    return
  }

  visible = awaitingAnswer ? [] : filterOptions(input.value)
  paintOptions()
}

function renderSidebarHistory(): void {
  const query = historySearch.value.trim().toLocaleLowerCase()
  const filtered = savedThreads.filter((threadSummary) =>
    threadSummary.title.toLocaleLowerCase().includes(query)
  )
  historyCount.textContent = query ? `${filtered.length}/${savedThreads.length}` : `${savedThreads.length}`

  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const startYesterday = yesterday.getTime()
  const groups = [
    { title: 'Today', threads: [] as typeof filtered },
    { title: 'Yesterday', threads: [] as typeof filtered },
    { title: 'Previous', threads: [] as typeof filtered }
  ]
  for (const threadSummary of filtered) {
    const group = threadSummary.updatedAt >= startToday
      ? groups[0]
      : threadSummary.updatedAt >= startYesterday
        ? groups[1]
        : groups[2]
    group.threads.push(threadSummary)
  }

  const entries: HTMLLIElement[] = []
  for (const group of groups) {
    if (group.threads.length === 0) continue
    const heading = document.createElement('li')
    heading.className = 'history-group-label'
    heading.textContent = group.title
    entries.push(heading)

    for (const threadSummary of group.threads) {
      const entry = document.createElement('li')
      entry.className = 'history-entry'
      const row = document.createElement('button')
      row.className = 'history-item'
      row.type = 'button'
      row.dataset['id'] = threadSummary.id
      row.dataset['active'] = String(threadSummary.id === activeThreadId)
      if (threadSummary.id === activeThreadId) row.setAttribute('aria-current', 'page')
      const title = document.createElement('span')
      title.className = 'history-title'
      title.textContent = threadSummary.title
      const meta = document.createElement('small')
      meta.className = 'history-meta'
      meta.textContent = `${threadSummary.questions} question${threadSummary.questions === 1 ? '' : 's'} · ${relativeTime(threadSummary.updatedAt)}`

      row.append(title, meta)
      row.addEventListener('click', () => {
        void resumeThread(threadSummary.id)
      })
      entry.append(row)
      entries.push(entry)
    }
  }

  historyList.replaceChildren(...entries)

  if (filtered.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'history-empty'
    empty.textContent = query ? 'No matching conversations.' : 'No saved chats yet'
    historyList.append(empty)
  }
}

function clearActiveHistory(): void {
  activeThreadId = null
  historyList.querySelectorAll<HTMLElement>('.history-item').forEach((row) => {
    row.dataset['active'] = 'false'
    row.removeAttribute('aria-current')
  })
}

function paintOptions(): void {
  if (highlighted >= visible.length) highlighted = visible.length - 1
  queueMicrotask(syncHeight)

  optionList.replaceChildren(
    ...visible.map((option, index) => {
      const row = document.createElement('li')
      row.className = 'option'
      row.dataset['selected'] = String(index === highlighted)

      const label = document.createElement('span')
      label.className = 'option-label'
      label.textContent = option.label

      const hint = document.createElement('span')
      hint.className = 'option-hint'
      hint.textContent = option.hint

      row.append(label, hint)
      row.addEventListener('mousedown', (event) => {
        event.preventDefault() // keep focus in the input
        choose(option)
      })
      return row
    })
  )
}

function choose(option: Option): void {
  if (option.id.startsWith('thread:')) {
    void resumeThread(option.id.slice('thread:'.length))
    return
  }

  input.value = option.insert
  highlighted = -1
  syncChip()

  if (option.id === 'history') {
    setStatus('')
    void refreshThreads()
    input.focus()
    return
  }

  renderOptions()

  if (option.immediate) {
    submit(option.insert)
    return
  }
  input.focus()
}

/** Loads a saved conversation back into the bar and continues it. */
async function resumeThread(id: string): Promise<void> {
  if (id === 'none') return

  const turns = await window.argus.openThread(id)
  activeThreadId = id
  savedThreads = await window.argus.threads()
  renderSidebarHistory()
  clearThread()

  for (let index = 0; index < turns.length; index += 2) {
    const question = turns[index]
    const answer = turns[index + 1]
    if (!question) continue
    const node = appendExchange(question.text)
    renderAnswer(node, answer?.text ?? '')
  }

  input.value = ''
  highlighted = -1
  syncChip()
  renderOptions()
  setStatus('Picked up where you left off — ask anything about your current screen.')
  input.focus()
}

function submit(text: string): void {
  const trimmed = text.trim()
  if (!trimmed || awaitingAnswer) return

  // Typing over a live recording means they have changed their mind about it.
  if (recorder) cancelListening()

  // The tutorial never leaves the renderer, so it works with no API key set.
  const tutorial = parseTutorialCommand(trimmed)
  if (tutorial.kind !== 'none') {
    runTutorialCommand(tutorial)
    return
  }

  // Anything else typed during the tutorial is a real request, so the lesson
  // gets out of the way rather than fighting the transcript for the thread.
  if (tutorialPage >= 0) {
    tutorialPage = -1
    clearThread()
    setStatus('')
  }

  // Thread management is a UI concern - it never reaches a model.
  if (/^\/history\b/i.test(trimmed)) {
    void refreshThreads()
    return
  }

  if (/^\/new\b/i.test(trimmed)) {
    void window.argus.newThread().then(() => {
      clearActiveHistory()
      clearThread()
      input.value = ''
      renderOptions()
      setStatus('Started a new chat.')
      input.focus()
    })
    return
  }

  // A pasted key must never be shown in the transcript or sent as a question.
  // It reaches here whenever someone pastes one without typing "/key" first,
  // which is the obvious thing to do and used to mail the key to the model.
  const isBareKey = isBareApiKey(trimmed)
  // "/recall" is the exception: its reply is an answer, not a report, so it
  // streams into the transcript like any other question.
  const isCommand = (trimmed.startsWith('/') && !isRecallQuestion(trimmed)) || isBareKey
  awaitingAnswer = true
  streaming = false
  input.disabled = true
  sendButton.disabled = true
  bar.setAttribute('aria-busy', 'true')
  highlighted = -1

  // Commands report through the status line; questions join the transcript.
  activeAnswer = isCommand ? null : appendExchange(trimmed)
  activeAnswerText = ''
  setStatus(
    isBareKey
      ? 'Saving your key…'
      : isCommand
        ? 'Working…'
        : currentMode() === 'agent'
          ? 'Taking control — hold Esc to stop'
          : 'Looking at your screen…',
    'busy'
  )
  renderOptions()

  const forced = manualMode ?? undefined
  /**
   * A question that failed - over quota, Gemini busy, no capture - goes back
   * in the box so Enter retries it. Only a question still showing in the
   * transcript qualifies: agent runs reopen the bar fresh (which clears it),
   * and commands and pasted keys never create an exchange, so neither is ever
   * put back.
   */
  let retry = ''

  void window.argus
    .submit(isBareKey ? `/key ${trimmed}` : trimmed, forced)
    .then((result) => {
      if (activeAnswer && result.ok) {
        activeAnswerText = result.message
        renderAnswer(activeAnswer, activeAnswerText)
        setStatus('')
      } else {
        if (activeAnswer && !result.ok) {
          dropExchange(activeAnswer)
          retry = trimmed
        }
        setStatus(result.message, result.ok ? 'done' : 'error')
      }
    })
    .catch((error: unknown) => {
      if (activeAnswer) {
        dropExchange(activeAnswer)
        retry = trimmed
      }
      setStatus(errorText(error, 'Something went wrong.'), 'error')
    })
    .finally(() => {
      awaitingAnswer = false
      streaming = false
      activeAnswer = null
      activeAnswerText = ''
      input.disabled = false
      sendButton.disabled = false
      bar.removeAttribute('aria-busy')
      input.value = retry
      // A retry keeps the mode it was asked in. Re-guessing it from the
      // wording could turn a question asked in Talk into an Agent run.
      manualMode = retry ? (forced ?? null) : null
      syncChip()
      input.focus()
      // Selected, so Enter retries it and typing replaces it.
      if (retry) input.select()
      renderOptions()
      thread.scrollTop = thread.scrollHeight
    })
}

rec.addEventListener('click', () => {
  // No confirmation. Being able to stop instantly is the entire reason the
  // pill is visible; a dialog between the user and that is the wrong trade,
  // and "/memory on" starts it again in one command.
  rec.disabled = true
  void window.argus
    .stopMemory()
    .then((forgotten) => {
      rec.hidden = true
      setStatus(
        forgotten === 0
          ? 'Screen memory off. Nothing was being kept.'
          : `Screen memory off — ${forgotten} remembered moment${forgotten === 1 ? '' : 's'} forgotten. "/memory on" starts it again.`,
        'done'
      )
    })
    .finally(() => {
      rec.disabled = false
    })
})

window.argus.onOpened(({ capture, error, notice, memory }) => {
  cancelListening()
  clearActiveHistory()
  awaitingAnswer = false
  streaming = false
  highlighted = -1
  input.value = ''
  input.disabled = false
  manualMode = null
  tutorialPage = -1
  clearThread()
  syncChip()
  renderOptions()
  input.focus()

  // Shown on every open while recording, never suppressed by a notice or an
  // error. The pill is the app admitting what it is doing.
  rec.hidden = !memory?.recording
  if (memory?.recording) recLabel.textContent = memory.label

  if (error) {
    setStatus(error, 'error')
  } else if (notice) {
    setStatus(notice)
  } else if (capture) {
    setStatus(`Screen captured — ${capture.width}x${capture.height}`)
  } else {
    setStatus('')
  }
})

window.argus.onDelta((delta) => {
  if (!awaitingAnswer) return
  if (!streaming) {
    streaming = true
    setStatus('')
  }
  if (activeAnswer) {
    activeAnswerText += delta
    renderAnswer(activeAnswer, activeAnswerText)
    thread.scrollTop = thread.scrollHeight
  }
})

window.argus.onAgentStep((event) => {
  // Agent runs report their to-do list; replays count their fixed steps;
  // notes (planning, writers finishing) carry neither.
  const progress = event.todo
    ? ` · ${event.todo.done}/${event.todo.total} to-dos done`
    : event.max > 0
      ? ` (step ${event.index}/${event.max})`
      : ''
  setStatus(`${event.description}${progress}`, 'busy')
})

// The bar is one line, and a single-line input drops line breaks on paste -
// "1. Open Gmail\n2. Write" arrives as "1. Open Gmail2. Write". A pasted SOP
// keeps its steps apart instead.
input.addEventListener('paste', (event) => {
  const pasted = event.clipboardData?.getData('text/plain') ?? ''
  if (!/[\r\n]/.test(pasted)) return
  event.preventDefault()
  const flattened = pasted
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' / ')
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? input.value.length
  input.setRangeText(flattened, start, end, 'end')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

closeButton.addEventListener('click', () => {
  // visibilitychange would catch this a moment later, but the microphone
  // should stop on the click that dismissed it, not on a subsequent event.
  cancelListening()
  window.argus.hide()
})

newChatButton.addEventListener('click', () => {
  void window.argus.newThread().then(() => {
    clearActiveHistory()
    clearThread()
    input.value = ''
    renderOptions()
    setStatus('Started a new chat.')
    input.focus()
  })
})

historySearch.addEventListener('input', () => renderSidebarHistory())

historySearch.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    historySearch.value = ''
    renderSidebarHistory()
    input.focus()
  }
})

document.querySelectorAll<HTMLButtonElement>('[data-suggestion]').forEach((button) => {
  button.addEventListener('click', () => {
    switch (button.dataset['suggestion']) {
      case 'screen':
        manualMode = 'talk'
        input.value = 'What is on my screen?'
        syncChip()
        submit(input.value)
        break
      case 'execute':
        manualMode = 'agent'
        syncChip()
        setStatus('Agent Mode selected. Describe the task you want help with.')
        input.focus()
        break
      case 'talk':
        manualMode = 'talk'
        syncChip()
        setStatus('Talk Mode selected. Type a question or use the microphone.')
        input.focus()
        break
      case 'teach':
        chooseMode('teach')
        syncChip()
        break
    }
  })
})

workflowsButton.addEventListener('click', () => {
  submit('/workflows')
})

sendButton.addEventListener('click', () => submit(input.value))

sidebarToggle.addEventListener('click', () => {
  const collapsed = sidebar.classList.toggle('collapsed')
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed))
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar')
  sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  sidebarToggle.textContent = collapsed ? 'Expand' : 'Collapse'
})

// Clicking back onto the bar should let you type again without having to aim
// at the input itself - but never steal a text selection the user is making.
bar.addEventListener('mouseup', () => {
  if (awaitingAnswer) return
  if (window.getSelection()?.toString()) return
  input.focus()
})

input.addEventListener('input', () => {
  highlighted = -1
  syncChip()
  if (showingHistory() && threadOptions.length === 0) {
    void refreshThreads()
    return
  }
  renderOptions()
})

/** The mode selector pins Talk or Agent; Teach uses the shared request parser. */
/**
 * Click to start, click again to stop.
 *
 * A toggle is easier to use than hold-to-talk, and brings one hazard
 * hold-to-talk did not have: a microphone left recording because the second
 * click never came. Three things close that off - the microphone state is
 * unmistakable
 * while live, Escape cancels, and a recording stops itself at
 * MAX_RECORDING_MS whatever the user does.
 */
async function startListening(): Promise<void> {
  if (recorder || awaitingAnswer) return

  const token = ++listenToken
  // Opening the microphone is not instant, and people speak as soon as they
  // click. Saying so is the only honest fix - the alternative is holding the
  // stream open between utterances, which is the always-listening behaviour
  // this app promises not to have.
  mic.dataset['state'] = 'starting'
  setStatus('Opening the microphone…', 'busy')

  try {
    const active = await startRecording({
      onLevel: (level) => {
        micLevel.style.transform = `scale(${0.7 + level * 0.55})`
      }
    })

    // Stopped, or the bar was dismissed, while the microphone was opening.
    if (token !== listenToken) {
      active.cancel()
      resetMic()
      return
    }

    recorder = active
    recordingStartedAt = Date.now()
    mic.dataset['state'] = 'recording'
    bar.dataset['listening'] = 'true'
    setStatus('Recording — click the mic again to stop', 'busy')

    // A forgotten recording stops itself rather than holding the microphone
    // open indefinitely.
    autoStop = window.setTimeout(() => void stopListening(), MAX_RECORDING_MS)
  } catch (error) {
    if (token !== listenToken) return
    resetMic()
    setStatus(error instanceof Error ? error.message : 'Could not start recording.', 'error')
  }
}

/** Puts the mic and the bar back to their resting appearance. */
function resetMic(): void {
  window.clearTimeout(autoStop)
  mic.dataset['state'] = ''
  bar.dataset['listening'] = 'false'
  micLevel.style.transform = 'scale(0.7)'
}

/** Throws the recording away without transcribing it. */
function cancelListening(): void {
  listenToken++
  recorder?.cancel()
  recorder = null
  resetMic()
}

async function stopListening(): Promise<void> {
  listenToken++

  const active = recorder
  if (!active) return
  recorder = null

  const heldFor = Date.now() - recordingStartedAt
  window.clearTimeout(autoStop)
  mic.dataset['state'] = 'thinking'
  bar.dataset['listening'] = 'false'
  micLevel.style.transform = 'scale(0.7)'
  setStatus('Transcribing…', 'busy')

  const capture = await active.stop()

  // Two clicks in quick succession is a mis-click, not an utterance.
  if (!capture || heldFor < MIN_UTTERANCE_MS) {
    resetMic()
    setStatus('That was too short — click, speak, then click again.')
    return
  }

  // Asked to transcribe silence the model does not return nothing - it returns
  // whatever it thinks it can hear. Catching it here costs no request at all.
  if (capture.peak < SILENCE_PEAK) {
    resetMic()
    setStatus("Didn't hear anything. Check the right microphone is selected.", 'error')
    return
  }

  try {
    const text = await window.argus.transcribe(capture.wav.buffer as ArrayBuffer)
    resetMic()
    if (!hasWords(text)) {
      setStatus("Didn't catch any words — try again.")
      return
    }

    input.value = text
    manualMode = manualMode ?? parseMode(text).mode
    syncChip()
    renderOptions()
    input.focus()

    // Talk Mode sends straight away; the worst case is a wasted question. Agent
    // and Teach wait for Enter, because there the text becomes mouse movement
    // and speech misheard by one word is not a wasted turn.
    if (currentMode() === 'talk') {
      setStatus('')
      submit(text)
    } else {
      setStatus('Check it, then press Enter to run it.')
    }
  } catch (error) {
    resetMic()
    setStatus(errorText(error, 'Could not transcribe that.'), 'error')
  }
}

/**
 * The bar can be dismissed from outside the renderer - the main process watches
 * Escape globally and hides the window without telling us. A recording must not
 * outlive the window it belongs to.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && recorder) cancelListening()
})

mic.addEventListener('click', () => {
  if (recorder) {
    void stopListening()
  } else {
    void startListening()
  }
})

modeTalkButton.addEventListener('click', () => chooseMode('talk'))
modeAgentButton.addEventListener('click', () => chooseMode('agent'))
modeTeachButton.addEventListener('click', () => chooseMode('teach'))

input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    // While recording, Escape means "throw this away", not "close the bar".
    if (recorder) {
      cancelListening()
      setStatus('Recording discarded.')
      return
    }
    window.argus.hide()
    return
  }

  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && visible.length > 0) {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    highlighted = (highlighted + step + visible.length + 1) % (visible.length + 1) - 1
    renderOptions()
    return
  }

  if (event.key === 'Tab' && highlighted >= 0) {
    event.preventDefault()
    choose(visible[highlighted]!)
    return
  }

  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()

  // A highlighted option wins; otherwise send whatever is typed.
  if (highlighted >= 0) {
    choose(visible[highlighted]!)
    return
  }

  // Enter on an empty bar turns the page. Only while the tutorial is up: it is
  // the one state where an empty bar means something other than "nothing yet".
  if (tutorialPage >= 0 && !input.value.trim()) {
    advanceTutorial()
    return
  }

  submit(input.value)
})

/**
 * Tells the main process how tall the bar needs to be.
 *
 * Called explicitly rather than left to the ResizeObserver alone: the window is
 * reset to its default height each time it opens, but the content re-renders to
 * the same size it was, so the observer sees no change and never fires - which
 * left the bar clipped on every open after the first.
 */
function syncHeight(): void {
  const style = getComputedStyle(bar)
  const margins = parseFloat(style.marginTop) + parseFloat(style.marginBottom)
  const bodyStyle = getComputedStyle(document.body)
  const padding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom)
  window.argus.resize(Math.ceil(bar.getBoundingClientRect().height + margins + padding))
}

new ResizeObserver(syncHeight).observe(bar)

syncChip()
renderOptions()
void refreshThreads()

/**
 * The message a failed IPC call carries, without Electron's wrapper.
 *
 * A rejection from the main process arrives as "Error invoking remote method
 * 'argus:transcribe': Error: <the actual message>", which buries the one line
 * the user needs behind plumbing they do not.
 */
function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '') || fallback
}
