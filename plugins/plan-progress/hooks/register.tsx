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
const STATE_GLYPH: Record<PlanState, string> = { running: '●', needs_input: '?', error: '!', done: '✓' }
const STATUSES: StepStatus[] = ['pending', 'active', 'done', 'error', 'skipped']
const TRACK_H = 22
const NARROW = 360

const RULES = `# Progress bars
Tasks needing more than ~3 edits or commands get a bar via ${TOOL}: create it once with the full breakdown (2-7 stages of steps {title}, or kind "todo" for one flat list; titles of at most 4 words, in the user's language; the first open step becomes active), then move it with short calls: {id, next:true} when the active step is finished, or {id, done:[...], active:"..."}, {id, failed:"...", note}. When the plan changes, resend stages under the same id; steps sent without a status keep their done by title. Send state "needs_input" with a note before asking the user to decide. Never describe the bars to the user.`

type Raw = Record<string, unknown>
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
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
    active.status = 'active'
  }
  const failed = typeof input.failed === 'string' ? find(input.failed) : undefined
  if (failed) failed.status = 'error'

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
function carryDone(stages: PlanStage[], before: PlanStage[]): PlanStage[] {
  const finished = new Map(before.flatMap(s => s.steps).filter(st => isFinished(st.status)).map(st => [st.title.trim().toLowerCase(), st]))
  return stages.map(s => ({
    ...s,
    steps: s.steps.map(st => {
      const was = finished.get(st.title.trim().toLowerCase())
      return was && (st.status === 'pending' || st.status === was.status) ? { ...st, status: was.status, doneAt: was.doneAt } : st
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
const lastHead = new Map<string, number>()

// the track draws in a sandboxed frame (for hover); its page must stay see-through in either theme
const SEE_THROUGH = '<style>:root,html,body{background:transparent!important;color-scheme:light dark;margin:0;overflow:hidden}svg{display:block}</style>'

// a clock that counts in the frame by itself, so the drawing never has to be redrawn each second (a redraw
// reloads the frame and everything in it blinks): each digit is a reel of its figures behind a one-line window,
// stepped by a CSS animation whose negative delay is the time already run. Plain SVG, since the host's frame
// drops foreignObject. {{T:start}} becomes those seconds only when a bar's markup really changes (liveSource)
const CLOCK_W = 48 // "59m 59s"
const LINE = 16
const CLOCK_CSS = `.ckt{font-variant-numeric:tabular-nums}
.rs1{animation:r10 10s steps(10) var(--d) infinite}.rs10{animation:r6 60s steps(6) var(--d) infinite}
.cc{animation:cc 600s linear var(--d) both}@keyframes cc{0%,9.99%{transform:translateX(-13.5px)}10%,99.99%{transform:translateX(-3.25px)}100%{transform:none}}
.rm1{animation:r10 600s steps(10) var(--d) infinite}.rm10{animation:r10 6000s steps(10) var(--d) infinite}.rmm{animation:hm 60s steps(1,end) var(--d) both}
@keyframes r10{to{transform:translateY(-${LINE * 10}px)}}@keyframes r6{to{transform:translateY(-${LINE * 6}px)}}@keyframes hm{from{opacity:0}to{opacity:1}}`

// x is the clock's left edge, top the window's top; the minutes part stays hidden for the first minute
function liveClock(x: number, top: number, start: number, cls: string, textCls: string, isCentered = false): string {
  const base = top + 12
  const reel = (cx: number, figures: string[], reelCls: string) =>
    `<g class="${reelCls}"><text class="${textCls} ckt" text-anchor="middle">${figures
      .map((f, i) => `<tspan x="${cx.toFixed(1)}" y="${base + i * LINE}">${f}</tspan>`)
      .join('')}</text></g>`
  const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  const id = `ck${start}x${Math.round(x)}y${Math.round(top)}`
  return (
    `<style>.${id}{--d:-{{T:${start}}}s}</style><g class="${cls} ${id}"><clipPath id="${id}"><rect x="${(x - 2).toFixed(1)}" y="${top}" width="${CLOCK_W + 4}" height="${LINE}"/></clipPath>` +
    `<g clip-path="url(#${id})"${isCentered ? ' class="cc"' : ''}><g class="rmm">${reel(x + 3.5, ['', ...digits.slice(1)], 'rm10')}${reel(x + 10.5, digits, 'rm1')}` +
    `<text x="${(x + 14).toFixed(1)}" y="${base}" class="${textCls}">m</text></g>` +
    `${reel(x + 31, digits.slice(0, 6), 'rs10')}${reel(x + 38, digits, 'rs1')}<text x="${(x + 41.5).toFixed(1)}" y="${base}" class="${textCls}">s</text></g></g>`
  )
}

// a bar's frame reloads whenever its markup changes; markup that differs only in when it was drawn keeps the
// source already shown, so its clocks run on instead of the frame blinking
const lastSource = new Map<string, { template: string; source: string }>()
function liveSource(id: string, template: string, now: number): string {
  const last = lastSource.get(id)
  if (last?.template === template) return last.source
  const source = template.replace(/\{\{T:(\d+)\}\}/g, (_, t: string) => Math.max(0, (now - Number(t)) / 1000).toFixed(1))
  lastSource.set(id, { template, source })
  return source
}

// a bar is drawn twice: the track itself as a plain picture, which the desktop keeps steady whatever else redraws,
// and a see-through layer on top for the hover parts (checkpoint times, the pill's clock). That layer needs an
// interactive frame, and the desktop rebuilds such frames on every redraw of the band; empty until hovered, the
// rebuild is invisible. A plan is immutable, so both drawings at one width are reused until the plan changes
type Track = { base: string; overlay: string }
const drawn = new WeakMap<Plan, { W: number; track: Track }>()

function trackSvg(p: Plan, W: number): Track {
  const cached = drawn.get(p)
  if (cached?.W === W) return cached.track
  const track = drawTrack(p, W)
  drawn.set(p, { W, track })
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
  const from = lastHead.get(key) ?? fx
  lastHead.set(key, fx)

  const acc = hex(STATE_COLOR[p.state])
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
  const color = STATE_COLOR[p.state]
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
    // the pill carries the stage name alone; the fill and the percent already say how far along it is
    const count = ''
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
.kc{font-weight:400;fill-opacity:.75}
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

// the desktop drops an Svg whose alt is empty, so every drawing says what it shows
function stripAlt(p: Plan, key: string): string {
  const a = (p.agents ?? []).find(x => x.id === key)
  return a ? `agent ${a.title}: ${a.state}, ${a.tool}` : 'more agents'
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

// what each strip showed last time it was drawn, so a change morphs from the old status instead of jumping
const lastStrip = new Map<string, { tool: string; color: string }>()
const MORPH = '.2s'

// a strip's markup per agent object: drawn once per change, so its morph plays once and later redraws match
const drawnRows = new WeakMap<AgentRun, { key: string; html: string }>()


// one tinted strip per agent: state colour, name, what it does now and for how long; not a progress bar
// Lucide "bot", drawn at 12 px in the gutter before each strip
const BOT = '<rect width="16" height="12" x="4" y="8" rx="2"/><path d="M12 8V4H8M2 14h2M20 14h2M15 13v2M9 13v2"/>'
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
  const gutter = (y: number, label: string, color: string) =>
    `<g transform="translate(1 ${y + 2}) scale(.5)" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${BOT}</g>` +
    `<text x="16" y="${y + 11.5}" class="sn sg" style="fill:${color}">${label}</text>`
  v.shown.forEach((a, i) => {
    // the first strip keeps a little room from the track above it
    const y = i === 0 ? 5 : STRIP_GAP
    const rowKey = `${W}|${y}|${all.indexOf(a)}`
    const cachedRow = drawnRows.get(a)
    if (cachedRow?.key === rowKey) {
      rows.push({ key: a.id, html: cachedRow.html, height: y + STRIP_H })
      return
    }
    const c = AGENT_COLOR[a.state]
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
    lastStrip.set(a.id, { tool: word, color: c })
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
      : (isWordChanged && was.tool ? `<text x="${toolEnd}" y="${y + 11.5}" text-anchor="end" class="sn mo" style="fill:${was.color}">${esc(was.tool)}</text>` : '') +
        (word ? `<text x="${toolEnd}" y="${y + 11.5}" text-anchor="end" class="sn${isWordChanged ? ' mi' : ''}" style="fill:${c}">${esc(word)}</text>` : '') +
        time
    const html =
      gutter(y, String(all.indexOf(a) + 1), '#A8A69E') +
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
        gutter(y, `+${v.hidden.length}`, '#8A8984') +
        `<rect x="${GUTTER}" y="${y}" width="${SW}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="#808080" fill-opacity=".14"/>` +
        `<text x="${GUTTER + 10}" y="${y + 11.5}" class="sn st">${plural(v.hidden.length, 'more agent')} · ${doneCount} done</text>`,
    })
  }
  return rows
}

const STRIP_STYLE = `<style>.sn{font:400 11.5px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:#F0EEFC}.st{fill-opacity:.65}.sg{font-weight:500;font-variant-numeric:tabular-nums}
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
const termBg = () => (isLight ? [255, 255, 255] : [24, 24, 27])
const termFg = () => (isLight ? [34, 34, 38] : [240, 238, 252])
const pack = (c: number[]) => ((c[0] ?? 0) << 16) | ((c[1] ?? 0) << 8) | (c[2] ?? 0)
const isWide = (cp: number) => cp > 0xffff || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
const cellText = (s: string) => [...s].map(ch => (isWide(ch.codePointAt(0) ?? 63) || (ch.codePointAt(0) ?? 0) < 32 ? '·' : ch)).join('')
const cellsOf = (s: string) => [...s].reduce((w, ch) => w + (isWide(ch.codePointAt(0) ?? 0) ? 2 : 1), 0)
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

function headAt(id: string, target: number, t: number): number {
  const g = glide.get(id)
  if (!g) {
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
  const fx = headAt(p.id, target, t)
  const back = termBg()
  const acc = hex(STATE_COLOR[p.state])
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
    const blink = 1 - dim * wave(t + (DELAY[cls] ?? 0), period, 0.25)
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

  const base = hex(STATE_COLOR[p.state])
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
  const white = pack([255, 255, 255])
  pill(g, 0, kx, kx + kw, () => color)
  let at = kx + 1
  at += g.text(at, 0, shown, white, pack(color))
  if (count) g.text(at + 1, 0, count, pack(mix([255, 255, 255], color, 0.3)), pack(color))
  return g.encode()
}

function stripCells(v: { shown: AgentRun[]; hidden: AgentRun[] }, W: number, now: number): { cells: string; rows: number } {
  const rows = v.shown.length + (v.hidden.length > 0 ? 1 : 0)
  const g = new Grid(W, rows)
  const back = termBg()
  const text = pack(termFg())
  v.shown.forEach((a, y) => {
    const c = hex(AGENT_COLOR[a.state])
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
    if (head !== name) g.text(at, y, name.slice(head.length), pack(mix(termFg(), tint, 0.4)), pack(tint))
    if (narrow) return
    if (word) {
      for (let i = -1; i <= word.length; i++) g.set(toolAt + i, y, ' ', DEFAULT, pack(tint))
      g.text(toolAt, y, word, pack(c), pack(tint))
    }
    for (let i = -1; i < time.length; i++) g.set(tx + i, y, ' ', DEFAULT, pack(tint))
    g.text(tx, y, time, pack(mix(termFg(), tint, 0.35)), pack(tint))
  })
  if (v.hidden.length > 0) {
    const y = v.shown.length
    const tint = mix(back, [128, 128, 128], 0.16)
    pill(g, y, 0, W, () => tint)
    const doneCount = v.hidden.filter(a => a.state === 'done').length
    g.text(2, y, fit(`+${plural(v.hidden.length, 'more agent')} · ${doneCount} done`, W - 4), pack(mix(termFg(), tint, 0.35)), pack(tint))
  }
  return { cells: g.encode(), rows }
}

type Band = { requestId: string; W: number; list: readonly Plan[] }
let band: Band | null = null
let isFrameBusy = false
// a bar twinkles only while Claude works on it; one waiting on the person or left open after the turn stands still
let isTurnLive = false
let frames: { cancel: () => void } | null = null

const hasRunningAgents = (p: Plan) => (p.agents ?? []).some(a => a.state === 'running' || a.state === 'waiting')
const isGliding = (p: Plan, t: number) => {
  const g = glide.get(p.id)
  return g !== undefined && g.from !== g.to && t - g.at < GLIDE_MS + 100
}
const isAnimated = (p: Plan, t: number) => (isTurnLive && p.state === 'running') || hasRunningAgents(p) || isGliding(p, t)

// the 30 fps clock runs only while a terminal band has something moving; the second timer starts and stops it
function syncFrames($: EngineInterface, now: number) {
  const isWanted = band !== null && band.list.some(p => isAnimated(p, now))
  if (isWanted && !frames) frames = $.clock.every(33, () => void animate($))
  if (!isWanted && frames) {
    frames.cancel()
    frames = null
  }
}

// ---------- terminal tint ----------
// the track's light or dark tint: a theme the person picked wins; "auto", and the default "dark" inside Terminal.app
// (whose stock profiles follow macOS), take the macOS appearance. The appearance is read only while a terminal bar
// is on screen, at most every APPEARANCE_MS, and never again once the command turns out to be missing (not a Mac)
const APPEARANCE_MS = 5000
let themeSetting = 'dark'
let mac: 'unknown' | 'yes' | 'no' = 'unknown'
let termProgram = ''
let isSystemDark: boolean | null = null
let appearanceAt = -Infinity
let isProbing = false

const followsSystem = () => mac !== 'no' && (themeSetting === 'auto' || (themeSetting === 'dark' && (mac === 'unknown' || termProgram === 'Apple_Terminal')))
const tintIsLight = () => (followsSystem() && isSystemDark !== null ? !isSystemDark : /light/i.test(themeSetting))

async function probeAppearance($: EngineInterface, now: number) {
  if (isProbing || !followsSystem() || now - appearanceAt < APPEARANCE_MS) return
  isProbing = true
  appearanceAt = now
  try {
    const r = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 2000 }).catch(() => null)
    if (!r) {
      // no such command: not a Mac, so the theme setting alone decides from here on
      mac = 'no'
      return
    }
    if (mac === 'unknown') {
      const t = await $.process.run(['/bin/sh', '-c', 'printf %s "$TERM_PROGRAM"'], { timeoutMs: 2000 }).catch(() => null)
      termProgram = t?.stdout.trim() ?? ''
      mac = 'yes'
    }
    // the key is missing in light mode, so anything but "Dark" reads as light
    isSystemDark = /dark/i.test(r.stdout)
  } finally {
    isProbing = false
  }
}

// reads the appearance when due and repaints the bars at once if the tint changed
async function syncTint($: EngineInterface, now: number) {
  if (band) await probeAppearance($, now)
  const next = tintIsLight()
  if (next === isLight) return
  isLight = next
  const b = band
  if (b) await blitPlans($, b, b.list, now)
}

function blitPlans($: EngineInterface, b: Band, list: readonly Plan[], now: number) {
  return Promise.all(
    list.flatMap(p => {
      const v = visibleAgents(p, now, stripBudget(b.list.length))
      const strips = v ? stripCells(v, b.W, now) : null
      const calls = [$.ui.blit({ requestId: b.requestId, key: `track-${p.id}`, cells: trackCells(p, b.W, now) })]
      if (strips) calls.push($.ui.blit({ requestId: b.requestId, key: `strips-${p.id}`, cells: strips.cells }))
      return calls.map(c => c.catch(() => undefined))
    }),
  )
}

async function animate($: EngineInterface) {
  const b = band
  if (!b || isFrameBusy) return
  const now = await $.clock.now()
  const live = b.list.filter(p => isAnimated(p, now))
  if (live.length === 0) return
  isFrameBusy = true
  try {
    await blitPlans($, b, live, now)
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
  const viaPowerShell = () =>
    $.process
      .run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { timeoutMs: 5000 })
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
  const kept = prev && !('agents' in next) ? { ...next, agents: prev.agents, agentsDoneAt: prev.agentsDoneAt } : next
  const rest = prev ? list.map(p => (p.id === next.id ? kept : p)) : [...list, next]
  while (rest.length > MAX_BARS) {
    const doneAt = rest.findIndex(p => p.state === 'done')
    rest.splice(doneAt >= 0 ? doneAt : 0, 1)
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
// Module maps: a reload forgets running agents, whose strips then stay until the bar is closed.
const agentHome = new Map<string, string>() // agentId -> bar id
const toolUses = new Map<string, string>() // tool_use_id -> agentId, to find who waits on a permission
const waiting = new Set<string>()
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
  return { ...p, agentsDoneAt, stages: [{ name: 'Agents', steps }], state }
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

// changes one agent's strip inside the latest list; silent, since a subagent answers to Claude, not to the person
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
  for (const id of lastSource.keys()) {
    const [bar, strip] = id.split('/')
    if (!bars.has(bar ?? '') || (strip !== undefined && strip !== '+' && !shown.has(strip))) lastSource.delete(id)
  }
  for (const id of lastStrip.keys()) if (!shown.has(id)) lastStrip.delete(id)
  for (const [id, home] of agentHome) {
    if (bars.has(home) && live.has(id)) continue
    agentHome.delete(id)
    waiting.delete(id)
  }
}

async function dropPlan($: EngineInterface, id: string) {
  lastHead.delete(id)
  glide.delete(id)
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
  const keys = (await $.store.keys()).filter(k => k.startsWith(SAVED))
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_SESSIONS))) await $.store.delete(old)
}

// agents do not outlive the process that ran them, so a restored bar comes back without strips
async function restorePlans($: EngineInterface) {
  const saved = await $.store.get(SAVED + (await $.session.id()))
  if (!Array.isArray(saved) || saved.length === 0) return
  const list = (saved as Plan[]).map(p => ({ ...p, agents: [], agentsDoneAt: null }))
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

export const register: Register = on => {
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
      if (!agentHome.has(agentId)) return next(e)
      await editAgent($, agentId, a => ({ ...a, state: 'running', tool: e.tool }))
      if (e.tool_use_id) toolUses.set(e.tool_use_id, agentId)
      let ran
      try {
        ran = await next(e)
      } finally {
        if (e.tool_use_id) toolUses.delete(e.tool_use_id)
      }
      if (waiting.delete(agentId)) await editAgent($, agentId, a => (a.state === 'waiting' ? { ...a, state: 'running' } : a))
      return ran
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
    if ((await read($, plans)).length === 0) await restorePlans($)
    const theme = (await $.config.list().catch(() => [])).find(row => row.key === 'theme')
    themeSetting = String(theme?.value ?? 'dark')
    isLight = tintIsLight()
    $.clock.every(1000, async () => {
      const list = await read($, plans)
      forgetGone(list)
      const now = await $.clock.now()
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

  on('command.run', { command: 'progress-clear' }, async $ => {
    glide.clear()
    await update($, plans, () => [])

    return { text: 'Progress bars removed.' }
  })

  // always drawn, so the person sees the mod is loaded; dim while there is nothing to show
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const count = (await read($, plans)).length
    const open = await read($, isOpen)
    const { Box, Button, Text } = $.ui.resolve(e)
    // other mods add their labels to modes beneath us; keep them
    const below = await next(e)
    const press = () =>
      count === 0
        ? $.ui.toast('plan-progress is on. A bar appears when Claude starts a task with several steps.')
        : update($, isOpen, () => !open)

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {e.surface === 'terminal' && e.viewport?.isFullscreen !== true ? (
          <Text dimColor>{count > 1 ? `Progress ${count}` : 'Progress'}</Text>
        ) : (
          <Button key="progress-toggle" dimColor={count === 0 || !open} label={count > 1 ? `Progress ${count}` : 'Progress'} onPress={press} />
        )}
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
      const titleW = Math.max(4, Math.min(Math.round(cols * 0.28), Math.max(...list.map(p => cellsOf(p.title)))))
      const trackW = Math.max(12, Math.min(512, cols - titleW - (hasClicks ? 15 : 13)))
      band = { requestId: e.requestId, W: trackW, list }
      return (
        <Box flexDirection="column">
          {list.map(p => {
            const v = visibleAgents(p, now, stripBudget(list.length))
            const strips = v ? stripCells(v, trackW, now) : null
            const w = where(p)
            const pct = p.state === 'done' ? 100 : Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100)
            return (
              <Box key={`bar-${p.id}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={STATE_COLOR[p.state]}>{STATE_GLYPH[p.state]}</Text>
                  <Box width={titleW} flexShrink={0}>
                    <Text wrap="truncate">{p.title}</Text>
                  </Box>
                  <Raster key={`track-${p.id}`} columns={trackW} rows={1} cells={trackCells(p, trackW, now)} />
                  <Text dimColor>{`${String(pct).padStart(3, FIGURE_SPACE)}%`}</Text>
                  {hasClicks ? <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} /> : null}
                </Box>
                {p.note && p.state !== 'running' ? (
                  <Box marginLeft={titleW + 3}>
                    <Text color={STATE_COLOR[p.state]} wrap="truncate">{p.note}</Text>
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
    }
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    // every bar has the same width and is pinned to the right edge (fixed-width percent, close button),
    // so rows line up whatever their titles; the slack goes into the gap after the title.
    // Desktop reports ~8 CSS px per column; glyph, gaps, percent and the close button take ~126 px.
    const titleWidth = Math.min(Math.round(total * 0.3), Math.max(...list.map(p => Math.round(textWidth(p.title, 6.4)))))
    const trackW = Math.max(120, Math.min(1400, total - titleWidth - 140))
    await read($, tick)
    const now = await $.clock.now()
    // a hairline between task bars, so each bar and its agent strips read as one group
    const divider = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="1"><rect width="${total}" height="1" fill="#808080" fill-opacity=".22"/></svg>`

    return (
      <Box flexDirection="column" gap={1}>
        {list.flatMap((p, i) => {
          const v = visibleAgents(p, now, stripBudget(list.length))
          const track = trackSvg(p, trackW)
          // the layer is rebuilt on every redraw anyway, so its clock is set from now each time
          const hover = track.overlay.replace(/\{\{T:(\d+)\}\}/g, (_, t: string) => Math.max(0, (now - Number(t)) / 1000).toFixed(1))
          const strips = v && Svg
            ? stripsSvg(v, p.agents ?? [], trackW).map(r => (
                <Svg
                  key={`strip-${p.id}-${r.key}`}
                  source={liveSource(`${p.id}/${r.key}`, `<svg xmlns="http://www.w3.org/2000/svg" width="${trackW}" height="${r.height}">${STRIP_STYLE}${r.html}</svg>`, now)}
                  alt={stripAlt(p, r.key)}
                  width={trackW}
                  height={r.height}
                />
              ))
            : []
          const agentsAlt = v ? `; agents: ${(p.agents ?? []).map(a => `${a.title} ${a.state}`).join(', ')}` : ''
          const line = i > 0 && Svg ? [<Svg key={`div-${p.id}`} source={divider} alt="divider" width={total} height={1} />] : []
          const w = where(p)
          const pct = p.state === 'done' ? 100 : Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100)
          const color = STATE_COLOR[p.state]
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
              <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} />
            </Box>,
          ]
        })}
      </Box>
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
      title: (e.description || e.subagentType).slice(0, 60),
      state: 'running',
      tool: 'Starting',
      model: started.model,
      startedAt: now,
      endedAt: null,
      depth: parentHome ? 1 : 0,
    }
    let isNew = false
    await update($, plans, list => {
      if (list.some(p => p.id === home)) return list.map(p => (p.id === home ? addRun(p, run, e.parentAgentId, now) : p))
      isNew = true
      const auto: Plan = { id: AGENTS, title: 'Agents', kind: 'todo', stages: [], state: 'running', note: null, startedAt: now }
      return placeBar(list, addRun(auto, run, undefined, now))
    })
    // known only once its strip is stored, so the cleanup in the clock never sees a home without the agent
    agentHome.set(id, home)
    if (isNew) await update($, isOpen, () => true)

    return started
  })

  // an agent waiting on a permission prompt turns its strip amber until the call goes on
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const agentId = e.tool_use_id ? toolUses.get(e.tool_use_id) : undefined
    const useId = e.tool_use_id
    // the mode often settles an ask by itself in a blink; only a call still held after a moment waits on the person
    if (agentId && useId && verdict.decision === 'ask') {
      $.clock.after(600, async () => {
        if (toolUses.get(useId) !== agentId) return
        waiting.add(agentId)
        await editAgent($, agentId, a => ({ ...a, state: 'waiting', tool: 'Needs approval' }))
      })
    }

    return verdict
  })

  // the first request of an agent's loop says what it runs on: the resolved model and its effort
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId && agentHome.has(agentId)) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const known = (await read($, plans)).flatMap(p => p.agents ?? []).find(a => a.id === agentId)
      if (known && (known.model !== e.model || known.effort !== effort)) await editAgent($, agentId, a => ({ ...a, model: e.model, effort }))
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId) isTurnLive = false
    if (agentId && agentHome.has(agentId)) {
      const now = await $.clock.now()
      const isFailed = e.reason !== 'answer'
      const tool = e.reason === 'aborted' ? 'Stopped' : isFailed ? 'Failed' : 'Done'
      await editAgent($, agentId, a => ({ ...a, state: isFailed ? 'error' : 'done', tool, endedAt: now }))
      agentHome.delete(agentId)
      waiting.delete(agentId)
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
