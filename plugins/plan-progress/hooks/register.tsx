import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Plan, PlanStage, PlanState, PlanStep, StepStatus } from '../types'

const TOOL = 'mcp__plan-progress__plan_progress'
const plans = atom({ plugin: 'plan-progress', key: 'plans' } as const, [])
const MAX_BARS = 3
// a space as wide as a digit, so '  0%' and '100%' take the same room
const FIGURE_SPACE = String.fromCharCode(0x2007)
const isOpen = atom({ plugin: 'plan-progress', key: 'isOpen' } as const, true)
const tick = atom({ plugin: 'plan-progress', key: 'tick' } as const, 0)
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
Tasks needing more than ~3 edits or commands get a bar via ${TOOL}: create it once with the full breakdown (2-7 stages of steps {title}, or kind "todo" for one flat list; titles of at most 4 words, in the user's language; the first open step becomes active), then move it with short calls: {id, next:true} when the active step is finished, or {id, done:[...], active:"..."}, {id, failed:"...", note}. When the plan changes, resend stages under the same id; steps sent without a status keep their done by title. Send state "needs_input" with a note before asking the user to decide. Never describe the bars to the user.`

type Raw = Record<string, unknown>
// the cut drops half a character left at the edge (an emoji is two UTF-16 units)
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd() : '')
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
    // past the last step, work goes back to one left open earlier
    const following = steps.slice(at + 1).find(st => st.status === 'pending') ?? steps.find(st => st.status === 'pending')
    if (following) following.status = 'active'
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

// the new bar, or the refusal for a call that names steps the bar does not have
function normalize(input: Raw, prev: Plan | null, now: number, id: string): Plan | string {
  const sent = list(input.stages)
    .map(s => ({
      name: str(s.name, 80) || 'Stage',
      steps: list(s.steps).map(st => ({
        title: str(st.title) || 'Step',
        status: status(st.status),
        substeps: list(st.substeps).map(sub => ({ title: str(sub.title) || '…', status: status(sub.status) })),
      })),
    }))
    .filter(s => s.steps.length > 0) as PlanStage[]
  const isPartial = sent.length === 0 && prev !== null
  // a resent plan keeps what was finished; short ops sent along with it apply on top
  const base = isPartial ? prev.stages : pointAt(prev ? carryDone(sent, prev.stages) : sent)
  const { stages, missing } = applyOps(base, input, now)
  if (missing.length > 0 && base.length > 0) {
    const titles = stages.flatMap(s => s.steps.map(st => st.title)).join(', ')
    return `plan_progress: "${id}" has no step ${missing.map(t => `"${str(t, 60)}"`).join(', ')}. Its steps: ${titles.slice(0, 400)}`
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
    startedAt: prev ? prev.startedAt : now,
    endedAt: state === 'done' ? (prev?.endedAt ?? now) : null,
  }
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
  const items: { depth: number; text: string; status: StepStatus }[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const text = clean(h[2] ?? '')
      if (h[1] === '#' && !title) title = text
      else headed.push({ name: text, steps: [] })
      continue
    }
    const li = line.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/)
    if (!li) continue
    const depth = Math.floor((li[1] ?? '').replace(/\t/g, '  ').length / 2)
    const text = clean(li[3] ?? '').slice(0, 120)
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
  let stages = headed.filter(s => s.steps.length > 0)
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

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a: number[], b: number[], m: number) => a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * m))
const rgb = (c: number[]) => `rgb(${c.join(',')})`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const hash = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return x - Math.floor(x)
}
const textWidth = (s: string, px = 6.7) => [...s].reduce((w, ch) => w + (/[　-鿿]/.test(ch) ? 12 : /[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMWШЩЖМ]/.test(ch) ? 9.5 : px), 0)

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

// last drawn head position per plan, so a redraw glides from where the bar was
const lastHead = new Map<string, { W: number; x: number }>()

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
.cc{animation:cc 36000s linear var(--d) both}@keyframes cc{0%,.1666%{transform:translateX(-13.5px)}.1667%,1.6666%{transform:translateX(-3.25px)}1.6667%,9.9999%{transform:none}10%,99.9999%{transform:translateX(-3.25px)}100%{transform:none}}
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
  const hours =
    `<g class="ph2">${reel(x + 3.5, tens, 'rh10')}${reel(x + 10.5, digits, 'rh1')}${unit(x + 14, 'h')}` +
    `${reel(x + 31, digits.slice(0, 6), 'rm6')}${reel(x + 38, digits, 'rm1')}${unit(x + 41.5, 'm')}</g>`
  return (
    `<style>.${id}{--d:-{{T:${start}}}s}</style><g class="${cls} ${id}"><clipPath id="${id}"><rect x="${(x - 2).toFixed(1)}" y="${top}" width="${CLOCK_W + 4}" height="${LINE}"/></clipPath>` +
    `<g clip-path="url(#${id})"${isCentered ? ' class="cc"' : ''}>${minutes}${hours}</g></g>`
  )
}

// the desktop rebuilds a strip's picture on every redraw of the band, another plugin's invalidate included, so a
// source reused from an earlier draw would restart its clocks at that draw's offset (issue #6): the offset is
// taken from now on every draw
function liveSource(template: string, now: number): string {
  return template.replace(/\{\{T:(\d+)\}\}/g, (_, t: string) => Math.max(0, (now - Number(t)) / 1000).toFixed(1))
}

// a bar is drawn twice: the track itself as a plain picture, which the desktop keeps steady whatever else redraws,
// and a see-through layer on top for the hover parts (checkpoint times, the pill's clock). That layer needs an
// interactive frame, and the desktop rebuilds such frames on every redraw of the band; empty until hovered, the
// rebuild is invisible. A plan is immutable, so both drawings at one width are reused until the plan changes
type Track = { base: string; overlay: string }
const drawn = new WeakMap<Plan, { W: number; color: string; track: Track }>()

function trackSvg(p: Plan, W: number): Track {
  const cached = drawn.get(p)
  const color = stateColor(p.state)
  if (cached?.W === W && cached.color === color) return cached.track
  const track = drawTrack(p, W)
  drawn.set(p, { W, color, track })
  return track
}

function drawTrack(p: Plan, W: number): Track {
  const H = TRACK_H
  const w = where(p)
  const done = p.state === 'done'
  // the fill is exactly the finished share: a fresh plan starts empty
  const frac = done ? 1 : Math.min(1, w.pos / Math.max(1, w.total))
  const fx = frac * W
  const key = p.id
  // a resize redraws at once: a head drawn at another width would glide in from the wrong place
  const last = lastHead.get(key)
  const from = last?.W === W ? last.x : fx
  lastHead.set(key, { W, x: fx })

  const acc = hex(stateColor(p.state))
  const light = mix(acc, [255, 255, 255], 0.32)
  const grey = [132, 130, 138]
  const ease = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"'
  const glide = Math.abs(from - fx) > 0.5

  const bounds: number[] = []
  let acc2 = 0
  p.stages.forEach((s, i) => {
    acc2 += s.steps.length
    if (i < p.stages.length - 1) bounds.push((acc2 / w.total) * W)
  })

  // pixels: 3px grid, 7 rows, denser towards the head, twinkling and warming from grey to the state colour
  const buckets = [0, 1, 2, 3, 4].map(b => {
    const m = b / 4
    const dense = 0.22 + 0.78 * Math.pow(m, 1.5)
    return { color: rgb(mix(grey, light, m)), opacity: (0.35 + 0.65 * dense).toFixed(2) }
  })
  const dots = new Map<string, string>()
  for (let col = 0; col * 3 < fx; col++) {
    const x = col * 3
    const u = Math.min(1, (x + 1.5) / fx)
    const dense = 0.22 + 0.78 * Math.pow(u, 1.5)
    const bucket = Math.min(4, Math.floor(Math.min(1, Math.pow(u, 0.9) * 1.1) * 4.99))
    for (let r = 0; r < 7; r++) {
      if (hash(col, r, 1) > dense + 0.1) continue
      addDot(dots, `b${bucket} t${Math.floor(hash(col, r, 2) * 4)}`, x, 1 + r * 3)
    }
  }
  const px = [...dots].map(([cls, d]) => `<path class="${cls}" d="${d}"/>`).join('')

  const took = stepTimes(p)
  const tipRules: string[] = []
  let marks = ''
  let hits = ''
  let tips = ''
  let k = 0
  p.stages.forEach((s, i) => {
    s.steps.forEach((_, j) => {
      if (k > 0) {
        const x = (k / w.total) * W
        const isStage = j === 0
        // a stage boundary is a short capsule, a step a dot; bright once passed
        const passed = x < fx - 1
        const fill = passed ? rgb(mix(light, [255, 255, 255], 0.45)) : '#A8A69E'
        const opacity = passed ? (isStage ? 0.95 : 0.8) : isStage ? 0.75 : 0.6
        marks += isStage
          ? `<rect x="${(x - 1.5).toFixed(1)}" y="${(H - 10) / 2}" width="3" height="10" rx="1.5" fill="${fill}" opacity="${opacity}"/>`
          : `<circle cx="${x.toFixed(1)}" cy="${H / 2}" r="1.4" fill="${fill}" opacity="${opacity}"/>`
        const before = p.stages[isStage ? i - 1 : i]
        const ended = isStage ? before?.steps[before.steps.length - 1] : s.steps[j - 1]
        const label = isStage ? (before?.name ?? '') : (ended?.title ?? '')
        const ms = isStage ? took.stages[i - 1] : took.steps.get(ended as PlanStep)
        const text = ms === undefined ? label : `${label} · ${elapsed(ms)}`
        const tw = textWidth(text, 6.2) + 16
        const tx = Math.max(0, Math.min(W - tw, x - tw / 2))
        hits += `<rect class="h${k}" x="${(x - 5).toFixed(1)}" width="10" height="${H}" fill="#000" fill-opacity="0"/>`
        tips += `<g class="tp p${k}"><rect x="${tx.toFixed(1)}" y="2" width="${tw.toFixed(1)}" height="${H - 4}" rx="${(H - 4) / 2}" fill="#1F1E1D" fill-opacity=".94"/><text x="${(tx + 8).toFixed(1)}" y="${H / 2 + 3.8}" class="tt">${esc(text)}</text></g>`
        tipRules.push(`.h${k}:hover~.p${k}`)
      }
      k++
    })
    void i
  })

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
    // the pill carries the stage name alone (the fill and the percent already say how far along it is), and, while
    // the person has folded the bar's agent strips away, how many of its agents are still at work
    const agents = p.isFolded && p.id !== AGENTS ? (p.agents ?? []) : []
    const running = agents.filter(a => a.state === 'running' || a.state === 'waiting').length
    const count = agents.length === 0 ? '' : running > 0 ? `${running} running` : `${agents.length} done`
    const iconW = icon ? 16 : 0
    const countW = count ? textWidth(count, 6.5) : -6
    const maxW = Math.max(80, W * 0.55)
    let shown = name
    while (shown.length > 3 && 20 + iconW + textWidth(shown) + 6 + countW > maxW) shown = shown.slice(0, -1)
    if (shown !== name) shown = shown.trimEnd() + '…'
    // a running pill is wide enough for its clock too, so the hover swap does not change its size
    const textW = done ? textWidth(shown) : Math.max(textWidth(shown), CLOCK_W)
    kw = Math.round(20 + iconW + textW + 6 + countW)
    const left = -(iconW + textW) / 2
    const mid = left + iconW + textW / 2
    knob = `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>`
    if (icon) knob += `<path d="${icon}" transform="translate(${left.toFixed(1)} 5) scale(.5)" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`
    knob += `<text x="${mid.toFixed(1)}" y="${H / 2 + 4.2}" text-anchor="middle" class="kt">${esc(shown)}${count ? `<tspan class="kc" dx="6">${count}</tspan>` : ''}</text>`
    // hovering the pill lays a copy of it over the stage name, carrying the time the plan has run so far
    if (!done) {
      const face = `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>${
        icon ? `<path d="${icon}" transform="translate(${left.toFixed(1)} 5) scale(.5)" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` : ''
      }`
      timePill = `<g class="kb"><rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" fill="#000" fill-opacity="0"/><g class="kv">${face}${liveClock(mid - CLOCK_W / 2, 3, p.startedAt, 'kc0', 'kt', true)}</g></g>`
    }
  }
  const clampX = (x: number) => Math.max(kw / 2, Math.min(W - kw / 2, x))
  const kx = clampX(fx)
  const kFrom = clampX(from)

  const style = `<style>
.b0{fill:${buckets[0]?.color};fill-opacity:${buckets[0]?.opacity}}.b1{fill:${buckets[1]?.color};fill-opacity:${buckets[1]?.opacity}}
.b2{fill:${buckets[2]?.color};fill-opacity:${buckets[2]?.opacity}}.b3{fill:${buckets[3]?.color};fill-opacity:${buckets[3]?.opacity}}
.b4{fill:${buckets[4]?.color};fill-opacity:${buckets[4]?.opacity}}
.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite}
.t1{animation-duration:2.8s;animation-delay:-.7s}.t2{animation-duration:1.9s;animation-delay:-1.3s}.t3{animation-duration:3.3s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}
.kt{font:500 12px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:${INK}}
.kc{font-weight:400}
@media (prefers-reduced-motion:reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>`
  const hoverStyle = `<style>
.tp{opacity:0;transition:opacity .12s;pointer-events:none}${tipRules.length ? `${tipRules.join(',')}{opacity:1}` : ''}
.tt{font:400 11px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:#F0EEFC}
.kt{font:500 12px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:${INK}}
.kv{opacity:0;filter:blur(3px);transition:opacity .2s,filter .2s}.kb:hover .kv{opacity:1;filter:none}
.kb,rect[class^="h"]{cursor:pointer}
${CLOCK_CSS}
</style>`
  const glideFill = glide ? `<animate attributeName="width" from="${from.toFixed(1)}" to="${fx.toFixed(1)}" dur=".45s" ${ease} fill="freeze"/>` : ''
  const glideKnob = glide ? `<animateTransform attributeName="transform" type="translate" from="${kFrom.toFixed(1)} 0" to="${kx.toFixed(1)} 0" dur=".45s" ${ease} fill="freeze"/>` : ''

  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  const base = `${open}${style}
<defs><clipPath id="pill"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath><clipPath id="fill"><rect width="${fx.toFixed(1)}" height="${H}">${glideFill}</rect></clipPath>
<linearGradient id="base" x1="0" x2="${fx.toFixed(1)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(acc)}" stop-opacity=".05"/><stop offset="1" stop-color="${rgb(acc)}" stop-opacity=".33"/></linearGradient></defs>
<g clip-path="url(#pill)"><rect width="${W}" height="${H}" fill="#808080" fill-opacity=".16"/>
<g clip-path="url(#fill)"><rect width="${fx.toFixed(1)}" height="${H}" fill="url(#base)"/>${px}</g>${marks}</g>
<g transform="translate(${kx.toFixed(1)} 0)">${glideKnob}${knob}</g></svg>`
  // the hover layer: checkpoint areas under the pill's copy, so the pill wins where they meet; tips on top
  const overlay = `${open}${SEE_THROUGH}${hoverStyle}${hits}<g transform="translate(${kx.toFixed(1)} 0)">${timePill}</g>${tips}</svg>`

  return { base, overlay }
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
  return a ? `agent ${a.title}: ${a.state}, ${a.tool}` : 'more agents'
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

// the strips drawn under a bar: none while the person has folded them away (the bar's pill still counts its agents)
const shownAgents = (p: Plan, now: number, max: number) => (p.isFolded ? null : visibleAgents(p, now, max))
// a bar gets a fold button while it has strips to show or fold; folded with none left (the batch over, or after a
// restart) it keeps the choice for its next agents but shows no button that would do nothing
const canFold = (p: Plan, now: number, max: number) => visibleAgents(p, now, max) !== null

// what each strip showed last time it was drawn, so a change morphs from the old status instead of jumping
const lastStrip = new Map<string, { tool: string; color: string; state: AgentRun['state'] }>()
const MORPH = '.2s'

// a strip's markup per agent object: drawn once per change, so its morph plays once and later redraws match
const drawnRows = new WeakMap<AgentRun, { key: string; html: string }>()


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
const GUTTER = 36 // icon and agent number, left of the strip

// claude-haiku-4-5-20251001 -> haiku 4.5; an alias stays as given
const modelName = (m: string) => {
  const r = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m)
  return r ? `${r[1]} ${r[2]}.${r[3]}` : m
}

// the agent's name, its model and effort in a dimmer parenthesis
const nameMarkup = (name: string) => {
  const at = name.indexOf(' (')
  return at > 0 ? `${esc(name.slice(0, at))}<tspan class="st">${esc(name.slice(at))}</tspan>` : esc(name)
}

// one tinted strip per agent behind a bot icon and its number: the colour says how it went,
// the word says what it does now (only while it runs or waits), the time how long it took
type StripRow = { key: string; html: string; height: number }

// each strip is its own drawing, so a change to one agent redraws that strip alone, never the bar or the others
function stripsSvg(v: { shown: AgentRun[]; hidden: AgentRun[] }, all: AgentRun[], W: number): StripRow[] {
  const isNarrow = W < NARROW
  const SW = W - GUTTER
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
    const rowKey = `${W}|${y}|${all.indexOf(a)}`
    const cachedRow = drawnRows.get(a)
    if (cachedRow?.key === rowKey) {
      rows.push({ key: a.id, html: cachedRow.html, height: y + STRIP_H })
      return
    }
    const c = agentColor(a.state)
    const indent = a.depth > 0 ? 10 : 0
    const word = a.state === 'running' || a.state === 'waiting' ? a.tool : ''
    const dots = new Map<string, string>()
    if (a.state === 'running') {
      for (let col = 0; col * 3 < SW; col++) {
        for (let r = 0; r < 4; r++) {
          if (hash(col + i * 41, r, 5) > 0.2) continue
          addDot(dots, `t${Math.floor(hash(col, r, 6) * 4)}`, GUTTER + col * 3, Math.round((y + 2.5 + r * 3.2) * 10) / 10)
        }
      }
    }
    const px = [...dots].map(([cls, d]) => `<path class="${cls}" fill="${c}" fill-opacity=".32" d="${d}"/>`).join('')
    // a status change: the old word blurs out while the new one blurs in, and the tint flows to the new colour
    const was = lastStrip.get(a.id)
    lastStrip.set(a.id, { tool: word, color: c, state: a.state })
    const isWordChanged = was !== undefined && was.tool !== word
    const flow = (attr: string) => (was && was.color !== c ? `<animate attributeName="${attr}" from="${was.color}" to="${c}" dur="${MORPH}" fill="freeze"/>` : '')
    // the tool word sits at the right, just before the clock, so the name and its model get the rest of the row
    const toolEnd = W - 9 - CLOCK_W - 10
    const wordW = Math.max(word ? textWidth(word, 6.2) : 0, isWordChanged && was.tool ? textWidth(was.tool, 6.2) : 0)
    const nameX = GUTTER + 19 + indent
    const nameRoom = isNarrow ? SW - 24 - indent : toolEnd - (wordW > 0 ? wordW + 12 : 0) - nameX
    const spec = [a.model ? modelName(a.model) : '', a.effort ?? ''].filter(Boolean).join(' · ')
    const full = (a.depth > 0 ? '↳ ' : '') + a.title + (spec ? ` (${spec})` : '')
    let name = full
    while (name.length > 4 && textWidth(name, 6.2) > nameRoom) name = name.slice(0, -1)
    if (name !== full) name = name.trimEnd() + '…'
    const time =
      a.endedAt === null
        ? liveClock(W - 9 - CLOCK_W, y, a.startedAt, 'sc', 'sn st')
        : `<text x="${W - 9}" y="${y + 11.5}" text-anchor="end" class="sn st">${elapsed(a.endedAt - a.startedAt)}</text>`
    const tool = isNarrow
      ? ''
      : (isWordChanged && was.tool ? `<text x="${toolEnd}" y="${y + 11.5}" text-anchor="end" class="sn mo w-${was.state}">${esc(was.tool)}</text>` : '') +
        (word ? `<text x="${toolEnd}" y="${y + 11.5}" text-anchor="end" class="sn w-${a.state}${isWordChanged ? ' mi' : ''}">${esc(word)}</text>` : '') +
        time
    const html =
      backing(y) +
      gutter(y, String(all.indexOf(a) + 1), 'gu') +
      `<rect x="${GUTTER}" y="${y}" width="${SW}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="${c}" fill-opacity=".15">${flow('fill')}</rect>${px}` +
      `<circle cx="${GUTTER + 10 + indent}" cy="${y + STRIP_H / 2}" r="3" fill="${c}"${a.state === 'running' ? ' class="sd"' : ''}>${flow('fill')}</circle>` +
      `<text x="${nameX}" y="${y + 11.5}" class="sn">${nameMarkup(name)}</text>` +
      tool
    drawnRows.set(a, { key: rowKey, html })
    rows.push({ key: a.id, html, height: y + STRIP_H })
  })
  if (v.hidden.length > 0) {
    const y = v.shown.length === 0 ? 5 : STRIP_GAP
    const doneCount = v.hidden.filter(a => a.state === 'done').length
    rows.push({
      key: '+',
      height: y + STRIP_H,
      html:
        backing(y) +
        gutter(y, `+${v.hidden.length}`, 'gm') +
        `<rect x="${GUTTER}" y="${y}" width="${SW}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="#808080" fill-opacity=".14"/>` +
        `<text x="${GUTTER + 10}" y="${y + 11.5}" class="sn st">${plural(v.hidden.length, 'more agent')} · ${doneCount} done</text>`,
    })
  }
  return rows
}

// a scheme's colours as the strip's classes; in the stylesheet the light set follows the dark one, so it wins where
// its query holds, and the dim and tool word follow the name they colour over
const schemeCss = (s: Scheme) =>
  `.sb{fill:${s.page}}.sn{fill:${s.ink}}.st{fill:${s.dim}}.gu{color:${s.gutter}}.gm{color:${s.more}}` +
  Object.entries(s.word).map(([state, c]) => `.w-${state}{fill:${c}}`).join('')
const STRIP_STYLE = `<style>.sn{font:400 11.5px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}.sg{font-weight:500;font-variant-numeric:tabular-nums}
${schemeCss(SCHEMES.dark)}@media (prefers-color-scheme:light){${schemeCss(SCHEMES.light)}}.gu .sn,.gm .sn{fill:currentColor}
.sd{animation:sp 1.1s ease-in-out infinite}@keyframes sp{50%{opacity:.3}}
.mi{animation:mi ${MORPH} ease-out both}@keyframes mi{from{opacity:0;filter:blur(3px)}}
.mo{animation:mo ${MORPH} ease-in both}@keyframes mo{to{opacity:0;filter:blur(3px)}}
.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite}.t1{animation-duration:2.8s;animation-delay:-.7s}.t2{animation-duration:1.9s;animation-delay:-1.3s}.t3{animation-duration:3.3s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}
${CLOCK_CSS}
@media (prefers-reduced-motion:reduce){.sd,.mi,.mo,.t0,.t1,.t2,.t3{animation:none}.mo{opacity:0}}</style>`

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

const glide = new Map<string, { from: number; to: number; at: number }>()
const GLIDE_MS = 450
// the twinkle moment of each bar's last moving frame, kept while it stands still
const stillPhase = new Map<string, number>()

// a head glides to a new place only while frames can carry the glide; otherwise it is drawn there at once
function headAt(id: string, target: number, t: number, canGlide: boolean): number {
  const g = glide.get(id)
  if (!g || (!canGlide && Math.abs(g.to - target) > 0.01)) {
    glide.set(id, { from: target, to: target, at: t })
    return target
  }
  const cur = g.from + (g.to - g.from) * easeOut((t - g.at) / GLIDE_MS)
  if (Math.abs(g.to - target) > 0.01) {
    glide.set(id, { from: cur, to: target, at: t })
    return cur
  }
  return cur
}


function trackCells(p: Plan, W: number, t: number): string {
  const g = new Grid(W, 1)
  const w = where(p)
  const done = p.state === 'done'
  const target = (done ? 1 : Math.min(1, w.pos / Math.max(1, w.total))) * W
  // after the turn a change lands at once: a glide would keep frames going through the engine's end-of-turn redraw
  const fx = headAt(p.id, target, t, isTurnLive || hasRunningAgents(p))
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
    const blink = 1 - dim * wave(phase + (DELAY[cls] ?? 0), period, 0.25)
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
        g.set(x, 0, '│', pack(passed ? mix(light, [255, 255, 255], 0.5) : mix(track, isLight ? [0, 0, 0] : [255, 255, 255], 0.3)), pack(under(x)))
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
    const agents = p.agents ?? []
    name = done ? 'Done' : single ? (p.stages[0]?.name ?? 'Tasks') : (p.stages[w.stage]?.name ?? '')
    const baseCount = p.id === AGENTS ? `${w.pos}/${w.total}` : done ? `${w.total}/${w.total}` : single ? `${number}/${w.total}` : `${w.step}/${w.stageSize}`
    count = baseCount + (agents.length > 0 && p.id !== AGENTS ? ` · ${agents.filter(a => a.state === 'done').length}/${agents.length}` : '')
  }
  const lead = icon && W >= 28 ? `${icon} ` : ''
  const maxName = Math.max(3, Math.floor(W * (W < 60 ? 0.75 : 0.55)) - cellsOf(lead) - cellsOf(count) - 5)
  const shown = lead + fit(name, maxName)
  const kw = cellsOf(shown) + (count ? count.length + 1 : 0) + 2
  const kx = Math.round(Math.max(0, Math.min(W - kw, fx - kw / 2)))
  const white = pack(inkOn(color))
  pill(g, 0, kx, kx + kw, () => color)
  let at = kx + 1
  at += g.text(at, 0, shown, white, pack(color))
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
            const b = 1 - 0.55 * wave(now, 1900 + hash(sx, r, 6) * 1400, hash(sx, r, 7))
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
    const word = narrow || !running ? '' : fit(a.tool, Math.max(0, Math.floor(W * 0.25)))
    const toolAt = tx - 1 - word.length
    let at = 4 + indent
    const spec = [a.model ? modelName(a.model) : '', a.effort ?? ''].filter(Boolean).join(' · ')
    const full = (a.depth > 0 ? '↳ ' : '') + a.title + (spec ? ` (${spec})` : '')
    const name = fit(full, Math.max(3, (narrow ? W - 2 : word ? toolAt - 1 : tx - 1) - at))
    // the model and effort are drawn dimmer than the name
    const cut = spec ? name.indexOf(' (') : -1
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
const isAnimated = (p: Plan, t: number) => (isTurnLive && p.state === 'running') || hasRunningAgents(p) || isGliding(p, t)

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
// theme switch follows within seconds; a machine without the file (or a file without an accent) is never read again
const OMARCHY_COLORS = 'cat "${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/current/theme/colors.toml"'
let hasOmarchy = true
let omarchyAt = -Infinity

async function readOmarchy($: EngineInterface, now: number) {
  if (!hasOmarchy || now - omarchyAt < APPEARANCE_MS) return
  omarchyAt = now
  const r = await $.process.run(['/bin/sh', '-c', OMARCHY_COLORS], { timeoutMs: 2000 }).catch(() => null)
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

async function probeAppearance($: EngineInterface, now: number) {
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

// reads the appearance when due and repaints the bars at once if the tint changed
async function syncTint($: EngineInterface, now: number) {
  const before = omarchy
  if (band) await readOmarchy($, now)
  if (band && !omarchy) await probeAppearance($, now)
  const next = tintIsLight()
  if (next === isLight && omarchy === before) return
  isLight = next
  const b = band
  if (b) await blitPlans($, b, b.list, now)
}

// the size goes along, so a band redrawn at another width answers with a deny naming both sizes
function blitPlans($: EngineInterface, b: Band, list: readonly Plan[], now: number) {
  return Promise.all(
    list.flatMap(p => {
      const v = shownAgents(p, now, stripBudget(b.list.length))
      const strips = v ? stripCells(v, b.W, now) : null
      const calls = [$.ui.blit({ requestId: b.requestId, key: `track-${p.id}`, cells: trackCells(p, b.W, now), columns: b.W, rows: 1 })]
      if (strips) calls.push($.ui.blit({ requestId: b.requestId, key: `strips-${p.id}`, cells: strips.cells, columns: b.W, rows: strips.rows }))
      return calls.map(c => c.catch(() => undefined))
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
    const answers = await blitPlans($, b, live, now)
    if (!answers.some(a => a?.deny)) {
      refusedInRow = 0
      refusedAt = null
    } else if (++refusedInRow >= REFUSED_MAX) stopFrames(b, now)
  } finally {
    isFrameBusy = false
  }
}


// ---------- engine glue ----------

// the engine's player first (afplay on macOS); PowerShell where it cannot play
// set while a demo reel records: every sound with its moment, so a video can carry them
let soundLog: { at: number; name: string }[] | null = null

function play($: EngineInterface, name: 'decision' | 'error' | 'done') {
  if (soundLog) void $.clock.now().then(at => soundLog?.push({ at, name }))
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

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'plan'

// adds or replaces one bar by id; keeps at most MAX_BARS, dropping finished ones first
// computed inside update() from the latest list, so concurrent writers (parallel agents) do not drop each other
function placeBar(list: readonly Plan[], next: Plan): Plan[] {
  const prev = list.find(p => p.id === next.id)
  // an update keeps its row and, unless it brings its own, the agent strips already on it; a new bar goes to the bottom
  // an update keeps the bar's strips and whether the person folded them; Claude moves a bar after every step
  const kept = prev && !('agents' in next) ? { ...next, agents: prev.agents, agentsDoneAt: prev.agentsDoneAt, isFolded: 'isFolded' in next ? next.isFolded : prev.isFolded } : next
  const rest = prev ? list.map(p => (p.id === next.id ? kept : p)) : [...list, next]
  // the oldest finished bar goes first, then the oldest running one; the bar just placed and a bar waiting on the
  // person or showing an error stay while any other can go, though the mod's own Agents bar gives way to them
  const pick = (ok: (p: Plan) => boolean) => rest.findIndex(p => p.id !== next.id && ok(p))
  while (rest.length > MAX_BARS) {
    const ownAgents = next.id === AGENTS ? rest.findIndex(p => p.id === AGENTS) : -1
    const at = [pick(p => p.state === 'done'), pick(p => p.state === 'running'), ownAgents, pick(() => true)].find(i => i >= 0) ?? 0
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

async function putPlan($: EngineInterface, next: Plan) {
  await editPlan($, next.id, () => next)
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
let foldUntil = 0 // keep ticking until finished strips have folded

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
  return { ...p, agentsDoneAt, stages: [{ name: isOver ? 'Agents' : `${running} running`, steps }], state }
}

function addRun(p: Plan, run: AgentRun, parentId: string | undefined, now: number): Plan {
  // a batch that has finished makes room for the next one
  const list = p.agentsDoneAt ? [] : [...(p.agents ?? [])]
  let at = list.length
  const parentAt = parentId ? list.findIndex(a => a.id === parentId) : -1
  if (parentAt >= 0) {
    at = parentAt + 1
    while (at < list.length && (list[at]?.depth ?? 0) > 0) at++
  }
  list.splice(at, 0, run)
  return syncAuto({ ...p, agents: list, agentsDoneAt: null }, now)
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
// an agent the map does not know (the mod reloaded while it ran, and its call came before session.start rebuilt
// the map) is found again by its strip still running on a bar
async function knowAgent($: EngineInterface, agentId: string): Promise<boolean> {
  if (agentHome.has(agentId)) return true
  const bar = (await read($, plans)).find(p => (p.agents ?? []).some(a => a.id === agentId && (a.state === 'running' || a.state === 'waiting')))
  if (!bar) return false
  agentHome.set(agentId, bar.id)
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
  if (isFolding) foldUntil = now + FOLD_MS + 200
}

// module maps outlive the bars they describe: a bar pushed out past MAX_BARS, a cleared list, an agent
// whose finish never arrived (killed, or started before a reload); drop what no bar holds any more
function forgetGone(list: readonly Plan[]) {
  const bars = new Set(list.map(p => p.id))
  const live = new Set(list.flatMap(p => (p.agents ?? []).filter(a => a.state === 'running' || a.state === 'waiting').map(a => a.id)))
  const shown = new Set(list.flatMap(p => (p.agents ?? []).map(a => a.id)))
  for (const id of lastHead.keys()) if (!bars.has(id)) lastHead.delete(id)
  for (const id of glide.keys()) if (!bars.has(id)) glide.delete(id)
  for (const id of stillPhase.keys()) if (!bars.has(id)) stillPhase.delete(id)
  for (const id of lastStrip.keys()) if (!shown.has(id)) lastStrip.delete(id)
  for (const [id, home] of agentHome) {
    if (bars.has(home) && live.has(id)) continue
    agentHome.delete(id)
    forgetFlights(id)
  }
}

// folds a bar's agent strips away or shows them again; the bar itself stays, its pill still counting the agents
async function foldPlan($: EngineInterface, id: string) {
  await update($, plans, list => list.map(p => (p.id === id ? { ...p, isFolded: !p.isFolded } : p)))
}

// with auto-close on, a finished bar leaves on its own doneStaysMs after it finished, once none of its agents is still
// at work; a failed bar or one waiting on the person stays until it is closed, since it still asks for attention.
// /plan-progress-autoclose turns it on and off (kept in the store, so a new session keeps the choice); the seconds are
// the doneBarSeconds option in /config
const AUTOCLOSE = 'autoclose'
let isAutoClose = true
let doneStaysMs = 30_000
const hasLeft = (p: Plan, now: number) =>
  isAutoClose && p.state === 'done' && p.endedAt != null && now - p.endedAt >= doneStaysMs && !hasRunningAgents(p)

async function dropPlan($: EngineInterface, id: string) {
  lastHead.delete(id)
  glide.delete(id)
  stillPhase.delete(id)
  for (const p of await read($, plans)) if (p.id === id) for (const a of p.agents ?? []) lastStrip.delete(a.id)
  await update($, plans, list => list.filter(p => p.id !== id))
}

// substeps are left out: the bar never draws them and short ops cannot reach them
const STEP_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    status: { enum: STATUSES, description: 'Default pending' },
  },
}

// edits are the work the enforcement below counts. Shell calls are never refused or counted: the host marks only
// plain reads (ls) read-only, so a compound read (cd x && git log) would look like work and be refused
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const WORK_BEFORE_PLAN = 3 // the 4th edit without a plan is refused once
const CALLS_BEFORE_NUDGE = 6 // edits without a plan update before a reminder



// ---------- demo reel: two pipelines and their agents, ~13 s, for screen recordings ----------
const run = (id: string, title: string, tool: string, at: number, isSonnet: boolean): AgentRun => ({
  id, title, state: 'running', tool, startedAt: at, endedAt: null, depth: 0,
  ...(isSonnet ? { model: 'claude-sonnet-5-5', effort: 'medium' } : { model: 'claude-haiku-4-5' }),
})

// $.state lives as long as the process, so the bars are kept per session in the plugin's store as well
const SAVED = 'plans:'
const KEEP_SESSIONS = 20
let lastSaved: Plan[] | null = null

async function savePlans($: EngineInterface, list: Plan[]) {
  lastSaved = list
  const key = SAVED + (await $.session.id())
  if (list.length === 0) {
    await $.store.delete(key)
    return
  }
  await $.store.set(key, list)
  // the current session counts as one of the kept, whatever its place in the store's order
  const keys = (await $.store.keys()).filter(k => k.startsWith(SAVED) && k !== key)
  for (const old of keys.slice(0, Math.max(0, keys.length - (KEEP_SESSIONS - 1)))) await $.store.delete(old)
}

// agents do not outlive the process that ran them, so a restored bar comes back without strips, and the mod's
// own Agents bar, which only ever showed them, does not come back at all
async function restorePlans($: EngineInterface) {
  const saved = await $.store.get(SAVED + (await $.session.id()))
  if (!Array.isArray(saved) || saved.length === 0) return
  const list = (saved as Plan[]).filter(p => p.id !== AGENTS).map(p => ({ ...p, agents: [], agentsDoneAt: null }))
  if (list.length === 0) return
  await update($, plans, () => list)
  lastSaved = list
}

async function runReel($: EngineInterface, logPath: string) {
  const t0 = await $.clock.now()
  soundLog = []
  foldUntil = t0 + 20_000
  await update($, plans, () => [])
  const A = 'reel-checkout'
  const B = 'reel-release'
  const steps = (names: string[], active: number) => names.map((n, i) => st(n, i < active ? 'done' : i === active ? 'active' : 'pending'))
  // mid-run the checkout plan is rewritten: a Harden stage lands between Build and Verify
  let isReplanned = false
  const planA = (k: number, state: PlanState = 'running'): Plan => {
    const all = isReplanned
      ? ['Routes', 'Cart store', 'Payment API', 'Webhooks', 'Checkout UI', 'Rate limits', 'Security review', 'Tests', 'Build']
      : ['Routes', 'Cart store', 'Payment API', 'Webhooks', 'Checkout UI', 'Tests', 'Build']
    const s2 = steps(all, k)
    const stages = isReplanned
      ? [{ name: 'Explore', steps: s2.slice(0, 2) }, { name: 'Build', steps: s2.slice(2, 5) }, { name: 'Harden', steps: s2.slice(5, 7) }, { name: 'Verify', steps: s2.slice(7) }]
      : [{ name: 'Explore', steps: s2.slice(0, 2) }, { name: 'Build', steps: s2.slice(2, 5) }, { name: 'Verify', steps: s2.slice(5) }]
    return { id: A, title: 'Checkout flow', kind: 'plan', state, note: null, startedAt: t0, stages }
  }
  const planB = (k: number, state: PlanState = 'running'): Plan =>
    ({ id: B, title: 'Release notes', kind: 'todo', state, note: null, startedAt: t0, stages: [{ name: 'Release', steps: steps(['Collect PRs', 'Group changes', 'Draft notes', 'Publish'], k) }] })
  const setAgents = async (id: string, f: (a: AgentRun[]) => AgentRun[]) => {
    const now = await $.clock.now()
    await update($, plans, list => list.map(p => (p.id === id ? syncAuto({ ...p, agents: f(p.agents ?? []) }, now) : p)))
  }
  const edit = (id: string, agentId: string, ch: Partial<AgentRun>, at: number) =>
    setAgents(id, list => list.map(a => (a.id === agentId ? { ...a, ...ch, ...(ch.state === 'done' || ch.state === 'error' ? { endedAt: at } : {}) } : a)))
  const keep = async (id: string, f: (p: Plan) => Plan) => {
    let before: PlanState | undefined
    let after: PlanState | undefined
    const now = await $.clock.now()
    await update($, plans, list =>
      list.map(p => {
        if (p.id !== id) return p
        before = p.state
        const made = f(p)
        // a finished bar shows its time in the pill, so it needs the moment it ended
        const next = { ...made, endedAt: made.state === 'done' ? now : null, agents: p.agents, agentsDoneAt: p.agentsDoneAt }
        after = next.state
        return next
      }),
    )
    if (after) chime($, before, after)
  }

  // agent events: [ms, bar, agent id, title or change]
  type Ev = [number, string, string, string | Partial<AgentRun>]
  const ev: Ev[] = [
    [0, A, 'a1', 'Map payment routes'], [0, A, 'a2', 'Read cart store'], [0, A, 'a3', 'Scan checkout tests'], [0, A, 'a4', 'Trace tax rules'],
    [0, A, 'a5', 'List webhooks'], [300, B, 'b1', 'Collect merged PRs'], [300, B, 'b2', 'Group by area'], [300, B, 'b3', 'Find breaking changes'],
    [300, B, 'b4', 'Check migrations'], [900, A, 'a1', { tool: 'Read' }], [1100, B, 'b1', { tool: 'Bash' }], [1500, A, 'a2', { state: 'done' }],
    [2000, B, 'b2', { tool: 'Grep' }], [2200, A, 'a4', { tool: 'Grep' }], [2400, B, 'b1', { state: 'done' }],
    [2800, A, 'a1', { state: 'done' }], [3200, B, 'b3', { tool: 'Read' }],
    [3500, A, 'a3', { state: 'waiting', tool: 'Needs approval' }], [4100, B, 'b2', { state: 'done' }],
    [4400, A, 'a5', { state: 'done' }], [4700, B, 'b4', { state: 'done' }], [5000, A, 'a3', { state: 'running', tool: 'Bash' }],
    [5600, B, 'b5', 'Draft release notes'], [6000, A, 'a3', { state: 'error' }], [6600, B, 'b3', { state: 'done' }], [7000, A, 'a6', 'Fix webhook retry'], [7600, A, 'a4', { state: 'done' }],
    [8000, B, 'b5', { tool: 'Write' }], [8400, A, 'a6', { tool: 'Bash' }], [9000, B, 'b5', { state: 'done' }], [10200, A, 'a6', { state: 'done' }],
  ]
  const script: [number, () => Promise<unknown>][] = [
    [0, async () => {
      await putPlan($, planA(0))
      await putPlan($, planB(0))
    }],
    ...ev.map(([at, bar, id, x]): [number, () => Promise<unknown>] => [
      at,
      () => (typeof x === 'string' ? setAgents(bar, list => [...list, run(id, x, ['Glob', 'Read', 'Grep'][list.length % 3] ?? 'Read', t0 + at, list.length % 3 === 1)]) : edit(bar, id, x, t0 + at)),
    ]),
    [1600, () => keep(A, () => planA(1))], [2500, () => keep(B, () => planB(1))], [3500, () => keep(A, p => ({ ...planA(2), state: 'needs_input', note: 'Run payment tests?' }))],
    [5000, () => keep(A, () => planA(3))], [5700, () => keep(B, () => planB(2))],
    [6000, () => keep(A, () => ({ ...planA(5), state: 'error', note: '2 tests failed' }))],
    [7000, () => keep(A, () => { isReplanned = true; return planA(5) })], [8200, () => keep(B, () => planB(3))],
    [8800, () => keep(A, () => planA(7))],
    [9100, () => keep(B, () => planB(4, 'done'))], [10400, () => keep(A, () => planA(9, 'done'))],
    [13500, async () => {
      await $.fs.write(logPath, JSON.stringify({ t0, sounds: soundLog }))
      soundLog = null
    }],
  ]
  for (const [at, step] of script) $.clock.after(at, () => void step())
}

export const register: Register = (on, options) => {
  const seconds = Number(options?.doneBarSeconds ?? 30)
  doneStaysMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000

  // per-turn bookkeeping; module variables are fine here, a reload just starts a fresh count
  let workCalls = 0
  let sinceUpdate = 0
  let isPlanTouched = false
  let hasRefused = false
  let isWaitingOnBackground = false

  on('turn.start', async ($, e, next) => {
    isTurnLive = true
    workCalls = 0
    sinceUpdate = 0
    isPlanTouched = false
    hasRefused = false
    isWaitingOnBackground = false

    return next(e)
  })

  // the rule lives in the cached system prompt; a message only carries one short line when bars are open,
  // and the person answering clears any "needs input" without a model call
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const list = await read($, plans)
    if (list.some(p => p.state === 'needs_input')) {
      await update($, plans, all => all.map(p => (p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p)))
    }
    const open = list.filter(p => p.state !== 'done' && p.id !== AGENTS)
    if (open.length === 0) return next(e)
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
      if (!(await knowAgent($, agentId))) return next(e)
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
    if (!EDIT_TOOLS.has(e.tool)) return next(e)
    isWaitingOnBackground = false
    const open = (await read($, plans)).filter(isOpenPlan)
    const hasLivePlan = isPlanTouched || open.length > 0
    if (!hasLivePlan && !hasRefused && workCalls >= WORK_BEFORE_PLAN) {
      hasRefused = true

      return { deny: `plan-progress: several changes ahead. Create a bar with ${TOOL} first, then retry.` }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    workCalls += 1
    sinceUpdate += 1
    if (hasLivePlan && sinceUpdate >= CALLS_BEFORE_NUDGE) {
      sinceUpdate = 0
      const ids = open.map(p => p.id).join(', ') || 'the bar'

      return { ...ran, context: [...(ran.context ?? []), `plan-progress: ${ids} not updated for a while; send {id, next:true} or {id, done, active}.`] }
    }

    return ran
  })

  // an open bar at the end of a turn: a question to the user marks it waiting on its own;
  // only a turn that did work and left the bar unexplained is sent back once
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active || result.block || isWaitingOnBackground || (e.background_tasks?.length ?? 0) > 0) return result
    const open = (await read($, plans)).filter(isOpenPlan)
    if (open.length === 0) return result
    const asks = /\?\s*$/.test(e.last_assistant_message ?? '')
    if (asks) {
      const last = open[open.length - 1]
      if (last) await putPlan($, { ...last, state: 'needs_input' })

      return result
    }
    if (workCalls === 0 && !isPlanTouched) return result

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
    // a reload of the mod keeps the bars (they are the host's) but starts its maps empty: agents still at work
    // find their strips again first thing, so their next calls and their finish are not lost (knowAgent covers
    // a call that comes in even sooner)
    const kept = await read($, plans)
    for (const p of kept) for (const a of p.agents ?? []) if (a.state === 'running' || a.state === 'waiting') agentHome.set(a.id, p.id)
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
    if (kept.length === 0) await restorePlans($)
    const theme = (await $.config.list().catch(() => [])).find(row => row.key === 'theme')
    themeSetting = String(theme?.value ?? 'dark')
    isLight = tintIsLight()
    $.clock.every(1000, async () => {
      const list = await read($, plans)
      forgetGone(list)
      const now = await $.clock.now()
      for (const p of list) if (hasLeft(p, now)) await dropPlan($, p.id)
      syncFrames($, now)
      await syncTint($, now)
      if (list !== lastSaved) await savePlans($, list)
      // clocks count inside the frame, so the only timed redraw is folding finished strips away
      if (foldUntil === 0 || (await $.clock.now()) < foldUntil) return
      foldUntil = 0
      if (await read($, isOpen)) await update($, tick, n => n + 1)
    })
    await $.command.register({ name: 'progress', description: 'Show or hide the progress bars' })
    await $.command.register({ name: 'progress-clear', description: 'Remove all progress bars' })
    await $.command.register({ name: 'progress-agents', description: 'Fold or show the agent strips under the bars' })
    await $.command.register({ name: 'plan-progress-autoclose', description: 'Turn on or off finished bars leaving on their own' })
    isAutoClose = (await $.store.get(AUTOCLOSE)) !== false

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return { sections: [...result.sections, { id: 'plan-progress:rules', text: RULES, scope: 'session' as const }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const raw = e as unknown as Raw
    const now = await $.clock.now()
    const id = slug(str(raw.id, 60) || str(raw.title, 80))
    if (id === 'reel' && typeof raw.note === 'string') {
      await runReel($, raw.note)
      return { result: 'reel started' }
    }
    const next = await editPlan(
      $,
      id,
      prev => {
        const made = normalize(raw, prev, now, id)
        return typeof made !== 'string' && made.stages.length === 0 ? `plan_progress: no bar "${id}" yet; create it with title and stages.` : made
      },
      Boolean(e.agentId),
    )
    if (typeof next === 'string') return { deny: next }
    isPlanTouched = true
    sinceUpdate = 0
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
    const live = (await read($, plans)).filter(p => p.state === 'running').pop()
    if (live) await update($, plans, list => list.map(p => (p.id === live.id ? { ...p, state: 'needs_input' as const } : p)))
    play($, 'decision')
    const ran = await next(e)
    if (live) await update($, plans, list => list.map(p => (p.id === live.id && p.state === 'needs_input' ? { ...p, state: 'running' as const } : p)))

    return ran
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    if (!e.agentId) play($, 'decision')
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const text = (ran.result as { plan?: unknown } | undefined)?.plan
    const parsed = typeof text === 'string' ? parsePlan(text, await $.clock.now()) : null
    if (!parsed) return ran
    await editPlan($, PLAN_ID, prev =>
      prev ? { ...parsed, stages: pointAt(carryDone(parsed.stages, prev.stages)), startedAt: prev.startedAt } : { ...parsed, stages: pointAt(parsed.stages) },
    )

    // the model learns which bar holds its plan, so it moves that one rather than opening its own
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
    isAutoClose = !isAutoClose
    await $.store.set(AUTOCLOSE, isAutoClose)
    const s = Math.round(doneStaysMs / 1000)

    return {
      text: isAutoClose
        ? `Finished bars leave ${s} s after they finish; /plan-progress-autoclose keeps them.`
        : 'Finished bars stay until closed; /plan-progress-autoclose turns auto-close back on.',
    }
  })

  on('command.run', { command: 'progress-clear' }, async $ => {
    glide.clear()
    await update($, plans, () => [])

    return { text: 'Progress bars removed.' }
  })

  // drawn wherever it can be pressed, so the person sees the mod is loaded; dim while there is nothing to show
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.viewport?.isFullscreen !== true) return next(e)
    const count = (await read($, plans)).length
    const open = await read($, isOpen)
    const { Box, Button } = $.ui.resolve(e)
    // other mods add their labels to modes beneath us; keep them
    const below = await next(e)
    const press = () =>
      count === 0
        ? $.ui.toast('plan-progress is on. A bar appears when Claude starts a task with several steps.')
        : update($, isOpen, () => !open)

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button key="progress-toggle" dimColor={count === 0 || !open} label={count > 1 ? `Progress ${count}` : 'Progress'} onPress={press} />
        {below}
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
      const cols = Math.max(30, e.props.bodyColumns || 100)
      const hasClicks = e.viewport?.isFullscreen === true
      const titleW = Math.max(4, Math.min(Math.round(cols * 0.28), Math.max(...list.map(p => columnsOf(p.title)))))
      // where clicks land, a bar with agent strips gets a fold button before its ✕; every row keeps its cell, so the
      // rows still line up
      const hasFold = hasClicks && list.some(p => canFold(p, now, stripBudget(list.length)))
      const trackW = Math.max(12, Math.min(512, cols - titleW - (hasClicks ? 15 : 13) - (hasFold ? 2 : 0)))
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
                  <Box width={titleW} flexShrink={0}>
                    <Text wrap="truncate">{p.title}</Text>
                  </Box>
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
                  <Box marginLeft={titleW + 3}>
                    <Text color={stateColor(p.state)} wrap="truncate">{p.note}</Text>
                  </Box>
                ) : null}
                {strips ? (
                  <Box marginLeft={titleW + 3}>
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
      // what the host and the plugins after this one draw here stays, under the bars, next to the prompt (issue #15).
      // Asked last: a slow hook below would otherwise let an older draw set the band after a newer one
      const below = await next(e)
      return below ? (
        <Box flexDirection="column">
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
          const track = trackSvg(p, trackW)
          const hover = liveSource(track.overlay, now)
          const strips = v && Svg
            ? stripsSvg(v, p.agents ?? [], trackW).map(r => (
                <Svg
                  key={`strip-${p.id}-${r.key}`}
                  source={liveSource(`<svg xmlns="http://www.w3.org/2000/svg" width="${trackW}" height="${r.height}">${STRIP_STYLE}${r.html}</svg>`, now)}
                  alt={stripAlt(p, r.key)}
                  width={trackW}
                  height={r.height}
                />
              ))
            : []
          const agentsAlt = canFold(p, now, stripBudget(list.length)) ? `; agents: ${(p.agents ?? []).map(a => `${a.title} ${a.state}`).join(', ')}` : ''
          const line = i > 0 && Svg ? [<Svg key={`div-${p.id}`} source={divider} alt="divider" width={total} height={1} />] : []
          const w = where(p)
          const pct = percent(p, w)
          const color = stateColor(p.state)
          const stageName = p.stages[w.stage]?.name ?? ''
          const alt =
            p.state === 'done'
              ? `${p.title}: done, ${plural(w.total, 'step')}${p.endedAt ? ` in ${elapsed(p.endedAt - p.startedAt)}` : ''}`
              : `${p.title}: ${stageName}, step ${w.step} of ${w.stageSize}, ${pct}%${p.note ? ` — ${p.note}` : ''}${agentsAlt}`
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
                    <Svg source={track.base} alt={alt} width={trackW} height={TRACK_H} />
                    <Box position="absolute" top={0} left={0}>
                      <Svg source={hover} alt={`${p.title}: hover for times`} width={trackW} height={TRACK_H} isInteractive />
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
      <Box flexDirection="column">
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
    const home = parentHome ?? [...(await read($, plans))].reverse().find(isOpenPlan)?.id ?? AGENTS
    const run: AgentRun = {
      id,
      title: str(e.description || e.subagentType, 60),
      state: 'running',
      tool: 'Starting',
      model: started.model,
      startedAt: now,
      endedAt: null,
      depth: parentHome ? 1 : 0,
    }
    let isNew = false
    // the bar the strip really lands on: the home picked above can be gone by now (closed, cleared or pushed out)
    let placed = home
    await update($, plans, list => {
      if (list.some(p => p.id === home)) {
        // a child sits under its parent only where the parent's strip really is; elsewhere it starts a line of its own
        return list.map(p => {
          if (p.id !== home) return p
          const isUnder = !!e.parentAgentId && (p.agents ?? []).some(a => a.id === e.parentAgentId)
          return addRun(p, isUnder ? run : { ...run, depth: 0 }, isUnder ? e.parentAgentId : undefined, now)
        })
      }
      placed = AGENTS
      const top = { ...run, depth: 0 }
      if (list.some(p => p.id === AGENTS)) return list.map(p => (p.id === AGENTS ? addRun(p, top, undefined, now) : p))
      isNew = true
      const auto: Plan = { id: AGENTS, title: 'Agents', kind: 'todo', stages: [], state: 'running', note: null, startedAt: now }
      return placeBar(list, addRun(auto, top, undefined, now))
    })
    // known only once its strip is stored, so the cleanup in the clock never sees a home without the agent
    agentHome.set(id, placed)
    if (isNew) await update($, isOpen, () => true)

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
    if (agentId && (await knowAgent($, agentId))) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const known = (await read($, plans)).flatMap(p => p.agents ?? []).find(a => a.id === agentId)
      if (known && (known.model !== e.model || known.effort !== effort)) await editAgent($, agentId, a => ({ ...a, model: e.model, effort }))
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId) {
      isTurnLive = false
      // a glide still under way lands now: frames running on would go out with the engine's end-of-turn redraw
      for (const [id, g] of glide) glide.set(id, { from: g.to, to: g.to, at: g.at })
    }
    if (agentId && (await knowAgent($, agentId))) {
      const now = await $.clock.now()
      const isFailed = e.reason !== 'answer'
      const tool = e.reason === 'aborted' ? 'Stopped' : isFailed ? 'Failed' : 'Done'
      await editAgent($, agentId, a => ({ ...a, state: isFailed ? 'error' : 'done', tool, endedAt: now }))
      agentHome.delete(agentId)
      forgetFlights(agentId)
    }
    // a plan whose steps are all finished closes itself
    for (const p of await read($, plans)) {
      if (p.id === AGENTS) continue
      if (p.state === 'done') continue
      const steps = p.stages.flatMap(s => s.steps)
      if (steps.length > 0 && steps.every(s => isFinished(s.status))) await putPlan($, { ...p, state: 'done', endedAt: await $.clock.now() })
    }

    return next(e)
  })
}
