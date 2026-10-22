import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, TurnStepChunk } from 'claude-code'

import type { AgentRun, Plan, PlanStage, PlanState, PlanStep, Prefs, Speed, StepStatus, VersionState } from '../types'

const TOOL = 'mcp__plan-progress__plan_progress'
const plans = atom({ plugin: 'plan-progress', key: 'plans' } as const, [])
const MAX_BARS = 3
// a space as wide as a digit, so '  0%' and '100%' take the same room
const FIGURE_SPACE = String.fromCharCode(0x2007)
const isOpen = atom({ plugin: 'plan-progress', key: 'isOpen' } as const, true)
const tick = atom({ plugin: 'plan-progress', key: 'tick' } as const, 0)
const speed = atom({ plugin: 'plan-progress', key: 'speed' } as const, { rate: null, isLive: false } as Speed)
// the settings window's choices as the session holds them (null until the session starts)
const prefs = atom({ plugin: 'plan-progress', key: 'prefs' } as const, null as Prefs | null)
const STRIP_H = 16
const STRIP_GAP = 2
// rows of strips per bar, the "+N more" row included: the band above the prompt has room for about 300 px
const stripBudget = (bars: number) => (bars >= 3 ? 3 : bars === 2 ? 4 : 5)
const FOLD_MS = 5000 // finished strips stay this long, failed ones stay until the bar closes

// one lightness for every state (OKLCH L .55, hues of the desktop's violet, amber, red and green), so no state
// shouts louder than another, and white on each reads at 4.5:1 or better
const STATE_COLOR: Record<PlanState, string> = { running: '#7858CA', needs_input: '#AD6400', error: '#C5353E', done: '#18883A' }
const INK = '#FFFFFF'

// the Omarchy theme in use, read from its colors.toml: a running bar takes its accent, the terminal track its
// background and foreground, and its mode says light or dark. Null anywhere else, where the defaults above stay
type Omarchy = { accent: string; background: number[]; foreground: number[]; isLight: boolean }
let omarchy: Omarchy | null = null
const stateColor = (s: PlanState) => (s === 'running' && omarchy ? omarchy.accent : STATE_COLOR[s])

function parseOmarchy(toml: string): Omarchy | null {
  const color = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*["'](#[0-9a-fA-F]{6})["']`, 'm').exec(toml)?.[1]?.toLowerCase()
  const accent = color('accent')
  if (!accent) return null
  const background = hex(color('background') ?? '#1b1b1b')
  const foreground = hex(color('foreground') ?? '#e0e0e0')
  const mode = /^\s*mode\s*=\s*["'](light|dark)["']/m.exec(toml)?.[1]
  return { accent, background, foreground, isLight: mode ? mode === 'light' : luminance(background) > 0.5 }
}

const luminance = (c: number[]) => (0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0)) / 255

// WCAG 2.x contrast, measured on the 4-bit colour the engine paints a Raster cell in
const q17 = (c: number[]) => c.map(v => Math.round(v / 17) * 17)
const relLum = (c: number[]) => {
  const l = q17(c).map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (l[0] ?? 0) + 0.7152 * (l[1] ?? 0) + 0.0722 * (l[2] ?? 0)
}
const contrast = (a: number[], b: number[]) => (Math.max(relLum(a), relLum(b)) + 0.05) / (Math.min(relLum(a), relLum(b)) + 0.05)
// text over a theme's colours: the first candidate that reads at AA (4.5:1) on bg, else the one that reads best. The
// theme's own colours are never changed; the text only picks among them
function readable(bg: number[], ...candidates: number[][]): number[] {
  const ok = candidates.find(c => contrast(c, bg) >= 4.5)
  return ok ?? candidates.reduce((a, b) => (contrast(b, bg) > contrast(a, bg) ? b : a))
}
// text on a pill: white, else the theme's background, else its foreground (a yellow or a pastel accent)
const inkOn = (c: number[]) => (omarchy ? readable(c, [255, 255, 255], omarchy.background, omarchy.foreground) : [255, 255, 255])
// a word in a colour of its own on a strip: that colour, else it mixed toward the theme's text, else the text
const wordOn = (bg: number[], c: number[]) =>
  omarchy ? readable(bg, c, mix(c, omarchy.foreground, 0.3), mix(c, omarchy.foreground, 0.6), omarchy.foreground) : c
// the model and the time: the theme's text dimmed toward the strip as far as AA allows
const dimOn = (bg: number[], c: number[]) =>
  omarchy ? readable(bg, mix(omarchy.foreground, bg, 0.4), mix(omarchy.foreground, bg, 0.25), omarchy.foreground) : c
const STATE_GLYPH: Record<PlanState, string> = { running: '●', needs_input: '?', error: '!', done: '✓' }
const STATUSES: StepStatus[] = ['pending', 'active', 'done', 'error', 'skipped']
const TRACK_H = 22
const NARROW = 360

const RULES = `# Progress bars
Tasks needing more than ~3 edits or commands get a bar via ${TOOL}: create it once with the full breakdown (2-7 stages of steps {title}, or kind "todo" for one flat list; titles of at most 4 words, in the user's language; the first open step becomes active), then move it with short calls: {id, next:true} when the active step is finished, or {id, done:[...], active:"..."}, {id, failed:"...", note}. When the plan changes, resend stages under the same id and title; steps sent without a status keep their done by title. Send state "needs_input" with a note before asking the user to decide. Never describe the bars to the user.`

type Raw = Record<string, unknown>
// the cut drops half a character left at the edge (an emoji is two UTF-16 units). Control characters go first: an
// ESC or a C1 code would reach the terminal as a command (colour, cursor), and U+FFFE/U+FFFF are no text at all
const str = (v: unknown, max = 120) =>
  typeof v === 'string'
    ? v
        .replace(/\s+/g, ' ')
        .replace(/[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, '')
        .trim()
        .slice(0, max)
        .replace(/[\uD800-\uDBFF]$/, '')
        .trimEnd()
    : ''
const status = (v: unknown): StepStatus => (STATUSES.includes(v as StepStatus) ? (v as StepStatus) : 'pending')
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []) as Raw[]
const isFinished = (s: StepStatus) => s === 'done' || s === 'skipped'

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// short updates: {next:true}, {done:[titles]}, {active:title}, {failed:title} against the stored plan;
// titles it cannot find come back in missing, so the call is refused instead of passing as a success
function applyOps(stages: PlanStage[], input: Raw, now: number): { stages: PlanStage[]; missing: string[] } {
  const next = stages.map(s => ({ ...s, steps: s.steps.map(st => ({ ...st })) }))
  const steps = next.flatMap(s => s.steps)
  const missing: string[] = []
  // a step finishing now remembers when, for the time its checkpoint shows
  const finish = (st: PlanStep) => {
    if (!isFinished(st.status)) Object.assign(st, { status: 'done', doneAt: now })
  }
  // a step opened again forgets when it was finished, so its checkpoint shows no stale time
  const reopen = (st: PlanStep, to: StepStatus) => {
    st.status = to
    delete st.doneAt
  }
  // a title used twice means the one still open
  const find = (title: string) => {
    const found = steps.find(st => same(st.title, title) && !isFinished(st.status)) ?? steps.find(st => same(st.title, title))
    if (!found) missing.push(title)
    return found
  }
  if (input.next === true) {
    const at = steps.findIndex(st => st.status === 'active') >= 0 ? steps.findIndex(st => st.status === 'active') : steps.findIndex(st => !isFinished(st.status))
    const cur = steps[at]
    if (cur) finish(cur)
    // past the last step, work goes back to one left open earlier; a call that names the new step itself picks it,
    // so a step jumped over is not finished on the way
    const following = steps.slice(at + 1).find(st => st.status === 'pending') ?? steps.find(st => st.status === 'pending')
    if (following && typeof input.active !== 'string') following.status = 'active'
  }
  let lastDone = -1
  for (const t of Array.isArray(input.done) ? input.done : []) {
    const st = typeof t === 'string' ? find(t) : undefined
    if (st?.status === 'active') lastDone = steps.indexOf(st)
    if (st) finish(st)
  }
  // finishing the step in progress moves on, as next does, unless the call names the new one itself
  if (lastDone >= 0 && typeof input.active !== 'string' && !steps.some(st => st.status === 'active')) {
    const following = steps.slice(lastDone + 1).find(st => st.status === 'pending') ?? steps.find(st => st.status === 'pending')
    if (following) following.status = 'active'
  }
  const active = typeof input.active === 'string' ? find(input.active) : undefined
  if (active) {
    const at = steps.indexOf(active)
    steps.forEach((st, i) => {
      if (st.status === 'active' && i !== at) {
        if (i < at) finish(st)
        else st.status = 'pending'
      }
    })
    reopen(active, 'active')
  }
  const failed = typeof input.failed === 'string' ? find(input.failed) : undefined
  if (failed) reopen(failed, 'error')

  return { stages: next, missing }
}

// steps may arrive as plain strings, a stage may call its name "title", and a flat list may come as top-level "steps"
const asSteps = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? { title: x } : x)).filter(x => x && typeof x === 'object') : []) as Raw[]

// the new bar, or the refusal for a call that names steps the bar does not have
function normalize(input: Raw, prev: Plan | null, now: number, id: string): Plan | string {
  const sentStages = list(input.stages).length > 0 ? list(input.stages) : asSteps(input.steps).length > 0 ? [{ name: str(input.title, 80) || 'Tasks', steps: input.steps } as Raw] : []
  const sent = sentStages
    .map(s => ({
      name: str(s.name, 80) || str(s.title, 80) || 'Stage',
      steps: asSteps(s.steps).map(st => ({
        title: str(st.title) || 'Step',
        status: status(st.status),
        substeps: asSteps(st.substeps).map(sub => ({ title: str(sub.title) || '…', status: status(sub.status) })),
      })),
    }))
    .filter(s => s.steps.length > 0) as PlanStage[]
  const isPartial = sent.length === 0 && prev !== null
  // the next task under a finished bar's id carries nothing of the last one over; the same plan grown by a step does
  const was = prev && !isPartial && isNextTask(prev, str(input.title, 400), sent) ? null : prev
  // a resent plan keeps what was finished; short ops sent along with it apply on top
  const base = isPartial ? prev.stages : pointAt(was ? carryDone(sent, was.stages) : sent)
  const { stages, missing } = applyOps(base, input, now)
  if (missing.length > 0 && base.length > 0) {
    const titles = stages.flatMap(s => s.steps.map(st => st.title)).join(', ')
    return `plan_progress: "${id}" has no step ${missing.map(t => `"${str(t, 60)}"`).join(', ')}. Its steps: ${str(titles, 400)}`
  }
  const title = str(input.title, 80) || prev?.title || 'Plan'
  const steps = stages.flatMap(s => s.steps)
  const isAllDone = steps.length > 0 && steps.every(s => isFinished(s.status))
  const asked = input.state as PlanState
  const failedNow = typeof input.failed === 'string'
  const state: PlanState = ['running', 'needs_input', 'error', 'done'].includes(asked) ? asked : isAllDone ? 'done' : failedNow ? 'error' : 'running'

  return {
    id,
    title,
    kind: input.kind === 'todo' || (isPartial && prev?.kind === 'todo') ? 'todo' : 'plan',
    stages,
    state,
    note: str(input.note, 160) || null,
    startedAt: was ? was.startedAt : now,
    endedAt: state === 'done' ? (was?.endedAt ?? now) : null,
    ...(prev && !was ? afresh(prev) : {}),
  }
}

// a whole plan sent to a finished bar: another task when it has another title or leaves out a step the last one
// finished. One that keeps the title and every finished step is the plan grown after it finished ("also commit it"),
// which the rules tell Claude to resend under the same id. The same plan sent again with no statuses (at most its
// first step active), bringing no step the bar did not have, is a new run of it ("deploy again", the plan approved a
// second time): carried over, it would be finished from the start, its time counting the first run and the gap. A
// later step sent active, or any sent done, is a redo of that step and carries over
function isNextTask(prev: Plan, title: string, stages: PlanStage[]): boolean {
  if (prev.state !== 'done') return false
  // a title is stored cut at 80, and a plan-mode one without its markdown, links and list marker, cut after that: the
  // same title resent either way, with them or without, is still the same plan
  const sentAs = [str(title, 80), str(clean(title), 80)]
  const keptAs = [prev.title, clean(prev.title)]
  if (title && !sentAs.some(a => keptAs.some(b => same(a, b)))) return true
  const key = (st: PlanStep) => st.title.trim().toLowerCase()
  const steps = stages.flatMap(s => s.steps)
  const sent = new Set(steps.map(key))
  const finished = prev.stages.flatMap(s => s.steps).filter(st => isFinished(st.status))
  if (finished.length === 0 || finished.some(st => !sent.has(key(st)))) return true
  const left = new Map<string, number>()
  for (const st of prev.stages.flatMap(s => s.steps)) left.set(key(st), (left.get(key(st)) ?? 0) + 1)
  const isGrown = steps.some(st => {
    const n = left.get(key(st)) ?? 0
    left.set(key(st), n - 1)
    return n <= 0
  })
  return !isGrown && steps.length > 0 && steps.every((st, i) => st.status === 'pending' || (st.status === 'active' && i === 0))
}
// what the next task under a finished bar's id keeps of the last one's strips: only agents still at work (a failed
// strip of the last task would otherwise stay under the new one for good); the fold starts over. A teammate resting
// between its turns stays too, and with nothing at work beside it, it folds away when its batch did
function afresh(prev: Plan): Pick<Plan, 'agents' | 'agentsDoneAt' | 'isFolded'> {
  const agents = keepStrips(prev.agents ?? [], a => a.state === 'running' || a.state === 'waiting' || resting.has(a.id))
  const isOver = agents.length > 0 && agents.every(a => a.state === 'done' || a.state === 'error')
  return { agents, agentsDoneAt: isOver ? (prev.agentsDoneAt ?? null) : null, isFolded: false }
}
// the strips that stay, in order: one whose parent strip goes moves up under its nearest ancestor that stays, or to
// the top, never drawn under a row that is no longer there
function keepStrips(agents: readonly AgentRun[], isKept: (a: AgentRun) => boolean): AgentRun[] {
  // the depth a child of the latest strip at each depth goes to: under it, or where it stood when it goes itself
  const childAt: number[] = []
  return agents.flatMap(a => {
    const depth = a.depth > 0 ? (childAt[a.depth - 1] ?? 0) : 0
    const keep = isKept(a)
    childAt.length = a.depth
    childAt[a.depth] = keep ? depth + 1 : depth
    return keep ? [depth === a.depth ? a : { ...a, depth }] : []
  })
}

// a resent plan keeps what is finished: a step sent as pending under a title that was done stays done
// a title used twice: each finished step carries over to one resent step of that title, in order
function carryDone(stages: PlanStage[], before: PlanStage[]): PlanStage[] {
  const finished = new Map<string, PlanStep[]>()
  for (const st of before.flatMap(s => s.steps).filter(st => isFinished(st.status))) {
    const key = st.title.trim().toLowerCase()
    finished.set(key, [...(finished.get(key) ?? []), st])
  }
  return stages.map(s => ({
    ...s,
    steps: s.steps.map(st => {
      const queue = finished.get(st.title.trim().toLowerCase())
      const was = queue?.[0]
      if (!queue || !was || !(st.status === 'pending' || st.status === was.status)) return st
      queue.shift()
      return { ...st, status: was.status, doneAt: was.doneAt }
    }),
  }))
}

// with nothing in progress, the first open step is the current one
function pointAt(stages: PlanStage[]): PlanStage[] {
  const steps = stages.flatMap(s => s.steps)
  if (steps.some(st => st.status === 'active' || st.status === 'error')) return stages
  const first = steps.find(st => st.status === 'pending')
  return stages.map(s => ({ ...s, steps: s.steps.map(st => (st === first ? { ...st, status: 'active' as const } : st)) }))
}

// the bar an approved plan-mode plan lands on; a revised plan updates it instead of opening a second one
const PLAN_ID = 'plan'

const clean = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\s*(\d+[.)]|[-*+]|\[[ xX]\])\s+/, '')
    .replace(/^(\d+[.)]|\[[ xX]\])\s+/, '')
    .trim()

function parsePlan(markdown: string, now: number): Plan | null {
  let title = ''
  const headed: PlanStage[] = []
  const heads: { level: number; isNumbered: boolean }[] = []
  const items: { depth: number; text: string; status: StepStatus }[] = []
  let fence = ''
  for (const line of markdown.split(/\r?\n/)) {
    // a code block's shell comments and diff lines only look like headings and list items
    // a backtick run closed on its own line is inline code, not a fence (a backtick fence's info string has no backtick)
    const f = line.match(/^\s*(`{3,})([^`]*)$/) ?? line.match(/^\s*(~{3,})(.*)$/)
    const mark = f?.[1] ?? ''
    if (fence) {
      if (mark[0] === fence[0] && mark.length >= fence.length && !f?.[2]?.trim()) fence = ''
      continue
    }
    if (mark) {
      fence = mark
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      // capped as the tool caps them: a heading may become a step (120), the title 80, which isNextTask compares
      const text = str(clean(h[2] ?? ''))
      if (h[1] === '#' && !title) title = str(text, 80)
      else {
        headed.push({ name: text, steps: [] })
        heads.push({ level: (h[1] ?? '').length, isNumbered: /^(\d+[.):]|step\s+\d+[.):]?)\s/i.test(h[2] ?? '') })
      }
      continue
    }
    const li = line.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/)
    if (!li) continue
    const depth = Math.floor((li[1] ?? '').replace(/\t/g, '  ').length / 2)
    const text = str(clean(li[3] ?? ''))
    if (!text) continue
    // a ticked box is a step the plan already counts as done
    const status: StepStatus = /^\[[xX]\]\s/.test(li[3] ?? '') ? 'done' : 'pending'
    items.push({ depth, text, status })
    const stage = headed[headed.length - 1]
    if (!stage) continue
    const step = stage.steps[stage.steps.length - 1]
    if (depth === 0 || !step) stage.steps.push({ title: text, status, substeps: [] })
    else step.substeps.push({ title: text, status })
  }
  // steps written as numbered headings with prose under them ("### 1. Add X" under "## Implementation") have no list
  // and would be dropped as empty stages: when most of a section's numbered headings are such ones, they all become
  // that section's steps, their list items its substeps; deepest first, and a top level with no section gets "Steps".
  // Numbered sections that mostly carry lists ("1. Context" in prose, then "2. Changes" with a list) stay stages
  const folded = new Set<number>()
  const root: PlanStage = { name: 'Steps', steps: [] }
  let rootAt = -1
  for (let level = 4; level >= 1; level--) {
    for (let p = -1; p < headed.length; p++) {
      if (p >= 0 && (heads[p]?.level ?? 0) >= level) continue
      const kids: number[] = []
      for (let i = p + 1; i < headed.length && (heads[i]?.level ?? 0) >= level; i++) if (heads[i]?.level === level && heads[i]?.isNumbered && !folded.has(i)) kids.push(i)
      if (kids.filter(i => headed[i]?.steps.length === 0).length * 2 <= kids.length) continue
      if (p < 0 && rootAt < 0) rootAt = kids[0] ?? -1
      const into = headed[p] ?? root
      for (const i of kids) {
        const kid = headed[i]
        if (!kid) continue
        into.steps.push({ title: kid.name, status: 'pending', substeps: kid.steps.map(s => ({ title: s.title, status: s.status })) })
        folded.add(i)
      }
    }
  }
  let stages = headed.flatMap((s, i) => (i === rootAt ? [root] : folded.has(i) ? [] : [s])).filter(s => s.steps.length > 0)
  if (stages.length === 0) {
    if (items.some(i => i.depth > 0)) {
      for (const item of items) {
        const stage = stages[stages.length - 1]
        if (item.depth === 0 || !stage) stages.push({ name: item.text, steps: [] })
        else stage.steps.push({ title: item.text, status: item.status, substeps: [] })
      }
      stages = stages.map(s => (s.steps.length ? s : { ...s, steps: [{ title: s.name, status: 'pending', substeps: [] }] }))
    } else if (items.length > 0) {
      stages = [{ name: 'Tasks', steps: items.map(i => ({ title: i.text, status: i.status, substeps: [] })) }]
    }
  }
  if (stages.length === 0) return null

  return { id: PLAN_ID, title: title || 'Plan', kind: stages.length === 1 ? 'todo' : 'plan', stages, state: 'running', note: null, startedAt: now }
}

function st(title: string, s: StepStatus): PlanStep {
  return { title, status: s, substeps: [] }
}

// ---------- drawing ----------

type Where = { pos: number; total: number; stage: number; step: number; stageSize: number }

// pos counts the finished steps wherever they are; the current step is the active one, else the first still open
function where(p: Plan): Where {
  const steps = p.stages.flatMap((s, i) => s.steps.map((step, j) => ({ i, j, step })))
  const pos = p.state === 'done' ? steps.length : steps.filter(x => isFinished(x.step.status)).length
  const cur = p.state === 'done' ? undefined : (steps.find(x => x.step.status === 'active') ?? steps.find(x => !isFinished(x.step.status)))
  const stage = (cur ?? steps[steps.length - 1])?.i ?? 0

  return { pos, total: steps.length, stage, step: cur ? cur.j + 1 : (p.stages[stage]?.steps.length ?? 0), stageSize: p.stages[stage]?.steps.length ?? 0 }
}

// what the pill shows: the stage its place on the track falls in (the finished share), so its name never runs ahead
// of the pill or lags behind it when Claude finishes steps out of order; the step counts within that stage. The
// model's own lines keep where(), which names the step actually in progress
function atHead(p: Plan): Where {
  const w = where(p)
  if (p.state === 'done') return w
  let start = 0
  for (let i = 0; i < p.stages.length; i++) {
    const size = p.stages[i]?.steps.length ?? 0
    if (w.pos < start + size || i === p.stages.length - 1) return { ...w, stage: i, step: Math.max(1, Math.min(size, w.pos - start + 1)), stageSize: size }
    start += size
  }
  return w
}

// the step the pill stands at, named after its stage behind a small separator; none on a finished bar
const pillStep = (p: Plan, w: Where) => (p.state === 'done' ? '' : (p.stages[w.stage]?.steps[w.step - 1]?.title ?? ''))

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a: number[], b: number[], m: number) => a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * m))
const rgb = (c: number[]) => `rgb(${c.join(',')})`
// XML has no place for C0 controls (an ANSI colour code's ESC, a bell) or U+FFFE/U+FFFF, escaped or not: one in a
// title would leave the whole picture unparsable, drawn as a broken image
const esc = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const hash = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return x - Math.floor(x)
}
const textWidth = (s: string, px = 6.7) => [...s].reduce((w, ch) => w + (/[　-鿿]/.test(ch) ? 12 : /[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMWШЩЖМ]/.test(ch) ? 9.5 : px), 0)

// a closer guess at a label's width in the system UI face the desktop draws a picture's text in (Segoe UI, SF Pro):
// spaces, the middle dot and narrow letters count narrow, wide capitals wide. Measured against Segoe UI it lands
// within a few percent; the margin on top keeps a wider face (SF Pro) inside the pill. Drawn text is centred on its
// box, so what is left of the error splits evenly between the two sides. Korean and full-width letters are an em wide
// like Chinese, an emoji (past the basic plane, or a dingbat like ✅) wider still, and the joiners and accents that
// ride on a letter take no room; lowercase Cyrillic ш щ ж ю ы м ф count wide, near their capitals
const glyphW = (ch: string) =>
  /[\u0300-\u036F\u200B-\u200D\uFE00-\uFE0F]/.test(ch) ? 0
  : ch.length > 1 || /[\u2600-\u27BF]/.test(ch) ? 16.5
  : /[　-鿿가-힣\uFF01-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 12
  : /[\s·.,:;'|!iljI]/.test(ch) ? 3.3
  : /[frt]/.test(ch) ? 4.4
  : /[MWШЩЖЮФ…]/.test(ch) ? 10.8
  : /[шщжю]/.test(ch) ? 10.4
  : /[mwМЫымф]/.test(ch) ? 9.6
  : /[0-9]/.test(ch) ? 6.6
  : /[A-ZА-ЯЁ]/.test(ch) ? 7.6
  : 6.3
const labelWidth = (s: string, size = 12, isBold = true) => (([...s].reduce((w, ch) => w + glyphW(ch), 0) * size) / 12) * (isBold ? 1 : 0.96) * 1.06
// a label cut to width, as labelWidth measures it, then given an ellipsis; at least three characters stay. It drops
// whole grapheme clusters, so an emoji is never split into a lone half (which shows as "�" and breaks the picture's
// encoding), and takes each one's width off as it goes, so a long label costs one pass and not one measure a letter
const fitLabel = (s: string, width: number, size = 12, isBold = true) => {
  if (labelWidth(s, size, isBold) <= width) return s
  const scale = (size / 12) * (isBold ? 1 : 0.96) * 1.06
  const parts = clusters(s).map(c => ({ c, w: [...c].reduce((sum, ch) => sum + glyphW(ch), 0) * scale }))
  let w = parts.reduce((sum, x) => sum + x.w, 0)
  let n = parts.length
  // the ellipsis takes its own room, so the cut label with it still fits
  const room = width - glyphW('…') * scale
  while (n > 3 && w > room) w -= parts[--n]?.w ?? 0
  return n === parts.length ? s : parts.slice(0, n).map(x => x.c).join('').trimEnd() + '…'
}
// the text without its last grapheme cluster, for the cuts measured with textWidth
const dropLast = (s: string) => clusters(s).slice(0, -1).join('')
// a strip's text (11.5 px, regular) cut so that it ends, ellipsis and all, within width. Measured both ways and the
// wider taken: textWidth reads Korean and full-width letters as Latin, labelWidth knows them
const stripW = (s: string) => Math.max(textWidth(s, 6.2), labelWidth(s, 11.5, false))
const fitStrip = (s: string, width: number) => {
  if (stripW(s) <= width) return s
  let cut = s
  while (cut.length > 4 && stripW(cut + '…') > width) cut = dropLast(cut)
  return cut.trimEnd() + '…'
}

const ICON_PATH: Partial<Record<PlanState, string>> = {
  needs_input: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  error: 'M18 6 6 18M6 6l12 12',
  done: 'M20 6 9 17l-5-5',
}

// how long each finished step took (from the previous finish, or the plan's start) and each finished stage
function stepTimes(p: Plan): { steps: Map<PlanStep, number>; stages: (number | undefined)[] } {
  const ends = p.stages.flatMap(s => s.steps).flatMap(st => (st.doneAt === undefined ? [] : [st.doneAt])).sort((a, b) => a - b)
  const startOf = (at: number) => Math.max(p.startedAt, ...ends.filter(t => t < at))
  const steps = new Map<PlanStep, number>()
  const stages = p.stages.map(s => {
    for (const st of s.steps) if (st.doneAt !== undefined) steps.set(st, st.doneAt - startOf(st.doneAt))
    const times = s.steps.map(st => st.doneAt)
    if (times.some(t => t === undefined)) return undefined
    const done = times as number[]
    return Math.max(...done) - Math.min(...done.map(startOf))
  })
  return { steps, stages }
}

// the 2 px dots of one look go into one path: a fraction of the markup of a rect each, and one node instead of thousands
function addDot(dots: Map<string, string>, cls: string, x: number, y: number) {
  dots.set(cls, `${dots.get(cls) ?? ''}M${x} ${y}h2v2h-2z`)
}

// the fill is a still grid of 2 px dots, 3 px apart in 7 rows, and brightness streams over it from the head towards
// the start the way it does on Claude Code's effort slider: a wave of a few brightness steps scrolls left one column
// per step, and every dot flickers on its own, stepping up and back down to the grid. It is all patterns and masks,
// so the picture is the same size at any width
const STREAM_COLS = 233 // the wave's pattern in columns, prime and long, so its loop does not show
const STREAM_SPEED = 20 // columns a second; a bar at rest (waiting, failed, done) streams at half that
const STREAM_LEVELS = [0.3, 0.37, 0.44, 0.51] // the grid's brightness at each step of the wave
const FLICKER_TILE = 173 // columns the flicker classes are dealt over, every dot in exactly one
const FLICKER_CLASSES = 24
const FLICKER_LIFTS = [0, 0.35, 0.6, 0.9]
// [share of the fill, opacity]: the grid fades in from nothing at the start to full at two thirds; the flicker fades in
// later and steeper, so it sparkles at the head and thins out on its way to the start
const STREAM_FADE: [number, number][] = [[0, 0], [0.67, 1], [1, 1]]
const FLICKER_FADE: [number, number][] = [[0, 0], [0.15, 0], [0.5, 0.45], [0.8, 0.9], [1, 1]]
// mixed better than hash for the few hundred values the stream takes: with it the wave comes out as it was measured
// against the slider
const streamHash = (a: number, b: number, k: number) => {
  let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(k, 1442695041)) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}
// the wave: noise over STREAM_COLS columns (wrapping), smoothed to blobs a few columns wide and cut into steps. Drawn
// as one stroke per step through its runs of columns, the full height of the track
const STREAM_WAVE = (() => {
  const raw = Array.from({ length: STREAM_COLS }, (_, i) => streamHash(i, 0, 5))
  const smooth = raw.map((_, i) => {
    let sum = 0
    let weight = 0
    for (let d = -5; d <= 5; d++) {
      const k = Math.exp(-(d * d) / 12.5)
      sum += (raw[(i + d + STREAM_COLS) % STREAM_COLS] ?? 0) * k
      weight += k
    }
    return sum / weight
  })
  const lo = Math.min(...smooth)
  const hi = Math.max(...smooth)
  const steps = smooth.map(v => Math.min(STREAM_LEVELS.length - 1, Math.floor(((v - lo) / (hi - lo)) * STREAM_LEVELS.length)))
  const runs = STREAM_LEVELS.map((level, l) => {
    let d = ''
    let end = -1
    for (let i = 0; i < steps.length; ) {
      let j = i
      while (j < steps.length && steps[j] === steps[i]) j++
      if (steps[i] === l) {
        d += `${end < 0 ? `M${i * 3} ${TRACK_H / 2}` : `m${(i - end) * 3} 0`}h${(j - i) * 3}`
        end = j
      }
      i = j
    }
    return d ? `<path stroke-opacity="${level}" d="${d}"/>` : ''
  })
  return `<g stroke="#fff" stroke-width="${TRACK_H}">${runs.join('')}</g>`
})()
// the flicker: each class a pattern of its dots over the tile, and a timeline of lifts (a random walk over
// FLICKER_LIFTS, each held 50 to 300 ms, back at the grid now and then) of its own length and start. Every time in
// it is a whole number of the wave's 50 ms steps: a change anywhere in the picture redraws all of it, and on one beat
// the 24 classes and the wave redraw it 20 times a second instead of at nearly every frame (half the CPU)
const FLICKER_TICK = 0.05
const FLICKER = (() => {
  const of = Array.from({ length: 7 }, (_, r) => Array.from({ length: FLICKER_TILE }, (_, c) => Math.floor(streamHash(c, r, 302) * FLICKER_CLASSES)))
  return Array.from({ length: FLICKER_CLASSES }, (_, k) => {
    let d = ''
    let last: [number, number] | null = null
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < FLICKER_TILE; c++) {
        if (of[r]?.[c] !== k) continue
        d += `${last ? `m${c * 3 - last[0]} ${r * 3 - last[1]}` : `M${c * 3} ${r * 3}`}h2v2h-2z`
        last = [c * 3, r * 3]
      }
    }
    // in ticks; a frame that would hold the level it already has is left out
    const length = Math.round((2.3 + 2.4 * streamHash(k, 1, 11)) / FLICKER_TICK)
    const frames: string[] = []
    let level = 0
    let shown = -1
    for (let t = 0, i = 0; t < length - 1; i++) {
      if (level !== shown) frames.push(`${+((t / length) * 100).toFixed(3)}%{opacity:${FLICKER_LIFTS[level]}}`)
      shown = level
      t += Math.max(1, Math.round((0.07 + 0.23 * streamHash(k, i, 13)) / FLICKER_TICK))
      const u = streamHash(k, i, 15)
      level = u < 0.4 ? Math.max(0, level - 1) : u < 0.8 ? Math.min(3, level + 1) : 0
    }
    const css = `.q${k}{opacity:0;animation:q${k} ${(length * FLICKER_TICK).toFixed(2)}s step-end infinite;animation-delay:calc(var(--f) - ${(Math.round(streamHash(k, 2, 16) * length) * FLICKER_TICK).toFixed(2)}s)}@keyframes q${k}{${frames.join('')}}`
    return { d, css }
  })
})()
const FLICKER_CSS = FLICKER.map(f => f.css).join('')
// the twinkle option in /config (#23). Off, the fill stands still as reduce motion draws it, the flicker left out and
// the wave's bands kept where they start, and the strips' dots and the terminal fill hold their middle brightness; the
// clocks, the glides and the agents' status dots still move
let isTwinkling = true

// the engine refuses the whole band, every bar in it, when one picture's source passes 131072 characters. A plan of
// hundreds of steps would get there through its marks and their hover tips (a few pixels apart they only cover each
// other anyway), so past a share of that each is thinned. Stage boundaries go first, as they give the track its
// shape and name the stages; the step marks fill what is left, kept only so far apart along the track. Picking by
// index would line up with regular stage sizes and drop every stage at once
const MARKS_BUDGET = 40_000
const TIPS_BUDGET = 100_000
type Mark<T> = { x: number; isStage: boolean; item: T }
function thin<T>(marks: Mark<T>[], size: (item: T) => number, budget: number): T[] {
  const sizeOf = (m: Mark<T>) => size(m.item)
  if (marks.reduce((n, m) => n + sizeOf(m), 0) <= budget) return marks.map(m => m.item)
  const keep = new Set<Mark<T>>()
  let used = 0
  // every so many, spread evenly, of the marks that fit only in part
  const spread = (list: Mark<T>[], room: number) => {
    const every = Math.max(1, Math.ceil(list.reduce((n, m) => n + sizeOf(m), 0) / Math.max(1, room)))
    list.forEach((m, i) => {
      if (i % every !== 0 || used + sizeOf(m) > budget) return
      used += sizeOf(m)
      keep.add(m)
    })
  }
  spread(marks.filter(m => m.isStage), budget)
  const steps = marks.filter(m => !m.isStage)
  const room = budget - used
  const fits = steps.length === 0 ? 0 : Math.floor(room / (steps.reduce((n, m) => n + sizeOf(m), 0) / steps.length))
  const span = (marks.at(-1)?.x ?? 0) - (marks[0]?.x ?? 0)
  const gap = fits > 0 ? span / fits : Infinity
  let last = -Infinity
  for (const m of marks) {
    if (keep.has(m)) last = m.x
    else if (!m.isStage && m.x - last >= gap && used + sizeOf(m) <= budget) {
      used += sizeOf(m)
      keep.add(m)
      last = m.x
    }
  }
  return marks.filter(m => keep.has(m)).map(m => m.item)
}

// last drawn head position per plan, so a redraw glides from where the bar was; from and at are the glide that led
// there (from === x when it stood), so a redraw before it has run keeps it going instead of drawing it arrived
const lastHead = new Map<string, { W: number; x: number; from: number; at: number }>()
// where each bar's wave got to (cols, in columns) when it last changed speed (at): a bar coming to rest, or set going
// again, streams on from there at its new speed. Timed from the start at the new speed instead, the wave would jump to
// wherever that speed had brought it
const waveFrom = new Map<string, { start: number; speed: number; at: number; cols: number }>()

// the track draws in a sandboxed frame (for hover); its page must stay see-through in either theme
const SEE_THROUGH = '<style>:root,html,body{background:transparent!important;color-scheme:light dark;margin:0;overflow:hidden}svg{display:block}</style>'

// a clock that counts in the frame by itself, so the drawing never has to be redrawn each second (a redraw
// reloads the frame and everything in it blinks): each digit is a reel of its figures behind a one-line window,
// stepped by a CSS animation whose negative delay is the time already run. Plain SVG, since the host's frame
// drops foreignObject. {{T:start}} becomes those seconds on every draw (liveSource)
const CLOCK_W = 48 // "59m 59s"
const LINE = 16
const CLOCK_CSS = `.ckt{font-variant-numeric:tabular-nums}
.rs1{animation:r10 10s steps(10) var(--d) infinite}.rs10{animation:r6 60s steps(6) var(--d) infinite}
.cc{animation:cc 36000s linear var(--d) both}@keyframes cc{0%,.1666%{transform:translateX(-13.5px)}.1667%,1.6666%{transform:translateX(-3.25px)}1.6667%,9.9999%{transform:none}10%,99.9999%{transform:translateX(-4.25px)}100%{transform:translateX(-.75px)}}
.rm1{animation:r10 600s steps(10) var(--d) infinite}.rm10{animation:r10 6000s steps(10) var(--d) infinite}.rmm{animation:hm 60s steps(1,end) var(--d) both}
.rm6{animation:r6 3600s steps(6) var(--d) infinite}.rh1{animation:r10 36000s steps(10) var(--d) infinite}.rh10{animation:r10 360000s steps(10) var(--d) infinite}
.ph1{animation:ho 3600s steps(1,end) var(--d) both}.ph2{animation:hm 3600s steps(1,end) var(--d) both}
@keyframes r10{to{transform:translateY(-${LINE * 10}px)}}@keyframes r6{to{transform:translateY(-${LINE * 6}px)}}@keyframes hm{from{opacity:0}to{opacity:1}}@keyframes ho{from{opacity:1}to{opacity:0}}`

// x is the clock's left edge, top the window's top. Under an hour it reads "12m 05s", the minutes part hidden for
// the first minute; from an hour on "1h 05m", as elapsed() writes a finished time, up to 99h
function liveClock(x: number, top: number, start: number, cls: string, textCls: string, isCentered = false): string {
  const base = top + 12
  const reel = (cx: number, figures: string[], reelCls: string) =>
    `<g class="${reelCls}"><text class="${textCls} ckt" text-anchor="middle">${figures
      .map((f, i) => `<tspan x="${cx.toFixed(1)}" y="${base + i * LINE}">${f}</tspan>`)
      .join('')}</text></g>`
  const unit = (ux: number, label: string) => `<text x="${ux.toFixed(1)}" y="${base}" class="${textCls}">${label}</text>`
  const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  const tens = ['', ...digits.slice(1)]
  const id = `ck${start}x${Math.round(x)}y${Math.round(top)}`
  const minutes =
    `<g class="ph1"><g class="rmm">${reel(x + 3.5, tens, 'rm10')}${reel(x + 10.5, digits, 'rm1')}${unit(x + 14, 'm')}</g>` +
    `${reel(x + 31, digits.slice(0, 6), 'rs10')}${reel(x + 38, digits, 'rs1')}${unit(x + 41.5, 's')}</g>`
  // "h" is narrower than "m", so the minutes sit 3 px nearer to it than the seconds sit to "m": the same space between
  // the parts, and the face's wide "m" ends about where the other face's "s" does
  const hours =
    `<g class="ph2">${reel(x + 3.5, tens, 'rh10')}${reel(x + 10.5, digits, 'rh1')}${unit(x + 14, 'h')}` +
    `${reel(x + 28, digits.slice(0, 6), 'rm6')}${reel(x + 35, digits, 'rm1')}${unit(x + 38.5, 'm')}</g>`
  // the window only has to hide the reels' other figures above and below; sideways it leaves room past the clock's
  // right edge for a wider face than Segoe UI (SF Pro), whose last letter would otherwise be cut
  return (
    `<style>.${id}{--d:-{{T:${start}}}s}</style><g class="${cls} ${id}"><clipPath id="${id}"><rect x="${(x - 2).toFixed(1)}" y="${top}" width="${CLOCK_W + 10}" height="${LINE}"/></clipPath>` +
    `<g clip-path="url(#${id})"${isCentered ? ' class="cc"' : ''}>${minutes}${hours}</g></g>`
  )
}

// the desktop rebuilds a strip's picture on every redraw of the band, another plugin's invalidate included, so a
// source reused from an earlier draw would restart its clocks at that draw's offset (issue #6): the offset is
// taken from now on every draw. To the millisecond: a glide is steepest at its start, where a tenth of a second
// is up to 40% of the way, so a picture rebuilt there at a rounded offset set the pill back and sent it on again
function liveSource(template: string, now: number): string {
  return template.replace(/\{\{T:(\d+)\}\}/g, (_, t: string) => Math.max(0, (now - Number(t)) / 1000).toFixed(3))
}

// SMIL runs whatever CSS says, so prefers-reduced-motion alone cannot stop a glide or a colour flow: an element that
// moves is drawn twice, the moving copy (class mv) hidden under reduced motion and a still one (sv), shown only then,
// in its place. draw gets the animation to put in the element and the class to give it
const withStill = (draw: (anim: string, cls: string) => string, anim: string) => (anim ? draw(anim, 'mv') + draw('', 'sv') : draw('', ''))
const classAttr = (cls: string) => (cls ? ` class="${cls}"` : '')
const STILL_CSS = '.sv{display:none}'
const STILL_REDUCED = '.mv{display:none}.sv{display:inline}'

// a bar is drawn three times: the track itself as a plain picture, cheap for the desktop to rebuild whenever anything
// redraws; the pill's clock, a plain picture too, that the desktop shows while the pointer is over the track; and a
// see-through layer on top for the checkpoint times. That layer needs an interactive frame, and the desktop rebuilds
// such frames on every redraw of the band; empty until hovered, the rebuild is invisible. The clock is no part of it:
// a frame built anew under a still pointer is not hovered until the pointer moves, so the clock went out on every
// redraw (the footer's figure, once a second while a response streams), where the desktop's own hover holds. All
// three at one width are reused until what they show of the plan changes
type Track = { base: string; overlay: string; clock: string }
// the desktop rebuilds the picture when anything near it redraws (the footer's figure, a strip), and a rebuilt glide
// would play again from the start, the pill jumping back to where it was. So the glide begins where its time has got
// to ({{T:moved}} becomes the seconds since the move on every draw, liveSource), and once it has run the bar is drawn
// standing at its place. A rebuild from the very same source starts that source's glide over, whatever its offset:
// the engine hands back its last answer when the desktop asks again with nothing the band read changed, which it does
// as the model starts to answer after a tool call, some .5 s after the move. So the glide is short and the standing
// picture is asked for before it ends: from PICTURE_STAND_MS on, with the pill all but there, a draw is standing,
// and the gliding source is current for as short a time as the desktop takes to draw the band again. The desktop
// shows a picture some .1 s after it is drawn and the standing one as late, so it lands about where the glide
// stands then: a step of 1-2% of the way, where at .2 s it was 5%
const PICTURE_GLIDE_MS = 300
const PICTURE_STAND_MS = 250
// a bar that glided is drawn once more as the glide ends, standing: with nothing else to redraw it (a finished bar, the
// turn over) the desktop would keep the gliding picture, and play it again from the old place whenever it rebuilds it.
// One timer at a time, when the first glide or morph still under way is over; a draw then queues the next. One due
// sooner than the timer waiting takes its place, else a later end queued first would hold the earlier picture on
let settleDue = 0
function settleBy($: EngineInterface, at: number, now: number) {
  if (at <= now || (settleDue > now && settleDue <= at)) return
  settleDue = at
  $.clock.after(at - now, () => {
    if (settleDue === at) settleDue = 0
    void update($, tick, n => n + 1).catch(() => {})
  })
}
// kept per bar id with what the track shows of the plan: $.state hands back a fresh copy on every read, so a plan
// object is never seen twice and could not key the drawings itself
const drawn = new Map<string, { sig: string; W: number; color: string; track: Track; glideUntil: number }>()
const trackSig = (p: Plan) => JSON.stringify([p.state, p.startedAt, p.endedAt, p.stages])

function trackSvg(p: Plan, W: number, now: number): Track {
  const cached = drawn.get(p.id)
  const sig = trackSig(p)
  const color = stateColor(p.state)
  if (cached?.sig === sig && cached.W === W && cached.color === color && (cached.glideUntil === 0 || now < cached.glideUntil)) return cached.track
  const track = drawTrack(p, W, now)
  const glideUntil = track.base.includes('<animateTransform') ? (lastHead.get(p.id)?.at ?? now) + PICTURE_STAND_MS : 0
  drawn.set(p.id, { sig, W, color, track, glideUntil })
  return track
}

function drawTrack(p: Plan, W: number, now = 0): Track {
  const H = TRACK_H
  const w = atHead(p)
  const done = p.state === 'done'
  // the fill is exactly the finished share: a fresh plan starts empty
  const frac = done ? 1 : Math.min(1, w.pos / Math.max(1, w.total))
  const fx = frac * W
  const key = p.id
  // a resize redraws at once: a head drawn at another width would glide in from the wrong place
  const last = lastHead.get(key)
  // drawn again on its way to the same place (an agent's event, any redraw), the glide goes on from where it began,
  // its begin offset putting the pill where its time has got to
  const isGliding = last?.W === W && Math.abs(last.x - fx) <= 0.5 && now < last.at + PICTURE_STAND_MS
  const from = isGliding ? last.from : last?.W === W ? last.x : fx
  const at = isGliding ? last.at : now
  lastHead.set(key, { W, x: fx, from, at })

  const acc = hex(stateColor(p.state))
  const light = mix(acc, [255, 255, 255], 0.32)
  const ease = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"'
  const glide = Math.abs(from - fx) > 0.5

  // the stream (STREAM_WAVE, FLICKER) over the fill, drawn as far as the fill reaches during a glide back. Its fades run
  // along the fill; the wave's mask is a pattern longer than that, so its slide never uncovers the end
  const span = Math.max(fx, from)
  const speed = p.state === 'running' ? STREAM_SPEED : STREAM_SPEED / 2
  const was = waveFrom.get(key)
  const wave =
    was?.start !== p.startedAt ? { start: p.startedAt, speed, at: p.startedAt, cols: 0 }
    : was.speed === speed ? was
    : // a whole column: the wave's delay (cols / speed) then stays on the flicker's 50 ms beat, one redraw rate for both
      { start: p.startedAt, speed, at: now, cols: Math.round(was.cols + (Math.max(0, now - was.at) / 1000) * was.speed) % STREAM_COLS }
  waveFrom.set(key, wave)
  const fadeMask = (id: string, stops: [number, number][]) =>
    `<linearGradient id="${id}g" x1="0" x2="${fx.toFixed(1)}" gradientUnits="userSpaceOnUse">${stops.map(([at, o]) => `<stop offset="${at}" stop-color="#fff" stop-opacity="${o}"/>`).join('')}</linearGradient>` +
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#${id}g)"/></mask>`
  // without the twinkle the flicker goes as a whole: its dots get their resting opacity from its stylesheet alone, so
  // patterns left without it would draw every one of them bright
  const streamDefs =
    fadeMask('fade', STREAM_FADE) +
    (isTwinkling ? fadeMask('kfade', FLICKER_FADE) : '') +
    `<pattern id="dg" width="3" height="3" y="1" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="${rgb(light)}"/></pattern>` +
    `<pattern id="wp" width="${STREAM_COLS * 3}" height="${H}" patternUnits="userSpaceOnUse">${STREAM_WAVE}</pattern>` +
    `<mask id="wave" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect class="wm" width="${(span + STREAM_COLS * 3 + 3).toFixed(1)}" height="${H}" fill="url(#wp)"/></mask>` +
    (isTwinkling ? FLICKER.map((f, k) => `<pattern id="fp${k}" width="${FLICKER_TILE * 3}" height="21" y="1" patternUnits="userSpaceOnUse"><path class="q${k}" fill="${rgb(light)}" d="${f.d}"/></pattern>`).join('') : '')
  const stream =
    `<g mask="url(#fade)"><g mask="url(#wave)"><rect width="${span.toFixed(1)}" height="21" fill="url(#dg)"/></g></g>` +
    (isTwinkling ? `<g mask="url(#kfade)">${FLICKER.map((_, k) => `<rect width="${span.toFixed(1)}" height="${H}" fill="url(#fp${k})"/>`).join('')}</g>` : '')

  const took = stepTimes(p)
  const markList: Mark<string>[] = []
  const zoneList: Mark<{ hit: string; tip: string; rule: string }>[] = []
  let k = 0
  p.stages.forEach((s, i) => {
    s.steps.forEach((_, j) => {
      if (k > 0) {
        const x = (k / w.total) * W
        const isStage = j === 0
        // a stage boundary is a short capsule, a step a dot; bright once passed. On a light page both would fade into
        // the track, so there the stylesheet darkens them by class
        const passed = x < fx - 1
        const fill = passed ? rgb(mix(light, [255, 255, 255], 0.45)) : '#A8A69E'
        const opacity = passed ? (isStage ? 0.95 : 0.8) : isStage ? 0.9 : 0.8
        const cls = passed ? 'mp' : 'ma'
        markList.push({
          x,
          isStage,
          item: isStage
            ? `<rect class="${cls}" x="${(x - 1.5).toFixed(1)}" y="${(H - 10) / 2}" width="3" height="10" rx="1.5" fill="${fill}" opacity="${opacity}"/>`
            : `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${H / 2}" r="1.4" fill="${fill}" opacity="${opacity}"/>`,
        })
        const before = p.stages[isStage ? i - 1 : i]
        const ended = isStage ? before?.steps[before.steps.length - 1] : s.steps[j - 1]
        // a mark the bar has reached names what ended there (and how long it took); one still ahead names what starts
        // there, so a name far up the track does not read as the stage the bar is in
        const label = k <= w.pos ? (isStage ? (before?.name ?? '') : (ended?.title ?? '')) : isStage ? s.name : (s.steps[j]?.title ?? '')
        const ms = isStage ? took.stages[i - 1] : took.steps.get(ended as PlanStep)
        const full = ms === undefined || k > w.pos ? label : `${label} · ${elapsed(ms)}`
        // a tip never runs past the track: a long title is shortened to fit
        const text = fitLabel(full, W - 16, 11, false)
        const tw = Math.min(W, labelWidth(text, 11, false) + 16)
        const tx = Math.max(0, Math.min(W - tw, x - tw / 2))
        zoneList.push({
          x,
          isStage,
          item: {
            hit: `<rect class="h${k}" x="${(x - 5).toFixed(1)}" width="10" height="${H}" fill="#000" fill-opacity="0"/>`,
            tip: `<g class="tp p${k}"><rect x="${tx.toFixed(1)}" y="2" width="${tw.toFixed(1)}" height="${H - 4}" rx="${(H - 4) / 2}" fill="#1F1E1D" fill-opacity=".94"/><text x="${(tx + tw / 2).toFixed(1)}" y="${H / 2 + 3.8}" text-anchor="middle" class="tt">${esc(text)}</text></g>`,
            rule: `.h${k}:hover~.p${k}`,
          },
        })
      }
      k++
    })
    void i
  })
  const marks = thin(markList, m => m.length, MARKS_BUDGET).join('')
  const zones = thin(zoneList, z => z.hit.length + z.tip.length + z.rule.length + 1, TIPS_BUDGET)
  const hits = zones.map(z => z.hit).join('')
  const tips = zones.map(z => z.tip).join('')
  const tipRules = zones.map(z => z.rule)

  // knob: a pill with stage and count, or a round dot with the stage number when narrow
  const isNarrow = W < NARROW
  const color = stateColor(p.state)
  const icon = ICON_PATH[p.state]
  const single = p.stages.length === 1
  const number = single ? w.step : w.stage + 1
  let knob = ''
  let timePill = ''
  let kw = H
  if (isNarrow) {
    const label = done ? '' : String(number)
    knob = `<circle cx="0" cy="${H / 2}" r="${H / 2}" fill="${color}"/>${
      done ? `<path d="${ICON_PATH.done}" transform="translate(-6 5) scale(.5)" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : `<text x="0" y="${H / 2 + 4.2}" text-anchor="middle" class="kt">${label}</text>`
    }`
  } else {
    const name = done ? (p.endedAt ? elapsed(p.endedAt - p.startedAt) : 'Done') : single ? (p.stages[0]?.name ?? 'Tasks') : (p.stages[w.stage]?.name ?? '')
    // the pill carries the stage name and, past a thin line, the step at its place (the fill and the percent
    // already say how far along it is); folded agents stay folded, the pill does not count them
    const iconW = icon ? 16 : 0
    // at most about half a short track, and never so wide on a long one that it hides the marks around it
    const maxW = Math.max(80, Math.min(W * 0.55, 320))
    const room = maxW - (20 + iconW)
    // the step is set a size smaller and lighter than the stage, past a thin line
    const stageWidth = (text: string) => labelWidth(text)
    const stepWidth = (text: string) => labelWidth(text, 11, false)
    // the step gives way first: shortened, then dropped, before the stage name is
    const sepW = 15
    const stepRoom = room - stageWidth(name) - sepW
    const step = stepRoom >= stepWidth('Abc…') ? fitLabel(pillStep(p, w), stepRoom, 11, false) : ''
    const shown = step ? name : fitLabel(name, room)
    const shownW = stageWidth(shown) + (step ? sepW + stepWidth(step) : 0)
    // a running pill is wide enough for its clock too, so the hover swap does not change its size
    const textW = done ? shownW : Math.max(shownW, CLOCK_W)
    const contentW = iconW + textW
    kw = Math.round(20 + contentW)
    const left = -contentW / 2
    const mid = left + iconW + textW / 2
    knob = `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>`
    if (icon) knob += `<path d="${icon}" transform="translate(${left.toFixed(1)} 5) scale(.5)" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`
    // the separator is the mark the pill stands on: a stage's capsule at a stage's first step, a step's dot past it
    const sepMark = (x: number) =>
      w.step === 1
        ? `<rect x="${(x - 1).toFixed(1)}" y="${(H - 10) / 2}" width="2" height="10" rx="1" fill="${INK}" fill-opacity=".7"/>`
        : `<circle cx="${x.toFixed(1)}" cy="${H / 2}" r="1.7" fill="${INK}" fill-opacity=".8"/>`
    if (step) {
      // the line is the anchor: the stage ends at it and the step starts after it, so whatever the font's real
      // widths, the two never run into each other
      const line = left + iconW + (textW - shownW) / 2 + stageWidth(shown)
      knob +=
        `<text x="${line.toFixed(1)}" y="${H / 2 + 4.2}" text-anchor="end" class="kt">${esc(shown)}</text>` +
        sepMark(line + 7.5) +
        `<text x="${(line + sepW).toFixed(1)}" y="${(H / 2 + 3.9).toFixed(1)}" class="kt kp">${esc(step)}</text>`
    } else knob += `<text x="${mid.toFixed(1)}" y="${H / 2 + 4.2}" text-anchor="middle" class="kt">${esc(shown)}</text>`
    // hovering the track lays a copy of the pill over it, the stage name giving way to the time the plan has run so far
    if (!done) {
      const face = `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>${
        icon ? `<path d="${icon}" transform="translate(${left.toFixed(1)} 5) scale(.5)" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` : ''
      }`
      timePill = `${face}${liveClock(mid - CLOCK_W / 2, 3, p.startedAt, 'kc0', 'kt', true)}`
    }
  }
  const clampX = (x: number) => Math.max(kw / 2, Math.min(W - kw / 2, x))
  const kx = clampX(fx)
  const kFrom = clampX(from)

  // the step name is full white: at .9 it reads under AA (4.5:1) on the amber pill
  // the desktop rebuilds the picture whenever something near it redraws, which starts its animations over: every one
  // is set back by the time since the plan started ({{T}}, liveSource), so a rebuild picks the stream up where it was
  // instead of jumping back. The wave moves one column at a time (steps), as the slider's does, timed from its last
  // change of speed (waveFrom) and set on by the columns it had gone by then
  const motion = `svg{--f:-{{T:${Math.round(p.startedAt)}}}s;--w:-{{T:${Math.round(wave.at)}}}s}
.wm{animation:wm ${(STREAM_COLS / speed).toFixed(2)}s steps(${STREAM_COLS}) infinite;animation-delay:calc(var(--w) - ${(wave.cols / speed).toFixed(2)}s)}
@keyframes wm{to{transform:translateX(-${STREAM_COLS * 3}px)}}
${FLICKER_CSS}
`
  const style = `<style>
${isTwinkling ? motion : ''}.kt{font:500 12px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:${INK}}
.kp{font-size:11px;font-weight:400}
@media (prefers-color-scheme:light){.mp{fill:${rgb(mix(acc, [0, 0, 0], 0.3))};opacity:1}.ma{fill:${SCHEMES.light.gutter};opacity:1}}
${STILL_CSS}@media (prefers-reduced-motion:reduce){.wm,[class^="q"]{animation:none}${STILL_REDUCED}}
</style>`
  const hoverStyle = `<style>
.tp{opacity:0;transition:opacity .12s;pointer-events:none}${tipRules.length ? `${tipRules.join(',')}{opacity:1}` : ''}
.tt{font:400 11px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:#F0EEFC}
.kb,rect[class^="h"]{cursor:pointer}
</style>`
  // a glide drawn again later starts that much into its run, or past its end, standing where it went
  const begin = `begin="-{{T:${Math.round(at)}}}s"`
  const dur = `dur="${PICTURE_GLIDE_MS / 1000}s"`
  const glideFill = glide ? `<animate attributeName="width" from="${from.toFixed(1)}" to="${fx.toFixed(1)}" ${dur} ${begin} ${ease} fill="freeze"/>` : ''
  const glideKnob = glide ? `<animateTransform attributeName="transform" type="translate" from="${kFrom.toFixed(1)} 0" to="${kx.toFixed(1)} 0" ${dur} ${begin} ${ease} fill="freeze"/>` : ''

  // a gliding pill is written once and shown by reference in both copies, so its words are not in the picture twice
  const place = `transform="translate(${kx.toFixed(1)} 0)"`
  const pill = glideKnob
    ? `<defs><g id="kn">${knob}</g></defs><g class="mv" ${place}>${glideKnob}<use href="#kn"/></g><use class="sv" href="#kn" ${place}/>`
    : `<g ${place}>${knob}</g>`

  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  const base = `${open}${style}
<defs><clipPath id="pill"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath><clipPath id="fill">${withStill((anim, cls) => `<rect${classAttr(cls)} width="${fx.toFixed(1)}" height="${H}">${anim}</rect>`, glideFill)}</clipPath>
<linearGradient id="base" x1="0" x2="${fx.toFixed(1)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(acc)}" stop-opacity=".05"/><stop offset="1" stop-color="${rgb(acc)}" stop-opacity=".33"/></linearGradient>
${streamDefs}</defs>
<g clip-path="url(#pill)"><rect width="${W}" height="${H}" fill="#808080" fill-opacity=".16"/>
<g clip-path="url(#fill)"><rect width="${fx.toFixed(1)}" height="${H}" fill="url(#base)"/>${stream}</g>${marks}</g>
${pill}</svg>`
  // the hover layer: checkpoint areas under a running pill's place, so the pill wins where they meet; tips on top
  const pillArea = timePill ? `<rect class="kb" x="${(kx - kw / 2).toFixed(1)}" y="0" width="${kw}" height="${H}" fill="#000" fill-opacity="0"/>` : ''
  const overlay = `${open}${SEE_THROUGH}${hoverStyle}${hits}${pillArea}${tips}</svg>`
  // the pill's copy with its clock, for the desktop to show over the track while the pointer is on it. Shown at any
  // moment, so it glides with the pill (the same glide and offset, and the same still copy for reduced motion) rather
  // than standing at the new place while the pill slides in under it
  const clockStyle = `<style>.kt{font:500 12px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:${INK}}${CLOCK_CSS}
${STILL_CSS}@media (prefers-reduced-motion:reduce){${STILL_REDUCED}}</style>`
  const clockPill = glideKnob ? `<g class="mv" ${place}>${glideKnob}${timePill}</g><g class="sv" ${place}>${timePill}</g>` : `<g ${place}>${timePill}</g>`
  const clock = timePill ? `${open}${clockStyle}${clockPill}</svg>` : ''

  return { base, overlay, clock }
}

const AGENT_COLOR: Record<AgentRun['state'], string> = {
  running: STATE_COLOR.running,
  waiting: STATE_COLOR.needs_input,
  done: STATE_COLOR.done,
  error: STATE_COLOR.error,
}
const agentColor = (s: AgentRun['state']) => (s === 'running' ? stateColor('running') : AGENT_COLOR[s])

// strip text that reads at WCAG AA (4.5:1) on its tint, in a dark and a light scheme (issue #13). The desktop draws
// a strip as a picture over the app's background, which no event tells the plugin: the picture carries both sets,
// its media query picks one, and it lays its own opaque page under the tint, so a wrong guess still pairs the text
// with its backing. The terminal picks by isLight
type Scheme = { page: string; ink: string; dim: string; gutter: string; more: string; word: Record<AgentRun['state'], string> }
const SCHEMES: Record<'dark' | 'light', Scheme> = {
  dark: { page: '#1F1E1D', ink: '#F0EEFC', dim: '#A7A5AE', gutter: '#A8A69E', more: '#9A9993', word: { running: '#9C85D8', waiting: '#C0883B', done: '#4FA569', error: '#D67278' } },
  light: { page: '#FFFFFF', ink: '#222226', dim: '#5B5B5E', gutter: '#5F5E59', more: '#6F6D66', word: { running: '#6A4DB2', waiting: '#905300', done: '#157632', error: '#B13038' } },
}

// the desktop drops an Svg whose alt is empty, so every drawing says what it shows
function stripAlt(p: Plan, key: string): string {
  const a = (p.agents ?? []).find(x => x.id === key)
  return a ? `agent ${a.title}: ${a.state}, ${toolWord(a.tool)}` : 'more agents'
}

// the hover layer's words: what its tips show, the time the latest finished steps took, for a person who hears the
// band instead of pointing at its marks
function timesAlt(p: Plan): string {
  const last = [...stepTimes(p).steps].sort(([a], [b]) => (a.doneAt ?? 0) - (b.doneAt ?? 0)).slice(-3)
  if (last.length) return `${p.title}: ${last.map(([st, ms]) => `${st.title} took ${elapsed(ms)}`).join(', ')}`
  // steps sent finished, a bar closed by its state, the Agents bar's agents: finished, with no time to read
  const steps = p.stages.flatMap(s => s.steps)
  const ended = p.state === 'done' ? steps.length : steps.filter(st => isFinished(st.status)).length
  return `${p.title}: ${ended ? `${ended} of ${plural(steps.length, 'step')} finished, no times` : 'no step finished yet'}`
}

// an unfinished bar stops at 99%: 199 of 200 steps would otherwise round up to 100%
function percent(p: Plan, w: { pos: number; total: number }): number {
  if (p.state === 'done') return 100
  return Math.min(99, Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100))
}

const elapsed = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  return sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

// which strips show: all of a small batch; in a big one the unfinished first, the rest folded into one line
function visibleAgents(p: Plan, now: number, max: number): { shown: AgentRun[]; hidden: AgentRun[] } | null {
  const list = p.agents ?? []
  if (list.length === 0) return null
  const hasError = list.some(a => a.state === 'error')
  if (p.agentsDoneAt && now - p.agentsDoneAt > FOLD_MS && !hasError) return null
  if (list.length <= max) return { shown: list, hidden: [] }
  const keep = new Set(list.filter(a => a.state !== 'done').slice(0, max - 1).map(a => a.id))
  for (const a of [...list].reverse()) {
    if (keep.size >= max - 1) break
    keep.add(a.id)
  }
  return { shown: list.filter(a => keep.has(a.id)), hidden: list.filter(a => !keep.has(a.id)) }
}

// the strips drawn under a bar: none while the person has folded them away (the pill does not count them either)
const shownAgents = (p: Plan, now: number, max: number) => (p.isFolded ? null : visibleAgents(p, now, max))
// a bar gets a fold button while it has strips to show or fold; folded with none left (the batch over, or after a
// restart) it keeps the choice for its next agents but shows no button that would do nothing
const canFold = (p: Plan, now: number, max: number) => visibleAgents(p, now, max) !== null

// what each strip showed last time it was drawn, so a change morphs from the old status instead of jumping
const lastStrip = new Map<string, { tool: string; color: string; state: AgentRun['state'] }>()
const MORPH = '.2s'
const MORPH_MS = 200

// a strip's markup per agent, with what it showed: drawn once per change and reused while the agent stays the same.
// The desktop rebuilds a strip on every redraw of the band, so a morph begins where its time has got to ({{T:at}},
// as the glide does), and until says when it has run: the next draw after that is the strip standing, without it.
// Kept by the agent's id, as $.state hands back a fresh copy of every agent on each read
const drawnRows = new Map<string, { key: string; html: string; until: number }>()


// whether a drawing below the bars shows anything: an empty Box or blank text would only add the gap under them. A Box
// that draws by itself (a border, a background, a height it keeps) shows without children, as another mod's divider
// does, and stays under the bars (issue #15)
type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | null | undefined
const hasContent = (n: unknown): boolean => {
  if (n === null || n === undefined || n === false) return false
  if (typeof n === 'string') return n.trim() !== ''
  if (Array.isArray(n)) return n.some(hasContent)
  const el = n as Exclude<Drawn, string | null | undefined>
  const props = el.props ?? {}
  if (el.type === 'Box' && (props.borderStyle || props.backgroundColor || Number(props.height) > 0 || Number(props.minHeight) > 0)) return true
  if (el.type === 'Box' || el.type === 'Text' || el.type === undefined) return (el.children ?? []).some(hasContent)
  return true
}

// tokens per second, the clean figure: the speed of one stream, the main conversation's. Agents stream on models of
// their own at the same time, and adding them up would count parallel work as speed.
// The figure is an average over time, not of speeds: all the tokens of the last minute of writing over that minute,
// so a long response weighs as long as it took and a burst of a short one cannot swing it. Each finished response adds
// its exact share: the API's output_tokens, and the time from its first piece of any kind to its stop (the wait before
// it starts is left out; thinking arrives as empty pieces but is written, so it is in), less the time a tool the API
// ran itself inside it (the advisor) kept it waiting. The response being written adds
// what its visible text and tool arguments come to so far, in tokens at the ratio finished responses showed, over the
// time they took; while it thinks out of sight it adds nothing until it stops. Another model starts the average over
const HISTORY_MS = 60_000
const SHOW_EVERY_MS = 1000
// a second with no visible piece while the response streams is a wait, on a tool the API runs itself (the advisor) or
// the network, not writing: its stretch ends at the last piece, and the figure dims until the response writes again
const WAIT_MS = 1000
type Timed = { tokens: number; ms: number }
type Meter = {
  first: number | null
  // since when the response has written visible pieces only: null while it thinks, or before it wrote any
  visibleFrom: number | null
  // the visible time and characters of its visible stretches before the current one
  visibleMs: number
  visibleChars: number
  // the characters of the current stretch after its first piece, which was written before the stretch's clock started
  stretchChars: number
  lastVisible: number
  chars: number
  hasThought: boolean
  shownAt: number
  shown: string
  // the latest piece of any kind, and where the response's clock starts over: a retry marker (a 529 or 429 retried
  // inside the step) comes before the backoff and the new request's wait, which are no writing
  last: number
  restart: number | null
}
// the footer's figure as last written, whichever response wrote it: each write redraws the footer, and the desktop
// builds the band anew with it, so the next response does not write the same figure again, and the live figure is
// written at most once a second across responses. A response's final figure goes at once
const lastSpeed = { label: '', at: -Infinity }
// the latest minute of finished responses on one model
let history: Timed[] = []
let historyModel = ''
function remember(model: string, done: Timed) {
  if (model !== historyModel) {
    history = []
    historyModel = model
  }
  history.push(done)
  let total = history.reduce((sum, h) => sum + h.ms, 0)
  while (history.length > 1 && total - (history[0]?.ms ?? 0) >= HISTORY_MS) total -= history.shift()?.ms ?? 0
}
// all the tokens over all the time, the response in progress included; none before a second of it
function average(model: string, now: Timed = { tokens: 0, ms: 0 }): number | null {
  const past = model === historyModel ? history : []
  const ms = past.reduce((sum, h) => sum + h.ms, now.ms)
  const tokens = past.reduce((sum, h) => sum + h.tokens, now.tokens)
  return ms >= 1000 ? tokens / (ms / 1000) : null
}
// what a visible character of the session's finished responses was worth, the latest few: each one the factor that
// made the live estimate read that response's exact rate. Taken by time, not as tokens over characters: a response
// that calls a tool pays ~120 tokens no character shows, which on a short one would count every character high. The
// lower median, as a long response is worth less per character than the short ones around it
const ratios: number[] = []
const tokensPerChar = () => {
  if (ratios.length === 0) return 1 / 3.6
  const sorted = [...ratios].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 1 / 3.6
}
// what a visible piece adds to the response's output: its text, a tool call's arguments, the tool's name
const pieceSize = (c: TurnStepChunk) => (c.kind === 'text' ? c.text.length : c.kind === 'input' ? c.json.length : c.kind === 'tool' ? c.name.length : 0)
const newMeter = (): Meter => ({
  first: null,
  visibleFrom: null,
  visibleMs: 0,
  visibleChars: 0,
  stretchChars: 0,
  lastVisible: 0,
  chars: 0,
  hasThought: false,
  shownAt: 0,
  shown: '',
  last: 0,
  restart: null,
})
// a visible stretch ends at its last piece: its time and characters join those before it
function endStretch(m: Meter) {
  if (m.visibleFrom === null) return
  m.visibleMs += m.lastVisible - m.visibleFrom
  m.visibleChars += m.stretchChars
  m.visibleFrom = null
  m.stretchChars = 0
}
const isWaiting = (m: Meter, t: number) => m.visibleFrom !== null && t - m.lastVisible >= WAIT_MS
// a piece arrives: the first of any kind starts the response's clock; thinking, or a wait before it, closes a visible
// stretch
function see(m: Meter, c: TurnStepChunk, t: number) {
  if (m.first === null) m.first = t
  // an engine piece a second or more after the last one, before anything was written or thought: a retried request
  else if (c.kind === 'engine' && m.chars === 0 && !m.hasThought && t - m.last >= WAIT_MS) m.restart = t
  m.last = t
  if (isWaiting(m, t)) endStretch(m)
  if (c.kind === 'thinking') {
    m.hasThought = true
    endStretch(m)
    return
  }
  const n = pieceSize(c)
  if (n === 0) return
  m.chars += n
  m.lastVisible = t
  if (m.visibleFrom === null) m.visibleFrom = t
  else m.stretchChars += n
}
// the response so far, as far as it can be measured: its visible stretches, in estimated tokens over their time
const sofar = (m: Meter, t: number): Timed => ({
  tokens: (m.visibleChars + m.stretchChars) * tokensPerChar(),
  ms: m.visibleMs + (m.visibleFrom === null ? 0 : t - m.visibleFrom),
})
// the response is whole: its exact share of the average, and what its visible characters were worth for the live
// estimate. One of under a second is too short to time cleanly and is left out. A clock started over by a retry is not
// taken when the API ran tools itself: their wait is taken off already, and a first one shows as such a gap too
function finish(m: Meter, model: string, outputTokens: number, t: number, hasServerTools = false) {
  if (m.first === null) return
  const ms = t - (m.restart !== null && !hasServerTools ? m.restart : m.first)
  endStretch(m)
  const perChar = m.visibleMs >= 1000 && m.visibleChars >= 200 && ms >= 1000 ? outputTokens / ms / (m.visibleChars / m.visibleMs) : 0
  if (perChar >= 0.1 && perChar <= 1) {
    ratios.push(perChar)
    if (ratios.length > 12) ratios.shift()
  }
  if (ms >= 1000 && outputTokens >= 20) remember(model, { tokens: outputTokens, ms })
}
// the footer's settings control on the desktop: ⚙ asked for in its text form (U+FE0E), one colour with the chip the
// desktop draws a footer Button as, where a font might pick a coloured emoji. The footer draws no pictures, only text
// and Buttons, so an icon there is a character
const GEAR_TEXT = '⚙\uFE0E'
// a newer release out: a blue mark in the ⚙ Button. The desktop draws a footer Button's label alone, in the chip's grey,
// puts the Buttons before the text and squeezes the whole to 3ch when the footer is short of room, so only the chip is
// sure to show: there the mark is an emoji in the label, which keeps its own colour (a small blue diamond). The
// terminal draws a Button's children, so there it is a ● in the accent colour
const GEAR_NEWS = '⚙\uFE0E \u{1F539}'
const speedLabel = (s: Speed) => `⚡ ${(s.rate === null ? '–' : s.rate < 10 ? s.rate.toFixed(1) : String(Math.round(s.rate))).padStart(3, FIGURE_SPACE)} tok/s`

// one tinted strip per agent: state colour, name, what it does now and for how long; not a progress bar
// Lucide "bot", drawn at 12 px in the gutter before each strip
const BOT = '<rect width="16" height="12" x="4" y="8" rx="2"/><path d="M12 8V4H8M2 14h2M20 14h2M15 13v2M9 13v2"/>'

// the desktop's fold control: Lucide "chevron-up" (fold) or "chevron-down" (show); a Button's label is text only, so
// the picture is centred in the cell and a blank Button over it, centred the same way, takes the presses and draws its
// own hover and focus ring around it (a picture laid over the Button would take the pointer)
const FOLD_W = 16
const FOLD_H = 16
const foldChip = (isFolded: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${FOLD_W}" height="${FOLD_H}" viewBox="0 0 ${FOLD_W} ${FOLD_H}"><style>.fc{stroke:#C2C0B6}` +
  `@media (prefers-color-scheme:light){.fc{stroke:#3D3D3A}}</style>` +
  `<g transform="translate(${(FOLD_W - 16) / 2} ${(FOLD_H - 16) / 2}) scale(${16 / 24})" fill="none" class="fc" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="${isFolded ? 'm6 9 6 6 6-6' : 'm18 15-6-6-6 6'}"/></g></svg>`

// claude-haiku-4-5-20251001 -> haiku 4.5, claude-sonnet-4-20250514 -> sonnet 4 (a date is no minor version); an
// alias stays as given
const modelName = (m: string) => {
  const r = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(m)
  return r ? `${r[1]} ${r[2]}${r[3] ? '.' + r[3] : ''}` : m
}

// an MCP tool's wire name is mcp__<server>__<tool>; the server part is the same on every call, so only the tool
// part says what the agent does
const toolWord = (tool: string) => /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool

// the agent's name, its model and effort in a dimmer parenthesis; the parenthesis starts where the title ends,
// since a title may hold a " (" of its own
const nameMarkup = (name: string, at: number) =>
  at > 0 && name.startsWith(' (', at) ? `${esc(name.slice(0, at))}<tspan class="st">${esc(name.slice(at))}</tspan>` : esc(name)

// one tinted strip per agent behind a bot icon and its number: the colour says how it went,
// the word says what it does now (only while it runs or waits), the time how long it took
type StripRow = { key: string; html: string; height: number; until: number }

// each strip is its own drawing, so a change to one agent redraws that strip alone, never the bar or the others
function stripsSvg(v: { shown: AgentRun[]; hidden: AgentRun[] }, all: AgentRun[], W: number, now: number): StripRow[] {
  const isNarrow = W < NARROW
  // the icon and the widest number, left of the strips: as wide as the numbers need, so the strips sit close to them
  const widest = Math.max(1, ...v.shown.map(a => String(all.indexOf(a) + 1).length), v.hidden.length > 0 ? String(v.hidden.length).length + 1 : 0)
  const GUTTER = Math.round(16 + widest * 6.4 + 7)
  const SW = W - GUTTER
  const R = STRIP_H / 2
  // a dot shows only where all of it lies inside the rounded strip, so none pokes past the round ends
  const isInside = (x: number, y: number) => {
    const cx = Math.max(GUTTER + R, Math.min(GUTTER + SW - R, x))
    return Math.hypot(x - cx, y - R) <= R - 0.5
  }
  const dotFits = (x: number, y: number) => isInside(x, y) && isInside(x + 2, y) && isInside(x, y + 2) && isInside(x + 2, y + 2)
  const rows: StripRow[] = []
  // the icon and number take their colour from the scheme's class (gu for an agent, gm for the more line)
  const gutter = (y: number, label: string, cls: string) =>
    `<g class="${cls}"><g transform="translate(1 ${y + 2}) scale(.5)" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${BOT}</g>` +
    `<text x="16" y="${y + 11.5}" class="sn sg">${label}</text></g>`
  // the scheme's page under a tint, so the tint and the text over it look the same on any background; drawn first, so
  // a "+N" wider than the gutter still shows whole
  const backing = (y: number) => `<rect class="sb" x="${GUTTER}" y="${y}" width="${SW}" height="${STRIP_H}" rx="${STRIP_H / 2}"/>`
  v.shown.forEach((a, i) => {
    // the first strip keeps a little room from the track above it
    const y = i === 0 ? 5 : STRIP_GAP
    const rowKey = `${W}|${y}|${GUTTER}|${all.indexOf(a)}|${JSON.stringify(a)}`
    const cachedRow = drawnRows.get(a.id)
    if (cachedRow?.key === rowKey && (cachedRow.until === 0 || now < cachedRow.until)) {
      rows.push({ key: a.id, html: cachedRow.html, height: y + STRIP_H, until: cachedRow.until })
      return
    }
    const c = agentColor(a.state)
    const indent = a.depth > 0 ? 10 : 0
    // the tool word takes at most a quarter of the row, as in the terminal, so a long one never runs over the name
    let word = a.state === 'running' || a.state === 'waiting' ? toolWord(a.tool) : ''
    if (textWidth(word, 6.2) > W * 0.25) {
      while (word.length > 1 && textWidth(word + '…', 6.2) > W * 0.25) word = dropLast(word)
      word = word.trimEnd() + '…'
    }
    const dots = new Map<string, string>()
    if (a.state === 'running') {
      for (let col = 0; col * 3 < SW; col++) {
        for (let r = 0; r < 4; r++) {
          const dy = Math.round((2.5 + r * 3.2) * 10) / 10
          if (hash(col + i * 41, r, 5) > 0.2 || !dotFits(GUTTER + col * 3, dy)) continue
          addDot(dots, `t${Math.floor(hash(col, r, 6) * 4)}`, GUTTER + col * 3, Math.round((y + dy) * 10) / 10)
        }
      }
    }
    const px = [...dots].map(([cls, d]) => `<path class="${cls}" fill="${c}" fill-opacity=".32" d="${d}"/>`).join('')
    // a status change: the old word blurs out while the new one blurs in, and the tint flows to the new colour
    const was = lastStrip.get(a.id)
    lastStrip.set(a.id, { tool: word, color: c, state: a.state })
    const isWordChanged = was !== undefined && was.tool !== word
    const begin = `-{{T:${Math.round(now)}}}s`
    const flow = was && was.color !== c ? `<animate attributeName="fill" from="${was.color}" to="${c}" dur="${MORPH}" begin="${begin}" fill="freeze"/>` : ''
    const delay = ` style="animation-delay:${begin}"`
    const until = isWordChanged || flow ? now + MORPH_MS : 0
    // the tool word sits at the right, just before the clock, so the name and its model get the rest of the row
    const toolEnd = W - 9 - CLOCK_W - 10
    const wordW = Math.max(word ? textWidth(word, 6.2) : 0, isWordChanged && was.tool ? textWidth(was.tool, 6.2) : 0)
    const nameX = GUTTER + 19 + indent
    const nameRoom = isNarrow ? SW - 24 - indent : toolEnd - (wordW > 0 ? wordW + 12 : 0) - nameX
    const spec = [a.model ? modelName(a.model) : '', a.effort ?? ''].filter(Boolean).join(' · ')
    const title = (a.depth > 0 ? '↳ ' : '') + a.title
    const full = title + (spec ? ` (${spec})` : '')
    const name = fitStrip(full, nameRoom)
    const time =
      a.endedAt === null
        ? liveClock(W - 9 - CLOCK_W, y, a.startedAt, 'sc', 'sn st')
        : `<text x="${W - 9}" y="${y + 11.5}" text-anchor="end" class="sn st">${elapsed(a.endedAt - a.startedAt)}</text>`
    const tool = isNarrow
      ? ''
      : (isWordChanged && was.tool ? `<text x="${toolEnd}" y="${y + 11.5}" text-anchor="end" class="sn mo w-${was.state}"${delay}>${esc(was.tool)}</text>` : '') +
        (word ? `<text x="${toolEnd}" y="${y + 11.5}" text-anchor="end" class="sn w-${a.state}${isWordChanged ? ' mi' : ''}"${isWordChanged ? delay : ''}>${esc(word)}</text>` : '') +
        time
    const html =
      backing(y) +
      gutter(y, String(all.indexOf(a) + 1), 'gu') +
      withStill((anim, cls) => `<rect${classAttr(cls)} x="${GUTTER}" y="${y}" width="${SW}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="${c}" fill-opacity=".15">${anim}</rect>`, flow) +
      px +
      withStill((anim, cls) => `<circle cx="${GUTTER + 10 + indent}" cy="${y + STRIP_H / 2}" r="3" fill="${c}"${classAttr([a.state === 'running' ? 'sd' : '', cls].filter(Boolean).join(' '))}>${anim}</circle>`, flow) +
      `<text x="${nameX}" y="${y + 11.5}" class="sn">${nameMarkup(name, title.length)}</text>` +
      tool
    drawnRows.set(a.id, { key: rowKey, html, until })
    rows.push({ key: a.id, html, height: y + STRIP_H, until })
  })
  if (v.hidden.length > 0) {
    const y = v.shown.length === 0 ? 5 : STRIP_GAP
    const doneCount = v.hidden.filter(a => a.state === 'done').length
    const more = plural(v.hidden.length, 'more agent')
    const moreText = stripW(`${more} · ${doneCount} done`) <= SW - 14 ? `${more} · ${doneCount} done` : fitStrip(more, SW - 14)
    rows.push({
      key: '+',
      height: y + STRIP_H,
      until: 0,
      html:
        backing(y) +
        gutter(y, `+${v.hidden.length}`, 'gm') +
        `<rect x="${GUTTER}" y="${y}" width="${SW}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="#808080" fill-opacity=".14"/>` +
        `<text x="${GUTTER + 10}" y="${y + 11.5}" class="sn st">${esc(moreText)}</text>`,
    })
  }
  return rows
}

// a scheme's colours as the strip's classes; in the stylesheet the light set follows the dark one, so it wins where
// its query holds, and the dim and tool word follow the name they colour over
const schemeCss = (s: Scheme) =>
  `.sb{fill:${s.page}}.sn{fill:${s.ink}}.st{fill:${s.dim}}.gu{color:${s.gutter}}.gm{color:${s.more}}` +
  Object.entries(s.word).map(([state, c]) => `.w-${state}{fill:${c}}`).join('')
const STRIP_TWINKLE = `.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite}.t1{animation-duration:2.8s;animation-delay:-.7s}.t2{animation-duration:1.9s;animation-delay:-1.3s}.t3{animation-duration:3.3s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}
`
const stripStyle = (twinkle: string) => `<style>.sn{font:400 11.5px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}.sg{font-weight:500;font-variant-numeric:tabular-nums}
${schemeCss(SCHEMES.dark)}@media (prefers-color-scheme:light){${schemeCss(SCHEMES.light)}}.gu .sn,.gm .sn{fill:currentColor}
.sd{animation:sp 1.1s ease-in-out infinite}@keyframes sp{50%{opacity:.3}}
.mi{animation:mi ${MORPH} ease-out both}@keyframes mi{from{opacity:0;filter:blur(3px)}}
.mo{animation:mo ${MORPH} ease-in both}@keyframes mo{to{opacity:0;filter:blur(3px)}}
${twinkle}${CLOCK_CSS}
${STILL_CSS}@media (prefers-reduced-motion:reduce){.sd,.mi,.mo,.t0,.t1,.t2,.t3{animation:none}.mo{opacity:0}${STILL_REDUCED}}</style>`
const STRIP_STYLE = stripStyle(STRIP_TWINKLE)
const STRIP_STILL = stripStyle('')

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

const DEFAULT = 0x01000000
let isLight = false
const termBg = () => omarchy?.background ?? (isLight ? [255, 255, 255] : [24, 24, 27])
const termFg = () => omarchy?.foreground ?? (isLight ? [34, 34, 38] : [240, 238, 252])
const scheme = () => SCHEMES[isLight ? 'light' : 'dark']
const pack = (c: number[]) => ((c[0] ?? 0) << 16) | ((c[1] ?? 0) << 8) | (c[2] ?? 0)
// a Raster cell takes one printable BMP character exactly one column wide, as the engine measures it
// (Bun.stringWidth, ambiguous narrow); any other character refuses the whole tree and every bar vanishes.
// NOT_ONE lists the printable BMP characters whose width is not one, as base-36 "start-extra" ranges
const NOT_ONE = '4t,lc-33,w3-6,13l-18,14v,14x-1,150-1,153,16o-5,174-a,17g,18r-k,19s,1cm-7,1cv-5,1d3-1,1d6-3,1e7,1e9,1f4-q,1ie-a,1kb-8,1kt,1li-3,1ln-8,1lx-2,1m1-4,1nd-2,1p3-8,1qi-1k,1tm-2,1tq-f,1u9-6,1uq-1,1vk-2,1x6-2,1xa-f,1xt-6,1ya-1,1z2,1z4-2,20q-2,20u-f,21d-6,21u-1,228-1,22d,22o-2,24a-2,24e-f,24x-6,25e-1,262-8,27u-2,27y-f,28h-6,28y-1,29s-2,2be-2,2bi-f,2c1-6,2ci-1,2dc-2,2dg,2ey-2,2f2-f,2fl-6,2g2-1,2gw-2,2ii-2,2im-f,2j5-6,2jm-1,2kg-2,2m2-2,2m6-f,2n6-1,2o1,2q2,2qa-2,2qe,2sx,2t0-6,2tj-7,2wh,2wk-8,2x4-6,2zc-1,305,307,309,31t-d,328-4,32e-1,32l-a,32x-z,346,371-3,376-5,37d-1,37h-1,388-1,38e-2,38x-3,39e,39h-1,39p,3a5,3cw-73,3tp-2,4k2-2,4ky-1,4lu-1,4mq-1,4ok-1,4on-6,4p2,4p5-a,4pp,4qz-4,4ud-1,4vd,4yo-2,4yv-1,4z6,4zd-2,55j-1,55n,57a,57c-6,57k,57m,57p-7,583-9,58f,59s-2b,5dg,5di-4,5do,5du,5ez-8,5fk-1,5gi-3,5go-1,5gr-2,5ie,5ig-1,5il,5in-2,5kc-7,5km-1,5ow-2,5p0-c,5pe-6,5pp,5pw,5q0-1,5vk-1r,6bv-4,6cq-4,6e8-f,6hc-1b,6xm-1,6y1-1,73d-3,73k,73n,7i5-1,7is-1,7jk-7,7k8-b,7lr,7m2-5,7mb,7mp,7my-1,7nh-1,7no-1,7ny,7o4,7oq,7oy-1,7p1,7p6,7p9,7ph,7pm-1,7qg,7rg,7ri,7rn-2,7rr,7th-2,7u8,7un,8ij-1,8k0,8k5,8vj-2,8zj,928-v,96o-p,97f-2g,9a8-5x,9gw-26,9j5-2d,9ll-2u,9ol-16,9pt-2l,9sg-2d,9v3-1b,9wg-13,9xs-mkc,wi8-1i,wvj-3,wvo-9,wwu-1,wz4-1,x6q,x6u,x6z,x7p-1,x7w,xc4-1,xcw-h,xdr,xeu-7,xfr-a,xgg-s,xhc-2,xir,xiu-3,xj0-1,xk5,xm1-5,xm9-1,xmd-1,xmr,xn0,xoc,xps,xpu-2,xpz-1,xq6-1,xq9,xrg-1,xrq,xyd,xyg,xyl,xz4-8mb,16ls-27,1d6o-e7,1dlq,1e68-p,1e74-1e,1e8k-i,1e94-3,1edb,1edd-2n,1ejk-6'
const notOne = NOT_ONE.split(',').map(r => {
  const [a = '0', n] = r.split('-')
  const from = parseInt(a, 36)
  return [from, from + (n ? parseInt(n, 36) : 0)] as const
})
function isNotOne(cp: number) {
  let lo = 0
  let hi = notOne.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [from, to] = notOne[mid] ?? [0, 0]
    if (cp < from) hi = mid - 1
    else if (cp > to) lo = mid + 1
    else return true
  }
  return false
}
// marks and format characters (accents written apart, variation selectors, joiners, soft hyphens) take no cell
// of their own and go; anything else that cannot fill exactly one cell is drawn as a middle dot
const cellChar = (ch: string) => {
  if (/\p{M}|\p{Cf}/u.test(ch)) return ''
  const cp = ch.codePointAt(0) ?? 63
  const isControl = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
  return isControl || cp > 0xffff || (cp >= 0xd800 && cp <= 0xdfff) || isNotOne(cp) ? '·' : ch
}
// an emoji sequence (a variation selector, a keycap, joined people, a skin tone, a flag) is one picture two columns
// wide, so it is found a grapheme cluster at a time; everything else is measured a character at a time, as the
// engine measures it, since a cluster of letters (a Hindi conjunct, Thai SARA AM) is several columns
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const clusters = (s: string): string[] => (segmenter ? Array.from(segmenter.segment(s), x => x.segment) : [...s])
const isEmojiCluster = (c: string) =>
  /\u20E3|\p{Regional_Indicator}/u.test(c) ||
  (/\p{Extended_Pictographic}/u.test(c) && (/[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/u.test(c) || (c.codePointAt(0) ?? 0) > 0xffff))
// the cells a string takes inside a Raster: a dot for an emoji sequence, each other character as cellChar draws it
const cellText = (s: string) => clusters(s).map(c => (isEmojiCluster(c) ? '·' : [...c].map(cellChar).join(''))).join('')
const cellsOf = (s: string) => [...cellText(s)].length
// the columns one character takes as plain Text: none for marks, format and control characters and the vowel and
// final jamo of a Hangul syllable written apart; two for wide ones, and for any character beyond the basic plane
// but mathematical letters (a guess too wide only pads the title box, one too narrow cuts the title)
function charColumns(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (/\p{M}|\p{Cf}/u.test(ch) || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0
  if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return 0
  if (cp > 0xffff) return cp >= 0x1d400 && cp <= 0x1d7ff ? 1 : 2
  return isNotOne(cp) ? 2 : 1
}
// the columns a string takes as plain Text, where the terminal draws a wide character (CJK, emoji) over two
const columnsOf = (s: string) => clusters(s).reduce((w, c) => w + (isEmojiCluster(c) ? 2 : [...c].reduce((n, ch) => n + charColumns(ch), 0)), 0)
const fit = (s: string, w: number) => {
  const chars = [...cellText(s)]
  if (chars.length <= w) return chars.join('')
  return w <= 1 ? '…'.slice(0, w) : chars.slice(0, w - 1).join('').trimEnd() + '…'
}

type Cell = [number, number, number]

class Grid {
  cells: Cell[]
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: columns * rows }, () => [32, DEFAULT, DEFAULT] as Cell)
  }
  set(x: number, y: number, ch: string | number, fg: number, bg: number) {
    if (x < 0 || x >= this.columns || y < 0 || y >= this.rows) return
    this.cells[y * this.columns + x] = [typeof ch === 'number' ? ch : (ch.codePointAt(0) ?? 32), fg, bg]
  }
  bg(x: number, y: number) {
    return this.cells[y * this.columns + x]?.[2] ?? DEFAULT
  }
  text(x: number, y: number, s: string, fg: number, bg?: number) {
    let i = 0
    for (const ch of cellText(s)) {
      this.set(x + i, y, ch, fg, bg ?? this.bg(x + i, y))
      i++
    }
    return i
  }
  encode() {
    const words = new Uint32Array(this.cells.length * 3)
    this.cells.forEach((c, i) => words.set(c, i * 3))
    return (new Uint8Array(words.buffer) as Uint8Array & { toBase64: () => string }).toBase64()
  }
}

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

function pill(g: Grid, y: number, from: number, to: number, bgAt: (x: number) => number[]) {
  for (let x = from; x < to; x++) g.set(x, y, ' ', DEFAULT, pack(bgAt(x)))
}

const LEVELS = 8
const q = (m: number) => Math.round(Math.max(0, Math.min(1, m)) * LEVELS) / LEVELS
const wave = (t: number, periodMs: number, offset = 0) => 0.5 + 0.5 * Math.sin(((t / periodMs) + offset) * Math.PI * 2)
const easeOut = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 4)

const glide = new Map<string, { from: number; to: number; at: number; W: number }>()
const GLIDE_MS = 450
// the twinkle moment of each bar's last moving frame, kept while it stands still
const stillPhase = new Map<string, number>()

// a head glides to a new place only while frames can carry the glide; otherwise it is drawn there at once. Its place
// is in cells of one width: at another (a narrower window, a longer title beside it) it would glide in from the wrong
// place, so it is drawn at the new one at once
function headAt(id: string, target: number, t: number, W: number, canGlide: boolean): number {
  const g = glide.get(id)
  if (!g || g.W !== W || (!canGlide && Math.abs(g.to - target) > 0.01)) {
    glide.set(id, { from: target, to: target, at: t, W })
    return target
  }
  const cur = g.from + (g.to - g.from) * easeOut((t - g.at) / GLIDE_MS)
  if (Math.abs(g.to - target) > 0.01) {
    glide.set(id, { from: cur, to: target, at: t, W })
    return cur
  }
  return cur
}


function trackCells(p: Plan, W: number, t: number): string {
  const g = new Grid(W, 1)
  const w = atHead(p)
  const done = p.state === 'done'
  const target = (done ? 1 : Math.min(1, w.pos / Math.max(1, w.total))) * W
  // after the turn a change lands at once: a glide would keep frames going through the engine's end-of-turn redraw
  const fx = headAt(p.id, target, t, W, isTurnLive || hasRunningAgents(p))
  // only a moving bar twinkles with the clock; one that stands still keeps the twinkle of its last frame, so a
  // redraw (the end of a turn is one) rewrites none of its cells, even right after it stopped moving
  const phase = isAnimated(p, t) ? t : (stillPhase.get(p.id) ?? 0)
  stillPhase.set(p.id, phase)
  const back = termBg()
  const acc = hex(stateColor(p.state))
  const light = mix(acc, [255, 255, 255], 0.35)
  const grey = [120, 118, 128]
  const track = mix(back, [128, 128, 128], isLight ? 0.14 : 0.18)
  const fill = mix(track, acc, done ? 0.3 : 0.17)
  const under = (x: number) => (x + 0.5 < fx ? fill : track)
  pill(g, 0, 0, W, under)

  const TWINKLE = done ? [3200, 3800, 4400, 3500] : [2200, 2800, 1900, 3300]
  const DELAY = [0, 700, 1300, 400]
  const dim = done ? 0.2 : 0.55
  for (let col = 0; col < Math.min(W, Math.ceil(fx)); col++) {
    const u = Math.min(1, (col + 0.5) / Math.max(1, fx))
    const dense = done ? 0.8 : 0.22 + 0.78 * Math.pow(u, 1.5)
    let bits = 0
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) {
        const sx = col * 2 + c
        if (sx / 2 >= fx || hash(sx, r, 1) > dense * 0.6) continue
        bits |= BRAILLE_BITS[r]?.[c] ?? 0
      }
    }
    if (bits === 0) continue
    const cls = Math.floor(hash(col, 0, 2) * 4)
    const period = TWINKLE[cls] ?? 2200
    const blink = 1 - dim * (isTwinkling ? wave(phase + (DELAY[cls] ?? 0), period, 0.25) : 0.5)
    const bucket = done ? 1 : q(Math.min(1, Math.pow(u, 0.9) * 1.1))
    const tone = mix(grey, light, bucket)
    const opacity = (0.35 + 0.65 * dense) * blink
    g.set(col, 0, 0x2800 + bits, pack(mix(fill, tone, q(opacity))), pack(fill))
  }

  let k = 0
  p.stages.forEach(s => {
    if (k > 0) {
      const x = Math.round((k / w.total) * W)
      if (x > 0 && x < W - 1) {
        const passed = x < fx - 0.5
        // a passed boundary is bright on a dark track and dark on a light one, where the fill is pale too
        const mark = passed ? (isLight ? mix(acc, [0, 0, 0], 0.3) : mix(light, [255, 255, 255], 0.5)) : mix(track, isLight ? [0, 0, 0] : [255, 255, 255], 0.45)
        g.set(x, 0, '│', pack(mark), pack(under(x)))
      }
    }
    k += s.steps.length
  })

  const base = hex(stateColor(p.state))
  const color = base
  const single = p.stages.length === 1
  const number = single ? Math.min(w.total, w.pos + 1) : w.stage + 1
  const icon = p.state === 'done' ? '✓' : p.state === 'error' ? '✕' : p.state === 'needs_input' ? '?' : ''
  let name = ''
  let count = ''
  if (W < 28) {
    name = icon || String(number)
  } else {
    name = done ? 'Done' : single ? (p.stages[0]?.name ?? 'Tasks') : (p.stages[w.stage]?.name ?? '')
    // the pill counts steps only; the agents have their own strips under the bar
    count = p.id === AGENTS ? `${w.pos}/${w.total}` : done ? `${w.total}/${w.total}` : single ? `${number}/${w.total}` : `${w.step}/${w.stageSize}`
  }
  const lead = icon && W >= 28 ? `${icon} ` : ''
  const maxName = Math.max(3, Math.floor(W * (W < 60 ? 0.75 : 0.55)) - cellsOf(lead) - cellsOf(count) - 5)
  // the step after the stage, as on the desktop; it gives way first when the bar is short
  const stepName = W < 28 || p.id === AGENTS ? '' : pillStep(p, w)
  const stepRoom = maxName - cellsOf(name) - 3
  const step = stepName && stepRoom >= 4 ? fit(stepName, stepRoom) : ''
  const shown = lead + (step ? name : fit(name, maxName))
  // the separator is the mark the pill stands on, as on the desktop: a stage's bar at its first step, a dot past it
  const tail = step ? ` ${w.step === 1 ? '│' : '•'} ${step}` : ''
  const kw = cellsOf(shown) + cellsOf(tail) + (count ? count.length + 1 : 0) + 2
  const kx = Math.round(Math.max(0, Math.min(W - kw, fx - kw / 2)))
  const white = pack(inkOn(color))
  pill(g, 0, kx, kx + kw, () => color)
  let at = kx + 1
  at += g.text(at, 0, shown, white, pack(color))
  // the separator in the text's own colour: every cell of the pill reads at AA
  if (tail) at += g.text(at, 0, tail, white, pack(color))
  if (count) g.text(at + 1, 0, count, white, pack(color))
  return g.encode()
}

function stripCells(v: { shown: AgentRun[]; hidden: AgentRun[] }, W: number, now: number): { cells: string; rows: number } {
  const rows = v.shown.length + (v.hidden.length > 0 ? 1 : 0)
  const g = new Grid(W, rows)
  const back = termBg()
  const text = pack(termFg())
  v.shown.forEach((a, y) => {
    const c = hex(agentColor(a.state))
    const tint = mix(back, c, 0.18)
    pill(g, y, 0, W, () => tint)
    const running = a.state === 'running' || a.state === 'waiting'
    if (running) {
      for (let col = 1; col < W - 1; col++) {
        let bits = 0
        let glow = 0
        for (let r = 0; r < 4; r++) {
          for (let cc = 0; cc < 2; cc++) {
            const sx = col * 2 + cc + y * 83
            if (hash(sx, r, 5) >= 0.08) continue
            const b = 1 - 0.55 * (isTwinkling ? wave(now, 1900 + hash(sx, r, 6) * 1400, hash(sx, r, 7)) : 0.5)
            bits |= BRAILLE_BITS[r]?.[cc] ?? 0
            glow = Math.max(glow, b)
          }
        }
        if (bits) g.set(col, y, 0x2800 + bits, pack(mix(tint, c, 0.2 + 0.4 * q(glow))), pack(tint))
      }
    }
    const indent = a.depth > 0 ? 2 : 0
    const dotColor = running ? mix(tint, c, 0.3 + 0.7 * q(wave(now, 1100))) : c
    g.text(2 + indent, y, '●', pack(dotColor), pack(tint))
    const time = elapsed((a.endedAt ?? now) - a.startedAt)
    const narrow = W < 30
    const tx = W - 2 - time.length
    // the tool word sits at the right, just before the time, so the name and its model get the rest of the row
    const word = narrow || !running ? '' : fit(toolWord(a.tool), Math.max(0, Math.floor(W * 0.25)))
    const toolAt = tx - 1 - word.length
    let at = 4 + indent
    const spec = [a.model ? modelName(a.model) : '', a.effort ?? ''].filter(Boolean).join(' · ')
    const title = (a.depth > 0 ? '↳ ' : '') + a.title
    const full = title + (spec ? ` (${spec})` : '')
    const name = fit(full, Math.max(3, (narrow ? W - 2 : word ? toolAt - 1 : tx - 1) - at))
    // the model and effort are drawn dimmer than the name; they start where the title ends, as a title may hold " (" too
    const titleEnd = cellText(title).length
    const cut = spec && name.startsWith(' (', titleEnd) ? titleEnd : -1
    const head = cut > 0 ? name.slice(0, cut) : name
    for (let i = -1; i < name.length + 1 && at + i < W - 1; i++) g.set(at + i, y, ' ', DEFAULT, pack(tint))
    at += g.text(at, y, head, text, pack(tint))
    const dim = pack(dimOn(tint, hex(scheme().dim)))
    if (head !== name) g.text(at, y, name.slice(head.length), dim, pack(tint))
    if (narrow) return
    if (word) {
      for (let i = -1; i <= word.length; i++) g.set(toolAt + i, y, ' ', DEFAULT, pack(tint))
      g.text(toolAt, y, word, pack(wordOn(tint, hex(a.state === 'running' && omarchy ? omarchy.accent : scheme().word[a.state]))), pack(tint))
    }
    for (let i = -1; i < time.length; i++) g.set(tx + i, y, ' ', DEFAULT, pack(tint))
    g.text(tx, y, time, dim, pack(tint))
  })
  if (v.hidden.length > 0) {
    const y = v.shown.length
    const tint = mix(back, [128, 128, 128], 0.16)
    pill(g, y, 0, W, () => tint)
    const doneCount = v.hidden.filter(a => a.state === 'done').length
    g.text(2, y, fit(`+${plural(v.hidden.length, 'more agent')} · ${doneCount} done`, W - 4), pack(dimOn(tint, hex(scheme().dim))), pack(tint))
  }
  return { cells: g.encode(), rows }
}

type Band = { requestId: string; W: number; list: readonly Plan[] }
let band: Band | null = null
let isFrameBusy = false
// a bar twinkles only while Claude works on it; one waiting on the person or left open after the turn stands still
let isTurnLive = false
let frames: { cancel: () => void } | null = null
// when the engine last refused frames of this band for good; the frames rest a second before they try again
let refusedAt: number | null = null
// refused frames in a row: one sent between a redraw and its commit is refused once and the next goes through
let refusedInRow = 0
const REFUSED_MAX = 6

const hasRunningAgents = (p: Plan) => (p.agents ?? []).some(a => a.state === 'running' || a.state === 'waiting')
const isGliding = (p: Plan, t: number) => {
  const g = glide.get(p.id)
  return g !== undefined && g.from !== g.to && t - g.at < GLIDE_MS + 100
}
// without the twinkle a running bar alone has nothing to move: a glide starts the frames itself (syncFrames after the cells)
const isAnimated = (p: Plan, t: number) => (isTwinkling && isTurnLive && p.state === 'running') || hasRunningAgents(p) || isGliding(p, t)

// the 30 fps clock runs only while a terminal band has something moving; the second timer starts and stops it
function syncFrames($: EngineInterface, now: number) {
  const isRested = refusedAt === null || now - refusedAt >= 1000
  const isWanted = band !== null && isRested && band.list.some(p => isAnimated(p, now))
  if (isWanted && !frames) frames = $.clock.every(33, () => void animate($))
  if (!isWanted && frames) {
    frames.cancel()
    frames = null
  }
}

// ---------- terminal tint ----------
// the track's light or dark tint: a theme the person picked wins; "auto", and the default "dark" inside Terminal.app
// (whose stock profiles follow macOS), take the macOS appearance. Off a Mac, "auto" takes the desktop's
// color-scheme (GNOME and the desktops that share its setting). The appearance is read only while a terminal bar
// is on screen, at most every APPEARANCE_MS, and never again once neither command is there
const APPEARANCE_MS = 5000
let themeSetting = 'dark'
let system: 'unknown' | 'mac' | 'gnome' | 'none' = 'unknown'
let termProgram = ''
let isSystemDark: boolean | null = null
let appearanceAt = -Infinity
let isProbing = false

const followsSystem = () =>
  system !== 'none' &&
  (themeSetting === 'auto' || (themeSetting === 'dark' && (system === 'unknown' || (system === 'mac' && termProgram === 'Apple_Terminal'))))
// an Omarchy theme paints the terminal itself, so its mode wins over the setting and the macOS appearance
const tintIsLight = () => (omarchy ? omarchy.isLight : followsSystem() && isSystemDark !== null ? !isSystemDark : /light/i.test(themeSetting))

// the Omarchy theme is read like the appearance: while a terminal bar is on screen, at most every APPEARANCE_MS, so a
// theme switch follows within seconds; a machine without the file (or a file without an accent) is never read again.
// A read cut short with the draw that asked for it (signal aborted) says nothing about the machine: it is tried again
const OMARCHY_COLORS = 'cat "${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/current/theme/colors.toml"'
let hasOmarchy = true
let omarchyAt = -Infinity

async function readOmarchy($: EngineInterface, now: number, signal?: AbortSignal) {
  if (!hasOmarchy || now - omarchyAt < APPEARANCE_MS) return
  omarchyAt = now
  const r = await $.process.run(['/bin/sh', '-c', OMARCHY_COLORS], { timeoutMs: 2000 }).catch(() => null)
  if (!r && signal?.aborted) return void (omarchyAt = -Infinity)
  const found = r && r.exitCode === 0 ? parseOmarchy(r.stdout) : null
  if (!found) {
    hasOmarchy = false
    omarchy = null
    return
  }
  const was = omarchy
  if (was && was.accent === found.accent && was.isLight === found.isLight && String(was.background) === String(found.background) && String(was.foreground) === String(found.foreground)) return
  omarchy = found
}

// the macOS appearance: the key is missing in light mode, so anything but "Dark" reads as light; null off a Mac
async function readMac($: EngineInterface) {
  const r = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 2000 }).catch(() => null)
  return r ? /dark/i.test(r.stdout) : null
}

// the desktop's color-scheme: 'prefer-dark' or 'prefer-light'; 'default' says nothing, so the theme setting decides
async function readGnome($: EngineInterface) {
  const r = await $.process.run(['gsettings', 'get', 'org.gnome.desktop.interface', 'color-scheme'], { timeoutMs: 2000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return undefined
  return /prefer-dark/.test(r.stdout) ? true : /prefer-light/.test(r.stdout) ? false : null
}

async function probeAppearance($: EngineInterface, now: number, signal?: AbortSignal) {
  if (isProbing || !followsSystem() || now - appearanceAt < APPEARANCE_MS) return
  isProbing = true
  appearanceAt = now
  try {
    if (system !== 'gnome') {
      const dark = await readMac($)
      if (dark !== null) {
        if (system === 'unknown') {
          const t = await $.process.run(['/bin/sh', '-c', 'printf %s "$TERM_PROGRAM"'], { timeoutMs: 2000 }).catch(() => null)
          termProgram = t?.stdout.trim() ?? ''
          system = 'mac'
        }
        isSystemDark = dark
        return
      }
    }
    const dark = await readGnome($)
    if (dark === undefined && signal?.aborted) return void (appearanceAt = -Infinity)
    if (dark === undefined) {
      // neither command: the theme setting alone decides from here on
      system = 'none'
      return
    }
    system = 'gnome'
    isSystemDark = dark
  } finally {
    isProbing = false
  }
}

async function readTint($: EngineInterface, now: number, signal?: AbortSignal) {
  await readOmarchy($, now, signal)
  if (!omarchy) await probeAppearance($, now, signal)
}

// the first terminal draw of the module's life waits for the appearance: drawn on a guess, a light terminal would show
// a dark bar until the second timer repainted it
let firstTint: Promise<void> | null = null

// reads the appearance when due and repaints the bars at once if the tint changed
async function syncTint($: EngineInterface, now: number) {
  const before = omarchy
  if (band) await readTint($, now)
  const next = tintIsLight()
  if (next === isLight && omarchy === before) return
  isLight = next
  const b = band
  if (b) await blitPlans($, b, b.list, now)
}

// what each key of the band was last sent: a frame sends only cells that changed, so a bar with nothing moving in
// its cells (a fill still empty, or all under the pill) is not blitted the same 30 times a second. A refusal forgets
// it all, so the band is painted whole again once it takes frames
let sent: { band: Band; cells: Map<string, string> } | null = null

// the size goes along, so a band redrawn at another width answers with a deny naming both sizes
function blitPlans($: EngineInterface, b: Band, list: readonly Plan[], now: number, isChangeOnly = false) {
  if (sent?.band !== b) sent = { band: b, cells: new Map() }
  const last = sent.cells
  const blit = (key: string, cells: string, rows: number) => {
    if (isChangeOnly && last.get(key) === cells) return []
    last.set(key, cells)
    return [$.ui.blit({ requestId: b.requestId, key, cells, columns: b.W, rows }).catch(() => undefined)]
  }
  return Promise.all(
    list.flatMap(p => {
      const v = shownAgents(p, now, stripBudget(b.list.length))
      const strips = v ? stripCells(v, b.W, now) : null
      return [...blit(`track-${p.id}`, trackCells(p, b.W, now), 1), ...(strips ? blit(`strips-${p.id}`, strips.cells, strips.rows) : [])]
    }),
  )
}

// blits the engine keeps refusing (the band hidden or unmounted, redrawn at another size, or its tree refused) stop
// the frames: the 1 s timer tries one frame again a second later, and a redraw lays the band out anew at once. A
// band shown again without a redraw (folded and unfolded) so comes back within a second instead of staying still
function stopFrames(b: Band, now: number) {
  if (band !== b) return
  refusedAt = now
  refusedInRow = 0
  frames?.cancel()
  frames = null
}

async function animate($: EngineInterface) {
  const b = band
  if (!b || isFrameBusy) return
  isFrameBusy = true
  try {
    const now = await $.clock.now()
    // a redraw while the clock was read laid the band out anew: this frame belongs to the old one
    if (band !== b) return
    const live = b.list.filter(p => isAnimated(p, now))
    if (live.length === 0) return
    const answers = await blitPlans($, b, live, now, true)
    if (!answers.some(a => a?.deny)) {
      refusedInRow = 0
      refusedAt = null
    } else {
      sent = null
      if (++refusedInRow >= REFUSED_MAX) stopFrames(b, now)
    }
  } finally {
    isFrameBusy = false
  }
}


// ---------- engine glue ----------

// the engine's player first (afplay on macOS); PowerShell where it cannot play
function play($: EngineInterface, name: 'decision' | 'error' | 'done') {
  // turned off in the settings window
  if (!isSoundOn) return
  const file = `${$.plugin.root}/sounds/${name}.wav`.replace(/\//g, '\\')
  // the path goes in through the environment: written into the command, a quote in it (C:\Users\O'Brien) ends the string
  const viaPowerShell = () =>
    $.process
      .run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '(New-Object Media.SoundPlayer $env:PLAN_PROGRESS_WAV).PlaySync()'], {
        env: { PLAN_PROGRESS_WAV: file },
        timeoutMs: 5000,
      })
      .catch(() => undefined)
  // on Windows the engine's player can report success and stay silent, so the system player plays it directly
  if (/^[A-Za-z]:/.test($.plugin.root)) {
    void viaPowerShell()
    return
  }
  void $.audio.play({ asset: `sounds/${name}.wav` }).catch(viaPowerShell)
}

// the agents bar is the mod's own; the model never owes it an update
const AGENTS = 'agents:auto' // slug() never yields ':', so no model id can take it
const isOpenPlan = (p: Plan) => p.id !== AGENTS && p.state === 'running' && !p.stages.flatMap(s => s.steps).every(s => isFinished(s.status))
const isAllFinished = (p: Plan) => {
  const steps = p.stages.flatMap(s => s.steps)
  return steps.length > 0 && steps.every(s => isFinished(s.status))
}

// the person answered a bar waiting on them: back to work, or done when every step already was
function answered(p: Plan, now: number): Plan {
  return isAllFinished(p) ? { ...p, state: 'done', note: null, endedAt: now } : { ...p, state: 'running', note: null }
}

// the bars the main loop itself set waiting through the tool, the call that chimed; a subagent's amber is quiet and
// not about the person's next question
const askedIds = new Set<string>()

// the task bars Claude set waiting before it asked, as its rules say; they chimed when they turned amber
async function waitingIds($: EngineInterface): Promise<string[]> {
  return (await read($, plans)).filter(p => p.id !== AGENTS && p.state === 'needs_input' && askedIds.has(p.id)).map(p => p.id)
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-/, '')
    .slice(0, 40)
    .replace(/[\uD800-\uDBFF]$/, '')
    // after the cut, which can end on a separator
    .replace(/-$/, '')

// adds or replaces one bar by id; keeps at most MAX_BARS, dropping finished ones first
// computed inside update() from the latest list, so concurrent writers (parallel agents) do not drop each other
function placeBar(list: readonly Plan[], next: Plan): Plan[] {
  const prev = list.find(p => p.id === next.id)
  // an update keeps its row and, unless it brings its own, the agent strips already on it; a new bar goes to the bottom
  // an update keeps the bar's strips and whether the person folded them; Claude moves a bar after every step
  const kept = prev && !('agents' in next) ? { ...next, agents: prev.agents, agentsDoneAt: prev.agentsDoneAt, isFolded: 'isFolded' in next ? next.isFolded : prev.isFolded } : next
  const rest = prev ? list.map(p => (p.id === next.id ? kept : p)) : [...list, next]
  // the oldest finished bar goes first, then the oldest running one a subagent made for its own work, then the oldest
  // running one of the main loop (with its strips); the bar just placed and a bar waiting on the person or showing an
  // error stay while any other can go, though the mod's own Agents bar gives way to them
  const pick = (ok: (p: Plan) => boolean) => rest.findIndex(p => p.id !== next.id && ok(p))
  while (rest.length > MAX_BARS) {
    const ownAgents = next.id === AGENTS ? rest.findIndex(p => p.id === AGENTS) : -1
    const at =
      [pick(p => p.state === 'done'), pick(p => p.state === 'running' && !!p.byAgent), pick(p => p.state === 'running'), ownAgents, pick(() => true)].find(
        i => i >= 0,
      ) ?? 0
    rest.splice(at, 1)
  }
  return rest
}

function chime($: EngineInterface, prev: PlanState | undefined, next: PlanState) {
  if (next === prev) return
  if (next === 'needs_input') play($, 'decision')
  if (next === 'error') play($, 'error')
  if (next === 'done') play($, 'done')
}

// builds a bar from the latest stored one inside update(), so back-to-back calls never work from a stale copy;
// make returns a string to refuse, and the list stays as it was
async function editPlan($: EngineInterface, id: string, make: (prev: Plan | null) => Plan | string, isQuiet = false): Promise<Plan | string> {
  let prev: Plan | undefined
  let made = '' as Plan | string
  await update($, plans, list => {
    prev = list.find(p => p.id === id)
    made = make(prev ?? null)
    return typeof made === 'string' ? [...list] : placeBar(list, made)
  })
  if (typeof made === 'string') return made
  if (!isQuiet) chime($, prev?.state, made.state)
  if (!prev) await update($, isOpen, () => true)
  return made
}

// ---------- agents: drawn from engine events alone, no model calls ----------
// each subagent lives on a bar as one state strip: the open task bar it was started under,
// the bar of its parent agent, or the mod's own "Agents" bar when no task is open.
// Module maps: a reload starts them empty; session.start finds the agents still at work again from the bars.
const agentHome = new Map<string, string>() // agentId -> bar id
// an agent's calls in flight, tool_use_id first: the tool, and whether a permission dialog for it is in front of the person.
// Kept per call, since one agent may run several calls at once and only some of them ask.
type Flight = { agentId: string; tool: string; isAsked: boolean }
const flights = new Map<string, Flight>()
let flightCount = 0
// bar id -> when its finished strips fold; each bar keeps its own, so a later batch on another bar never holds it back
const foldAt = new Map<string, number>()
// bar id -> the subagent that made it, for a bar handed to the main loop when that subagent's run ended
const handedOver = new Map<string, string>()

// the mod's own bar mirrors its agents as steps, finished first, so percent and count read done/total
function syncAuto(p: Plan, now: number): Plan {
  const agents = p.agents ?? []
  const isOver = agents.length > 0 && agents.every(a => a.state === 'done' || a.state === 'error')
  const agentsDoneAt = isOver ? (p.agentsDoneAt ?? now) : null
  if (p.id !== AGENTS) return { ...p, agentsDoneAt }
  const rank = (a: AgentRun) => (a.state === 'done' ? 0 : a.state === 'error' ? 1 : 2)
  const steps: PlanStep[] = [...agents]
    .sort((a, b) => rank(a) - rank(b))
    .map(a => ({ title: a.title, status: a.state === 'done' ? 'done' : a.state === 'error' ? 'error' : 'active', substeps: [] }))
  const state: PlanState = isOver
    ? agents.some(a => a.state === 'error') ? 'error' : 'done'
    : agents.some(a => a.state === 'waiting') ? 'needs_input' : 'running'
  // the pill says how many are still at work; the bar's title already says "Agents"
  const running = agents.filter(a => a.state === 'running' || a.state === 'waiting').length
  // work after a finished batch (a new spawn, a resumed agent, a teammate's next turn) starts the clock over, as the
  // next task under a finished bar's id does
  const startedAt = p.agentsDoneAt && !isOver ? now : p.startedAt
  return { ...p, agentsDoneAt, startedAt, stages: [{ name: isOver ? 'Agents' : `${running} running`, steps }], state }
}

function addRun(p: Plan, run: AgentRun, parentId: string | undefined, now: number): Plan {
  // a batch that has finished makes room for the next one; a teammate only resting between its turns stays, so its
  // next turn has a strip to wake
  const list = p.agentsDoneAt ? keepStrips(p.agents ?? [], a => resting.has(a.id)) : [...(p.agents ?? [])]
  // a child sits under its parent's strip where that strip is, after the parent's own children and not after its
  // later siblings; elsewhere it starts a line of its own
  const parentAt = parentId ? list.findIndex(a => a.id === parentId) : -1
  const parent = list[parentAt]
  let at = list.length
  if (parent) {
    at = parentAt + 1
    while (at < list.length && (list[at]?.depth ?? 0) > parent.depth) at++
  }
  list.splice(at, 0, { ...run, depth: parent ? parent.depth + 1 : 0 })
  return syncAuto({ ...p, agents: list }, now)
}

// puts a strip on its home bar; the home picked can be gone by now (closed, cleared or pushed out), and then the strip
// goes to the mod's own Agents bar. Answers the bar it landed on
async function placeRun($: EngineInterface, run: AgentRun, home: string, parentId: string | undefined, now: number): Promise<string> {
  let isNew = false
  let placed = home
  await update($, plans, list => {
    // two wakes of one agent at once put its strip back only once
    const holder = list.find(p => (p.agents ?? []).some(a => a.id === run.id))
    if (holder) {
      placed = holder.id
      return [...list]
    }
    if (list.some(p => p.id === home)) return list.map(p => (p.id === home ? addRun(p, run, parentId, now) : p))
    placed = AGENTS
    if (list.some(p => p.id === AGENTS)) return list.map(p => (p.id === AGENTS ? addRun(p, run, undefined, now) : p))
    isNew = true
    const auto: Plan = { id: AGENTS, title: 'Agents', kind: 'todo', stages: [], state: 'running', note: null, startedAt: now }
    return placeBar(list, addRun(auto, run, undefined, now))
  })
  if (isNew) await update($, isOpen, () => true)
  return placed
}

// an agent's strip from its calls in flight: amber while any of them has a dialog up, else the latest tool;
// a finished agent stays as it is
async function showAgent($: EngineInterface, agentId: string, endedTool?: string) {
  const mine = [...flights.values()].filter(f => f.agentId === agentId)
  const isAsked = mine.some(f => f.isAsked)
  const tool = isAsked ? 'Needs approval' : (mine.at(-1)?.tool ?? endedTool)
  await editAgent($, agentId, a =>
    a.state === 'running' || a.state === 'waiting' ? { ...a, state: isAsked ? 'waiting' : 'running', tool: tool ?? a.tool } : a,
  )
}

function forgetFlights(agentId: string) {
  for (const [id, f] of flights) if (f.agentId === agentId) flights.delete(id)
}

// changes one agent's strip inside the latest list; silent, since a subagent answers to Claude, not to the person
// an agent the map does not know is found again by its strip on a bar: one still running (the mod reloaded while it
// ran, and its call came before session.start rebuilt the map), or one that finished and is resumed under the same id
// (a message sent to it, a teammate's next turn). isWaking is for its loop's own work: a finished strip runs again
async function knowAgent($: EngineInterface, agentId: string, isWaking = false): Promise<boolean> {
  if (agentHome.has(agentId)) return true
  const bar = (await read($, plans)).find(p => (p.agents ?? []).some(a => a.id === agentId))
  const last = isWaking && !bar ? ended.get(agentId) : undefined
  if (last) {
    // its strip went with a finished batch when the bar made room for the next one: it comes back under the main
    // loop's latest open bar, as a new agent would
    ended.delete(agentId)
    const now = await $.clock.now()
    const home = [...(await read($, plans))].reverse().find(p => isOpenPlan(p) && !p.byAgent)?.id ?? AGENTS
    const run: AgentRun = { ...last, state: 'running', tool: 'Starting', startedAt: now, endedAt: null, depth: 0 }
    agentHome.set(agentId, await placeRun($, run, home, undefined, now))
    return true
  }
  if (!bar) return false
  agentHome.set(agentId, bar.id)
  if (!isWaking) return true
  const now = await $.clock.now()
  await update($, plans, list =>
    list.map(p => {
      if (p.id !== bar.id) return p
      const agents = (p.agents ?? []).map(a =>
        a.id === agentId && (a.state === 'done' || a.state === 'error') ? { ...a, state: 'running' as const, tool: 'Starting', startedAt: now, endedAt: null } : a,
      )
      // woken after its batch folded away, it comes back alone: the batch's other finished strips stay out of sight
      // (each one comes back the same way if it is resumed too)
      const isPast = !!p.agentsDoneAt && now - p.agentsDoneAt > FOLD_MS && !agents.some(a => a.state === 'error')
      return syncAuto({ ...p, agents: isPast ? keepStrips(agents, a => a.state !== 'done' || resting.has(a.id)) : agents }, now)
    }),
  )
  return true
}

async function editAgent($: EngineInterface, agentId: string, change: (a: AgentRun) => AgentRun) {
  const home = agentHome.get(agentId)
  if (!home) return
  const now = await $.clock.now()
  let isFolding = false
  await update($, plans, list =>
    list.map(p => {
      if (p.id !== home || !p.agents?.some(a => a.id === agentId)) return p
      const next = syncAuto({ ...p, agents: p.agents.map(a => (a.id === agentId ? change(a) : a)) }, now)
      isFolding = !p.agentsDoneAt && next.agentsDoneAt !== null
      return next
    }),
  )
  if (isFolding) foldAt.set(home, now + FOLD_MS + 200)
}

// an agent's run is over: its strip says how it ended. Its own turn.complete has the last word; an end read from
// $.agent.list() (isGuess) only ends a strip still running
async function endAgent($: EngineInterface, agentId: string, isFailed: boolean, tool: string, isGuess = false) {
  const now = await $.clock.now()
  await editAgent($, agentId, a =>
    isGuess && a.state !== 'running' && a.state !== 'waiting' ? a : { ...a, state: isFailed ? 'error' : 'done', tool, endedAt: a.endedAt ?? now },
  )
  const run = (await read($, plans)).flatMap(p => p.agents ?? []).find(a => a.id === agentId)
  if (run) {
    ended.delete(agentId)
    ended.set(agentId, run)
    for (const id of ended.keys()) if (ended.size > ENDED_KEPT) ended.delete(id)
  }
  agentHome.delete(agentId)
  forgetFlights(agentId)
  if (!isGuess) resting.delete(agentId)
}

// how $.agent.list() words an agent whose run is over: waiting for a message (a teammate between turns) counts as over
const ENDED: Partial<Record<AgentStatus, { isFailed: boolean; tool: string }>> = {
  completed: { isFailed: false, tool: 'Done' },
  idle: { isFailed: false, tool: 'Done' },
  failed: { isFailed: true, tool: 'Failed' },
  killed: { isFailed: true, tool: 'Stopped' },
}
// agents seen in $.agent.list(): a row gone later means the engine dropped the task of one that ended. A workflow's
// agents are never listed, so an agent never seen there is left to its turn.complete
const listed = new Set<string>()
// strips ended because the list said idle: a teammate between turns, done only for now
const resting = new Set<string>()
// each ended agent's last strip, the latest ENDED_KEPT: an agent can be resumed under the same id (a message sent to
// it, an in-process teammate's next turn) after its strip went with its batch, and gets it back from here
const ended = new Map<string, AgentRun>()
const ENDED_KEPT = 200

// some ends never reach the mod (a teammate in a terminal pane of its own sends no turn.complete here, a finish can be
// missed), so a strip still running is checked against $.agent.list() while any is shown. It brings back only a strip
// it ended itself on an idle row, once that row is at work again (the teammate's next turn, which sends nothing here
// either); an end the agent reported stays, since the list may still say running just after it
async function settleAgents($: EngineInterface) {
  const list = await read($, plans)
  const live = list.flatMap(p => (p.agents ?? []).filter(a => a.state === 'running' || a.state === 'waiting'))
  const idle = list.flatMap(p => (p.agents ?? []).filter(a => a.state === 'done' && resting.has(a.id)))
  if (live.length === 0 && idle.length === 0) return
  const rows = await Promise.resolve()
    .then(() => $.agent.list())
    .catch(() => null)
  if (!rows) return
  for (const row of rows) listed.add(row.id)
  for (const a of live) {
    const row = rows.find(r => r.id === a.id)
    const end = row ? ENDED[row.status] : listed.has(a.id) ? ENDED.completed : undefined
    if (!end || !(await knowAgent($, a.id))) continue
    await endAgent($, a.id, end.isFailed, end.tool, true)
    if (row?.status === 'idle') resting.add(a.id)
  }
  for (const a of idle) {
    const row = rows.find(r => r.id === a.id)
    if (row?.status === 'idle') continue
    resting.delete(a.id)
    if (row && !ENDED[row.status]) await knowAgent($, a.id, true)
  }
}

// module maps outlive the bars they describe: a bar pushed out past MAX_BARS, a cleared list, an agent
// whose finish never arrived (killed, or started before a reload); drop what no bar holds any more
function forgetGone(list: readonly Plan[]) {
  const bars = new Set(list.map(p => p.id))
  const live = new Set(list.flatMap(p => (p.agents ?? []).filter(a => a.state === 'running' || a.state === 'waiting').map(a => a.id)))
  const shown = new Set(list.flatMap(p => (p.agents ?? []).map(a => a.id)))
  for (const id of lastHead.keys()) if (!bars.has(id)) lastHead.delete(id)
  for (const id of waveFrom.keys()) if (!bars.has(id)) waveFrom.delete(id)
  for (const id of resting) if (!shown.has(id)) resting.delete(id)
  for (const id of drawn.keys()) if (!bars.has(id)) drawn.delete(id)
  for (const id of glide.keys()) if (!bars.has(id)) glide.delete(id)
  for (const id of stillPhase.keys()) if (!bars.has(id)) stillPhase.delete(id)
  for (const id of lastStrip.keys()) if (!shown.has(id)) lastStrip.delete(id)
  for (const id of drawnRows.keys()) if (!shown.has(id)) drawnRows.delete(id)
  for (const id of listed) if (!shown.has(id)) listed.delete(id)
  for (const [id, home] of agentHome) {
    if (bars.has(home) && live.has(id)) continue
    agentHome.delete(id)
    forgetFlights(id)
  }
}

// folds a bar's agent strips away or shows them again; the bar itself stays, its pill naming only the stage and step
async function foldPlan($: EngineInterface, id: string) {
  await update($, plans, list => list.map(p => (p.id === id ? { ...p, isFolded: !p.isFolded } : p)))
}

// auto-close is off until the person turns it on: a finished bar stays until it is closed. On, a finished bar leaves
// on its own doneStaysMs after it finished, once none of its agents is still at work; a failed bar or one waiting on
// the person stays until it is closed, since it still asks for attention. /plan-progress-autoclose turns it on and off
// (kept in the store, so a new session keeps the choice); the seconds are the doneBarSeconds option in /config
const AUTOCLOSE = 'autoclose'
let isAutoClose = false
let doneStaysMs = 30_000
// the Agents bar has no end of its own: it finished when its last agent did
const endOf = (p: Plan) => (p.id === AGENTS ? p.agentsDoneAt : p.endedAt)
const hasLeft = (p: Plan, now: number) => {
  const end = endOf(p)
  return isAutoClose && p.state === 'done' && end != null && now - end >= doneStaysMs && !hasRunningAgents(p)
}

// the settings window (the ⚙ in the footer, /plan-progress-settings) turns auto-close, the sounds and the footer's
// figure on and off: each choice is kept in the store, as auto-close always was, and holds at once with no reload. The
// two options of /config (twinkle, doneBarSeconds) it sets the way the menu does, which reloads the mod
const SOUNDS = 'sounds'
const SPEED_SHOWN = 'speedShown'
const UPDATE_CHECK = 'updateCheck'
let isSoundOn = true
let isSpeedShown = true
let isUpdateCheckOn = true
const SETTINGS = 'settings'
// the seconds a finished bar stays that the window offers; /config takes any
const STAYS = [10, 30, 60]

// the window's words in the 35 languages the desktop app speaks, fields in the order of WORD_KEYS: two section heads,
// a title and a line for each setting, the two states of a switch, the seconds (`{n}`); `{v}` is the footer's figure
const WORD_KEYS = ['g1', 'g2', 'fx', 'fxd', 'sp', 'spd', 'ac', 'acd', 'st', 'std', 'sn', 'snd', 'enabled', 'disabled', 'secs'] as const
type Words = Record<(typeof WORD_KEYS)[number] | (typeof VERSION_KEYS)[number], string>
const WORDS: Record<string, string> = {
  en: 'Appearance|Behavior|Effects|Twinkling dots in the bar and the agent rows|Speed|Show {v} in the footer|Auto-close|A finished bar leaves on its own|Stays for|How long a finished bar stays|Sounds|A chime on an error, a question and the finish|On|Off|{n} s',
  ru: 'Вид|Поведение|Эффекты|Мерцание точек в полосе и строках агентов|Скорость|Показывать {v} в футере|Автозакрытие|Готовая полоса уходит сама|Время показа|Сколько готовая полоса видна|Звуки|Сигнал при ошибке, вопросе и финише|Вкл|Выкл|{n} с',
  uk: 'Вигляд|Поведінка|Ефекти|Мерехтіння точок у смузі та рядках агентів|Швидкість|Показувати {v} у футері|Автозакриття|Готова смуга зникає сама|Час показу|Скільки готова смуга видна|Звуки|Сигнал при помилці, питанні й завершенні|Увімк|Вимк|{n} с',
  de: 'Darstellung|Verhalten|Effekte|Funkelnde Punkte im Balken und in den Agentenzeilen|Tempo|{v} in der Fußzeile zeigen|Automatisch schließen|Ein fertiger Balken geht von selbst|Anzeigedauer|Wie lange ein fertiger Balken bleibt|Töne|Signal bei Fehler, Frage und Abschluss|An|Aus|{n} s',
  fr: 'Apparence|Comportement|Effets|Points scintillants dans la barre et les lignes d’agents|Vitesse|Afficher {v} dans le pied de page|Fermeture auto|Une barre terminée part d’elle-même|Reste affichée|Combien de temps une barre terminée reste|Sons|Un signal en cas d’erreur, de question et à la fin|Oui|Non|{n} s',
  es: 'Apariencia|Comportamiento|Efectos|Puntos que destellan en la barra y las filas de agentes|Velocidad|Mostrar {v} en el pie de página|Cierre automático|Una barra terminada se cierra sola|Permanece|Cuánto se queda una barra terminada|Sonidos|Un aviso ante un error, una pregunta y al terminar|Sí|No|{n} s',
  'es-419': 'Apariencia|Comportamiento|Efectos|Puntos que destellan en la barra y las filas de agentes|Velocidad|Mostrar {v} en el pie de página|Cierre automático|Una barra terminada se cierra sola|Permanece|Cuánto tiempo queda una barra terminada|Sonidos|Un aviso ante un error, una pregunta y al terminar|Sí|No|{n} s',
  'pt-BR': 'Aparência|Comportamento|Efeitos|Pontos que cintilam na barra e nas linhas dos agentes|Velocidade|Mostrar {v} no rodapé|Fechar sozinho|Uma barra concluída sai sozinha|Fica por|Quanto tempo uma barra concluída fica|Sons|Um aviso em erro, pergunta e conclusão|Sim|Não|{n} s',
  it: 'Aspetto|Comportamento|Effetti|Punti che scintillano nella barra e nelle righe degli agenti|Velocità|Mostra {v} nel piè di pagina|Chiusura automatica|Una barra finita se ne va da sola|Resta per|Quanto resta una barra finita|Suoni|Un segnale per errore, domanda e fine|Sì|No|{n} s',
  nl: 'Weergave|Gedrag|Effecten|Fonkelende stippen in de balk en de agentregels|Snelheid|{v} in de voettekst tonen|Automatisch sluiten|Een voltooide balk verdwijnt vanzelf|Blijft staan|Hoe lang een voltooide balk blijft|Geluiden|Een signaal bij een fout, een vraag en het einde|Aan|Uit|{n} s',
  da: 'Udseende|Adfærd|Effekter|Glimtende prikker i bjælken og agentlinjerne|Hastighed|Vis {v} i sidefoden|Luk automatisk|En færdig bjælke forsvinder af sig selv|Bliver i|Hvor længe en færdig bjælke bliver|Lyde|Et signal ved fejl, spørgsmål og afslutning|Til|Fra|{n} s',
  sv: 'Utseende|Beteende|Effekter|Glittrande punkter i stapeln och agentraderna|Hastighet|Visa {v} i sidfoten|Stäng automatiskt|En klar stapel försvinner av sig själv|Stannar i|Hur länge en klar stapel stannar kvar|Ljud|En signal vid fel, frågor och slut|På|Av|{n} s',
  nb: 'Utseende|Atferd|Effekter|Glitrende prikker i linjen og agentradene|Hastighet|Vis {v} i bunnteksten|Lukk automatisk|En ferdig linje forsvinner av seg selv|Blir i|Hvor lenge en ferdig linje blir|Lyder|Et signal ved feil, spørsmål og slutt|På|Av|{n} s',
  fi: 'Ulkoasu|Toiminta|Tehosteet|Tuikkivat pisteet palkissa ja agenttiriveillä|Nopeus|Näytä {v} alatunnisteessa|Sulje automaattisesti|Valmis palkki poistuu itsestään|Näkyy|Kuinka kauan valmis palkki näkyy|Äänet|Merkkiääni virheestä, kysymyksestä ja valmistumisesta|Päällä|Pois|{n} s',
  tr: 'Görünüm|Davranış|Efektler|Çubukta ve ajan satırlarında parıldayan noktalar|Hız|Alt bilgide {v} göster|Otomatik kapat|Biten çubuk kendiliğinden kalkar|Kalma süresi|Biten çubuk ne kadar kalır|Sesler|Hata, soru ve bitişte uyarı sesi|Açık|Kapalı|{n} sn',
  id: 'Tampilan|Perilaku|Efek|Titik berkelip di bilah dan baris agen|Kecepatan|Tampilkan {v} di footer|Tutup otomatis|Bilah yang selesai hilang sendiri|Tampil selama|Berapa lama bilah yang selesai tetap tampil|Suara|Bunyi saat galat, pertanyaan, dan selesai|Aktif|Nonaktif|{n} dtk',
  fil: 'Hitsura|Gawi|Mga epekto|Kumikislap na tuldok sa bar at sa mga hanay ng agent|Bilis|Ipakita ang {v} sa footer|Kusang pagsara|Kusang nawawala ang tapos na bar|Tagal|Gaano katagal nananatili ang tapos na bar|Mga tunog|Tunog sa error, tanong, at pagtatapos|On|Off|{n} s',
  vi: 'Giao diện|Hành vi|Hiệu ứng|Chấm lấp lánh trong thanh và các dòng tác tử|Tốc độ|Hiện {v} ở chân trang|Tự đóng|Thanh đã xong tự biến mất|Hiển thị trong|Thanh đã xong ở lại bao lâu|Âm thanh|Tiếng báo khi lỗi, khi hỏi và khi xong|Bật|Tắt|{n} giây',
  th: 'รูปลักษณ์|การทำงาน|เอฟเฟกต์|จุดระยิบระยับในแถบและแถวของเอเจนต์|ความเร็ว|แสดง {v} ที่ส่วนท้าย|ปิดอัตโนมัติ|แถบที่เสร็จแล้วหายไปเอง|แสดงนาน|แถบที่เสร็จแล้วอยู่นานเท่าไร|เสียง|เสียงเตือนเมื่อผิดพลาด มีคำถาม และเสร็จสิ้น|เปิด|ปิด|{n} วิ',
  ja: '表示|動作|エフェクト|バーとエージェント行のドットがきらめく|速度|フッターに {v} を表示|自動で閉じる|完了したバーが自動で消える|表示時間|完了したバーを残す時間|サウンド|エラー・質問・完了時に音を鳴らす|オン|オフ|{n}秒',
  ko: '표시|동작|효과|막대와 에이전트 줄의 점이 반짝임|속도|하단에 {v} 표시|자동 닫기|완료된 막대가 스스로 사라짐|표시 시간|완료된 막대가 남아 있는 시간|소리|오류, 질문, 완료 시 알림음|켬|끔|{n}초',
  'zh-CN': '外观|行为|特效|进度条和代理行中的点会闪烁|速度|在页脚显示 {v}|自动关闭|完成的进度条自动消失|停留时间|完成的进度条保留多久|声音|出错、提问和完成时发出提示音|开|关|{n} 秒',
  'zh-TW': '外觀|行為|特效|進度條和代理列中的點會閃爍|速度|在頁尾顯示 {v}|自動關閉|完成的進度條自動消失|停留時間|完成的進度條保留多久|聲音|出錯、提問和完成時發出提示音|開|關|{n} 秒',
  hi: 'रूप|व्यवहार|इफ़ेक्ट|बार और एजेंट पंक्तियों में टिमटिमाते बिंदु|गति|फ़ुटर में {v} दिखाएँ|अपने-आप बंद|पूरा हुआ बार खुद हट जाता है|दिखने का समय|पूरा हुआ बार कितनी देर दिखे|आवाज़ें|गलती, सवाल और पूरा होने पर संकेत|चालू|बंद|{n} से',
  bho: 'रूप|बेवहार|इफ़ेक्ट|बार आ एजेंट के पंक्ति में टिमटिमात बिंदु|रफ़्तार|फ़ुटर में {v} देखाईं|अपने से बंद|पूरा भइल बार अपने से हट जाला|देखाए के समय|पूरा भइल बार केतना देर रही|आवाज|गलती, सवाल आ पूरा भइला पर संकेत|चालू|बंद|{n} से',
  mr: 'स्वरूप|वर्तन|इफेक्ट्स|बार आणि एजंट ओळींमध्ये लुकलुकणारे ठिपके|वेग|फूटरमध्ये {v} दाखवा|आपोआप बंद|पूर्ण झालेला बार आपोआप जातो|दिसण्याचा वेळ|पूर्ण झालेला बार किती वेळ दिसतो|आवाज|त्रुटी, प्रश्न आणि पूर्ण झाल्यावर संकेत|सुरू|बंद|{n} से',
  gu: 'દેખાવ|વર્તન|ઇફેક્ટ્સ|બાર અને એજન્ટ પંક્તિઓમાં ઝબકતા બિંદુઓ|ઝડપ|ફૂટરમાં {v} બતાવો|આપમેળે બંધ|પૂર્ણ થયેલો બાર જાતે જ જાય છે|દેખાવાનો સમય|પૂર્ણ થયેલો બાર કેટલો સમય રહે|અવાજો|ભૂલ, પ્રશ્ન અને પૂર્ણ થવા પર સંકેત|ચાલુ|બંધ|{n} સે',
  bn: 'চেহারা|আচরণ|ইফেক্ট|বার ও এজেন্টের সারিতে ঝিকমিক বিন্দু|গতি|ফুটারে {v} দেখান|নিজে থেকে বন্ধ|শেষ হওয়া বার নিজেই সরে যায়|দেখানোর সময়|শেষ হওয়া বার কতক্ষণ থাকে|শব্দ|ত্রুটি, প্রশ্ন ও শেষ হলে সংকেত|চালু|বন্ধ|{n} সেকেন্ড',
  ta: 'தோற்றம்|நடத்தை|விளைவுகள்|பட்டையிலும் முகவர் வரிசைகளிலும் மின்னும் புள்ளிகள்|வேகம்|அடிக்குறிப்பில் {v} காட்டு|தானாக மூடு|முடிந்த பட்டை தானாக மறையும்|காட்டும் நேரம்|முடிந்த பட்டை எவ்வளவு நேரம் இருக்கும்|ஒலிகள்|பிழை, கேள்வி, முடிவில் ஒலி|ஆன்|ஆஃப்|{n} வி',
  te: 'రూపం|ప్రవర్తన|ప్రభావాలు|బార్ మరియు ఏజెంట్ వరుసలలో మెరిసే చుక్కలు|వేగం|అడుగున {v} చూపించు|స్వయంగా మూసివేత|పూర్తయిన బార్ దానంతటదే వెళ్తుంది|చూపే సమయం|పూర్తయిన బార్ ఎంతసేపు ఉంటుంది|శబ్దాలు|లోపం, ప్రశ్న, ముగింపులో సంకేతం|ఆన్|ఆఫ్|{n} సె',
  kn: 'ನೋಟ|ನಡವಳಿಕೆ|ಪರಿಣಾಮಗಳು|ಬಾರ್ ಮತ್ತು ಏಜೆಂಟ್ ಸಾಲುಗಳಲ್ಲಿ ಮಿನುಗುವ ಚುಕ್ಕೆಗಳು|ವೇಗ|ಅಡಿಯಲ್ಲಿ {v} ತೋರಿಸಿ|ಸ್ವಯಂ ಮುಚ್ಚು|ಮುಗಿದ ಬಾರ್ ತಾನಾಗಿ ಹೋಗುತ್ತದೆ|ತೋರಿಸುವ ಸಮಯ|ಮುಗಿದ ಬಾರ್ ಎಷ್ಟು ಹೊತ್ತು ಇರುತ್ತದೆ|ಶಬ್ದಗಳು|ದೋಷ, ಪ್ರಶ್ನೆ ಮತ್ತು ಮುಕ್ತಾಯದಲ್ಲಿ ಸಂಕೇತ|ಆನ್|ಆಫ್|{n} ಸೆ',
  ml: 'രൂപം|പെരുമാറ്റം|ഇഫക്റ്റുകൾ|ബാറിലും ഏജന്റ് വരികളിലും മിന്നുന്ന കുത്തുകൾ|വേഗം|ഫൂട്ടറിൽ {v} കാണിക്കുക|സ്വയം അടയ്ക്കുക|പൂർത്തിയായ ബാർ സ്വയം മാറും|കാണിക്കുന്ന സമയം|പൂർത്തിയായ ബാർ എത്ര നേരം നിൽക്കും|ശബ്ദങ്ങൾ|പിശക്, ചോദ്യം, പൂർത്തീകരണം എന്നിവയിൽ സൂചന|ഓൺ|ഓഫ്|{n} സെ',
  am: 'መልክ|ባህሪ|ውጤቶች|በአሞሌው እና በወኪል ረድፎች ውስጥ የሚያብረቀርቁ ነጥቦች|ፍጥነት|{v} በግርጌ አሳይ|ራስ-ሰር መዝጋት|የተጠናቀቀ አሞሌ በራሱ ይሄዳል|የሚቆይበት ጊዜ|የተጠናቀቀ አሞሌ ምን ያህል ይቆያል|ድምጾች|በስህተት፣ በጥያቄ እና በማጠናቀቅ ጊዜ ምልክት|በርቷል|ጠፍቷል|{n} ሰከ',
  ha: 'Kamanni|Ɗabi’a|Tasiri|Ɗigogi masu walƙiya a sanda da layukan wakilai|Gudu|Nuna {v} a ƙasan shafi|Rufewa da kanta|Sandar da ta gama tana tafiya da kanta|Lokacin zama|Tsawon lokacin da sandar da ta gama take zama|Sauti|Ƙara a kuskure, tambaya da ƙarshe|A kunne|A kashe|{n} d',
  sw: 'Mwonekano|Tabia|Madoido|Vitone vinavyometameta kwenye upau na safu za mawakala|Kasi|Onyesha {v} kwenye sehemu ya chini|Funga kiotomatiki|Upau uliokamilika huondoka wenyewe|Hukaa kwa|Muda upau uliokamilika unakaa|Sauti|Mlio kwa hitilafu, swali na kumaliza|Imewashwa|Imezimwa|{n} s',
}
// what /config language may hold for each, in English and in the language itself; the longest name found wins, so
// "Spanish (Latin America)" is not taken for Spanish
const LANG_NAMES: Record<string, string> = {
  en: 'english',
  ru: 'russian,русский',
  uk: 'ukrainian,українська',
  de: 'german,deutsch',
  fr: 'french,français,francais',
  es: 'spanish,español,espanol,castellano,spanish (spain),español (españa)',
  'es-419': 'latin american spanish,spanish (latin america),español latino,español (latinoamérica)',
  'pt-BR': 'portuguese,português,portugues,brazilian portuguese,portuguese (brazil)',
  it: 'italian,italiano',
  nl: 'dutch,nederlands',
  da: 'danish,dansk',
  sv: 'swedish,svenska',
  nb: 'norwegian,norsk,bokmål,bokmal',
  fi: 'finnish,suomi',
  tr: 'turkish,türkçe,turkce',
  id: 'indonesian,bahasa indonesia',
  fil: 'filipino,tagalog',
  vi: 'vietnamese,tiếng việt',
  th: 'thai,ไทย',
  ja: 'japanese,日本語',
  ko: 'korean,한국어',
  'zh-CN': 'chinese,simplified chinese,chinese (simplified),mandarin,中文,简体中文',
  'zh-TW': 'traditional chinese,chinese (traditional),繁體中文,繁体中文',
  hi: 'hindi,हिन्दी,हिंदी',
  bho: 'bhojpuri,भोजपुरी',
  mr: 'marathi,मराठी',
  gu: 'gujarati,ગુજરાતી',
  bn: 'bangla,bengali,বাংলা',
  ta: 'tamil,தமிழ்',
  te: 'telugu,తెలుగు',
  kn: 'kannada,ಕನ್ನಡ',
  ml: 'malayalam,മലയാളം',
  am: 'amharic,አማርኛ',
  ha: 'hausa',
  sw: 'swahili,kiswahili',
}
// the version row's words, in the same languages and the same way: its section head, its title, the line under it at
// rest and in each state of a check or an update (`{v}` a version, `{e}` what went wrong, as the network or the CLI
// says it), the link to the release notes and the two buttons a newer release offers
const VERSION_KEYS = ['g3', 'ver', 'verd', 'checking', 'latest', 'avail', 'notes', 'upd', 'later', 'updating', 'updated', 'restart', 'failc', 'failu', 'folder', 'uc', 'ucd'] as const
const VERSION_WORDS: Record<string, string> = {
  en: 'About|Version|Press it to look for a newer release|Checking…|This is the latest version|Version {v} is out|What’s new|Update|Later|Updating to {v}…|Updated to {v}|Restart Claude Code to finish the update|Could not check: {e}|Could not update: {e}|Installed from a folder: it updates with the folder|Check for updates|Look for a new release every 6 hours',
  ru: 'О моде|Версия|Нажмите, чтобы проверить новую версию|Проверяю…|Это последняя версия|Вышла версия {v}|Что нового|Обновить|Позже|Обновляю до {v}…|Обновлено до {v}|Перезапустите Claude Code, чтобы закончить обновление|Не удалось проверить: {e}|Не удалось обновить: {e}|Установлен из папки: обновляется вместе с ней|Проверять обновления|Искать новую версию раз в 6 часов',
  uk: 'Про мод|Версія|Натисніть, щоб перевірити нову версію|Перевіряю…|Це остання версія|Вийшла версія {v}|Що нового|Оновити|Пізніше|Оновлюю до {v}…|Оновлено до {v}|Перезапустіть Claude Code, щоб завершити оновлення|Не вдалося перевірити: {e}|Не вдалося оновити: {e}|Встановлено з теки: оновлюється разом із нею|Перевіряти оновлення|Шукати нову версію раз на 6 годин',
  de: 'Über|Version|Klicken, um nach einer neuen Version zu suchen|Wird geprüft…|Das ist die neueste Version|Version {v} ist erschienen|Was ist neu|Aktualisieren|Später|Aktualisiere auf {v}…|Auf {v} aktualisiert|Claude Code neu starten, um das Update abzuschließen|Prüfung fehlgeschlagen: {e}|Update fehlgeschlagen: {e}|Aus einem Ordner installiert: wird mit ihm aktualisiert|Nach Updates suchen|Alle 6 Stunden nach einer neuen Version sehen',
  fr: 'À propos|Version|Cliquez pour chercher une nouvelle version|Vérification…|C’est la dernière version|La version {v} est sortie|Nouveautés|Mettre à jour|Plus tard|Mise à jour vers {v}…|Mis à jour vers {v}|Redémarrez Claude Code pour terminer la mise à jour|Vérification impossible : {e}|Mise à jour impossible : {e}|Installé depuis un dossier : il se met à jour avec lui|Rechercher les mises à jour|Chercher une nouvelle version toutes les 6 heures',
  es: 'Acerca de|Versión|Pulsa para buscar una versión nueva|Comprobando…|Esta es la última versión|Ya está la versión {v}|Novedades|Actualizar|Más tarde|Actualizando a {v}…|Actualizado a {v}|Reinicia Claude Code para terminar la actualización|No se pudo comprobar: {e}|No se pudo actualizar: {e}|Instalado desde una carpeta: se actualiza con ella|Buscar actualizaciones|Buscar una versión nueva cada 6 horas',
  'es-419': 'Acerca de|Versión|Haz clic para buscar una versión nueva|Verificando…|Esta es la versión más reciente|Ya salió la versión {v}|Novedades|Actualizar|Más tarde|Actualizando a {v}…|Actualizado a {v}|Reinicia Claude Code para terminar la actualización|No se pudo verificar: {e}|No se pudo actualizar: {e}|Instalado desde una carpeta: se actualiza con ella|Buscar actualizaciones|Revisar si hay una versión nueva cada 6 horas',
  'pt-BR': 'Sobre|Versão|Clique para procurar uma versão nova|Verificando…|Esta é a versão mais recente|Saiu a versão {v}|Novidades|Atualizar|Depois|Atualizando para {v}…|Atualizado para {v}|Reinicie o Claude Code para concluir a atualização|Não foi possível verificar: {e}|Não foi possível atualizar: {e}|Instalado de uma pasta: atualiza junto com ela|Procurar atualizações|Procurar uma versão nova a cada 6 horas',
  it: 'Informazioni|Versione|Fai clic per cercare una nuova versione|Controllo…|Questa è l’ultima versione|È uscita la versione {v}|Novità|Aggiorna|Più tardi|Aggiornamento a {v}…|Aggiornato a {v}|Riavvia Claude Code per completare l’aggiornamento|Controllo non riuscito: {e}|Aggiornamento non riuscito: {e}|Installato da una cartella: si aggiorna con essa|Cerca aggiornamenti|Cerca una nuova versione ogni 6 ore',
  nl: 'Over|Versie|Klik om naar een nieuwe versie te zoeken|Controleren…|Dit is de nieuwste versie|Versie {v} is uit|Wat is er nieuw|Bijwerken|Later|Bijwerken naar {v}…|Bijgewerkt naar {v}|Herstart Claude Code om de update af te ronden|Controleren mislukt: {e}|Bijwerken mislukt: {e}|Geïnstalleerd uit een map: wordt daarmee bijgewerkt|Naar updates zoeken|Elke 6 uur naar een nieuwe versie zoeken',
  da: 'Om|Version|Klik for at søge efter en ny version|Tjekker…|Dette er den nyeste version|Version {v} er ude|Nyheder|Opdater|Senere|Opdaterer til {v}…|Opdateret til {v}|Genstart Claude Code for at afslutte opdateringen|Kunne ikke tjekke: {e}|Kunne ikke opdatere: {e}|Installeret fra en mappe: opdateres med den|Søg efter opdateringer|Søg efter en ny version hver 6. time',
  sv: 'Om|Version|Klicka för att söka efter en ny version|Kontrollerar…|Det här är den senaste versionen|Version {v} har släppts|Nyheter|Uppdatera|Senare|Uppdaterar till {v}…|Uppdaterad till {v}|Starta om Claude Code för att slutföra uppdateringen|Kunde inte kontrollera: {e}|Kunde inte uppdatera: {e}|Installerad från en mapp: uppdateras med den|Sök efter uppdateringar|Sök efter en ny version var 6:e timme',
  nb: 'Om|Versjon|Klikk for å se etter en ny versjon|Sjekker…|Dette er den nyeste versjonen|Versjon {v} er ute|Nyheter|Oppdater|Senere|Oppdaterer til {v}…|Oppdatert til {v}|Start Claude Code på nytt for å fullføre oppdateringen|Kunne ikke sjekke: {e}|Kunne ikke oppdatere: {e}|Installert fra en mappe: oppdateres med den|Se etter oppdateringer|Se etter en ny versjon hver 6. time',
  fi: 'Tietoja|Versio|Napsauta etsiäksesi uutta versiota|Tarkistetaan…|Tämä on uusin versio|Versio {v} on julkaistu|Mitä uutta|Päivitä|Myöhemmin|Päivitetään versioon {v}…|Päivitetty versioon {v}|Käynnistä Claude Code uudelleen päivityksen viimeistelemiseksi|Tarkistus epäonnistui: {e}|Päivitys epäonnistui: {e}|Asennettu kansiosta: päivittyy sen mukana|Etsi päivityksiä|Etsi uutta versiota 6 tunnin välein',
  tr: 'Hakkında|Sürüm|Yeni sürümü denetlemek için tıklayın|Denetleniyor…|Bu en son sürüm|{v} sürümü çıktı|Yenilikler|Güncelle|Sonra|{v} sürümüne güncelleniyor…|{v} sürümüne güncellendi|Güncellemeyi bitirmek için Claude Code’u yeniden başlatın|Denetlenemedi: {e}|Güncellenemedi: {e}|Bir klasörden kuruldu: onunla birlikte güncellenir|Güncellemeleri denetle|Her 6 saatte bir yeni sürüm ara',
  id: 'Tentang|Versi|Klik untuk mencari versi baru|Memeriksa…|Ini versi terbaru|Versi {v} sudah keluar|Yang baru|Perbarui|Nanti|Memperbarui ke {v}…|Diperbarui ke {v}|Mulai ulang Claude Code untuk menyelesaikan pembaruan|Gagal memeriksa: {e}|Gagal memperbarui: {e}|Dipasang dari folder: diperbarui bersama folder itu|Periksa pembaruan|Cari versi baru setiap 6 jam',
  fil: 'Tungkol|Bersyon|I-click para maghanap ng bagong bersyon|Sinusuri…|Ito ang pinakabagong bersyon|Labas na ang bersyon {v}|Ano ang bago|I-update|Mamaya|Ina-update sa {v}…|Na-update sa {v}|I-restart ang Claude Code para matapos ang update|Hindi masuri: {e}|Hindi ma-update: {e}|Naka-install mula sa folder: sumasabay ito sa folder|Tingnan ang mga update|Maghanap ng bagong bersyon tuwing 6 na oras',
  vi: 'Giới thiệu|Phiên bản|Bấm để tìm phiên bản mới|Đang kiểm tra…|Đây là phiên bản mới nhất|Đã có phiên bản {v}|Có gì mới|Cập nhật|Để sau|Đang cập nhật lên {v}…|Đã cập nhật lên {v}|Khởi động lại Claude Code để hoàn tất cập nhật|Không kiểm tra được: {e}|Không cập nhật được: {e}|Cài từ một thư mục: cập nhật cùng thư mục đó|Kiểm tra cập nhật|Tìm phiên bản mới mỗi 6 giờ',
  th: 'เกี่ยวกับ|เวอร์ชัน|คลิกเพื่อหาเวอร์ชันใหม่|กำลังตรวจสอบ…|นี่คือเวอร์ชันล่าสุด|เวอร์ชัน {v} ออกแล้ว|มีอะไรใหม่|อัปเดต|ภายหลัง|กำลังอัปเดตเป็น {v}…|อัปเดตเป็น {v} แล้ว|รีสตาร์ต Claude Code เพื่อให้อัปเดตเสร็จ|ตรวจสอบไม่ได้: {e}|อัปเดตไม่ได้: {e}|ติดตั้งจากโฟลเดอร์: อัปเดตไปพร้อมกับโฟลเดอร์|ตรวจหาอัปเดต|หาเวอร์ชันใหม่ทุก 6 ชั่วโมง',
  ja: '情報|バージョン|クリックして新しいバージョンを確認|確認中…|最新バージョンです|バージョン {v} が公開されました|新機能|アップデート|後で|{v} にアップデート中…|{v} にアップデートしました|アップデートを完了するには Claude Code を再起動してください|確認できませんでした: {e}|アップデートできませんでした: {e}|フォルダーからインストール: フォルダーと一緒に更新されます|アップデートを確認|6 時間ごとに新しいバージョンを確認',
  ko: '정보|버전|클릭하여 새 버전 확인|확인 중…|최신 버전입니다|{v} 버전이 나왔습니다|새로운 기능|업데이트|나중에|{v}(으)로 업데이트 중…|{v}(으)로 업데이트됨|업데이트를 마치려면 Claude Code를 다시 시작하세요|확인하지 못함: {e}|업데이트하지 못함: {e}|폴더에서 설치됨: 폴더와 함께 업데이트됩니다|업데이트 확인|6시간마다 새 버전 확인',
  'zh-CN': '关于|版本|点击检查新版本|正在检查…|已是最新版本|版本 {v} 已发布|新功能|更新|稍后|正在更新到 {v}…|已更新到 {v}|重启 Claude Code 以完成更新|无法检查：{e}|无法更新：{e}|从文件夹安装：随文件夹一起更新|检查更新|每 6 小时查找新版本',
  'zh-TW': '關於|版本|點擊檢查新版本|正在檢查…|已是最新版本|版本 {v} 已發佈|新功能|更新|稍後|正在更新到 {v}…|已更新到 {v}|重新啟動 Claude Code 以完成更新|無法檢查：{e}|無法更新：{e}|從資料夾安裝：隨資料夾一起更新|檢查更新|每 6 小時尋找新版本',
  hi: 'जानकारी|संस्करण|नया संस्करण देखने के लिए क्लिक करें|जाँच हो रही है…|यह नवीनतम संस्करण है|संस्करण {v} आ गया है|नया क्या है|अपडेट करें|बाद में|{v} पर अपडेट हो रहा है…|{v} पर अपडेट हो गया|अपडेट पूरा करने के लिए Claude Code फिर से शुरू करें|जाँच नहीं हो सकी: {e}|अपडेट नहीं हो सका: {e}|फ़ोल्डर से इंस्टॉल: उसी के साथ अपडेट होता है|अपडेट जाँचें|हर 6 घंटे में नया संस्करण देखें',
  bho: 'जानकारी|संस्करण|नया संस्करण देखे खातिर क्लिक करीं|जाँच होता…|ई सबसे नया संस्करण बा|संस्करण {v} आ गइल|नया का बा|अपडेट करीं|बाद में|{v} पर अपडेट होता…|{v} पर अपडेट हो गइल|अपडेट पूरा करे खातिर Claude Code फेर से चालू करीं|जाँच ना हो पाइल: {e}|अपडेट ना हो पाइल: {e}|फ़ोल्डर से इंस्टॉल: ओकरे संगे अपडेट होला|अपडेट जाँचीं|हर 6 घंटा में नया संस्करण देखीं',
  mr: 'माहिती|आवृत्ती|नवी आवृत्ती पाहण्यासाठी क्लिक करा|तपासत आहे…|ही नवीनतम आवृत्ती आहे|आवृत्ती {v} आली आहे|नवीन काय|अपडेट करा|नंतर|{v} वर अपडेट करत आहे…|{v} वर अपडेट झाले|अपडेट पूर्ण करण्यासाठी Claude Code पुन्हा सुरू करा|तपासता आले नाही: {e}|अपडेट करता आले नाही: {e}|फोल्डरमधून इंस्टॉल: त्याच्यासोबत अपडेट होते|अपडेट तपासा|दर 6 तासांनी नवी आवृत्ती शोधा',
  gu: 'માહિતી|સંસ્કરણ|નવું સંસ્કરણ જોવા ક્લિક કરો|તપાસી રહ્યું છે…|આ નવીનતમ સંસ્કરણ છે|સંસ્કરણ {v} આવી ગયું છે|નવું શું છે|અપડેટ કરો|પછી|{v} પર અપડેટ થઈ રહ્યું છે…|{v} પર અપડેટ થયું|અપડેટ પૂરું કરવા Claude Code ફરી શરૂ કરો|તપાસી શકાયું નહીં: {e}|અપડેટ થઈ શક્યું નહીં: {e}|ફોલ્ડરમાંથી ઇન્સ્ટોલ: તેની સાથે અપડેટ થાય છે|અપડેટ તપાસો|દર 6 કલાકે નવું સંસ્કરણ શોધો',
  bn: 'সম্পর্কে|সংস্করণ|নতুন সংস্করণ খুঁজতে ক্লিক করুন|পরীক্ষা চলছে…|এটিই সর্বশেষ সংস্করণ|সংস্করণ {v} এসেছে|নতুন কী|আপডেট করুন|পরে|{v}-এ আপডেট হচ্ছে…|{v}-এ আপডেট হয়েছে|আপডেট শেষ করতে Claude Code আবার চালু করুন|পরীক্ষা করা যায়নি: {e}|আপডেট করা যায়নি: {e}|ফোল্ডার থেকে ইনস্টল: সেটির সঙ্গেই আপডেট হয়|আপডেট খুঁজুন|প্রতি 6 ঘণ্টায় নতুন সংস্করণ খুঁজুন',
  ta: 'பற்றி|பதிப்பு|புதிய பதிப்பைத் தேட கிளிக் செய்யவும்|சரிபார்க்கிறது…|இதுவே சமீபத்திய பதிப்பு|பதிப்பு {v} வந்துவிட்டது|புதியவை|புதுப்பி|பிறகு|{v}-க்குப் புதுப்பிக்கிறது…|{v}-க்குப் புதுப்பிக்கப்பட்டது|புதுப்பிப்பை முடிக்க Claude Code-ஐ மீண்டும் தொடங்கவும்|சரிபார்க்க முடியவில்லை: {e}|புதுப்பிக்க முடியவில்லை: {e}|கோப்புறையிலிருந்து நிறுவப்பட்டது: அதனுடன் புதுப்பிக்கப்படும்|புதுப்பிப்புகளைச் சரிபார்|ஒவ்வொரு 6 மணி நேரமும் புதிய பதிப்பைத் தேடு',
  te: 'గురించి|వెర్షన్|కొత్త వెర్షన్ కోసం క్లిక్ చేయండి|తనిఖీ చేస్తోంది…|ఇదే తాజా వెర్షన్|వెర్షన్ {v} వచ్చింది|కొత్తవి|అప్‌డేట్ చేయి|తర్వాత|{v}కి అప్‌డేట్ అవుతోంది…|{v}కి అప్‌డేట్ అయింది|అప్‌డేట్ పూర్తి చేయడానికి Claude Code‌ను మళ్లీ ప్రారంభించండి|తనిఖీ చేయలేకపోయింది: {e}|అప్‌డేట్ చేయలేకపోయింది: {e}|ఫోల్డర్ నుండి ఇన్‌స్టాల్: దానితో పాటే అప్‌డేట్ అవుతుంది|అప్‌డేట్‌ల కోసం చూడు|ప్రతి 6 గంటలకు కొత్త వెర్షన్ కోసం చూడు',
  kn: 'ಕುರಿತು|ಆವೃತ್ತಿ|ಹೊಸ ಆವೃತ್ತಿ ಹುಡುಕಲು ಕ್ಲಿಕ್ ಮಾಡಿ|ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ…|ಇದು ಇತ್ತೀಚಿನ ಆವೃತ್ತಿ|ಆವೃತ್ತಿ {v} ಬಂದಿದೆ|ಹೊಸದೇನು|ಅಪ್‌ಡೇಟ್ ಮಾಡಿ|ನಂತರ|{v}ಗೆ ಅಪ್‌ಡೇಟ್ ಆಗುತ್ತಿದೆ…|{v}ಗೆ ಅಪ್‌ಡೇಟ್ ಆಗಿದೆ|ಅಪ್‌ಡೇಟ್ ಮುಗಿಸಲು Claude Code ಅನ್ನು ಮತ್ತೆ ಆರಂಭಿಸಿ|ಪರಿಶೀಲಿಸಲಾಗಲಿಲ್ಲ: {e}|ಅಪ್‌ಡೇಟ್ ಮಾಡಲಾಗಲಿಲ್ಲ: {e}|ಫೋಲ್ಡರ್‌ನಿಂದ ಸ್ಥಾಪಿಸಲಾಗಿದೆ: ಅದರೊಂದಿಗೆ ಅಪ್‌ಡೇಟ್ ಆಗುತ್ತದೆ|ಅಪ್‌ಡೇಟ್ ಪರಿಶೀಲಿಸಿ|ಪ್ರತಿ 6 ಗಂಟೆಗೆ ಹೊಸ ಆವೃತ್ತಿ ಹುಡುಕಿ',
  ml: 'വിവരം|പതിപ്പ്|പുതിയ പതിപ്പ് നോക്കാൻ ക്ലിക്ക് ചെയ്യുക|പരിശോധിക്കുന്നു…|ഇതാണ് ഏറ്റവും പുതിയ പതിപ്പ്|പതിപ്പ് {v} പുറത്തിറങ്ങി|പുതിയത് എന്ത്|അപ്‌ഡേറ്റ് ചെയ്യുക|പിന്നീട്|{v}-ലേക്ക് അപ്‌ഡേറ്റ് ചെയ്യുന്നു…|{v}-ലേക്ക് അപ്‌ഡേറ്റ് ചെയ്തു|അപ്‌ഡേറ്റ് പൂർത്തിയാക്കാൻ Claude Code വീണ്ടും തുടങ്ങുക|പരിശോധിക്കാനായില്ല: {e}|അപ്‌ഡേറ്റ് ചെയ്യാനായില്ല: {e}|ഫോൾഡറിൽ നിന്ന് ഇൻസ്റ്റാൾ ചെയ്തു: അതിനൊപ്പം അപ്‌ഡേറ്റ് ആകും|അപ്‌ഡേറ്റുകൾ പരിശോധിക്കുക|ഓരോ 6 മണിക്കൂറിലും പുതിയ പതിപ്പ് തിരയുക',
  am: 'ስለ|ስሪት|አዲስ ስሪት ለመፈለግ ጠቅ ያድርጉ|በማረጋገጥ ላይ…|ይህ የቅርብ ጊዜው ስሪት ነው|ስሪት {v} ወጥቷል|ምን አዲስ ነገር አለ|አዘምን|በኋላ|ወደ {v} በማዘመን ላይ…|ወደ {v} ተዘምኗል|ዝማኔውን ለመጨረስ Claude Codeን እንደገና ያስጀምሩ|ማረጋገጥ አልተቻለም፦ {e}|ማዘመን አልተቻለም፦ {e}|ከአቃፊ የተጫነ፦ ከእሱ ጋር ይዘምናል|ዝማኔዎችን ፈልግ|በየ6 ሰዓቱ አዲስ ስሪት ፈልግ',
  ha: 'Game da|Siga|Danna don neman sabuwar siga|Ana dubawa…|Wannan ita ce sabuwar siga|Siga {v} ta fito|Me ya sabunta|Sabunta|Daga baya|Ana sabuntawa zuwa {v}…|An sabunta zuwa {v}|Sake kunna Claude Code don gama sabuntawa|Ba a iya dubawa ba: {e}|Ba a iya sabuntawa ba: {e}|An saka daga babban fayil: yana sabuntawa tare da shi|Duba sabuntawa|Nemi sabuwar siga kowane awa 6',
  sw: 'Kuhusu|Toleo|Bofya ili kutafuta toleo jipya|Inakagua…|Hili ndilo toleo jipya zaidi|Toleo {v} limetoka|Kipi kipya|Sasisha|Baadaye|Inasasisha hadi {v}…|Imesasishwa hadi {v}|Anzisha upya Claude Code ili kumaliza kusasisha|Imeshindwa kukagua: {e}|Imeshindwa kusasisha: {e}|Imesakinishwa kutoka folda: inasasishwa pamoja nayo|Angalia masasisho|Tafuta toleo jipya kila saa 6',
}
const wordsOf = (lang: string): Words => {
  const parts = (WORDS[lang] ?? WORDS.en ?? '').split('|')
  const more = (VERSION_WORDS[lang] ?? VERSION_WORDS.en ?? '').split('|')
  return Object.fromEntries([...WORD_KEYS.map((k, i) => [k, parts[i] ?? '']), ...VERSION_KEYS.map((k, i) => [k, more[i] ?? ''])]) as Words
}
// a language tag (ru, pt-BR, zh-Hant-TW, es-MX) to one of WORDS, or '' for none of them
function fromTag(tag: string) {
  const [base = '', ...rest] = tag.trim().toLowerCase().replaceAll('_', '-').split('-')
  if (base === 'zh') return rest.includes('hans') ? 'zh-CN' : rest.some(r => ['hant', 'tw', 'hk', 'mo'].includes(r)) ? 'zh-TW' : 'zh-CN'
  if (base === 'es') return rest.length === 0 || rest.includes('es') ? 'es' : 'es-419'
  if (base === 'pt') return 'pt-BR'
  if (base === 'no' || base === 'nn') return 'nb'
  if (base === 'tl') return 'fil'
  return Object.hasOwn(WORDS, base) ? base : ''
}
// a name of Chinese that says which script, or where it is written
const TRADITIONAL = /traditional|taiwan|hong kong|macau|hant|繁|正體|台灣|臺灣|香港/
const SIMPLIFIED = /simplified|hans|简体|简化|大陆|中国大陆/
// the language /config language names (a name in English or in the language itself, or a tag), or '' for none of them;
// unset, the row reads "Default (English)", which names no choice. 'zh' for a Chinese that says no script
function fromLanguage(language: string) {
  const v = language.trim().toLowerCase()
  if (!v || /^default\b/.test(v)) return ''
  if (v === 'zh') return 'zh'
  let found = fromTag(v)
  let longest = 0
  if (!found)
    for (const [lang, names] of Object.entries(LANG_NAMES))
      for (const name of names.split(','))
        if (name.length > longest && v.includes(name)) {
          found = lang
          longest = name.length
        }
  if (found === 'zh-CN' && !fromTag(v)) return TRADITIONAL.test(v) ? 'zh-TW' : SIMPLIFIED.test(v) ? 'zh-CN' : 'zh'
  return found
}
// the language the desktop app speaks, as its own settings pick it from these same 35 ("locale" in its config.json);
// '' where there is no app or it says none
async function readAppLocale($: EngineInterface) {
  try {
    const [appData, home] = await Promise.all([$.env.get('APPDATA'), $.env.get('HOME')])
    const paths = appData ? [`${appData}/Claude/config.json`] : home ? [`${home}/Library/Application Support/Claude/config.json`, `${home}/.config/Claude/config.json`] : []
    for (const path of paths) {
      const text = await $.fs.read(path).catch(() => '')
      const locale: unknown = text ? (JSON.parse(text) as { locale?: unknown }).locale : undefined
      if (typeof locale === 'string' && locale) return locale
    }
  } catch {}
  return ''
}
// the system's language, read once: the locale variables, else Windows' own setting (the engine's Intl says en-US there
// whatever the system speaks); '' when neither says
let systemLocale: string | null = null
async function readSystemLocale($: EngineInterface) {
  try {
    const vars = await Promise.all([$.env.get('LC_ALL'), $.env.get('LC_MESSAGES'), $.env.get('LANG')])
    const set = vars.find(v => v && !/^(C|POSIX)([._@]|$)/.test(v))
    if (set) return set.split(/[.@]/)[0] ?? ''
  } catch {}
  if (/^[A-Za-z]:/.test($.plugin.root)) {
    const r = await $.process.run(['reg', 'query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { timeoutMs: 2000 }).catch(() => null)
    const found = r ? /LocaleName\s+REG_SZ\s+(\S+)/.exec(r.stdout) : null
    if (found?.[1]) return found[1]
  }
  return ''
}
const intlLocale = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return ''
  }
}
let langCode = 'en'
let words = wordsOf('en')
// true when the language changed: the caller then writes the choices, which draws the footer and the window again
const useLang = (code: string) => {
  if (code === langCode || !Object.hasOwn(WORDS, code)) return false
  langCode = code
  words = wordsOf(code)
  return true
}
// the window speaks the language Claude answers in (/config language), else the desktop app's, else the system's, else
// English; a Chinese that names no script takes the one the app or the system writes in. Read when the session starts
// and each time the window opens, so a language set in between is spoken next
async function readWords($: EngineInterface, rows: readonly { key: string; value: unknown }[]) {
  const row = rows.find(r => r.key === 'language')
  const named = fromLanguage(typeof row?.value === 'string' ? row.value : '')
  if (named && named !== 'zh') return useLang(named)
  const local = fromTag(await readAppLocale($)) || fromTag((systemLocale ??= await readSystemLocale($))) || fromTag(intlLocale())
  return useLang(named === 'zh' ? (local === 'zh-TW' ? 'zh-TW' : 'zh-CN') : local || 'en')
}
// one row of the window: a switch, the seconds a finished bar stays, or the version (by key), whose line may end in a link
type SettingRow = { key: string; title: string; about: string; isOn?: boolean; press?: () => Promise<void>; link?: { href: string; label: string } }

// the desktop's controls, drawn as Claude Desktop's own settings draw them and following its theme: a Button's label is
// text only, so the picture sits under a Button that takes the presses (the fold chip's way). The desktop draws a
// Button's label alone, never its children, so the label is what is widened, with figure spaces: a run of plain ones
// collapses to one, and a press then lands at the centre only
// the plain Button's own hover plate, cleared: the desktop writes a Button's hover, under its keyed Box, as !important
// rules on the button itself, a raw colour only as hex or rgb(); a dim label still brightens under the pointer
const NO_PLATE = { backgroundColor: '#0000' }
// the width a plain Button takes on the desktop at its largest, the pane's text 14 px with 6 px of padding a side (its
// density tokens): a label wider than the box it sits in is cut with an ellipsis, so a box under one is made this wide.
// A figure space is a digit wide
const buttonW = (label: string) => Math.ceil(labelWidth(label.replaceAll(FIGURE_SPACE, '0'), 14, false) + 12)
// a switch: blue with the knob right when on, grey with it left when off. The blank label over it is four figure spaces,
// so a press lands on the whole switch; the picture is as wide as that Button at its largest, the switch at its right
// edge, where the Button is put
const SWITCH_W = 36
const SWITCH_H = 20
const SWITCH_LABEL = FIGURE_SPACE.repeat(4)
const SWITCH_BOX = Math.max(SWITCH_W, buttonW(SWITCH_LABEL))
const switchSvg = (isOn: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SWITCH_BOX}" height="${SWITCH_H}" viewBox="0 0 ${SWITCH_BOX} ${SWITCH_H}"><style>.sw{fill:${isOn ? '#2C84DB' : '#5B5A55'}}` +
  `@media (prefers-color-scheme:light){.sw{fill:${isOn ? '#2C84DB' : '#C8C6BD'}}}</style>` +
  `<rect class="sw" x="${SWITCH_BOX - SWITCH_W}" width="${SWITCH_W}" height="${SWITCH_H}" rx="${SWITCH_H / 2}"/>` +
  `<circle cx="${SWITCH_BOX - (isOn ? SWITCH_H / 2 : SWITCH_W - SWITCH_H / 2)}" cy="${SWITCH_H / 2}" r="${SWITCH_H / 2 - 2}" fill="#FFFFFF"/></svg>`
// one cell of the segmented control: its share of the track, rounded at the two outer ends only, and the raised thumb
// under the picked one; the thumb dimmer while auto-close is off, when the seconds wait for it
const SEG_H = 26
const segSvg = (w: number, i: number, count: number, isPicked: boolean, isLive: boolean) => {
  const r = 8
  const x = i === 0 ? 0 : -r
  const width = w + (i === 0 ? 0 : r) + (i === count - 1 ? 0 : r)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${SEG_H}" viewBox="0 0 ${w} ${SEG_H}"><style>.tr{fill:#000000;fill-opacity:.28}.th{fill:#FFFFFF;fill-opacity:.14}` +
    `@media (prefers-color-scheme:light){.tr{fill-opacity:.06}.th{fill-opacity:1;stroke:#000000;stroke-opacity:.12}}</style>` +
    `<rect class="tr" x="${x}" width="${width}" height="${SEG_H}" rx="${r}"/>` +
    (isPicked ? `<rect class="th" x="2.5" y="2.5" width="${w - 5}" height="${SEG_H - 5}" rx="6" opacity="${isLive ? 1 : 0.55}"/>` : '') +
    `</svg>`
  )
}
// a hairline between the desktop's rows, stretched to the pane's width; its height is the room around it
const RULE = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="13" viewBox="0 0 2000 13" preserveAspectRatio="none"><rect y="6" width="2000" height="1" fill="#808080" fill-opacity=".22"/></svg>`

// the version row's line for where a check or an update stands; the newer release's line ends in its notes
const versionLine = (s: VersionState, me: Install, w: Words): Pick<SettingRow, 'about' | 'link'> => {
  const v = (text: string, version: string) => text.replace('{v}', version)
  switch (s.phase) {
    case 'checking':
      return { about: w.checking }
    case 'latest':
      return { about: w.latest }
    case 'available':
      return { about: v(w.avail, s.version), ...(s.url ? { link: { href: s.url, label: w.notes } } : {}) }
    case 'updating':
      return { about: v(w.updating, s.version) }
    case 'installed':
      return { about: v(s.version === me.version ? w.updated : w.updating, s.version) }
    case 'restart':
      return { about: w.restart }
    case 'failed':
      return { about: (s.what === 'check' ? w.failc : w.failu).replace('{e}', s.detail) }
    case 'folder':
      return { about: w.folder }
    default:
      return { about: w.verd }
  }
}

// one pane, opened by a press or a command, so it is placed at any width; the engine draws its close control and
// Escape closes it. Inline on the terminal it asks room for three heads, seven rows and the lines between the sections
async function openSettings($: EngineInterface) {
  if (await readWords($, await Promise.resolve().then(() => $.config.list()).catch(() => []))) await holdChoices($)
  return $.ui.open({ id: SETTINGS, title: 'Plan progress', focus: true, closeOnEscape: true, rows: 12 })
}

// the choices are written to $.state with every change: the footer and the window draw them again, and a reload of the
// mod (an option set in the window) takes them back from there, even when the store cannot keep them (fromStore)
async function holdChoices($: EngineInterface) {
  await update($, prefs, held => ({ autoclose: isAutoClose, sounds: isSoundOn, speedShown: isSpeedShown, updateCheck: isUpdateCheckOn, lang: langCode, rev: (held?.rev ?? 0) + 1 }))
}

async function setChoice($: EngineInterface, key: typeof AUTOCLOSE | typeof SOUNDS | typeof SPEED_SHOWN | typeof UPDATE_CHECK, isOn: boolean) {
  if (key === AUTOCLOSE) isAutoClose = isOn
  else if (key === SOUNDS) isSoundOn = isOn
  else if (key === UPDATE_CHECK) isUpdateCheckOn = isOn
  else isSpeedShown = isOn
  // drawn first, kept after: the store writes a file
  await holdChoices($)
  await Promise.resolve()
    .then(() => $.store.set(key, isOn))
    .catch(() => {})
}

// written to the settings as /config writes it; the mod then reloads with the new options, and the window stays open.
// A press while a set is on its way is dropped: the old window still shows the old value, and the engine takes the
// same value sent again as no change
let isSettingOption = false
async function setOption($: EngineInterface, field: 'twinkle' | 'doneBarSeconds', value: boolean | number) {
  if (isSettingOption) return
  isSettingOption = true
  try {
    const once = () =>
      Promise.resolve()
        .then(() => $.config.set({ key: `plan-progress.${field}`, value }))
        .catch((err: unknown) => ({ deny: String(err) }))
    let set = await once()
    // the engine reads a plugin's /config rows off its list of loaded plugins, which a reload of that list (the plugin
    // sync just after a session starts, seen in a real terminal) leaves without them for a moment: refused as having
    // "no /config row", the set is tried again a little later before the refusal is shown
    for (let wait = 400; set.deny?.includes('no /config row') && wait <= 1600; wait *= 2) {
      await $.clock.sleep(wait)
      set = await once()
    }
    if (set.deny) $.ui.toast(`plan-progress: ${set.deny}`)
  } finally {
    isSettingOption = false
  }
}

// the version row: the mod's own version, and on a press the newest published release of it. The marketplace repo holds
// several mods, so a release is ours by its tag (plan-progress-v1.2.3); drafts and pre-releases are not offered.
// PLAN_PROGRESS_RELEASES_URL points the check elsewhere (a local stand-in for GitHub while the update is developed)
const RELEASES = 'https://api.github.com/repos/zycck/claude-mods/releases?per_page=100'
const RELEASE_TAG = 'plan-progress-v'
// where a check or an update stands, in $.state: the window draws it, and it outlives the reload an update ends with
const versionState = atom({ plugin: 'plan-progress', key: 'version' } as const, { phase: 'idle' } as VersionState)
// how this copy is installed: its version, and the marketplace it came from, or none for a folder (--plugin-dir, a dev
// mod), which updates with its folder and not through `claude plugin update`
type Install = { version: string; market: string | null }
let install: Promise<Install> | null = null
const samePath = (a: string, b: string) => {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '')
  const [x, y] = [norm(a), norm(b)]
  return /^[A-Za-z]:/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y
}
async function readInstall($: EngineInterface): Promise<Install> {
  const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => '{}')
  const version = String((JSON.parse(manifest) as { version?: unknown }).version ?? '')
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
    const list = JSON.parse(await $.fs.read(`${dir}/plugins/installed_plugins.json`)) as { plugins?: Record<string, { installPath?: string }[]> }
    for (const [id, rows] of Object.entries(list.plugins ?? {}))
      for (const row of rows)
        if (id.startsWith('plan-progress@') && row.installPath && samePath(row.installPath, $.plugin.root))
          return { version, market: id.slice('plan-progress@'.length) }
  } catch {}
  return { version, market: null }
}
// 1.10.0 after 1.9.2; a part that is no number counts as 0
const isNewer = (a: string, b: string) => {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}
// the newest of our releases in GitHub's list, or null for none
const newestRelease = (list: unknown) => {
  let best: { version: string; url: string } | null = null
  for (const r of Array.isArray(list) ? (list as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; html_url?: unknown }[]) : []) {
    const tag = typeof r.tag_name === 'string' ? r.tag_name : ''
    const version = tag.startsWith(RELEASE_TAG) ? tag.slice(RELEASE_TAG.length) : ''
    if (!/^\d+(\.\d+)*$/.test(version) || r.draft === true || r.prerelease === true) continue
    if (!best || isNewer(version, best.version)) best = { version, url: typeof r.html_url === 'string' ? r.html_url : '' }
  }
  return best
}
// what went wrong, short enough for the line under the title
const shortReason = (text: string) => {
  const line = text.trim().split('\n').filter(Boolean).at(-1) ?? ''
  return (line.length > 80 ? `${line.slice(0, 79)}…` : line) || 'unknown error'
}
// a check or an update on its way; an installed version waits for the reload, which this copy outlives only when the
// reload did not take (then restart says so)
const isVersionBusy = (s: VersionState, me: Install) => s.phase === 'checking' || s.phase === 'updating' || (s.phase === 'installed' && s.version !== me.version)

async function setVersion($: EngineInterface, next: VersionState) {
  await update($, versionState, () => next)
}
// the keyboard's ring follows the row as its buttons change (the ↻ becomes Update and Later, and back), or it is left
// on nothing and the next Tab starts over; refused, and nothing done, where the window does not hold the keys
async function ringOn($: EngineInterface, key: string) {
  await Promise.resolve()
    .then(() => $.ui.focus({ requestId: SETTINGS, key }))
    .catch(() => {})
}

// a press on the version: looks for a newer release. A folder install is not checked, it updates with its folder
// the newest release of this mod, or null for none; what was found is kept in the store with the time, so every
// session (and the next one) knows it without asking GitHub again
async function fetchNewest($: EngineInterface) {
  const url = (await $.env.get('PLAN_PROGRESS_RELEASES_URL')) || RELEASES
  const r = await $.http.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'plan-progress' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const newest = newestRelease(JSON.parse(r.text))
  await Promise.resolve()
    .then(async () => {
      await $.store.set(CHECKED_AT, await $.clock.now())
      await $.store.set(FOUND, newest)
    })
    .catch(() => {})
  return newest
}

async function checkVersion($: EngineInterface) {
  const me = await (install ??= readInstall($))
  if (isVersionBusy(await read($, versionState), me)) return
  if (!me.market) return void (await setVersion($, { phase: 'folder' }))
  await setVersion($, { phase: 'checking' })
  let next: VersionState
  try {
    const newest = await fetchNewest($)
    next = newest && isNewer(newest.version, me.version) ? { phase: 'available', ...newest } : { phase: 'latest' }
  } catch (err) {
    next = { phase: 'failed', what: 'check', detail: shortReason(err instanceof Error ? err.message : String(err)) }
  }
  await setVersion($, next)
  if (next.phase === 'available') await ringOn($, 'version-update')
}

// the check on its own: when the session starts and every half hour after, it asks GitHub when the last answer (any
// session's) is six hours old, and offers what it found, a blue mark by the footer's ⚙ saying so. Quiet: a failure
// shows nothing, and the window's states on their way or waiting for a restart are left alone (an offer replaces an
// answer or a failure). Off with the window's switch, for a folder install, and where non-essential traffic is off
const CHECKED_AT = 'updateCheckedAt'
const FOUND = 'updateFound'
const DISMISSED = 'updateDismissed'
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
async function autoCheck($: EngineInterface) {
  if (!isUpdateCheckOn || (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))) return
  const me = await (install ??= readInstall($))
  if (!me.market) return
  const checkedAt = await fromStore($, CHECKED_AT)
  let found = (await fromStore($, FOUND)) as { version: string; url: string } | null | undefined
  if (typeof checkedAt !== 'number' || (await $.clock.now()) - checkedAt >= CHECK_EVERY_MS) found = await fetchNewest($).catch(() => found)
  if (!found || !isNewer(found.version, me.version) || (await fromStore($, DISMISSED)) === found.version) return
  const offer = found
  await update($, versionState, (s): VersionState => (s.phase === 'idle' || s.phase === 'latest' || s.phase === 'failed' ? { phase: 'available', ...offer } : s))
}

// the CLI's --json answer: its last line that parses
const lastJson = (text: string) => {
  for (const line of text.trim().split('\n').reverse())
    try {
      return JSON.parse(line) as { outcome?: string; updateOutcome?: string; newVersion?: string; message?: string }
    } catch {}
  return null
}
// the claude to run: the session's own binary where the host names it (the desktop's is off PATH), else the one on
// PATH, which may be another version: the commands below are ones 2.1.286 already knows
async function claudeCli($: EngineInterface) {
  const own = (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? ''
  return /(^|[\\/])claude(\.exe)?$/i.test(own) ? own : 'claude'
}
// Update: the marketplace is pulled first (without it `claude plugin update` finds nothing new), then the plugin, in
// the scope the CLI finds it in; the running session then reloads its plugins, which loads the new version in place.
// The CLI says to restart, but a /reload-plugins run from here was seen to load it (on a local stand-in marketplace,
// in the terminal)
async function updateVersion($: EngineInterface) {
  const s = await read($, versionState)
  if (s.phase !== 'available') return
  const me = await (install ??= readInstall($))
  if (!me.market) return
  await setVersion($, { phase: 'updating', version: s.version })
  await ringOn($, 'version')
  try {
    const cli = await claudeCli($)
    // `marketplace update` has no --json before 2.1.295: its exit code says
    const pulled = await $.process.run([cli, 'plugin', 'marketplace', 'update', me.market], { timeoutMs: 180_000 })
    if (pulled.exitCode !== 0) throw new Error(pulled.stderr || pulled.stdout)
    const ran = await $.process.run([cli, 'plugin', 'update', `plan-progress@${me.market}`, '--json'], { timeoutMs: 180_000 })
    const res = lastJson(ran.stdout)
    if (ran.exitCode !== 0 || res?.outcome !== 'ok') throw new Error(res?.message ?? (ran.stderr || ran.stdout))
    // nothing installed: the marketplace does not have the release yet. Already there counts when it is newer than this
    // copy: an update whose reload did not take, pressed again
    if (res.updateOutcome !== 'updated' && !(res.newVersion && isNewer(res.newVersion, me.version))) throw new Error(res.message ?? 'nothing to update')
    const version = res.newVersion ?? s.version
    await setVersion($, { phase: 'installed', version })
    // a command waits for the session to be idle, the press's own turn included: started after it
    $.clock.after(300, () => void reloadPlugins($, version))
  } catch (err) {
    await setVersion($, { phase: 'failed', what: 'update', detail: shortReason(err instanceof Error ? err.message : String(err)) })
  }
}
// the reload unloads this module and loads the new one, whose timers start over: this one's timer firing means the
// old code is still running, so the update waits for a restart
async function reloadPlugins($: EngineInterface, version: string) {
  const isRun = await $.command.run({ command: 'reload-plugins', args: '' }).then(
    () => true,
    () => false,
  )
  if (!isRun) return void (await setVersion($, { phase: 'restart', version }))
  $.clock.after(5000, () => void update($, versionState, (s): VersionState => (s.phase === 'installed' && s.version === version ? { phase: 'restart', version } : s)))
}
// the mod loaded again: a check or an update on its way went with the old code (its waits are cancelled), so the row
// starts over; an installed update is done when this copy is it, and waits for a restart when the reload brought the
// old one back
async function settleVersion($: EngineInterface) {
  const me = await (install ??= readInstall($))
  await update($, versionState, (s): VersionState => {
    if (s.phase === 'checking' || s.phase === 'updating') return { phase: 'idle' }
    if (s.phase === 'installed' && s.version !== me.version) return { phase: 'restart', version: s.version }
    if (s.phase === 'restart' && s.version === me.version) return { phase: 'installed', version: s.version }
    return s
  })
}
// Later: the dot goes, and the timer does not bring this version back; a newer one, or a press on the version, does
async function dismissVersion($: EngineInterface) {
  const s = await read($, versionState)
  if (s.phase === 'available')
    await Promise.resolve()
      .then(() => $.store.set(DISMISSED, s.version))
      .catch(() => {})
  await setVersion($, { phase: 'idle' })
  await ringOn($, 'version')
}

// leftAt: the clock's time when it let the bar go. The bar is looked at again as it is taken away, since an agent that
// landed on it meanwhile (the Agents bar is where a new one goes) has it running again, and would go with it for good
async function dropPlan($: EngineInterface, id: string, leftAt?: number) {
  let gone = null as Plan | null
  await update($, plans, list => {
    gone = list.find(p => p.id === id && (leftAt === undefined || hasLeft(p, leftAt))) ?? null
    return list.filter(p => p !== gone)
  })
  if (!gone) return
  lastHead.delete(id)
  waveFrom.delete(id)
  drawn.delete(id)
  glide.delete(id)
  stillPhase.delete(id)
  for (const a of gone.agents ?? []) lastStrip.delete(a.id)
  await saveNow($)
}

// substeps are left out: the bar never draws them and short ops cannot reach them; a plain string is its title
const STEP_SCHEMA = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        status: { enum: STATUSES, description: 'Default pending' },
      },
    },
  ],
}

// edits are the work the enforcement below counts. Shell calls are never refused or counted: the host marks only
// plain reads (ls) read-only, so a compound read (cd x && git log) would look like work and be refused
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
// the person's own messages, wherever they typed them: the prompt, Remote Control, an SDK host, a Slack ping
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const WORK_BEFORE_PLAN = 3 // the 4th edit without a plan is refused once
const CALLS_BEFORE_NUDGE = 6 // edits without a plan update before a reminder
// the file plan mode has Claude build its plan in, a write at a time: as the engine's plan-mode note names it, else
// where plans are kept by default. Writing it is planning, so it neither counts as work nor is refused
let planFile = ''
const slashed = (path: string) => path.replace(/\\/g, '/').toLowerCase()
const isPlanFile = (path: unknown) =>
  typeof path === 'string' && ((planFile !== '' && slashed(path) === planFile) || /\/\.claude\/plans\/[^/]+\.md$/.test(slashed(path)))



// $.state lives as long as the process, so the bars are kept per session in the plugin's store as well
const SAVED = 'plans:'
const KEEP_SESSIONS = 20
// what was saved last, as text: every read of $.state is a fresh copy, so only the content tells a change
let lastSaved = ''
// the session whose bars $.state holds, the only one the bars are saved under. A /clear or a /resume inside a
// running app wipes the state and goes on under another id with no session.start; between session.end and the
// new id the wiped state is nobody's, so endedSession keeps it from being saved over the session that ended
let shownSession = ''
let endedSession = ''
// when a save last failed: the timer tries a store that cannot be written again after SAVE_RETRY_MS, not every second;
// session.end, the last chance, tries it at once
let saveFailedAt = -Infinity
const SAVE_RETRY_MS = 30_000

// the store is a file the host keeps, and one it cannot read (cut short or left empty by a crash) throws on every call:
// that costs the saved bars and the auto-close choice, never the session start or the clock that runs after it
async function fromStore($: EngineInterface, key: string): Promise<unknown> {
  return Promise.resolve()
    .then(() => $.store.get(key))
    .catch(() => undefined)
}

async function savePlans($: EngineInterface, list: Plan[], text: string, isInPlace = false) {
  lastSaved = text
  const key = SAVED + shownSession
  try {
    if (list.length === 0) return void (await $.store.delete(key))
    // session.end's short bound can cut a $ call in flight, and a cut between a delete and a set would leave the
    // session nothing to resume: there the save only writes over the key, left where the timer's last save put it
    if (isInPlace) return void (await $.store.set(key, list))
    // set keeps a key where it first went in the store's order, so the session goes to the end anew: the
    // sessions trimmed are the ones left alone longest, not the ones saved first
    await $.store.delete(key)
    await $.store.set(key, list)
  } catch {
    // a store the host cannot write (fromStore) costs this save, not the bars on screen. It is owed, even if the bars
    // never change again (the delete may have gone through), and tried again once the store has had a while
    lastSaved = ''
    saveFailedAt = await $.clock.now()
    return
  }
  // the current session counts as one of the kept, whatever its place in the store's order; a trim that fails leaves
  // old sessions a while longer and this one saved
  await Promise.resolve()
    .then(async () => {
      const keys = (await $.store.keys()).filter(k => k.startsWith(SAVED) && k !== key)
      for (const old of keys.slice(0, Math.max(0, keys.length - (KEEP_SESSIONS - 1)))) await $.store.delete(old)
    })
    .catch(() => {})
}

// a bar taken away is saved at once: a reload before the next tick would find the state empty and bring the session's
// saved bars back
async function saveNow($: EngineInterface) {
  if (shownSession === '') return
  const list = await read($, plans)
  const text = JSON.stringify(list)
  if (text === lastSaved || (await $.clock.now()) - saveFailedAt < SAVE_RETRY_MS) return
  await savePlans($, list, text)
}

// a saved bar as the store hands it back: a file written over by hand or cut short can hold anything, and one bar
// without the parts the drawings read would fail every draw of the band, or the session start
const isSavedPlan = (p: unknown): p is Plan => {
  const v = p as Plan | null
  return (
    typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.title === 'string' && typeof v.state === 'string' &&
    Array.isArray(v.stages) &&
    v.stages.every(s => typeof s === 'object' && s !== null && Array.isArray(s.steps) && s.steps.every(t => typeof t === 'object' && t !== null && typeof t.title === 'string'))
  )
}

// agents do not outlive the process that ran them, so a restored bar comes back without strips, and the mod's
// own Agents bar, which only ever showed them, does not come back at all
async function restorePlans($: EngineInterface, id: string) {
  shownSession = id
  // nothing saved is nothing to delete
  lastSaved = '[]'
  const saved = await fromStore($, SAVED + id)
  if (!Array.isArray(saved) || saved.length === 0) return
  const list = saved.filter(isSavedPlan).filter(p => p.id !== AGENTS).map(p => ({ ...p, agents: [], agentsDoneAt: null, byAgent: undefined }))
  if (list.length === 0) return
  // bars the session made before the timer noticed the switch stay, after the restored ones
  await update($, plans, shown => [...list.filter(p => !shown.some(s => s.id === p.id)), ...shown])
  // lastSaved stays behind, so the next tick saves the session again and an opened session counts as used
  lastSaved = ''
}

// whether the tool reached the session, null until the first look. Missing, nothing asks Claude to use it (no
// refusal, no turn sent back, no reminders) and each turn looks again until it shows up; found, it is not looked for
// again
let hasTool: boolean | null = null
// whether the tool is known to be missing: looked up here while nothing is known yet (a reload mid-turn, a resumed
// session's first prompt, which comes before turn.start), so Claude is not sent to a tool it cannot call. Declared
// at the top of the file: the engine refuses a module that hands $ to a function declared anywhere else
async function isToolMissing($: EngineInterface) {
  if (hasTool === null) {
    const tools = await Promise.resolve()
      .then(() => $.tool.list())
      .catch(() => null)
    if (tools) hasTool = tools.some(t => t.name === TOOL)
  }
  return hasTool === false
}

export const register: Register = (on, options) => {
  const seconds = Number(options?.doneBarSeconds ?? 30)
  doneStaysMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000
  isTwinkling = options?.twinkle !== false

  // per-turn bookkeeping; module variables are fine here, a reload just starts a fresh count
  let workCalls = 0
  let sinceUpdate = 0
  let isPlanTouched = false
  let hasRefused = false
  let isWaitingOnBackground = false
  let hasWarnedNoTool = false

  on('prompt.attachment', async ($, e, next) => {
    if (!e.agentId && (e.type === 'plan_mode' || e.type === 'plan_mode_reentry' || e.type === 'plan_mode_exit') && e.detail?.planFilePath)
      planFile = slashed(e.detail.planFilePath)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isTurnLive = true
    workCalls = 0
    sinceUpdate = 0
    isPlanTouched = false
    hasRefused = false
    isWaitingOnBackground = false
    // the engine hands the tool to the session over HTTP on 127.0.0.1; an antivirus web filter or a proxy that
    // catches loopback breaks that, and the tool is simply missing, so say why once instead of drawing nothing
    if (hasTool !== true) {
      const tools = await Promise.resolve()
        .then(() => $.tool.list())
        .catch(() => null)
      if (tools) hasTool = tools.some(t => t.name === TOOL)
      if (hasTool === false && !hasWarnedNoTool) {
        hasWarnedNoTool = true
        const why = `plan-progress: the ${TOOL} tool did not reach this session, so Claude cannot draw bars. An antivirus web filter (AVG Web Shield, for one) or a proxy is likely blocking 127.0.0.1: add 127.0.0.1 to its exceptions, or set NO_PROXY=127.0.0.1,localhost, then restart Claude Code.`
        $.ui.log(why)
        $.ui.toast(why, { timeoutMs: 15000 })
      }
    }

    return next(e)
  })

  // the rule lives in the cached system prompt; a message only carries one short line when bars are open,
  // and the person answering clears any "needs input" without a model call
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.has(e.origin.kind)) return next(e)
    const list = await read($, plans)
    // the Agents bar waits on an agent's permission dialog, which a message does not answer
    if (list.some(p => p.state === 'needs_input' && p.id !== AGENTS)) {
      const now = await $.clock.now()
      await update($, plans, all => all.map(p => (p.state === 'needs_input' && p.id !== AGENTS ? answered(p, now) : p)))
      askedIds.clear()
    }
    const open = (await read($, plans)).filter(p => p.state !== 'done' && p.id !== AGENTS)
    if (open.length === 0 || (await isToolMissing($))) return next(e)
    const line = `plan-progress open bars: ${open
      .map(p => {
        const w = where(p)
        return `${p.id} (${p.stages[w.stage]?.name ?? ''} ${w.step}/${w.stageSize})`
      })
      .join(', ')}`

    return next({ ...e, context: [...(e.context ?? []), line] })
  })

  // watches the main loop's changing calls: refuses once when multi-step work starts without a bar,
  // and reminds to update the bar when it goes stale mid-turn
  on('tool.call', async ($, e, next) => {
    // a subagent's call only names its current tool on its strip; no gate, no reminders
    if (e.agentId) {
      const agentId = e.agentId
      if (!(await knowAgent($, agentId, true))) return next(e)
      const useId = e.tool_use_id ?? `${agentId}#${++flightCount}`
      flights.set(useId, { agentId, tool: e.tool, isAsked: false })
      await showAgent($, agentId)
      try {
        return await next(e)
      } finally {
        flights.delete(useId)
        await showAgent($, agentId, e.tool)
      }
    }
    if (SHELL_TOOLS.has(e.tool)) {
      isWaitingOnBackground = (e as unknown as Raw).run_in_background === true
      return next(e)
    }
    if (!EDIT_TOOLS.has(e.tool) || isPlanFile((e as unknown as Raw).file_path)) return next(e)
    isWaitingOnBackground = false
    // a bar a subagent made is its own to move: it neither stands in for the main loop's bar nor is reminded of
    const open = (await read($, plans)).filter(p => isOpenPlan(p) && !p.byAgent)
    const hasLivePlan = isPlanTouched || open.length > 0
    if (!hasLivePlan && !hasRefused && workCalls >= WORK_BEFORE_PLAN && !(await isToolMissing($))) {
      hasRefused = true

      return { deny: `plan-progress: several changes ahead. Create a bar with ${TOOL} first, then retry.` }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    workCalls += 1
    sinceUpdate += 1
    // a finished bar keeps the gate shut but has nothing left to update, so only an open one is reminded of
    if (open.length > 0 && sinceUpdate >= CALLS_BEFORE_NUDGE && !(await isToolMissing($))) {
      sinceUpdate = 0
      const ids = open.map(p => p.id).join(', ')

      return { ...ran, context: [...(ran.context ?? []), `plan-progress: ${ids} not updated for a while; send {id, next:true} or {id, done, active}.`] }
    }

    return ran
  })

  // an open bar at the end of a turn: a question to the user marks it waiting on its own;
  // only a turn that did work and left the bar unexplained is sent back once
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active || result.block) return result
    // a bar a subagent made is its own: the main loop's question is not about it, nor is it held to account here
    const open = (await read($, plans)).filter(p => isOpenPlan(p) && !p.byAgent)
    if (open.length === 0) return result
    // ？ and ؟ are the full-width (zh, ja) and Arabic marks; bold, code, a bracket or a quote may close the question
    const asks = /[?？؟][*_`)\]"'»”’」』）]*\s*$/.test(e.last_assistant_message ?? '')
    if (asks) {
      // a bar Claude already set waiting is the one asked about: no second bar turns amber, no second chime
      if ((await waitingIds($)).length > 0) return result
      const last = open[open.length - 1]
      if (last) {
        await editPlan($, last.id, prev => (prev ? { ...prev, state: 'needs_input' } : 'skip'))
        askedIds.add(last.id)
      }

      return result
    }
    // a session waiting on its background work wakes again by itself (or never, a dev server): nothing to send back
    if (isWaitingOnBackground || (e.background_tasks?.length ?? 0) > 0) return result
    if ((workCalls === 0 && !isPlanTouched) || (await isToolMissing($))) return result

    return {
      ...result,
      block: `plan-progress: ${open.map(p => p.id).join(', ')} still open. Update each with ${TOOL}: {id, next:true}, or state "done", "needs_input" or "error" with a note.`,
    }
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined) {
      themeSetting = String(r.value)
      appearanceAt = -Infinity
      await syncTint($, await $.clock.now())
    }

    return r
  })

  on('session.start', async ($, e, next) => {
    // the window's choices before anything else: a reload starts from the defaults, and the footer and the window may
    // be drawn with them meanwhile. The session's own first (an option set in the window reloads the mod), else the store's
    const held = await read($, prefs)
    isAutoClose = held ? held.autoclose : (await fromStore($, AUTOCLOSE)) === true
    isSoundOn = held ? held.sounds : (await fromStore($, SOUNDS)) !== false
    isSpeedShown = held ? held.speedShown : (await fromStore($, SPEED_SHOWN)) !== false
    isUpdateCheckOn = held?.updateCheck ?? (await fromStore($, UPDATE_CHECK)) !== false
    // the language too, as the session last read it; read again below
    if (held?.lang) useLang(held.lang)
    await holdChoices($)
    // a reload of the mod keeps the bars (they are the host's) but starts its maps empty: agents still at work
    // find their strips again first thing, so their next calls and their finish are not lost (knowAgent covers
    // a call that comes in even sooner)
    const kept = await read($, plans)
    for (const p of kept) for (const a of p.agents ?? []) if (a.state === 'running' || a.state === 'waiting') agentHome.set(a.id, p.id)
    // and a batch that finished just before still folds away on time, and a teammate resting between its turns
    // (idle in the list) still wakes for its next one
    const start = await $.clock.now()
    for (const p of kept) if (p.agentsDoneAt && p.agentsDoneAt + FOLD_MS + 200 > start) foldAt.set(p.id, p.agentsDoneAt + FOLD_MS + 200)
    const finished = new Set(kept.flatMap(p => (p.agents ?? []).filter(a => a.state === 'done').map(a => a.id)))
    if (finished.size > 0) {
      const rows = await Promise.resolve()
        .then(() => $.agent.list())
        .catch(() => null)
      for (const row of rows ?? []) if (row.status === 'idle' && finished.has(row.id)) resting.add(row.id)
    }
    await $.tool.register({
      name: 'plan_progress',
      description: 'Live progress bar above the prompt, one per id. Create with title + stages; update with short ops (next, done, active, failed) or state.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Bar id; reuse it for updates' },
          title: { type: 'string' },
          kind: { enum: ['plan', 'todo'] },
          stages: {
            type: 'array',
            description: 'Full breakdown: when creating, or resent under the same id when the plan changes',
            items: { type: 'object', required: ['name', 'steps'], properties: { name: { type: 'string' }, steps: { type: 'array', items: STEP_SCHEMA } } },
          },
          steps: {
            type: 'array',
            description: 'One flat list (kind "todo") instead of stages: step titles or {title}',
            items: STEP_SCHEMA,
          },
          next: { type: 'boolean', description: 'Active step finished, start the next one' },
          done: { type: 'array', items: { type: 'string' }, description: 'Step titles now finished' },
          active: { type: 'string', description: 'Step title now in progress' },
          failed: { type: 'string', description: 'Step title that failed' },
          state: { enum: ['running', 'needs_input', 'error', 'done'] },
          note: { type: 'string', description: 'One line for needs_input or error' },
        },
      },
    })
    // a session reopened later (an app restart, a resume) finds its bars where it left them
    const session = await $.session.id()
    if (kept.length === 0) await restorePlans($, session)
    else shownSession = session
    const rows = await $.config.list().catch(() => [])
    const theme = rows.find(row => row.key === 'theme')
    themeSetting = String(theme?.value ?? 'dark')
    if (await readWords($, rows)) await holdChoices($)
    isLight = tintIsLight()
    await settleVersion($)
    // the update check waits a little after the start, out of the session's way
    $.clock.after(15_000, () => void autoCheck($))
    $.clock.every(30 * 60 * 1000, () => void autoCheck($))
    $.clock.every(1000, async () => {
      // the session changed under the mod (a /clear, a /resume): its bars are loaded here, as no session.start comes
      const id = await $.session.id()
      if (id !== shownSession && id !== endedSession) await restorePlans($, id)
      await settleAgents($)
      const list = await read($, plans)
      forgetGone(list)
      const now = await $.clock.now()
      for (const p of list) if (hasLeft(p, now)) await dropPlan($, p.id, now)
      syncFrames($, now)
      await syncTint($, now)
      // from the latest list: the one read above may predate a bar dropped just now
      await saveNow($)
      // clocks count inside the frame, so the only timed redraw is folding finished strips away
      const due = [...foldAt].filter(([, at]) => now >= at)
      if (due.length === 0) return
      for (const [id] of due) foldAt.delete(id)
      if (await read($, isOpen)) await update($, tick, n => n + 1)
    })
    await $.command.register({ name: 'progress', description: 'Show or hide the progress bars' })
    await $.command.register({ name: 'progress-clear', description: 'Remove all progress bars' })
    await $.command.register({ name: 'progress-agents', description: 'Fold or show the agent strips under the bars' })
    await $.command.register({ name: 'plan-progress-autoclose', description: 'Turn on or off finished bars leaving on their own' })
    await $.command.register({ name: 'plan-progress-settings', description: 'Open the plan-progress settings' })

    return next(e)
  })

  // the host wipes $.state right after this: the bars as they are now are the session's last save, and the timer
  // keeps off the wiped state until the next session's id shows
  on('session.end', async ($, e, next) => {
    try {
      if (e.sessionId === shownSession) {
        const list = await read($, plans)
        const text = JSON.stringify(list)
        if (text !== lastSaved) await savePlans($, list, text, true)
      }
    } finally {
      // even when the bound cut the save short: the timer must keep off the wiped state, and the host wipes the
      // footer's figure with it, so the next one is written again even if it reads the same
      endedSession = e.sessionId
      shownSession = ''
      lastSpeed.label = ''
      lastSpeed.at = -Infinity
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return { sections: [...result.sections, { id: 'plan-progress:rules', text: RULES, scope: 'session' as const }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const raw = e as unknown as Raw
    const now = await $.clock.now()
    // an id of emoji or punctuation alone names no bar: the title names it then, and with no title it is refused
    // rather than landing on the plan-mode bar
    const id = slug(str(raw.id, 60)) || slug(str(raw.title, 80))
    if (!id) return { deny: 'plan_progress: the id needs a letter or a digit, like "fix-login".' }
    const next = await editPlan(
      $,
      id,
      prev => {
        const made = normalize(raw, prev, now, id)
        if (typeof made === 'string') return made
        if (made.stages.length === 0) {
          // a breakdown that was sent but did not parse is a format problem, not a missing bar
          const sentAny = (Array.isArray(raw.stages) && raw.stages.length > 0) || (Array.isArray(raw.steps) && raw.steps.length > 0)
          return sentAny ? `plan_progress: could not read the breakdown for "${id}"; send stages:[{name, steps:[{title}]}], steps may be plain strings.` : `plan_progress: no bar "${id}" yet; create it with title and stages.`
        }
        // a bar belongs to the loop that made it; the main loop moving one takes it over. A subagent resumed under its id
        // (a message sent to it) takes back the bar it made, handed to the main loop when its run ended
        const isMine = !!prev && !prev.byAgent && handedOver.get(id) === e.agentId
        const owner = e.agentId ? (prev && !isMine ? prev.byAgent : e.agentId) : undefined
        return owner ? { ...made, byAgent: owner } : made
      },
      Boolean(e.agentId),
    )
    if (typeof next === 'string') return { deny: next }
    if (!e.agentId || next.byAgent === e.agentId) handedOver.delete(id)
    if (!e.agentId && next.state === 'needs_input') askedIds.add(id)
    else askedIds.delete(id)
    // the gate and the reminders count the main loop's own updates; a subagent's bar is not the main loop's
    if (!e.agentId) {
      isPlanTouched = true
      sinceUpdate = 0
    }
    const w = where(next)
    const active = next.state === 'done' ? undefined : next.stages.flatMap(st => st.steps).find(st => st.status === 'active')
    // the strips on the bar as stored, so the model sees which of its agents the bar tracks
    const runs = (await read($, plans)).find(p => p.id === id)?.agents ?? []
    const live = runs.filter(a => a.state === 'running' || a.state === 'waiting').length
    const agents = runs.length ? `, agents ${live} running of ${runs.length}` : ''

    return { result: `${id}: ${Math.min(w.pos, w.total)}/${w.total}, ${next.state}${active ? `, active "${active.title}"` : ''}${agents}` }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // a subagent's question goes to Claude, not to the person: no sound, no waiting bar
    if (e.agentId) return next(e)
    // a bar Claude already set waiting is the one asked about; else the latest task bar at work, never the Agents
    // bar, whose amber means an agent's dialog, nor a bar a subagent made for its own work
    const asked = await waitingIds($)
    const live = asked.length > 0 ? undefined : (await read($, plans)).filter(p => p.state === 'running' && p.id !== AGENTS && !p.byAgent).pop()
    if (live) await update($, plans, list => list.map(p => (p.id === live.id ? { ...p, state: 'needs_input' as const } : p)))
    if (asked.length === 0) play($, 'decision')
    const ran = await next(e)
    const now = await $.clock.now()
    await update($, plans, list =>
      list.map(p => (p.state !== 'needs_input' ? p : p.id === live?.id ? { ...p, state: 'running' as const } : asked.includes(p.id) ? answered(p, now) : p)),
    )
    for (const id of asked) askedIds.delete(id)

    return ran
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    // a subagent's or teammate's plan (a teammate's still goes to its lead for approval) is its own work: it never
    // takes the main loop's bar, nor plays the person's sound
    if (e.agentId) return next(e)
    const asked = await waitingIds($)
    if (asked.length === 0) play($, 'decision')
    const ran = await next(e)
    if (asked.length > 0) {
      const now = await $.clock.now()
      await update($, plans, list => list.map(p => (p.state === 'needs_input' && asked.includes(p.id) ? answered(p, now) : p)))
      for (const id of asked) askedIds.delete(id)
    }
    if (ran.deny !== undefined || ran.isError === true) return ran
    const text = (ran.result as { plan?: unknown } | undefined)?.plan
    const parsed = typeof text === 'string' ? parsePlan(text, await $.clock.now()) : null
    if (!parsed) return ran
    // a revised plan keeps what was finished; a plan approved after the last one finished is a new task
    await editPlan($, PLAN_ID, prev =>
      prev && !isNextTask(prev, parsed.title, parsed.stages)
        ? { ...parsed, stages: pointAt(carryDone(parsed.stages, prev.stages)), startedAt: prev.startedAt }
        : { ...parsed, stages: pointAt(parsed.stages), ...(prev ? afresh(prev) : {}) },
    )

    // the model learns which bar holds its plan, so it moves that one rather than opening its own (not when the tool
    // to move it never reached the session)
    if (await isToolMissing($)) return ran
    return { ...ran, context: [...(ran.context ?? []), `plan-progress: bar "${PLAN_ID}" shows this plan; move it with {id:"${PLAN_ID}", next:true} as steps finish.`] }
  })

  on('command.run', { command: 'progress' }, async $ => {
    if ((await read($, plans)).length === 0) return { text: 'No plan yet. A bar appears when Claude starts a task with several steps.' }
    const open = await read($, isOpen)
    await update($, isOpen, () => !open)

    return { text: open ? 'Progress bars hidden.' : 'Progress bars shown.' }
  })

  // folds every bar's agent strips at once, or shows them all again: the terminal outside fullscreen has no buttons
  on('command.run', { command: 'progress-agents' }, async $ => {
    const now = await $.clock.now()
    const list = await read($, plans)
    const foldable = new Set(list.filter(p => canFold(p, now, stripBudget(list.length))).map(p => p.id))
    if (foldable.size === 0) return { text: 'No agent strips to fold.' }
    const isFolding = list.some(p => foldable.has(p.id) && !p.isFolded)
    await update($, plans, all => all.map(p => (foldable.has(p.id) ? { ...p, isFolded: isFolding } : p)))

    return { text: isFolding ? 'Agent strips folded; /progress-agents shows them again.' : 'Agent strips shown.' }
  })

  on('command.run', { command: 'plan-progress-autoclose' }, async $ => {
    await setChoice($, AUTOCLOSE, !isAutoClose)
    const s = Math.round(doneStaysMs / 1000)

    return {
      text: isAutoClose
        ? `Finished bars leave ${s} s after they finish; /plan-progress-autoclose keeps them.`
        : 'Finished bars stay until closed; /plan-progress-autoclose turns auto-close on.',
    }
  })

  // the footer's ⚙ opens the same window; the terminal takes clicks only in fullscreen, and VS Code has no footer
  on('command.run', { command: 'plan-progress-settings' }, async $ => {
    // another plugin's ui.open hook may refuse it
    const opened = await openSettings($).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    if (typeof opened === 'string') return { text: `Settings did not open: ${opened}` }

    return { text: opened.isPlaced ? 'Settings are open.' : `Settings wait for room: ${opened.reason}` }
  })

  on('command.run', { command: 'progress-clear' }, async $ => {
    glide.clear()
    await update($, plans, () => [])
    await saveNow($)

    return { text: 'Progress bars removed.' }
  })

  // the footer reads how fast the model writes: bright while a response streams, dim with the last exact figure after it
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const s = await read($, speed)
    await read($, prefs)
    const hasNews = (await read($, versionState)).phase === 'available'
    const { Box, Button, Text } = $.ui.resolve(e)
    // other mods add their labels to modes beneath us; keep them
    const below = await next(e)
    // the ⚙ opens the settings window where a click reaches it: the desktop, the terminal in fullscreen
    const hasGear = e.surface === 'desktop' || e.viewport?.isFullscreen === true
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {isSpeedShown ? <Text dimColor={!s.isLive}>{speedLabel(s)}</Text> : null}
        {hasGear && hasNews && e.surface !== 'desktop' ? (
          <Button key="settings" plain label="⚙" onPress={() => openSettings($)}>
            <Text dimColor>⚙</Text>
            <Text color="suggestion">●</Text>
          </Button>
        ) : hasGear ? (
          <Button key="settings" plain dimColor label={e.surface !== 'desktop' ? '⚙' : hasNews ? GEAR_NEWS : GEAR_TEXT} onPress={() => openSettings($)} />
        ) : null}
        {below}
      </Box>
    )
  })

  // the settings window, laid out as Claude Desktop's own settings: two sections of rows, each a title and a line on
  // what it does with its control at the right, in the person's language (words). The desktop builds the window anew at
  // every redraw (the footer's figure, once a second while a response streams), which an open list or a half-typed
  // field would not survive: every control is a Button, over a picture where the surface draws one (switchSvg, segSvg)
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    const s = await read($, speed)
    await read($, prefs)
    const ver = await read($, versionState)
    const me = await (install ??= readInstall($))
    const t = $.ui.resolve(e)
    const { Box, Button, Link, Text } = t
    // the terminal's table carries an Svg too and draws it as nothing: the surface decides, not the table
    const Svg = e.surface !== 'terminal' && 'Svg' in t ? t.Svg : null
    const w = words
    const secs = Math.round(doneStaysMs / 1000)
    // /config takes any seconds: one the window has no cell for gets its own, picked
    const stays = STAYS.includes(secs) ? STAYS : [...STAYS, secs].sort((a, b) => a - b)
    const secsLabel = (n: number) => w.secs.replace('{n}', String(n))
    // the label over a cell on the desktop, a figure space either side so a press lands on most of the cell
    const cellLabel = (n: number) => `${FIGURE_SPACE}${secsLabel(n)}${FIGURE_SPACE}`
    const stateWord = (isOn: boolean) => (isOn ? w.enabled : w.disabled)
    const rows: SettingRow[] = [
      { key: 'twinkle', title: w.fx, about: w.fxd, isOn: isTwinkling, press: () => setOption($, 'twinkle', !isTwinkling) },
      { key: 'speed', title: w.sp, about: w.spd.replace('{v}', speedLabel(s).replaceAll(FIGURE_SPACE, '')), isOn: isSpeedShown, press: () => setChoice($, SPEED_SHOWN, !isSpeedShown) },
      { key: AUTOCLOSE, title: w.ac, about: w.acd, isOn: isAutoClose, press: () => setChoice($, AUTOCLOSE, !isAutoClose) },
      { key: 'stays', title: w.st, about: w.std },
      { key: 'sounds', title: w.sn, about: w.snd, isOn: isSoundOn, press: () => setChoice($, SOUNDS, !isSoundOn) },
      { key: UPDATE_CHECK, title: w.uc, about: w.ucd, isOn: isUpdateCheckOn, press: () => setChoice($, UPDATE_CHECK, !isUpdateCheckOn) },
      { key: 'version', title: w.ver, ...versionLine(ver, me, w) },
    ]
    // the cell a seconds label needs on the desktop, the same for all so the track is even: the widest of their Buttons
    const segW = Math.max(44, ...stays.map(n => buttonW(cellLabel(n))))
    // the terminal's switch reads ━━● On / ●━━ Off, the word padded so the brackets line up
    const wordCells = Math.max(columnsOf(w.enabled), columnsOf(w.disabled))
    const titleCells = Math.min(24, Math.max(...rows.map(r => columnsOf(r.title))) + 2)
    // a terminal pane too narrow for a title, its line and the widest control on one row (the dock beside a 110-column
    // transcript is 39) gives the line a row of its own under the title, so neither the title nor a control is cut.
    // A switch is [ ━━● On ], a seconds cell [ 30 s ]
    const versionLabel = `↻ ${me.version || '?'}`
    const controlCells = Math.max(
      wordCells + 8,
      stays.reduce((n, x) => n + columnsOf(secsLabel(x)) + 4, 0),
      columnsOf(versionLabel) + 4,
      columnsOf(w.upd) + columnsOf(w.later) + 8,
    )
    const isNarrow = e.props.bodyColumns < titleCells + 1 + 16 + 1 + controlCells
    // the seconds: on the desktop one track cut into cells, the picked one raised; on the terminal [ 10 s ][ 30 s ]..., the
    // picked one in the accent colour. Dim while auto-close is off, still pressable: they wait for it. The terminal
    // draws a dim Button grey whatever its variant, so there the picked one stays lit, or the pick would not show
    const segmented = (
      <Box key="stays" flexDirection="row" flexShrink={0}>
        {stays.map((n, i) => {
          const isPicked = n === secs
          // variant marks the picked one; plain draws it the same, the raised thumb under it shows it
          const marks = isPicked ? { variant: 'primary' as const } : {}
          const pick = () => setOption($, 'doneBarSeconds', n)
          return Svg ? (
            <Box key={`seg-${n}`} flexShrink={0} justifyContent="center" alignItems="center">
              <Svg source={segSvg(segW, i, stays.length, isPicked, isAutoClose)} alt={`${w.st}: ${secsLabel(n)}`} width={segW} height={SEG_H} />
              <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
                <Button key={`stay-${n}`} plain dimColor={!isPicked || !isAutoClose} hover={NO_PLATE} {...marks} label={cellLabel(n)} onPress={pick} />
              </Box>
            </Box>
          ) : (
            <Button key={`stay-${n}`} dimColor={!isAutoClose && !isPicked} {...marks} label={secsLabel(n)} onPress={pick} />
          )
        })}
      </Box>
    )
    // the version: a button that checks, or, with a newer release out, Update and Later. Each surface draws its own
    // buttons, the desktop its native ones
    const versionControl =
      ver.phase === 'available' ? (
        <Box key="version" flexDirection="row" flexShrink={0} gap={1}>
          <Button key="version-update" variant="primary" label={w.upd} onPress={() => updateVersion($)} />
          <Button key="version-later" label={w.later} onPress={() => dismissVersion($)} />
        </Box>
      ) : (
        <Button key="version" dimColor={isVersionBusy(ver, me)} label={versionLabel} onPress={() => checkVersion($)} />
      )
    const control = (r: SettingRow) => {
      if (r.key === 'version') return versionControl
      if (r.isOn === undefined) return segmented
      const press = () => r.press?.()
      // the picture says what the switch is and where it stands; the Button over it is blank
      if (Svg)
        return (
          <Box key={`switch-${r.key}`} flexShrink={0} justifyContent="center" alignItems="center">
            <Svg source={switchSvg(r.isOn)} alt={`${r.title}: ${stateWord(r.isOn)}`} width={SWITCH_BOX} height={SWITCH_H} />
            <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="flex-end" alignItems="center">
              <Button key={r.key} plain hover={NO_PLATE} label={SWITCH_LABEL} onPress={press} />
            </Box>
          </Box>
        )
      // the terminal draws the children, ━━● On: no label, which it would draw instead. Its focus ring starts on
      // Auto-close, whose press reloads nothing
      return (
        <Button key={r.key} {...(e.surface === 'terminal' && r.key === AUTOCLOSE ? { autoFocus: true as const } : {})} onPress={press}>
          <Text color={r.isOn ? 'suggestion' : undefined} dimColor={!r.isOn}>
            {r.isOn ? '━━●' : '●━━'}
          </Text>
          {` ${stateWord(r.isOn)}${' '.repeat(wordCells - columnsOf(stateWord(r.isOn)))}`}
        </Button>
      )
    }
    // a row's line, dim, and the link it may end in: on the desktop after the words, on the terminal on a line of its
    // own, where a terminal without links draws the address after the label and would push the words out of the row
    const about = (r: SettingRow, wrap: 'wrap' | 'truncate') =>
      r.link ? (
        <Box flexDirection={Svg ? 'row' : 'column'} columnGap={1} flexShrink={1}>
          <Text dimColor wrap={wrap}>
            {r.about}
          </Text>
          <Link href={r.link.href} label={r.link.label} />
        </Box>
      ) : (
        <Text dimColor wrap={wrap}>
          {r.about}
        </Text>
      )
    // the desktop: a title over its line, the control at the right, a hairline between rows; the terminal: one line each,
    // or on a narrow pane the title with the control and the line under them
    const line = (r: SettingRow) =>
      Svg ? (
        <Box key={`row-${r.key}`} flexDirection="row" alignItems="center" gap={2}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text>{r.title}</Text>
            {about(r, 'wrap')}
          </Box>
          {control(r)}
        </Box>
      ) : isNarrow ? (
        <Box key={`row-${r.key}`} flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">{r.title}</Text>
            </Box>
            {control(r)}
          </Box>
          {about(r, 'truncate')}
        </Box>
      ) : (
        <Box key={`row-${r.key}`} flexDirection="row" alignItems="center" gap={1}>
          <Box width={titleCells} flexShrink={1}>
            <Text wrap="truncate">{r.title}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {about(r, 'truncate')}
          </Box>
          {control(r)}
        </Box>
      )
    const sections = [
      { head: w.g1, rows: rows.slice(0, 2) },
      { head: w.g2, rows: rows.slice(2, 5) },
      { head: w.g3, rows: rows.slice(5) },
    ]
    return (
      <Box flexDirection="column">
        {sections.map((sec, i) => (
          <Box key={`section-${i}`} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
            <Text bold>{sec.head}</Text>
            {sec.rows.flatMap(r => [...(Svg ? [<Svg key={`rule-${r.key}`} source={RULE} alt="divider" height={13} />] : []), line(r)])}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, plans)
    if (list.length === 0 || e.props.hasSurvey || !(await read($, isOpen))) {
      band = null
      return next(e)
    }
    if (e.surface === 'terminal') {
      const { Box, Button, Text, Raster } = $.ui.resolve(e)
      await read($, tick)
      const now = await $.clock.now()
      await (firstTint ??= readTint($, now, next.signal).then(() => void (isLight = tintIsLight())))
      const cols = Math.max(1, e.props.bodyColumns || 100)
      const hasClicks = e.viewport?.isFullscreen === true
      // where clicks land, a bar with agent strips gets a fold button before its ✕; every row keeps its cell, so the
      // rows still line up
      const hasFold = hasClicks && list.some(p => canFold(p, now, stripBudget(list.length)))
      const rest = (hasClicks ? 15 : 13) + (hasFold ? 2 : 0)
      // in a narrow band the title gives way before the track: the track keeps 12 cells while the title shrinks, and
      // below 4 columns of title there is none (its cell and gap go to the track), so the row never runs past the band
      const fit = Math.min(Math.max(4, Math.min(Math.round(cols * 0.28), Math.max(...list.map(p => columnsOf(p.title))))), cols - rest - 12)
      const titleW = fit >= 4 ? fit : 0
      const trackW = Math.max(4, Math.min(512, cols - titleW - rest + (titleW > 0 ? 0 : 1)))
      const under = titleW > 0 ? titleW + 3 : 2
      band = { requestId: e.requestId, W: trackW, list }
      refusedAt = null
      refusedInRow = 0
      const tree = (
        <Box flexDirection="column">
          {list.map(p => {
            const v = shownAgents(p, now, stripBudget(list.length))
            const strips = v ? stripCells(v, trackW, now) : null
            const w = where(p)
            const pct = percent(p, w)
            return (
              <Box key={`bar-${p.id}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={stateColor(p.state)}>{STATE_GLYPH[p.state]}</Text>
                  {titleW > 0 ? (
                    <Box width={titleW} flexShrink={0}>
                      <Text wrap="truncate">{p.title}</Text>
                    </Box>
                  ) : null}
                  <Raster key={`track-${p.id}`} columns={trackW} rows={1} cells={trackCells(p, trackW, now)} />
                  <Text dimColor>{`${String(pct).padStart(3, FIGURE_SPACE)}%`}</Text>
                  {hasFold ? (
                    <Box width={1} flexShrink={0}>
                      {canFold(p, now, stripBudget(list.length)) ? <Button key={`fold-${p.id}`} plain dimColor label={p.isFolded ? '▸' : '▾'} onPress={() => foldPlan($, p.id)} /> : null}
                    </Box>
                  ) : null}
                  {hasClicks ? <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} /> : null}
                </Box>
                {p.note && p.state !== 'running' ? (
                  <Box marginLeft={under}>
                    <Text color={stateColor(p.state)} wrap="truncate">{p.note}</Text>
                  </Box>
                ) : null}
                {strips ? (
                  <Box marginLeft={under}>
                    <Raster key={`strips-${p.id}`} columns={trackW} rows={strips.rows} cells={strips.cells} />
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      )
      // the cells above start a glide where the bar moved; the frames that carry it start with them
      syncFrames($, now)
      // the engine keeps this tree, and a band folded and shown again mounts it anew, glide start and all (frames sent
      // while it was folded were refused): once the glides are over the band is drawn again standing, where they end
      const settleAt = Math.max(0, ...list.map(p => glide.get(p.id)).map(g => (g && g.from !== g.to ? g.at + GLIDE_MS + 100 : 0)))
      if (settleAt > 0) settleBy($, settleAt + 50, now)
      // what the host and the plugins after this one draw here stays, under the bars, next to the prompt (issue #15).
      // Asked last: a slow hook below would otherwise let an older draw set the band after a newer one
      const below = await next(e)
      // the gap only over something that shows; the drawing itself is never left out
      return below ? (
        <Box flexDirection="column" gap={hasContent(below) ? 1 : 0}>
          {tree}
          {below}
        </Box>
      ) : (
        tree
      )
    }
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    // every bar has the same width and is pinned to the right edge (fixed-width percent, close button),
    // so rows line up whatever their titles; the slack goes into the gap after the title.
    // Desktop reports ~8 CSS px per column; glyph, gaps, percent and the close button take ~126 px.
    const titleWidth = Math.min(Math.round(total * 0.3), Math.max(...list.map(p => Math.round(textWidth(p.title, 6.4)))))
    await read($, tick)
    // read for its redraws only: the footer's figure changing asks the whole session to draw again, and a band that read
    // nothing changed is handed back as it was last drawn. Rebuilt from that very source, a picture starts its glide
    // over (the pill went back to where it set off and slid again), and its clocks and stream run from the old time
    await read($, speed)
    const now = await $.clock.now()
    // a bar with agent strips gets a fold chevron before its ✕ (up folds, down shows), in a cell every row keeps so
    // the rows line up; wide enough for the desktop's own button, which a narrower cell squeezes to a dot
    const hasFold = list.some(p => canFold(p, now, stripBudget(list.length)))
    const trackW = Math.max(120, Math.min(1400, total - titleWidth - 140 - (hasFold ? 40 : 0)))
    // a hairline between task bars, so each bar and its agent strips read as one group
    const divider = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="1"><rect width="${total}" height="1" fill="#808080" fill-opacity=".22"/></svg>`

    const bars = (
      <Box flexDirection="column" gap={1}>
        {list.flatMap((p, i) => {
          const v = shownAgents(p, now, stripBudget(list.length))
          const track = trackSvg(p, trackW, now)
          const rows = v && Svg ? stripsSvg(v, p.agents ?? [], trackW, now) : []
          // a glide (as good as over at PICTURE_STAND_MS) or a strip's morph still running is drawn once more when it
          // is over, standing: timed from the move, not from this draw, so a draw late in the glide does not hold the
          // gliding picture on any longer. Each end on its own, the first one first: a strip's later morph does not
          // hold a glide on. A few ms past the end, so the draw it brings finds it over
          for (const end of [drawn.get(p.id)?.glideUntil ?? 0, ...rows.map(r => r.until)]) if (end > 0) settleBy($, end + 5, now)
          const hover = liveSource(track.overlay, now)
          const strips = Svg
            ? rows.map(r => (
                <Svg
                  key={`strip-${p.id}-${r.key}`}
                  source={liveSource(`<svg xmlns="http://www.w3.org/2000/svg" width="${trackW}" height="${r.height}">${isTwinkling ? STRIP_STYLE : STRIP_STILL}${r.html}</svg>`, now)}
                  alt={stripAlt(p, r.key)}
                  width={trackW}
                  height={r.height}
                />
              ))
            : []
          const agentsAlt = canFold(p, now, stripBudget(list.length)) ? `; agents: ${(p.agents ?? []).map(a => `${a.title} ${a.state}`).join(', ')}` : ''
          const line = i > 0 && Svg ? [<Svg key={`div-${p.id}`} source={divider} alt="divider" width={total} height={1} />] : []
          const w = atHead(p)
          const pct = percent(p, w)
          const color = stateColor(p.state)
          const stageName = p.stages[w.stage]?.name ?? ''
          // the colour and the icon say a bar failed or waits on the person; the words say it too, note or not
          const failedAt = p.stages.flatMap(s => s.steps).find(st => st.status === 'error')?.title
          const stateAlt = p.state === 'needs_input' ? 'waiting for your answer, ' : p.state === 'error' ? `failed${failedAt ? ` at ${failedAt}` : ''}, ` : ''
          const alt =
            p.state === 'done'
              ? `${p.title}: done, ${plural(w.total, 'step')}${p.endedAt ? ` in ${elapsed(p.endedAt - p.startedAt)}` : ''}`
              : `${p.title}: ${stateAlt}${stageName}, step ${w.step} of ${w.stageSize}, ${pct}%${p.note ? ` — ${p.note}` : ''}${agentsAlt}`
          const bar = `${'━'.repeat(Math.round(pct / 4))}${'─'.repeat(25 - Math.round(pct / 4))}`

          return [
            ...line,
            <Box key={`bar-${p.id}`} flexDirection="row" alignItems={v ? 'flex-start' : 'center'} gap={1}>
              <Text color={color}>{STATE_GLYPH[p.state]}</Text>
              <Text wrap="truncate">{p.title}</Text>
              <Box flexGrow={1} />
              {Svg ? (
                <Box flexDirection="column" flexShrink={0}>
                  <Box key={`track-${p.id}`}>
                    <Svg source={liveSource(track.base, now)} alt={alt} width={trackW} height={TRACK_H} />
                    {track.clock ? (
                      // the pill's clock, shown by the desktop's own hover of this keyed Box: the pointer over the frame
                      // below is over the Box too. Under the frame, so the checkpoint tips still take the pointer; not
                      // placed itself, or the desktop would lift it out as a hover card
                      <Box position="absolute" top={0} left={0}>
                        <Box display="none" hover={{ display: 'flex' }}>
                          <Svg source={liveSource(track.clock, now)} alt={`${p.title} has run for ${elapsed(now - p.startedAt)}`} width={trackW} height={TRACK_H} />
                        </Box>
                      </Box>
                    ) : null}
                    <Box position="absolute" top={0} left={0}>
                      <Svg source={hover} alt={timesAlt(p)} width={trackW} height={TRACK_H} isInteractive />
                    </Box>
                  </Box>
                  {strips}
                </Box>
              ) : (
                <Text>
                  <Text color={color}>{bar.replace(/─/g, '')}</Text>
                  <Text dimColor>{bar.replace(/━/g, '')}</Text>
                  <Text color={color}>{` ${stageName} ${w.step}/${w.stageSize}`}</Text>
                </Text>
              )}
              <Text dimColor>{`${String(pct).padStart(3, FIGURE_SPACE)}%`}</Text>
              {hasFold ? (
                <Box width={5} flexShrink={0}>
                  {canFold(p, now, stripBudget(list.length)) ? (
                    Svg ? (
                      <Box key={`foldchip-${p.id}`} width={5} height={1} justifyContent="center" alignItems="center">
                        <Svg source={foldChip(!!p.isFolded)} alt={p.isFolded ? 'show the agents' : 'fold the agents'} width={FOLD_W} height={FOLD_H} />
                        <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
                          <Button key={`fold-${p.id}`} plain label={'  '} onPress={() => foldPlan($, p.id)} />
                        </Box>
                      </Box>
                    ) : (
                      <Button key={`fold-${p.id}`} plain dimColor label={p.isFolded ? '⌄' : '⌃'} onPress={() => foldPlan($, p.id)} />
                    )
                  ) : null}
                </Box>
              ) : null}
              <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} />
            </Box>,
          ]
        })}
      </Box>
    )
    const below = await next(e)
    return below ? (
      <Box flexDirection="column" gap={hasContent(below) ? 1 : 0}>
        {bars}
        {below}
      </Box>
    ) : (
      bars
    )
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!('agentId' in started) || !started.agentId) return started
    const id = started.agentId
    const now = await $.clock.now()
    const parentHome = e.parentAgentId ? agentHome.get(e.parentAgentId) : undefined
    // an agent the main loop starts goes under the main loop's latest open bar, never one a subagent made for its own work
    const home = parentHome ?? [...(await read($, plans))].reverse().find(p => isOpenPlan(p) && (!p.byAgent || !!e.parentAgentId))?.id ?? AGENTS
    const run: AgentRun = {
      id,
      title: str(e.description || e.subagentType, 60),
      state: 'running',
      tool: 'Starting',
      model: started.model,
      startedAt: now,
      endedAt: null,
      depth: 0,
    }
    // known only once its strip is stored, so the cleanup in the clock never sees a home without the agent
    agentHome.set(id, await placeRun($, run, home, e.parentAgentId, now))

    return started
  })

  // an agent's strip turns amber only while a permission dialog for its call is really shown:
  // an ask the auto-mode classifier settles by itself raises no dialog and asks nobody
  on('classic.PermissionRequest', async ($, e, next) => {
    const agentId = e.agent_id
    // the request names no call: take that agent's oldest call of this tool not yet asked, else its oldest not asked
    const open = [...flights.values()].filter(f => f.agentId === agentId && !f.isAsked)
    const flight = open.find(f => f.tool === e.tool_name) ?? open[0]
    if (agentId && flight) {
      flight.isAsked = true
      await showAgent($, agentId)
    }
    const answer = await next(e)
    // a settings hook that answered the request leaves no dialog in front of the person
    if (agentId && flight && answer.decision) {
      flight.isAsked = false
      await showAgent($, agentId)
    }

    return answer
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    const agentId = e.agent_id
    const flight = flights.get(e.tool_use_id) ?? [...flights.values()].find(f => f.agentId === agentId && f.isAsked)
    if (agentId && flight) {
      flight.isAsked = false
      await showAgent($, agentId)
    }

    return next(e)
  })

  // the first request of an agent's loop says what it runs on: the resolved model and its effort
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId && (await knowAgent($, agentId, true))) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const known = (await read($, plans)).flatMap(p => p.agents ?? []).find(a => a.id === agentId)
      if (known && (known.model !== e.model || known.effort !== effort)) await editAgent($, agentId, a => ({ ...a, model: e.model, effort }))
    }
    if (agentId) return yield* next(e)

    // the main conversation's response, timed piece by piece for the footer's tokens per second; the footer is written
    // at most once a second, and only when what it reads changes
    const m = newMeter()
    const show = (value: Speed, isFinal = false) => {
      const label = `${speedLabel(value)}|${value.isLive}`
      m.shown = label
      // the figure turned off in the window: only a response's final figure is written, so the desktop is not drawn
      // anew every second for a figure nobody sees
      if (!isSpeedShown && !isFinal) return
      const t = performance.now()
      if (label === lastSpeed.label || (!isFinal && t - lastSpeed.at < SHOW_EVERY_MS)) return
      lastSpeed.label = label
      lastSpeed.at = t
      void update($, speed, () => value).catch(() => {})
    }
    const stream = next(e)
    // no piece comes while the response waits, so a clock looks in: a wait dims the figure instead of leaving it bright
    // (written at once: the wait is seen only on this tick, so a write held back here would leave it bright)
    const wait = $.clock.every(SHOW_EVERY_MS, () => {
      const t = performance.now()
      if (!isWaiting(m, t)) return
      endStretch(m)
      if (m.shown !== '') show({ rate: average(e.model, sofar(m, t)), isLive: false }, true)
    })
    let stop: { tokens: number | null; t: number } | null = null
    let isStopped = false
    try {
      for await (const c of stream) {
        const t = performance.now()
        if (c.kind === 'stop') {
          stop = { tokens: c.usage?.output_tokens ?? null, t }
        } else {
          see(m, c, t)
          if (t - m.shownAt >= SHOW_EVERY_MS) {
            const now = sofar(m, t)
            const rate = average(e.model, now)
            // live while the response's own writing is being measured; dim while it thinks out of sight
            if (rate !== null) {
              m.shownAt = t
              show({ rate, isLive: m.visibleFrom !== null })
            }
          }
        }
        yield c
      }
      const result = await stream.result
      if (stop) {
        // the tools the API ran itself are known once the response is whole, each with when it started and ended; one
        // whose result never came waited until the end
        const uses = result.serverToolUses ?? []
        const end = uses.length > 0 ? await $.clock.now() : 0
        const waited = uses.reduce((sum, u) => sum + (u.endedAt ?? end) - u.startedAt, 0)
        if (stop.tokens !== null) finish(m, e.model, stop.tokens, stop.t - waited, uses.length > 0)
        show({ rate: average(e.model), isLive: false }, true)
        isStopped = true
      }
      return result
    } finally {
      wait.cancel()
      // a response cut short leaves the average of those that finished, dimmed
      if (!isStopped && m.shown !== '') show({ rate: average(e.model), isLive: false }, true)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId) {
      isTurnLive = false
      // a glide still under way lands now: frames running on would go out with the engine's end-of-turn redraw
      for (const [id, g] of glide) glide.set(id, { ...g, from: g.to })
    }
    if (agentId && (await knowAgent($, agentId))) {
      const isFailed = e.reason !== 'answer'
      await endAgent($, agentId, isFailed, e.reason === 'aborted' ? 'Stopped' : isFailed ? 'Failed' : 'Done')
    }
    // a bar a subagent leaves when its run is over has no one left to move it: the main loop takes it over, so its
    // Stop asks about it; a teammate only rests between its turns and keeps its own
    if (agentId && (await read($, plans)).some(p => p.byAgent === agentId)) {
      const rows = await Promise.resolve()
        .then(() => $.agent.list())
        .catch(() => null)
      if (!rows?.find(r => r.id === agentId)?.teammateId) {
        for (const p of await read($, plans)) if (p.byAgent === agentId) handedOver.set(p.id, agentId)
        await update($, plans, list => list.map(p => (p.byAgent === agentId ? { ...p, byAgent: undefined } : p)))
      }
    }
    // a plan whose steps are all finished closes itself; a failed one or one waiting on the person stays as it is,
    // since it still asks for attention. Each is closed from the latest stored bar, so an agent's end written meanwhile
    // stays
    for (const p of await read($, plans)) {
      if (p.id === AGENTS || p.state !== 'running' || !isAllFinished(p)) continue
      const now = await $.clock.now()
      await editPlan($, p.id, prev => (prev?.state === 'running' && isAllFinished(prev) ? { ...prev, state: 'done', endedAt: now } : 'skip'))
    }

    return next(e)
  })
}
