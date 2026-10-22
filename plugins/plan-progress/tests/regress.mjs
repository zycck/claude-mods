// the audit's cases after the fixes: each check states the behaviour the mod should have now
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { boot, S, st } from './engine.mjs'

const file = process.argv[2] ?? './register.mjs'
const three = () => [S('One', st('A', 'active'), 'B'), S('Two', 'C')]
const create = (E, id = 't', stages = three(), title = 'Task') => E.call({ id, title, stages })
const res = r => r.deny ?? r.result
const glyphs = cells => {
  const w = new Uint32Array(Uint8Array.from(Buffer.from(cells, 'base64')).buffer)
  let out = ''
  for (let i = 0; i < w.length; i += 3) out += String.fromCodePoint(w[i])
  return out
}
// the track's unfilled background, read from the last cell of its latest frame
const backOf = cells => new Uint32Array(Uint8Array.from(Buffer.from(cells, 'base64')).buffer).at(-1)
const lum = c => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255)
const LUM_MID = 384
// the latest track frame: a repaint if there was one, else the raster of the last render
const trackTint = async E => {
  const blit = E.blits.filter(b => b.key === 'track-t').at(-1)
  if (blit) return backOf(blit.cells)
  const r = (await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t')
  return backOf(r.props.cells)
}
const MACHINE = ['MAC', 'DARK', 'TERM_PROGRAM', 'THEME', 'SCHEME', 'OMARCHY']
// every cell's background in a track frame, and the colors.toml of two Omarchy themes
const backsOf = cells => {
  const w = new Uint32Array(Uint8Array.from(Buffer.from(cells, 'base64')).buffer)
  const out = []
  for (let i = 2; i < w.length; i += 3) out.push(w[i])
  return out
}
const latestTrack = async E => {
  const blit = E.blits.filter(b => b.key === 'track-t').at(-1)
  if (blit) return blit.cells
  return (await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t').props.cells
}
const OMARCHY_LIGHT = 'mode = "light"\naccent = "#3264eb"\nbackground = "#fafafa"\nforeground = "#212121"\n'
const OMARCHY_DARK = 'accent = "#e75a50"\nforeground = "#efebdc"\nbackground = "#1B1B1B"\n'
// the tint tests play a machine through globals; each run starts from a light Mac and cleans up after itself
async function withMachine(set, run) {
  for (const k of MACHINE) delete globalThis[k]
  Object.assign(globalThis, set)
  try {
    return await run()
  } finally {
    for (const k of MACHINE) delete globalThis[k]
  }
}
const pct = async (E, id) => (await E.view(id)).alt.match(/\d+%/)?.[0]
// what a drawn Button keyed `key` reads, and whether the footer shows the tokens-per-second figure
const labelOf = (nodes, key) => nodes.find(n => n.type === 'Button' && n.props?.key === key)?.props.label
// the desktop pads the Buttons over its pictures with figure spaces; the words are what is left
const FIG = String.fromCharCode(0x2007)
const unpadded = label => label?.replaceAll(FIG, '')
// a switch's state: on the desktop as the picture under its blank Button says it ("Sounds: On"), on the terminal as
// the Button's children draw it ("━━● On")
const stateOf = (nodes, key) => {
  const at = nodes.findIndex(n => n.type === 'Button' && n.props?.key === key)
  if (at < 0) return undefined
  const drawn = (nodes[at].children ?? []).flat().map(c => (typeof c === 'string' ? c : (c?.children ?? []).join(''))).join('').trim()
  if (drawn) return drawn.split(/\s+/).pop()
  return nodes.slice(0, at).reverse().find(n => n.type === 'Svg')?.props.alt.split(': ').pop()
}
// every word the window draws: its texts, its Buttons' labels and children, its pictures' alts; a blank Button over a
// picture says nothing of its own
const wordsIn = nodes =>
  nodes.flatMap(n =>
    n.type === 'Text'
      ? [(n.children ?? []).flat().join('')]
      : n.type === 'Button'
        ? [unpadded(n.props.label ?? '')].filter(x => x !== '')
        : n.type === 'Svg'
          ? [n.props.alt]
          : [],
  )
// the version row's world: a marketplace install of plan-progress at version v (its manifest, and installed_plugins.json
// under CLAUDE_CONFIG_DIR /cfg listing it at the copy's root), the releases GitHub lists, and what the row draws
const installAs = (v, root = `/cfg/plugins/cache/mods/plan-progress/${v}`) => {
  globalThis.ROOT = root
  globalThis.ENV = { ...(globalThis.ENV ?? {}), CLAUDE_CONFIG_DIR: '/cfg' }
  globalThis.FILES = {
    [`${root}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'plan-progress', version: v }),
    '/cfg/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'plan-progress@mods': [{ scope: 'user', installPath: root, version: v }] } }),
  }
}
const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://example.test/releases/tag/${tag}`, ...extra })
const releasesAre = list => (globalThis.HTTP = async () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(list) }))
const clearVersion = () => ['ROOT', 'ENV', 'FILES', 'HTTP', 'CLI', 'COMMAND_RUN'].forEach(k => delete globalThis[k])
const versionRow = async (E, surface = 'desktop') => {
  const w = await E.pane('settings', surface)
  const said = wordsIn(w)
  // the row's line: the text after its title, Version
  const texts = w.filter(n => n.type === 'Text').map(n => (n.children ?? []).flat().join(''))
  return { w, label: labelOf(w, 'version'), said: said.join(' / '), line: texts[texts.lastIndexOf('Version') + 1], link: w.find(n => n.type === 'Link')?.props, buttons: w.filter(n => n.type === 'Button').map(n => n.props.key) }
}
// the claude CLI's answers: the marketplace pulled (its exit code says), then `update --json` for the plugin
const cliAnswers = (calls, update) => argv => {
  calls.push(argv.slice(1).join(' '))
  if (argv[2] === 'marketplace') return { exitCode: 0, stdout: `Refreshing…\n${JSON.stringify({ command: 'marketplace-update', outcome: 'ok', message: 'Successfully updated marketplace: mods' })}\n`, stderr: '' }
  return { exitCode: 0, stdout: JSON.stringify(update), stderr: '' }
}
const UPDATED = { command: 'update', outcome: 'ok', updateOutcome: 'updated', oldVersion: '1.0.0', newVersion: '1.0.1', message: 'Plugin "plan-progress" updated from 1.0.0 to 1.0.1 for scope user. Restart to apply changes.' }
// the settings window open on a booted copy, its version pressed (and Update after it when asked), the press's timers run
async function pressVersion(F, ...keys) {
  for (const key of keys) await F.press((await versionRow(F)).w, key)
  F.tick(300)
  await F.fireTimers()
  return versionRow(F)
}
// the footer's news mark: on the desktop a blue diamond emoji in the ⚙ chip's label, on the terminal a ● inside the ⚙ Button
const dotOf = async (E, surface) => {
  const foot = await E.footer(surface, true)
  if (surface === 'desktop') return foot.find(n => n.type === 'Button' && n.props.key === 'settings')?.props.label === '⚙\uFE0E \u{1F539}'
  const gear = foot.find(n => n.type === 'Button' && n.props.key === 'settings')
  return (gear?.children ?? []).flat().some(c => c?.type === 'Text' && c.props.color === 'suggestion' && (c.children ?? []).join('') === '●')
}
// the session's first check: 15 s after it starts
const firstCheck = async E => {
  E.tick(15_000)
  await E.fireTimers()
  // the timer starts the check and returns; the check runs on
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}
const hasFigure = nodes => nodes.some(n => n.type === 'Text' && (n.children ?? []).join('').includes('tok/s'))
// every element of a drawn tree, flat
// WCAG 2.x contrast of two colours, and a colour laid over another at some opacity, as a browser paints them
const toRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const luminance = c => {
  const l = c.map(v => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
const over = (back, c, a) => back.map((v, i) => Math.round(v + (c[i] - v) * a))
const walkAll = (n, out = []) => {
  if (Array.isArray(n)) n.forEach(c => walkAll(c, out))
  else if (n && typeof n === 'object') {
    out.push(n)
    ;(n.children ?? []).forEach(c => walkAll(c, out))
  }
  return out
}

// the stream's parts in a track picture: the wave's pattern and its runs of columns, the flicker's patterns, the rects
// that lay them over the fill, every dot of the tile and every class's timeline
const streamOf = src => {
  const [, wpW, wpBody = ''] = src.match(/<pattern id="wp" width="(\d+)" height="\d+"[^>]*>(.*?)<\/pattern>/) ?? []
  const levels = []
  const runs = []
  for (const [, o, d] of wpBody.matchAll(/<path stroke-opacity="([\d.]+)" d="([^"]+)"\/>/g)) {
    levels.push(Number(o))
    let x = 0
    for (const [, cmd, a, w] of d.matchAll(/([Mm])(-?[\d.]+) -?[\d.]+h([\d.]+)/g)) {
      x = cmd === 'M' ? Number(a) : x + Number(a)
      runs.push([x, x + Number(w)])
      x += Number(w)
    }
  }
  runs.sort((a, b) => a[0] - b[0])
  const kfade = src.match(/<g mask="url\(#kfade\)">(.*?)<\/g>/)?.[1] ?? ''
  const laid = [...kfade.matchAll(/<rect width="([\d.]+)" height="\d+" fill="url\(#fp(\d+)\)"\/>/g)].map(m => ({ k: Number(m[2]), w: Number(m[1]) }))
  const patterns = [...src.matchAll(/<pattern id="fp(\d+)" width="(\d+)" height="\d+" y="([\d.]+)"[^>]*><path class="q(\d+)" fill="[^"]+" d="([^"]+)"\/><\/pattern>/g)].map(m => ({ k: Number(m[1]), w: Number(m[2]), y: m[3], cls: Number(m[4]), d: m[5] }))
  const dots = new Map()
  for (const p of patterns) {
    let x = 0
    let y = 0
    for (const [, cmd, a, b] of p.d.matchAll(/([Mm])(-?\d+) (-?\d+)h2v2h-2z/g)) {
      x = cmd === 'M' ? Number(a) : x + Number(a)
      y = cmd === 'M' ? Number(b) : y + Number(b)
      dots.set(`${x},${y}`, (dots.get(`${x},${y}`) ?? 0) + 1)
    }
  }
  const timelines = [...src.matchAll(/\.q(\d+)\{opacity:0;animation:q\1 ([\d.]+)s step-end infinite;animation-delay:calc\(var\(--f\) - ([\d.]+)s\)\}@keyframes q\1\{(.*?)\}\}/g)].map(m => ({
    k: Number(m[1]),
    length: Number(m[2]),
    delay: Number(m[3]),
    frames: [...m[4].matchAll(/([\d.]+)%\{opacity:([\d.]+)/g)].map(f => [Number(f[1]), Number(f[2])]),
  }))
  return { wpW: Number(wpW), strokeW: Number(wpBody.match(/<g stroke="#fff" stroke-width="([\d.]+)">/)?.[1]), levels, runs, laid, patterns, dots, timelines }
}
// the wave's column at the moment of drawing: the columns gone since its last change of speed plus those it had by then
const waveAt = src => {
  const [, loop, n] = src.match(/\.wm\{animation:wm ([\d.]+)s steps\((\d+)\)/) ?? []
  const since = Number(src.match(/--w:-([\d.]+)s/)?.[1])
  const ahead = Number(src.match(/animation-delay:calc\(var\(--w\) - ([\d.]+)s\)/)?.[1])
  return { col: Math.floor((since + ahead) * (Number(n) / Number(loop)) + 1e-6) % Number(n), n: Number(n), speed: Number(n) / Number(loop) }
}
const onBeat = (t, beat = 0.05) => Math.abs(t / beat - Math.round(t / beat)) < 0.04

const C = {
  async T01_next(E) {
    await create(E)
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', next: true })
    return [E.steps('t'), E.steps('t') === 'A:done B:done C:active']
  },
  async T02_T04_snapshot(E) {
    await create(E)
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', stages: [S('New', st('C', 'active'), st('A', 'done'), st('B2', 'pending'))] })
    return [`${E.plans().length} bar; ${E.steps('t')}`, E.plans().length === 1 && E.steps('t') === 'C:active A:done B2:pending']
  },
  async T03_percent_after_append(E) {
    await create(E)
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', next: true })
    const a = await pct(E, 't')
    await E.call({ id: 't', stages: [S('One', st('A', 'done'), st('B', 'done')), S('Two', st('C', 'active'), 'D')] })
    return [`${a} → ${await pct(E, 't')}`, a === '67%' && (await pct(E, 't')) === '50%']
  },
  async T05_resend_keeps_done(E) {
    await create(E)
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', stages: [S('One', 'A', 'B'), S('Two', 'C', 'D')] })
    return [E.steps('t'), E.steps('t') === 'A:done B:done C:active D:pending']
  },
  async T05b_active_redoes(E) {
    await create(E)
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', stages: [S('One', st('A', 'active'), 'B'), S('Two', 'C')] })
    return [E.steps('t'), E.steps('t') === 'A:active B:pending C:pending']
  },
  async T06_T07_create_without_status(E) {
    const r = await E.call({ id: 't', title: 'Task', stages: [{ name: 'One', steps: [{ title: 'A' }, { title: 'B' }] }] })
    const req = E.toolSpec.inputSchema.properties.stages.items.properties.steps.items.anyOf.find(s => s.type === 'object').required
    return [`${E.steps('t')}; ${res(r)}; required ${req}`, E.steps('t') === 'A:active B:pending' && req.join() === 'title']
  },
  async string_steps_and_stage_title(E) {
    // a model's first guess at the format: steps as plain strings, the stage calling its name "title"; it used to
    // answer "no bar yet", as if nothing had been sent
    const r = await E.call({ id: 't', title: 'Task', stages: [{ title: 'One', steps: ['A', 'B'] }, { name: 'Two', steps: ['C'] }] })
    return [`${E.steps('t')}; ${res(r)}`, r.deny === undefined && E.steps('t') === 'A:active B:pending C:pending' && E.bar('t').stages[0].name === 'One']
  },
  async flat_steps_make_a_todo(E) {
    // the rules offer kind "todo" for one flat list; a flat top-level steps list is that list
    const r = await E.call({ id: 't', title: 'Task', kind: 'todo', steps: ['A', { title: 'B' }, 'C'] })
    return [`${E.steps('t')}; ${res(r)}`, r.deny === undefined && E.steps('t') === 'A:active B:pending C:pending' && E.bar('t').kind === 'todo']
  },
  async unreadable_breakdown_is_named(E) {
    // a breakdown that was sent but did not parse answers the format; only a bare op without a bar says "no bar yet"
    const bad = await E.call({ id: 't', title: 'Task', stages: [{ name: 'One', steps: [] }] })
    const bare = await E.call({ id: 'nope', next: true })
    return [`${res(bad)} | ${res(bare)}`, (bad.deny ?? '').includes('could not read the breakdown') && (bare.deny ?? '').includes('no bar "nope" yet')]
  },
  async T08_reimport_keeps_done(E) {
    const plan = '# Fix login\n\n## Analyse\n- Read code\n- Find bug\n## Fix\n- Patch\n- Test'
    await E.exitPlan({ result: { plan } })
    await E.call({ id: 'plan', next: true })
    await E.call({ id: 'plan', next: true })
    await E.exitPlan({ result: { plan: plan + '\n- Deploy' } })
    return [E.steps('plan'), E.steps('plan') === 'Read code:done Find bug:done Patch:active Test:pending Deploy:pending']
  },
  async T09_new_title_same_bar(E) {
    await E.exitPlan({ result: { plan: '# Fix login\n## A\n- One\n- Two\n## B\n- Three' } })
    await E.exitPlan({ result: { plan: '# Fix login flow\n## A\n- One\n- Two\n## B\n- Three' } })
    return [`${E.plans().map(p => `${p.id}:${p.title}`)}`, E.plans().length === 1 && E.bar('plan').title === 'Fix login flow']
  },
  async T10_ticked_boxes(E) {
    await E.exitPlan({ result: { plan: '# Ship\n- [x] Read code\n- [x] Find bug\n- [ ] Patch' } })
    return [E.steps('plan'), E.steps('plan') === 'Read code:done Find bug:done Patch:active']
  },
  async T11_active_forward_unchanged(E) {
    await create(E)
    await E.call({ id: 't', active: 'C' })
    return [E.steps('t'), E.steps('t') === 'A:done B:pending C:active']
  },
  async T12_out_of_order(E) {
    const r = await E.call({ id: 't', title: 'Task', stages: [S('First', st('A', 'pending')), S('Second', st('B', 'active'), st('C', 'done'))] })
    const v = await E.view('t')
    return [`"${res(r)}"; "${v.alt}"`, res(r).includes('1/3') && v.alt.includes('Second') && v.alt.includes('33%')]
  },
  async T13_duplicate_titles(E) {
    await E.call({ id: 't', title: 'Task', stages: [S('Backend', st('API', 'active'), 'Tests'), S('Frontend', 'UI', 'Tests')] })
    await E.call({ id: 't', done: ['Tests'] })
    await E.call({ id: 't', done: ['Tests'] })
    return [E.steps('t'), E.steps('t') === 'API:active Tests:done UI:pending Tests:done']
  },
  async T14_unknown_refused(E) {
    await create(E)
    const r = await E.call({ id: 't', done: ['Nonexistent'] })
    return [`${r.deny}`, !!r.deny && r.deny.includes('A, B, C') && E.steps('t') === 'A:active B:pending C:pending']
  },
  async T15_ops_with_stages(E) {
    await create(E)
    await E.call({ id: 't', stages: [S('One', st('A', 'active'), 'B'), S('Two', 'C')], next: true })
    return [E.steps('t'), E.steps('t') === 'A:done B:active C:pending']
  },
  async T16_T17_strips_survive(E) {
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', stages: [S('One', 'A', 'B', 'X'), S('Two', 'C')] })
    await E.agentTool('ag1', 'Grep')
    const src = (await E.view('t')).source
    return [`strip ${src.includes('Scan tests')}, tool ${src.includes('Grep')}`, src.includes('Scan tests') && src.includes('Grep')]
  },
  async T16b_strips_survive_import(E) {
    await E.exitPlan({ result: { plan: '# P\n## A\n- One\n## B\n- Two' } })
    await E.spawn('ag1', 'Scan tests')
    await E.exitPlan({ result: { plan: '# P\n## A\n- One\n## B\n- Two\n- Three' } })
    return [`${E.bar('plan').agents?.map(a => a.title)}`, E.bar('plan').agents?.length === 1]
  },
  async T19_parallel_next(E) {
    await create(E)
    await Promise.all([E.call({ id: 't', next: true }), E.call({ id: 't', next: true })])
    return [E.steps('t'), E.steps('t') === 'A:done B:done C:active']
  },
  async T20_parallel_bars(E) {
    await Promise.all([create(E, 'x'), create(E, 'y')])
    return [E.plans().map(p => p.id).join(), E.plans().length === 2]
  },
  async T21_unknown_failed_refused(E) {
    await create(E)
    const r = await E.call({ id: 't', failed: 'Nope' })
    return [`${E.bar('t').state}; deny ${!!r.deny}`, !!r.deny && E.bar('t').state === 'running']
  },
  async T22_done_result_has_no_active(E) {
    await create(E)
    const r = await E.call({ id: 't', state: 'done' })
    return [res(r), res(r) === 't: 3/3, done']
  },
  async T23_reminder_names_bar(E) {
    await E.turnStart()
    await create(E)
    const out = []
    for (let i = 0; i < 6; i++) out.push(await E.work('Edit'))
    const hit = out.findIndex(r => (r.context ?? []).some(c => c.includes('not updated')))
    return [`#${hit + 1}: ${out[hit]?.context}`, hit === 5 && out[hit].context.some(c => c.startsWith('plan-progress: t not updated'))]
  },
  async T24_refusal_keeps_count(E) {
    await E.turnStart()
    await create(E)
    let hit = -1
    for (let i = 0; i < 6; i++) {
      if (i === 3) await E.call({ id: 't', done: ['Nonexistent'] })
      const r = await E.work('Edit')
      if (hit < 0 && (r.context ?? []).some(c => c.includes('not updated'))) hit = i
    }
    return [`reminder on edit #${hit + 1}`, hit === 5]
  },
  async T25_shell_never_refused(E) {
    await E.turnStart()
    for (let i = 0; i < 3; i++) await E.work('Edit')
    const bash = await E.work('Bash', false)
    const edit = await E.work('Edit')
    return [`bash ${bash.deny ? 'denied' : 'ran'}, 4th edit ${edit.deny ? 'denied' : 'ran'}`, !bash.deny && !!edit.deny]
  },
  async T25b_shell_not_counted(E) {
    await E.turnStart()
    await create(E)
    let reminded = false
    for (let i = 0; i < 12; i++) if (((await E.work('Bash', false)).context ?? []).length) reminded = true
    return [`12 shell calls, reminder ${reminded}`, !reminded]
  },
  async T27_no_substeps_in_schema(E) {
    const step = E.toolSpec.inputSchema.properties.stages.items.properties.steps.items.anyOf.find(s => s.type === 'object').properties
    return [Object.keys(step).join(), !('substeps' in step)]
  },
  async T30_T31_no_import(E) {
    await E.exitPlan({ deny: 'no' })
    await E.exitPlan({ isError: true, result: { plan: '# X\n- a\n- b' } })
    await E.exitPlan({ result: { plan: null } })
    return [`${E.plans().length} bars`, E.plans().length === 0]
  },
  async T32_next_wraps_back(E) {
    await E.call({ id: 't', title: 'Task', stages: [S('One', 'A', st('B', 'active'), 'C')] })
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', next: true })
    const a = E.steps('t')
    await E.call({ id: 't', next: true })
    return [`${a} → ${E.steps('t')} ${E.bar('t').state}`, a === 'A:active B:done C:done' && E.bar('t').state === 'done']
  },
  async N1_model_told_bar_id(E) {
    const r = await E.exitPlan({ result: { plan: '# Fix login\n## A\n- One\n## B\n- Two' } })
    return [`${r.context}`, (r.context ?? []).some(c => c.includes('"plan"'))]
  },
  async N2_one_bar_one_block(E) {
    await E.turnStart()
    await E.exitPlan({ result: { plan: '# Fix login\n## A\n- One\n## B\n- Two' } })
    await E.work('Edit')
    await E.call({ id: 'plan', next: true })
    await E.call({ id: 'plan', next: true })
    const r = await E.stop('All set.')
    return [`${E.plans().length} bar, ${E.bar('plan').state}, stop ${r.block ? 'blocked' : 'passes'}`, E.plans().length === 1 && !r.block]
  },
  async done_on_active_moves_on(E) {
    await create(E)
    const r = await E.call({ id: 't', done: ['A'] })
    return [res(r), E.steps('t') === 'A:done B:active C:pending']
  },
  async track_still_strip_clock_follows_now(E) {
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    // the track picture stays as it was but for its animations' offset; that offset and a strip's clock follow the
    // time passed, since the desktop rebuilds the band on every redraw and a reused offset would restart them from the
    // earlier draw
    const delay = v => v.strips.join('').match(/--d:-([\d.]+)s/)?.[1]
    const flow = v => [v.track.match(/--f:-([\d.]+)s/)?.[1], v.track.match(/--w:-([\d.]+)s/)?.[1]].join('/')
    const still = v => v.track.replace(/--[fw]:-[\d.]+s/g, '')
    const a = await E.view('t')
    E.tick(7000)
    const b = await E.view('t')
    const ok = still(a) === still(b) && flow(a) === '0.000/0.000' && flow(b) === '7.000/7.000' && delay(a) === '0.000' && delay(b) === '7.000'
    return [`track same ${still(a) === still(b)}, its offset ${flow(a)}s → ${flow(b)}s, strip clock ${delay(a)}s → ${delay(b)}s`, ok]
  },
  async strip_clock_counts_through_foreign_redraws(E) {
    // issue #6: another plugin invalidates ui.render every second while the strip's markup stays the same
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    E.tick(3500)
    const seen = []
    for (let i = 0; i < 10; i++) {
      seen.push((await E.view('t')).strips.join('').match(/--d:-([\d.]+)s/)?.[1])
      E.tick(1000)
    }
    const ok = seen.every((d, i) => d === (3.5 + i).toFixed(3))
    return [seen.join(' '), ok]
  },
  async running_pill_has_live_clock(E) {
    await create(E)
    E.tick(83_000)
    await E.call({ id: 't', next: true })
    const src = (await E.view('t')).clock
    const delay = src.match(/--d:-([\d.]+)s/)?.[1]
    return [`clock ${src.includes('class="kc0 ')}, delay ${delay}s`, src.includes('class="kc0 ') && delay === '83.000' && !src.includes('{{T:')]
  },
  async done_pill_static_time(E) {
    await create(E)
    E.tick(125_000)
    await E.call({ id: 't', state: 'done' })
    const src = (await E.view('t')).source
    return [`2m 5s ${src.includes('2m 5s')}, no clock ${!src.includes('class="kc0 ')}`, src.includes('2m 5s') && !src.includes('class="kc0 ')]
  },
  async strips_clock_live_then_static(E) {
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    E.tick(12_000)
    const live = (await E.view('t')).source.includes('class="sc ')
    await E.turnComplete('ag1')
    const src = (await E.view('t')).source
    return [`live ${live}, finished shows 12s ${src.includes('>12s<')}`, live && src.includes('>12s<') && !src.includes('class="sc ')]
  },
  async agent_change_redraws_only_its_strip(E) {
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    await E.spawn('ag2', 'Read docs')
    const a = await E.view('t')
    await E.agentTool('ag1', 'Grep')
    const b = await E.view('t')
    const same = a.track === b.track && a.strips[1] === b.strips[1]
    return [`track and other strip kept ${same}, own strip redrawn ${a.strips[0] !== b.strips[0]}`, same && a.strips[0] !== b.strips[0]]
  },
  async strip_names_model_and_effort(E) {
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    const before = (await E.view('t')).strips[0]
    await E.step('ag1', 'low')
    const after = (await E.view('t')).strips[0]
    return [`model ${before.includes('(haiku 4.5)')}, effort ${after.includes('(haiku 4.5 · low)')}`, before.includes('(haiku 4.5)') && after.includes('(haiku 4.5 · low)')]
  },
  async bars_survive_a_restart(E) {
    const kept = new Map()
    const first = await boot(file, kept)
    await create(first)
    await first.spawn('ag1', 'Scan tests')
    await first.call({ id: 't', next: true })
    await first.everyTick()
    const second = await boot(file, kept)
    const bar = second.bar('t')
    const ok = !!bar && second.steps('t') === first.steps('t') && (bar.agents ?? []).length === 0
    return [`restored ${!!bar}, same steps ${bar ? second.steps('t') === first.steps('t') : false}, strips dropped ${bar ? (bar.agents ?? []).length === 0 : false}`, ok]
  },
  async done_bar_streams_at_half_speed(E) {
    // a bar at rest (waiting, failed, done) streams and flickers like a running one, its wave at half the speed
    await create(E)
    const loop = src => Number(src.match(/\.wm\{animation:wm ([\d.]+)s steps\(\d+\)/)?.[1])
    // all 24 flicker classes laid over the fill and timed, not just defined
    const flickers = src => {
      const s = streamOf(src)
      return s.laid.length === 24 && new Set(s.laid.map(r => r.k)).size === 24 && s.timelines.length === 24
    }
    const first = (await E.view('t')).track
    const running = loop(first)
    const rest = []
    for (const state of ['needs_input', 'error', 'done']) {
      await E.call({ id: 't', state })
      const src = (await E.view('t')).track
      rest.push([state, loop(src), flickers(src)])
    }
    const ok = running > 0 && flickers(first) && rest.every(([, s, f]) => Math.abs(s - running * 2) < 0.02 && f)
    return [`running ${running}s a loop, flickers ${flickers(first)}; ${rest.map(([st, s, f]) => `${st} ${s}s, flickers ${f}`).join('; ')}`, ok]
  },
  async wave_goes_on_when_the_bar_comes_to_rest(E) {
    // the wave is timed from its last change of speed: a bar coming to rest, or set going again, streams on from the
    // column it was at instead of jumping to wherever the new speed would have brought it since the start
    await create(E)
    E.tick(100_000)
    const at = async () => waveAt((await E.view('t')).track)
    const seen = []
    const a = await at()
    await E.call({ id: 't', state: 'needs_input' })
    const b = await at()
    E.tick(5000)
    const c = await at()
    await E.call({ id: 't', state: 'running' })
    const d = await at()
    E.tick(2000)
    const e = await at()
    for (const [x, y, cols] of [[b, a, 0], [c, b, 50], [d, c, 0], [e, d, 40]]) {
      const off = (((x.col - y.col - cols) % x.n) + x.n) % x.n
      seen.push(off <= 1 || off >= x.n - 1)
    }
    const ok = seen.every(Boolean) && b.speed === a.speed / 2 && e.speed === a.speed
    return [`running at column ${a.col}; at rest ${b.col}, 5 s later ${c.col}; running again ${d.col}, 2 s later ${e.col}; speeds ${a.speed}/${b.speed}/${e.speed}`, ok]
  },
  async fill_stream_still_grid_wave_and_flicker(E) {
    // the dots stand still; brightness streams over them: a stepped wave mask slides left one column per step, every
    // dot of the flicker tile in exactly one flicker class, both fading towards the start. Every animation is set back
    // by --f or --w, so a rebuild picks the stream up where it was, and reduced motion stops all of them
    await create(E)
    await E.call({ id: 't', next: true })
    E.tick(1000)
    const src = (await E.view('t')).track
    const H = Number(src.match(/<svg[^>]* height="(\d+)"/)?.[1])
    const fx = Number(src.match(/<linearGradient id="fadeg" x1="0" x2="([\d.]+)"/)?.[1])
    const s = streamOf(src)
    const dgY = src.match(/<pattern id="dg" width="3" height="3" y="([\d.]+)"[^>]*><rect width="2" height="2"/)?.[1]
    const grid = dgY !== undefined && /<g mask="url\(#fade\)"><g mask="url\(#wave\)"><rect width="[\d.]+" height="21" fill="url\(#dg\)"\/>/.test(src)
    const [, cols, shift] = src.match(/steps\((\d+)\) infinite;animation-delay:calc\(var\(--w\) - [\d.]+s\)\}\s*@keyframes wm\{to\{transform:translateX\(-(\d+)px\)\}\}/) ?? []
    // the wave: its pattern as long as one loop's slide, a step of brightness at every column, the runs of its steps
    // covering the pattern end to end once, at a few distinct levels, the track's full height
    const oneColumn = Number(shift) === Number(cols) * 3 && s.wpW === Number(shift)
    const tiled = s.runs.length > 0 && s.runs[0][0] === 0 && s.runs.at(-1)[1] === s.wpW && s.runs.every(([a, b], i) => b > a && a % 3 === 0 && b % 3 === 0 && (i === 0 || s.runs[i - 1][1] === a))
    const wave = tiled && new Set(s.levels).size === s.levels.length && s.levels.length >= 3 && s.levels.every(o => o > 0 && o <= 1) && s.strokeW === H
    const maskW = Number(src.match(/<rect class="wm" width="([\d.]+)"/)?.[1])
    const covers = maskW >= fx + Number(shift)
    // the flicker: 24 class patterns of one tile on the grid's rows, each laid over the whole fill under its own fade
    const tile = (s.patterns[0]?.w ?? 0) / 3
    const laid = s.laid.length === 24 && new Set(s.laid.map(r => r.k)).size === 24 && s.laid.every(r => r.w >= fx)
    const classes = s.patterns.length === 24 && s.patterns.every(p => p.w === tile * 3 && p.y === dgY && p.cls === p.k)
    // every dot of the tile, gathered from the 24 class patterns, once and only once, each on the grid
    const exact = s.dots.size === tile * 7 && [...s.dots.values()].every(n => n === 1) && [...s.dots.keys()].every(k => {
      const [x, y] = k.split(',').map(Number)
      return x % 3 === 0 && x >= 0 && x < tile * 3 && y % 3 === 0 && y >= 0 && y <= 18
    })
    // each class steps (no easing) through a few lifts from 0% on, changing on the wave's 50 ms beat
    const timed = s.timelines.length === 24 && s.timelines.every(t => t.frames[0]?.[0] === 0 && new Set(t.frames.map(f => f[1])).size >= 2 && t.frames.every(f => f[1] >= 0 && f[1] <= 1) && Math.max(...t.frames.map(f => f[1])) > 0)
    const beat = s.timelines.every(t => onBeat(t.length) && onBeat(t.delay) && t.frames.every(([pct]) => onBeat((pct / 100) * t.length)))
    const stops = id => [...(src.match(new RegExp(`<linearGradient id="${id}"[^>]*>(.*?)</linearGradient>`))?.[1] ?? '').matchAll(/offset="([\d.]+)" stop-color="#fff" stop-opacity="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])])
    const lastZero = id => Math.max(...stops(id).filter(([, o]) => o === 0).map(([at]) => at))
    // both fade in from nothing at the start; the flicker later, so it sparkles at the head
    const fades = stops('fadeg')[0]?.[1] === 0 && stops('fadeg').at(-1)?.[1] === 1 && stops('kfadeg')[0]?.[1] === 0 && stops('kfadeg').at(-1)?.[1] === 1 && lastZero('kfadeg') > lastZero('fadeg')
    const anims = [...src.matchAll(/animation:[^;}]+;animation-delay:([^}]+)\}/g)]
    const offsetAll = anims.length >= 25 && anims.every(m => m[1].includes('var(--f)') || m[1].includes('var(--w)'))
    const offset = [src.match(/--f:-([\d.]+)s/)?.[1], src.match(/--w:-([\d.]+)s/)?.[1]].join('/')
    const reduced = /@media \(prefers-reduced-motion:reduce\)\{\.wm,\[class\^="q"\]\{animation:none\}/.test(src)
    const ok = grid && oneColumn && wave && covers && laid && classes && exact && timed && beat && fades && offsetAll && offset === '1.000/1.000' && reduced
    return [`still grid ${grid}, wave ${cols} columns sliding ${shift}px over a ${s.wpW}px pattern (one column a step ${oneColumn}; ${s.runs.length} runs at ${s.levels.length} levels covering it once ${wave}; mask ${maskW} covers ${covers}), flicker laid ${laid}, ${s.patterns.length} classes on the grid ${classes}, tile ${tile} columns with ${s.dots.size} dots each in one class ${exact}, timelines ${timed}, on the 50 ms beat ${beat}, fades ${fades}, ${anims.length} animations all set back ${offsetAll}, offsets ${offset}s, reduced motion ${reduced}`, ok]
  },
  async fill_stream_same_size_at_any_width(E) {
    // the stream is patterns and masks: a wide track's picture is no bigger than a narrow one's but for its marks
    await create(E)
    const sizes = []
    try {
    for (const cols of [60, 240]) {
      globalThis.COLS = cols
      await E.call({ id: 't', state: 'done' })
      const src = (await E.svgs()).map(x => x.source).find(x => x.includes('clip-path="url(#fill)"')) ?? ''
      sizes.push([Number(src.match(/<svg[^>]* width="(\d+)"/)?.[1]), src.length])
    }
    } finally {
      delete globalThis.COLS
    }
    const [[w1, n1], [w2, n2]] = sizes
    const ok = w2 > w1 * 2 && Math.abs(n2 - n1) < 2000 && n2 < 60000
    return [`width ${w1}: ${n1} chars, width ${w2}: ${n2} chars`, ok]
  },
  async fill_stream_reaches_the_fill_during_a_glide_back(E) {
    // a plan that grows moves its fill back, and the fill's edge glides from where it was: the stream is drawn as far
    // as that, so the shrinking fill is never left without dots
    await E.call({ id: 't', title: 'Task', stages: [S('One', st('A', 'done'), st('B', 'done'), st('C', 'active'))] })
    await E.view('t')
    E.tick(2000)
    await E.view('t')
    await E.call({ id: 't', stages: [S('One', st('A', 'done'), st('B', 'active'), 'C', 'D', 'E', 'F', 'G', 'H')] })
    const src = (await E.view('t')).track
    const [, from, to] = src.match(/<clipPath id="fill">.*?<animate [^>]*from="([\d.]+)" to="([\d.]+)"/) ?? []
    const s = streamOf(src)
    const grid = Number(src.match(/<rect width="([\d.]+)" height="21" fill="url\(#dg\)"\/>/)?.[1])
    const maskW = Number(src.match(/<rect class="wm" width="([\d.]+)"/)?.[1])
    const back = Number(from) > Number(to)
    const reaches = grid >= Number(from) && s.laid.length === 24 && s.laid.every(r => r.w >= Number(from)) && maskW - s.wpW >= Number(from)
    return [`fill glides back ${from} → ${to} ${back}; grid ${grid}, flicker ${s.laid[0]?.w}, wave mask past its slide ${(maskW - s.wpW).toFixed(1)}: reach it ${reaches}`, back && reaches]
  },
  async pill_covers_checkpoints(E) {
    await create(E)
    const src = (await E.view('t')).overlay
    const hit = src.indexOf('class="h'), pill = src.indexOf('class="kb"'), tip = src.indexOf('class="tp')
    return [`hit ${hit} < pill ${pill} < tip ${tip}`, hit > 0 && hit < pill && pill < tip]
  },
  async pill_clock_is_the_desktops_own_hover(E) {
    // a frame built anew under a still pointer is not hovered until the pointer moves, and the desktop builds the band
    // anew on every write (the footer's figure, once a second while a response streams): the clock that lived in the
    // hover frame went out each time. It is a plain picture now, under the frame, shown by the desktop's own hover of
    // the track's keyed Box, which a rebuild keeps. Its Box is not placed itself, or the desktop would lift it out as a
    // hover card; a finished bar has none
    await create(E)
    const kidsOf = n => [n?.children ?? []].flat(Infinity).filter(c => c && typeof c === 'object')
    let track = null
    const find = n => {
      if (n?.type === 'Box' && n.props?.key === 'track-t') track = n
      kidsOf(n).forEach(find)
    }
    ;[await E.band()].flat(Infinity).forEach(find)
    const kids = kidsOf(track)
    const holder = kids.findIndex(k => k.type === 'Box' && kidsOf(k).some(c => c.props?.display === 'none'))
    const frame = kids.findIndex(k => k.type === 'Box' && kidsOf(k).some(c => c.type === 'Svg' && c.props.isInteractive))
    const reveal = kidsOf(kids[holder]).find(c => c.props?.display === 'none')
    const pic = kidsOf(reveal).find(c => c.type === 'Svg')
    const v = await E.view('t')
    const shape =
      kids[holder]?.props.position === 'absolute' && reveal?.props.hover?.display === 'flex' && reveal.props.position !== 'absolute' &&
      pic?.props.isInteractive !== true && pic.props.source.includes('class="kc0 ') && holder > 0 && holder < frame
    // a key makes a Box a hover scope of its own: on the holder or the reveal it would answer to its own hover, not the track's
    const unkeyed = kids[holder]?.props.key === undefined && reveal?.props.key === undefined
    const frameClean = v.overlay !== '' && !v.overlay.includes('kc0') && !v.overlay.includes(':hover .kv')
    await E.call({ id: 't', state: 'done' })
    const doneClock = (await E.view('t')).clock
    return [
      `track Box ${track ? 'keyed' : 'missing'}; clock at ${holder}, frame at ${frame}, shown by hover ${reveal?.props.hover?.display}, placed itself ${reveal?.props.position ?? 'no'}, keyed ${!unkeyed}; frame without the clock ${frameClean}; finished bar's clock "${doneClock}"`,
      shape && unkeyed && frameClean && doneClock === '',
    ]
  },
  async pill_clock_lies_on_the_pill(E) {
    // the clock is a copy laid over the pill: at its place and in its color while it stands, and gliding with it, the
    // same glide from the same offset, while it moves, so the copy never waits at the new place for the pill to come
    await create(E)
    const places = src => [...src.matchAll(/<(?:g|use) (?:class="[ms]v" )?(?:href="#kn" )?transform="translate\(([\d.]+) 0\)"/g)].map(m => m[1])
    const face = src => src.match(/<rect x="-[\d.]+" y="0" width="[\d.]+" height="\d+" rx="[\d.]+" fill="[^"]+"\/>/)?.[0]
    const glideOf = src => src.match(/<animateTransform[^>]*\/>/)?.[0]
    const standing = await E.view('t')
    const kx = places(standing.track).at(-1)
    const area = standing.overlay.match(/<rect class="kb" x="([\d.]+)" y="0" width="([\d.]+)"/)
    const stands = places(standing.clock).join() === kx && face(standing.clock) === face(standing.track) && Math.abs(Number(area?.[1]) + Number(area?.[2]) / 2 - Number(kx)) < 0.06
    await E.call({ id: 't', next: true })
    await E.view('t')
    E.tick(120)
    const mid = await E.view('t')
    const glide = glideOf(mid.track)
    const to = places(mid.track).at(-1)
    const glides =
      glide !== undefined && glideOf(mid.clock) === glide && glide.includes('begin="-0.120s"') && places(mid.track).join() === `${to},${to}` && places(mid.clock).join() === `${to},${to}` &&
      mid.clock.includes('class="mv"') && mid.clock.includes('class="sv"') && mid.clock.includes('@media (prefers-reduced-motion:reduce){.mv{display:none}.sv{display:inline}}')
    E.tick(1000)
    const after = await E.view('t')
    const settles = !after.clock.includes('<animateTransform') && places(after.clock).join() === places(after.track).at(-1) && places(after.track).at(-1) !== kx
    return [`standing at ${kx}: clock at ${places(standing.clock)}, same face, hover area centred ${stands}; mid-glide the same glide ${glides}; standing after at ${places(after.clock)} ${settles}`, stands && glides && settles]
  },
  async pill_clock_on_every_open_bar(E) {
    // a bar waiting for an answer or stopped by an error still runs its clock; two bars each have their own, under their
    // own track
    await create(E, 'a', three(), 'Alpha')
    await create(E, 'b', three(), 'Beta')
    const kidsOf = n => [n?.children ?? []].flat(Infinity).filter(c => c && typeof c === 'object')
    const tracks = {}
    const find = n => {
      if (n?.type === 'Box' && String(n.props?.key ?? '').startsWith('track-')) tracks[n.props.key] = n
      kidsOf(n).forEach(find)
    }
    ;[await E.band()].flat(Infinity).forEach(find)
    const clockOf = id => {
      const reveal = kidsOf(tracks[`track-${id}`]).flatMap(kidsOf).find(c => c.props?.display === 'none')
      return kidsOf(reveal).find(c => c.type === 'Svg')?.props.alt ?? ''
    }
    const own = clockOf('a').startsWith('Alpha has run for') && clockOf('b').startsWith('Beta has run for')
    const states = []
    for (const [id, state] of [['a', 'needs_input'], ['b', 'error']]) {
      await E.call({ id, state, note: 'why' })
      states.push(`${state} ${(await E.view(id))?.clock.includes('class="kc0 ')}`)
    }
    const ok = own && states.every(s => s.endsWith('true'))
    return [`two bars: "${clockOf('a')}", "${clockOf('b')}"; ${states.join(', ')}`, ok]
  },
  async stop_still_blocks_open_bar(E) {
    await E.turnStart()
    await create(E)
    await E.work('Edit')
    const r = await E.stop('All set.')
    return [`${r.block ? 'blocked' : 'passes'}`, !!r.block]
  },
  async terminal_bar_is_a_raster_that_fits(E) {
    await create(E)
    const out = []
    for (const cols of [120, 60]) {
      const nodes = await E.terminal(cols)
      const r = nodes.find(n => n.type === 'Raster' && n.props.key === 'track-t')
      const row = glyphs(r.props.cells)
      out.push({ cols, w: r.props.columns, row })
    }
    const fits = out.every(o => o.w + 'Task'.length + 13 <= o.cols)
    return [out.map(o => `${o.cols}: ${o.row.trim()}`).join(' | '), fits && out.every(o => o.row.includes('One │ A 1/2'))]
  },
  async terminal_animates_by_blits(E) {
    await E.turnStart()
    await create(E)
    await E.call({ id: 't', next: true })
    await E.terminal(120)
    const frames = []
    for (let i = 0; i < 10; i++) {
      E.tick(100)
      await E.everyTick()
      frames.push(E.blits.filter(b => b.key === 'track-t').at(-1)?.cells)
    }
    const distinct = new Set(frames.filter(Boolean)).size
    return [`${E.blits.length} blits, ${distinct} distinct frames`, distinct > 1]
  },
  async frame_clock_only_with_a_moving_terminal_bar(E) {
    await E.turnStart()
    await create(E)
    await E.svgs()
    await E.everyTick()
    const desktop = E.frameTimers()
    await E.terminal(120)
    await E.everyTick()
    const terminal = E.frameTimers()
    return [`desktop ${desktop}, terminal ${terminal}`, desktop === 0 && terminal === 1]
  },
  async terminal_bar_stands_still_after_the_turn(E) {
    await E.turnStart()
    await create(E)
    await E.terminal(120)
    await E.everyTick()
    const during = E.frameTimers()
    await E.turnComplete(undefined)
    E.tick(1000)
    await E.everyTick()
    const before = E.blits.length
    E.tick(100)
    await E.everyTick()
    const after = E.frameTimers()
    return [`timer during turn ${during}, after ${after}, blits after ${E.blits.length - before}`, during === 1 && after === 0 && E.blits.length === before]
  },
  async waiting_bar_stands_still(E) {
    await E.turnStart()
    await create(E)
    await E.call({ id: 't', state: 'needs_input', note: 'Pick one' })
    await E.terminal(120)
    E.tick(1000)
    await E.everyTick()
    const F = await boot(file)
    await F.turnStart()
    await create(F)
    await F.terminal(120)
    await F.everyTick()
    return [`frame timers ${E.frameTimers()}, running twin ${F.frameTimers()}`, E.frameTimers() === 0 && F.frameTimers() === 1]
  },
  async closed_bar_forgets_its_glide(E) {
    await E.turnStart()
    await create(E)
    await E.terminal(120)
    await E.call({ id: 't', next: true })
    await E.terminal(120)
    E.tick(1000)
    await E.terminal(120)
    await E.command('progress-clear')
    await create(E)
    const row = (await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t')
    // a fresh bar at step 1 has no fill, so its pill sits at the left edge instead of sliding back from the old head
    const first = glyphs(row.props.cells).indexOf('One')
    return [`pill text at column ${first}`, first >= 0 && first <= 2]
  },
  async strip_tool_sits_right_and_name_keeps_its_model(E) {
    await create(E)
    await E.spawn('ag1', 'Review Python backend architecture')
    await E.step('ag1', 'high')
    await E.agentTool('ag1', 'Read')
    const desk = (await E.view('t')).strips[0]
    const full = desk.includes('Review Python backend architecture<tspan class="st"> (haiku 4.5 · high)</tspan>')
    const anchored = /text-anchor="end"[^>]*>Read</.test(desk)
    const r = (await E.terminal(110)).find(n => n.type === 'Raster' && n.props.key === 'strips-t')
    const row = glyphs(r.props.cells).replace(/[⠀-⣿]/g, ' ')
    const term = /architecture \(haiku 4\.5 · high\) +Read \d+s/.test(row)
    return [`desktop full name ${full}, tool at right ${anchored}, terminal ${term}`, full && anchored && term]
  },
  async auto_mode_ask_is_not_needs_approval(E) {
    // issue #4: the auto-mode classifier settles an ask by itself; no dialog, so nobody is asked
    await create(E)
    await E.spawn('ag1', 'Run the suite')
    const held = await E.hold('ag1', { dialog: false })
    E.tick(5000)
    await E.fireTimers()
    const strip = E.bar('t').agents.find(a => a.id === 'ag1')
    await held.release()
    return [`while the tool runs: ${strip.state} / ${strip.tool}`, strip.state === 'running' && strip.tool === 'Bash']
  },
  async needs_approval_only_while_the_dialog_is_up(E) {
    await create(E)
    await E.spawn('ag1', 'Run the suite')
    await E.agentTool('ag1', 'Read')
    const held = await E.hold('ag1')
    const asked = E.bar('t').agents.find(a => a.id === 'ag1')
    await E.deny('ag1')
    const denied = E.bar('t').agents.find(a => a.id === 'ag1')
    await held.release()
    const after = E.bar('t').agents.find(a => a.id === 'ag1')
    const shown = `${asked.state}/${asked.tool} → ${denied.state}/${denied.tool} → ${after.state}/${after.tool}`
    return [shown, asked.state === 'waiting' && asked.tool === 'Needs approval' && denied.state === 'running' && denied.tool === 'Bash' && after.tool === 'Bash']
  },
  async parallel_call_ending_keeps_the_dialog(E) {
    // one agent runs two calls at once; the quick one ends while the other's dialog is still up
    await create(E)
    await E.spawn('ag1', 'Run the suite')
    const asked = await E.hold('ag1')
    const quick = await E.hold('ag1', { dialog: false })
    await quick.release()
    const during = E.bar('t').agents.find(a => a.id === 'ag1')
    await E.deny('ag1')
    await asked.release()
    const after = E.bar('t').agents.find(a => a.id === 'ag1')
    const shown = `dialog up: ${during.state}/${during.tool}, after: ${after.state}/${after.tool}`
    return [shown, during.state === 'waiting' && during.tool === 'Needs approval' && after.state === 'running' && after.tool === 'Bash']
  },
  async two_dialogs_clear_one_by_one(E) {
    await create(E)
    await E.spawn('ag1', 'Run the suite')
    const first = await E.hold('ag1', { dialog: false })
    const second = await E.hold('ag1', { dialog: false })
    await E.raw('classic.PermissionRequest', { agent_id: 'ag1', tool_name: 'Bash', tool_input: {} })
    await E.raw('classic.PermissionRequest', { agent_id: 'ag1', tool_name: 'Bash', tool_input: {} })
    await E.deny('ag1')
    const one = E.bar('t').agents.find(a => a.id === 'ag1')
    await E.deny('ag1')
    const none = E.bar('t').agents.find(a => a.id === 'ag1')
    await first.release()
    await second.release()
    const shown = `one left: ${one.state}/${one.tool}, none left: ${none.state}/${none.tool}`
    return [shown, one.state === 'waiting' && one.tool === 'Needs approval' && none.state === 'running' && none.tool === 'Bash']
  },
  async agents_make_no_sounds(E) {
    // agents with no task bar open land on the mod's own Agents bar, whose state follows them
    await E.spawn('ag1', 'Scan tests')
    await E.spawn('ag2', 'Read docs')
    await E.agentTool('ag1', 'Read')
    // ag2 waits on an approval: its strip and the Agents bar turn amber
    const held = await E.hold('ag2')
    E.tick(700)
    await E.fireTimers()
    const waited = E.bar('agents:auto')?.state
    await held.release()
    await E.turnComplete('ag1', 'error')
    await E.turnComplete('ag2')
    E.tick(1000)
    await E.fireTimers()
    // and on a task bar: a failed agent
    await create(E)
    await E.spawn('ag3', 'Build')
    await E.turnComplete('ag3', 'error')
    return [`sounds ${E.sounds.length ? E.sounds.join(', ') : 'none'}; agents bar while waiting ${waited}`, E.sounds.length === 0 && waited === 'needs_input']
  },
  async agent_bar_calls_and_questions_are_silent(E) {
    await create(E)
    await E.call({ id: 't', state: 'needs_input', note: 'which one?', agentId: 'ag1' })
    await E.call({ id: 't', state: 'error', note: 'failed', agentId: 'ag1' })
    await E.call({ id: 't', state: 'running', agentId: 'ag1' })
    await E.ask('ag1')
    const agentSounds = E.sounds.length
    const stateAfterAgentAsk = E.bar('t').state
    await E.call({ id: 't', state: 'needs_input', note: 'which one?' })
    await E.call({ id: 't', state: 'running' })
    await E.ask()
    return [`agent ${agentSounds} sounds, bar after agent question ${stateAfterAgentAsk}; main ${E.sounds.join(', ')}`, agentSounds === 0 && stateAfterAgentAsk === 'running' && E.sounds.length === 2]
  },
  async terminal_bar_follows_the_system_appearance_after_the_turn(E) {
    // Terminal.app with the default "dark" theme: its stock profiles follow macOS, so the bar does too
    return withMachine({ TERM_PROGRAM: 'Apple_Terminal' }, async () => {
      await E.turnStart()
      await create(E)
      await E.terminal(120)
      await E.everyTick()
      await E.turnComplete(undefined)
      E.tick(1000)
      await E.everyTick()
      const light = await trackTint(E)
      const before = E.blits.length
      globalThis.DARK = true
      E.tick(5000)
      await E.everyTick()
      const fresh = E.blits.slice(before).filter(b => b.key === 'track-t')
      const dark = fresh.length ? backOf(fresh.at(-1).cells) : light
      return [`${fresh.length} repaint, track ${light.toString(16)} → ${dark.toString(16)}`, fresh.length > 0 && lum(light) > LUM_MID && lum(dark) < LUM_MID]
    })
  },
  async dark_terminal_keeps_the_dark_theme(E) {
    // a dark iTerm on a light Mac: the default "dark" theme stands, and the appearance is not read again
    return withMachine({ TERM_PROGRAM: 'iTerm.app' }, async () => {
      await create(E)
      await E.terminal(120)
      for (let i = 0; i < 12; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      const tint = await trackTint(E)
      const reads = E.procs.filter(c => c.startsWith('defaults')).length
      return [`track ${tint.toString(16)}, appearance read ${reads}x`, lum(tint) < LUM_MID && reads === 1]
    })
  },
  async picked_light_theme_wins_over_a_dark_mac(E) {
    return withMachine({ DARK: true, TERM_PROGRAM: 'Apple_Terminal' }, async () => {
      await E.setTheme('light')
      await create(E)
      await E.terminal(120)
      for (let i = 0; i < 6; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      const tint = await trackTint(E)
      const appearance = E.procs.filter(c => !c.includes('colors.toml')).length
      return [`track ${tint.toString(16)}, appearance commands run ${appearance}`, lum(tint) > LUM_MID && appearance === 0]
    })
  },
  async auto_theme_follows_the_mac_in_any_terminal(E) {
    return withMachine({ TERM_PROGRAM: 'iTerm.app' }, async () => {
      await E.setTheme('auto')
      await create(E)
      await E.terminal(120)
      E.tick(1000)
      await E.everyTick()
      const light = await trackTint(E)
      globalThis.DARK = true
      E.tick(5000)
      await E.everyTick()
      const dark = await trackTint(E)
      return [`track ${light.toString(16)} → ${dark.toString(16)}`, lum(light) > LUM_MID && lum(dark) < LUM_MID]
    })
  },
  async no_mac_no_more_reads(E) {
    // Windows or Linux: the command is missing once, then the theme setting decides and nothing runs again
    return withMachine({ MAC: false }, async () => {
      await E.setTheme('auto')
      await create(E)
      await E.terminal(120)
      for (let i = 0; i < 20; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      const tint = await trackTint(E)
      const appearance = E.procs.filter(c => !c.includes('colors.toml')).length
      const omarchy = E.procs.length - appearance
      return [`appearance commands run ${appearance}, Omarchy looked for ${omarchy}x, track ${tint.toString(16)}`, appearance === 2 && omarchy === 1 && lum(tint) < LUM_MID]
    })
  },
  async omarchy_accent_paints_a_running_bar(E) {
    // Linux with Omarchy and the "auto" theme: the pill takes the accent, the track the theme's light background
    return withMachine({ MAC: false, OMARCHY: OMARCHY_LIGHT }, async () => {
      await E.setTheme('auto')
      await create(E)
      await E.terminal(120)
      E.tick(1000)
      await E.everyTick()
      const backs = backsOf(await latestTrack(E))
      const hasAccent = backs.includes(0x3264eb)
      const track = backs.at(-1)
      return [`accent ${hasAccent}, track ${track.toString(16)}`, hasAccent && !backs.includes(0x7858ca) && lum(track) > LUM_MID]
    })
  },
  async omarchy_read_cut_short_is_tried_again(E) {
    // the first terminal draw reads the theme, and the engine abandons that draw: its read says nothing about the
    // machine, so the timer reads the file again and the bar takes the accent and the light track
    return withMachine({ MAC: false, OMARCHY: OMARCHY_LIGHT }, async () => {
      await E.setTheme('custom:omarchy')
      await create(E)
      globalThis.ABORTED = true
      try {
        await E.terminal(120)
      } finally {
        delete globalThis.ABORTED
      }
      await E.terminal(120)
      E.tick(5000)
      await E.everyTick()
      const backs = backsOf(await latestTrack(E))
      const hasAccent = backs.includes(0x3264eb)
      const track = backs.at(-1)
      return [`accent ${hasAccent}, track ${track.toString(16)}`, hasAccent && lum(track) > LUM_MID]
    })
  },
  async omarchy_theme_switch_follows(E) {
    // switching the Omarchy theme repaints the bar within one read: new accent, dark track
    return withMachine({ MAC: false, OMARCHY: OMARCHY_LIGHT }, async () => {
      await E.setTheme('auto')
      await create(E)
      await E.terminal(120)
      E.tick(1000)
      await E.everyTick()
      const before = E.blits.length
      globalThis.OMARCHY = OMARCHY_DARK
      E.tick(5000)
      await E.everyTick()
      const fresh = E.blits.slice(before).filter(b => b.key === 'track-t').at(-1)
      const backs = fresh ? backsOf(fresh.cells) : []
      const track = backs.at(-1) ?? 0xffffff
      const done = await (async () => {
        await E.call({ id: 't', state: 'done' })
        const drawn = (await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t')
        return backsOf(drawn.props.cells).includes(0x18883a)
      })()
      return [`repaint ${!!fresh}, accent ${backs.includes(0xe75a50)}, track ${track.toString(16)}, done green ${done}`, !!fresh && backs.includes(0xe75a50) && lum(track) < LUM_MID && done]
    })
  },
  async omarchy_text_reads_on_every_theme() {
    // the theme's colours stay as given (the pill is the accent, the track sits on the background), and every text
    // cell picks a colour that reads at AA (4.5:1) as the engine paints it: a dark and a yellow theme, and a light one
    const themes = {
      tokyo: 'accent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\nmode = "dark"\n',
      latte: 'accent = "#1e66f5"\nbackground = "#eff1f5"\nforeground = "#4c4f69"\nmode = "light"\n',
      gruvbox: 'accent = "#d79921"\nbackground = "#282828"\nforeground = "#ebdbb2"\nmode = "dark"\n',
    }
    const q = c => c.map(v => Math.round(v / 17) * 17)
    const parts = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
    const out = []
    let ok = true
    for (const [name, toml] of Object.entries(themes)) {
      await withMachine({ MAC: false, OMARCHY: toml }, async () => {
        const F = await boot(file)
        await create(F)
        for (const [id, title] of [['g1', 'Run the tests'], ['g2', 'Ask first'], ['g3', 'Break'], ['g4', 'Old one'], ['g5', 'Old two'], ['g6', 'Old three'], ['g7', 'Last one']]) await F.spawn(id, title)
        await F.step('g1', 'high')
        await F.agentTool('g1', 'Bash')
        await F.hold('g2')
        await F.turnComplete('g3', 'error')
        for (const id of ['g4', 'g5', 'g6', 'g7']) await F.turnComplete(id)
        await F.terminal(120)
        F.tick(1000)
        await F.everyTick()
        const nodes = await F.terminal(120)
        let min = Infinity
        let hasAccent = false
        const accent = parseInt(/accent = "#(\w+)"/.exec(toml)[1], 16)
        for (const key of ['strips-t', 'track-t']) {
          const r = nodes.find(n => n.type === 'Raster' && n.props.key === key)
          const w = new Uint32Array(Uint8Array.from(Buffer.from(r?.props.cells ?? '', 'base64')).buffer)
          if (w.length === 0) min = 0
          for (let i = 0; i < w.length; i += 3) {
            if (w[i + 2] === accent) hasAccent = true
            const ch = String.fromCodePoint(w[i])
            if (ch === ' ' || ch === '●' || ch === '│' || (w[i] >= 0x2800 && w[i] <= 0x28ff) || w[i + 1] & 0x01000000) continue
            min = Math.min(min, contrast(q(parts(w[i + 1])), q(parts(w[i + 2]))))
          }
        }
        out.push(`${name} ${min.toFixed(2)}${hasAccent ? '' : ' (no accent)'}`)
        if (!(min >= 4.5 && hasAccent)) ok = false
      })
    }
    return [`worst text: ${out.join(', ')}`, ok]
  },
  async standard_theme_keeps_its_text_colors(E) {
    // without Omarchy nothing changes: white on the violet pill, the dark scheme's tool word and dim text on strips
    return withMachine({ MAC: false }, async () => {
      await create(E)
      await E.spawn('g1', 'Run the tests')
      await E.agentTool('g1', 'Bash')
      const nodes = await E.terminal(120)
      const fgs = key => {
        const r = nodes.find(n => n.type === 'Raster' && n.props.key === key)
        const w = new Uint32Array(Uint8Array.from(Buffer.from(r.props.cells, 'base64')).buffer)
        const set = new Set()
        for (let i = 0; i < w.length; i += 3) if (String.fromCodePoint(w[i]).trim() && !(w[i] >= 0x2800 && w[i] <= 0x28ff)) set.add(w[i + 1])
        return set
      }
      const track = fgs('track-t')
      const strips = fgs('strips-t')
      const ok = track.has(0xffffff) && strips.has(0x9c85d8) && strips.has(0xa7a5ae)
      return [`pill white ${track.has(0xffffff)}, tool word #9C85D8 ${strips.has(0x9c85d8)}, time #A7A5AE ${strips.has(0xa7a5ae)}`, ok]
    })
  },
  async without_omarchy_the_bar_stays_violet(E) {
    // no colors.toml: the default violet stays and the file is looked for once only
    return withMachine({ MAC: false }, async () => {
      await create(E)
      await E.terminal(120)
      for (let i = 0; i < 12; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      const backs = backsOf(await latestTrack(E))
      const reads = E.procs.filter(c => c.includes('colors.toml')).length
      return [`violet ${backs.includes(0x7858ca)}, file read ${reads}x`, backs.includes(0x7858ca) && reads === 1]
    })
  },
  async auto_theme_follows_the_linux_desktop(E) {
    // Linux with "auto": the desktop's color-scheme decides, and a change shows on the next read
    return withMachine({ MAC: false, SCHEME: 'prefer-light' }, async () => {
      await E.setTheme('auto')
      await create(E)
      await E.terminal(120)
      E.tick(1000)
      await E.everyTick()
      const light = await trackTint(E)
      globalThis.SCHEME = 'prefer-dark'
      E.tick(5000)
      await E.everyTick()
      const dark = await trackTint(E)
      const macReads = E.procs.filter(c => c.startsWith('defaults')).length
      return [`track ${light.toString(16)} → ${dark.toString(16)}, defaults run ${macReads}x`, lum(light) > LUM_MID && lum(dark) < LUM_MID && macReads === 1]
    })
  },
  async linux_desktop_without_a_preference_keeps_the_setting(E) {
    // 'default' says nothing: "auto" stays on the dark default, and a picked "dark" theme never reads the desktop
    const auto = await withMachine({ MAC: false, SCHEME: 'default' }, async () => {
      await E.setTheme('auto')
      await create(E)
      await E.terminal(120)
      E.tick(1000)
      await E.everyTick()
      return trackTint(E)
    })
    return [`track ${auto.toString(16)}`, lum(auto) < LUM_MID]
  },
  async linux_dark_theme_ignores_a_light_desktop(E) {
    return withMachine({ MAC: false, SCHEME: 'prefer-light' }, async () => {
      await E.setTheme('dark')
      await create(E)
      await E.terminal(120)
      for (let i = 0; i < 12; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      const tint = await trackTint(E)
      // the first read finds the desktop and stops there: a picked "dark" does not follow it
      const appearance = E.procs.filter(c => !c.includes('colors.toml')).length
      return [`track ${tint.toString(16)}, appearance commands run ${appearance}`, lum(tint) < LUM_MID && appearance === 2]
    })
  },
  async finished_bar_stays_by_default(E) {
    // auto-close is off until the person turns it on: a finished bar stays until it is closed
    await create(E)
    await E.call({ id: 't', state: 'done' })
    for (let i = 0; i < 120; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    return [`shown after 2 min ${!!E.bar('t')}`, !!E.bar('t')]
  },
  async autoclose_command_turns_leaving_on_and_off(E) {
    // /plan-progress-autoclose turns auto-close on, and off again; on, a finished bar leaves 30 s after it finished
    const ticks = async n => {
      for (let i = 0; i < n; i++) {
        E.tick(1000)
        await E.everyTick()
      }
    }
    const on = (await E.command('plan-progress-autoclose')).text
    await create(E)
    await E.call({ id: 't', state: 'done' })
    await ticks(29)
    const at29 = !!E.bar('t')
    await ticks(2)
    const at31 = !!E.bar('t')
    const off = (await E.command('plan-progress-autoclose')).text
    await create(E, 'u')
    await E.call({ id: 'u', state: 'done' })
    await ticks(60)
    const kept = !!E.bar('u')
    return [`on: "${on}"; shown at 29 s ${at29}, at 31 s ${at31}; off: "${off}"; kept a minute ${kept}`, /leave 30 s/.test(on) && at29 && !at31 && /stay until closed/.test(off) && kept]
  },
  async autoclose_choice_lasts_a_new_session(E) {
    // the choice is kept in the store, so the next session starts with auto-close on as well
    const kept = new Map()
    const A = await boot(file, kept)
    await A.command('plan-progress-autoclose')
    const B = await boot(file, kept)
    await create(B)
    await B.call({ id: 't', state: 'done' })
    for (let i = 0; i < 40; i++) {
      B.tick(1000)
      await B.everyTick()
    }
    return [`stored ${kept.get('autoclose')}, bar after 40 s in the next session ${!!B.bar('t')}`, kept.get('autoclose') === 'true' && !B.bar('t')]
  },
  async broken_store_costs_only_the_saves() {
    // a store file the host cannot read (left as three zero bytes) throws on every call: the session still starts and
    // its clock runs, so bars work and auto-close turns on for the session; only the saves are lost
    class Broken extends Map {
      has() { return true }
      get() { return '\0\0\0' }
      set() { throw new Error('store file cannot be read') }
      delete() { throw new Error('store file cannot be read') }
      keys() { throw new Error('store file cannot be read') }
    }
    let F
    try {
      F = await boot(file, new Broken())
    } catch (err) {
      return [`the session start threw: ${err.message}`, false]
    }
    const said = (await F.command('plan-progress-autoclose'))?.text ?? ''
    const made = (await F.call({ id: 't', title: 'Task', stages: three() })).result ?? ''
    await F.call({ id: 't', state: 'done' })
    for (let i = 0; i < 31; i++) {
      F.tick(1000)
      await F.everyTick()
    }
    return [`autoclose: "${said}"; call: "${made}"; finished bar after 31 s ${!!F.bar('t')}`, /leave 30 s/.test(said) && made.startsWith('t: ') && !F.bar('t')]
  },
  async done_bar_seconds_comes_from_the_config() {
    // the doneBarSeconds option sets how long a finished bar stays
    globalThis.OPTIONS = { doneBarSeconds: 10 }
    try {
      const F = await boot(file)
      await F.command('plan-progress-autoclose')
      await create(F)
      await F.call({ id: 't', state: 'done' })
      const ticks = async n => {
        for (let i = 0; i < n; i++) {
          F.tick(1000)
          await F.everyTick()
        }
      }
      await ticks(9)
      const at9 = !!F.bar('t')
      await ticks(2)
      const at11 = !!F.bar('t')
      return [`shown at 9 s ${at9}, at 11 s ${at11}`, at9 && !at11]
    } finally {
      delete globalThis.OPTIONS
    }
  },
  async failed_save_is_tried_again(E) {
    // a save the store refused (its delete went through, its write did not) is owed, even if the bars never change
    // again: the clock tries it again after a while, and session.end at once
    const saved = async () => ((await E.$.store.get('plans:session-1')) ?? []).map(p => `${p.id}:${p.stages.flatMap(g => g.steps).find(t => t.status === 'active')?.title}`).join()
    const ticks = async n => {
      for (let i = 0; i < n; i++) {
        E.tick(1000)
        await E.everyTick()
      }
    }
    const set = E.$.store.set
    const refuse = () => {
      E.$.store.set = async () => {
        throw new Error('locked')
      }
    }
    await create(E)
    await ticks(1)
    const first = await saved()
    refuse()
    await E.call({ id: 't', next: true })
    await ticks(1)
    E.$.store.set = set
    const lost = await saved()
    await ticks(5)
    const soon = await saved()
    await ticks(26)
    const later = await saved()
    refuse()
    await E.call({ id: 't', next: true })
    await ticks(1)
    E.$.store.set = set
    await E.sessionEnd('clear')
    const atEnd = await saved()
    return [
      `saved "${first}"; refused: "${lost}", 5 s on "${soon}", 31 s on "${later}"; refused again, then session.end "${atEnd}"`,
      first === 't:A' && lost === '' && soon === '' && later === 't:B' && atEnd === 't:C',
    ]
  },
  async junk_saved_bars_are_left_out() {
    // a store holding junk among a session's saved bars (a file written over by hand): the good bars come back, the rest
    // is left out, and the session starts with its clock and draws
    const good = { id: 'g', title: 'Good', kind: 'plan', stages: [{ name: 'One', steps: [{ title: 'A', status: 'active', substeps: [] }] }], state: 'running', note: null, startedAt: 1 }
    const junk = [null, 5, { title: 'x' }, { id: 'b', title: 'B', state: 'running', stages: [null] }, { id: 'c', title: 'C', state: 'running', stages: [{ name: 'S', steps: [null] }] }]
    const kept = new Map([['plans:session-1', JSON.stringify([...junk, good])]])
    let F
    try {
      F = await boot(file, kept)
    } catch (err) {
      return [`the session start threw: ${err.message}`, false]
    }
    const ids = F.plans().map(p => p.id).join() || 'none'
    const desktop = (await F.svgs()).length
    const terminal = (await F.terminal(120)).some(n => n.type === 'Raster')
    const said = (await F.command('plan-progress-autoclose'))?.text ?? ''
    return [`restored ${ids}; drawn: desktop ${desktop} pictures, terminal ${terminal}; autoclose "${said.slice(0, 30)}"`, ids === 'g' && desktop > 0 && terminal && /leave/.test(said)]
  },
  async twinkle_off_draws_the_fill_still() {
    // the twinkle option off (#23): the track's fill has no flicker and no sliding wave, its grid and the wave's bands
    // stay; the strips' dots stand while their status dot still pulses; a glide and the clocks still move
    globalThis.OPTIONS = { twinkle: false }
    try {
      const F = await boot(file)
      await create(F)
      await F.spawn('ag1', 'Scan tests')
      await F.agentTool('ag1', 'Read')
      await F.view('t')
      await F.call({ id: 't', next: true })
      const v = await F.view('t')
      const t = v.track
      const flicker = /@keyframes q\d/.test(t) || t.includes('id="fp') || t.includes('url(#kfade)')
      const wave = /\.wm\{animation/.test(t) || t.includes('@keyframes wm')
      const kept = t.includes('fill="url(#dg)"') && t.includes('mask="url(#wave)"') && t.includes('<animateTransform')
      const strip = v.strips[0] ?? ''
      const dots = /class="t\d"/.test(strip) && !strip.includes('animation:tw')
      const moving = strip.includes('.sd{animation') && /class="sc ck/.test(strip) && v.clock.includes('class="kc0 ')
      return [`flicker ${flicker}, wave ${wave}; grid, bands and glide ${kept}; strip dots still ${dots}; status dot and clocks move ${moving}; track ${t.length} chars`, !flicker && !wave && kept && dots && moving && t.length < 8000]
    } finally {
      delete globalThis.OPTIONS
    }
  },
  async twinkle_off_terminal_fill_holds() {
    // the twinkle option off: a running bar's terminal fill is the same from one draw to the next, so a turn sends no
    // frames for it; a step that moves still glides, its frames started with it
    globalThis.OPTIONS = { twinkle: false }
    try {
      const F = await boot(file)
      await F.turnStart()
      await F.call({ id: 't', title: 'Task', stages: [S('One', st('A', 'done'), st('B', 'done'), st('C', 'active'), 'D')] })
      const cells = async () => (await F.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t').props.cells
      const first = await cells()
      F.tick(700)
      const later = await cells()
      await F.everyTick()
      const resting = F.frameTimers()
      await F.call({ id: 't', next: true })
      await F.terminal(120)
      const gliding = F.frameTimers()
      // an agent at work keeps the frames going for its strip; the bar's fill above it sends none once the glide is over
      F.tick(1000)
      await F.spawn('ag1', 'Scan tests')
      await F.terminal(120)
      await F.everyTick()
      const from = F.blits.length
      for (let i = 0; i < 30; i++) {
        F.tick(33)
        await F.frameTick()
      }
      const sent = F.blits.slice(from)
      const track = sent.filter(b => b.key === 'track-t').length
      const strips = sent.filter(b => b.key !== 'track-t').length
      return [
        `fill the same 700 ms on ${first === later}; frame clocks at rest ${resting}, on a glide ${gliding}; with an agent at work, 1 s of frames: track ${track}, strips ${strips}`,
        first === later && resting === 0 && gliding === 1 && track === 0 && strips > 0,
      ]
    } finally {
      delete globalThis.OPTIONS
    }
  },
  async version_row_shows_the_installed_version() {
    // the window's last section, About, holds the version: this copy's own, read from its manifest, on a button that
    // checks for a newer release; nothing is fetched until it is pressed
    installAs('1.0.0')
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      const d = await versionRow(F)
      const t = await versionRow(F, 'terminal')
      const heads = d.w.filter(n => n.type === 'Text' && n.props.bold).map(n => n.children.join(''))
      return [
        `heads ${heads.join(', ')}; desktop "${d.label}", terminal "${t.label}"; "${d.line}"; fetched ${F.fetches.length}`,
        heads.join() === 'Appearance,Behavior,About' && d.label === '↻ 1.0.0' && t.label === '↻ 1.0.0' && d.line === 'Press it to look for a newer release' && F.fetches.length === 0,
      ]
    } finally {
      clearVersion()
    }
  },
  async version_check_offers_the_newest_release_of_this_mod() {
    // the marketplace repo holds several mods: only plan-progress-v tags count, drafts and pre-releases never, and the
    // newest wins by number (1.0.10 after 1.0.9). The offer is Update and Later, with the release notes linked; Later
    // puts the version button back. PLAN_PROGRESS_RELEASES_URL sends the check elsewhere
    installAs('1.0.0')
    releasesAre([release('other-mod-v9.0.0'), release('plan-progress-v2.0.0', { draft: true }), release('plan-progress-v1.1.0', { prerelease: true }), release('plan-progress-v1.0.9'), release('plan-progress-v1.0.10'), release('plan-progress-v1.0.0')])
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      const d = await pressVersion(F, 'version')
      const t = await versionRow(F, 'terminal')
      globalThis.ENV.PLAN_PROGRESS_RELEASES_URL = 'http://127.0.0.1:47901/repos/zycck/claude-mods/releases'
      const back = await pressVersion(F, 'version-later')
      await pressVersion(F, 'version')
      const own = buttons => buttons.filter(k => k.startsWith('version')).join()
      return [
        `offer "${d.line}" ${JSON.stringify(d.link)}; buttons ${own(d.buttons)}; terminal ${own(t.buttons)}; later "${back.label}"; fetched ${F.fetches.join(' , ')}`,
        d.line === 'Version 1.0.10 is out' &&
          d.link?.href === 'https://example.test/releases/tag/plan-progress-v1.0.10' &&
          d.link?.label === 'What’s new' &&
          own(d.buttons) === 'version-update,version-later' &&
          own(t.buttons) === 'version-update,version-later' &&
          back.label === '↻ 1.0.0' &&
          F.fetches[0].startsWith('https://api.github.com/repos/zycck/claude-mods/releases') &&
          F.fetches[1] === 'http://127.0.0.1:47901/repos/zycck/claude-mods/releases',
      ]
    } finally {
      clearVersion()
    }
  },
  async version_check_says_latest_or_why_it_failed() {
    // the newest release is this one: said so; a refused request or no network: said why, the button still there to try
    // again
    installAs('1.0.10')
    releasesAre([release('plan-progress-v1.0.9'), release('plan-progress-v1.0.10')])
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      const latest = (await pressVersion(F, 'version')).line
      globalThis.HTTP = async () => ({ status: 403, ok: false, headers: {}, text: '{"message":"API rate limit exceeded"}' })
      const refused = (await pressVersion(F, 'version')).line
      delete globalThis.HTTP
      const offline = await pressVersion(F, 'version')
      return [
        `"${latest}" / "${refused}" / "${offline.line}" / button "${offline.label}"`,
        latest === 'This is the latest version' && refused === 'Could not check: HTTP 403' && offline.line === 'Could not check: fetch failed: no network in the tests' && offline.label === '↻ 1.0.10',
      ]
    } finally {
      clearVersion()
    }
  },
  async version_update_installs_and_reloads_in_place() {
    // Update pulls the marketplace, then updates the plugin in the scope it is installed in, then reloads the plugins
    // once the press is over; the copy the reload loads says it is the new version
    installAs('1.0.0')
    releasesAre([release('plan-progress-v1.0.1')])
    const calls = []
    globalThis.CLI = cliAnswers(calls, UPDATED)
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      await pressVersion(F, 'version')
      await F.press((await versionRow(F)).w, 'version-update')
      const during = (await versionRow(F)).line
      const ranBefore = F.commandRuns.length
      F.tick(300)
      await F.fireTimers()
      const ran = F.commandRuns.map(r => `${r.command}:${r.args}`)
      // the reload: the engine loads the new copy, and the old one's timers stop
      installAs('1.0.1')
      await F.reload()
      const after = await versionRow(F)
      F.tick(6000)
      await F.fireTimers()
      const later = (await versionRow(F)).line
      return [
        `cli ${calls.join(' ; ')}; during "${during}"; ran ${ranBefore} then ${ran.join()}; after "${after.line}" "${after.label}"; later "${later}"`,
        calls.join(' ; ') === 'plugin marketplace update mods ; plugin update plan-progress@mods --json' &&
          during === 'Updating to 1.0.1…' &&
          ranBefore === 0 &&
          ran.join() === 'reload-plugins:' &&
          after.line === 'Updated to 1.0.1' &&
          after.label === '↻ 1.0.1' &&
          later === 'Updated to 1.0.1',
      ]
    } finally {
      clearVersion()
    }
  },
  async version_update_asks_for_a_restart_when_the_reload_does_not_take() {
    // the reload ran but this copy is still the one running five seconds on, or the reload could not run: a restart
    // finishes the update
    installAs('1.0.0')
    releasesAre([release('plan-progress-v1.0.1')])
    globalThis.CLI = cliAnswers([], UPDATED)
    try {
      const updateOnce = async () => {
        const F = await boot(file)
        await F.command('plan-progress-settings')
        await pressVersion(F, 'version')
        await pressVersion(F, 'version-update')
        return F
      }
      const F = await updateOnce()
      const waiting = (await versionRow(F)).line
      F.tick(5000)
      await F.fireTimers()
      const stale = (await versionRow(F)).line
      globalThis.COMMAND_RUN = () => {
        throw new Error('no command named /reload-plugins in this session')
      }
      const refused = (await versionRow(await updateOnce())).line
      return [
        `waiting "${waiting}", five seconds on "${stale}"; reload refused "${refused}"`,
        waiting === 'Updating to 1.0.1…' && stale === 'Restart Claude Code to finish the update' && refused === 'Restart Claude Code to finish the update',
      ]
    } finally {
      clearVersion()
    }
  },
  async version_update_failure_says_why() {
    // nothing new in the marketplace yet, or no claude CLI to run: said why, nothing reloaded, a new check offers it again
    installAs('1.0.0')
    releasesAre([release('plan-progress-v1.0.1')])
    globalThis.CLI = cliAnswers([], { command: 'update', outcome: 'ok', updateOutcome: 'up_to_date', oldVersion: '1.0.0', newVersion: '1.0.0', message: 'plan-progress is already at the latest version (1.0.0).' })
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      await pressVersion(F, 'version')
      const stale = (await pressVersion(F, 'version-update')).line
      delete globalThis.CLI
      await pressVersion(F, 'version')
      const noCli = (await pressVersion(F, 'version-update')).line
      return [
        `"${stale}" / "${noCli}"; reloads ${F.commandRuns.length}`,
        stale === 'Could not update: plan-progress is already at the latest version (1.0.0).' && noCli === 'Could not update: claude: not found' && F.commandRuns.length === 0,
      ]
    } finally {
      clearVersion()
    }
  },
  async version_update_runs_the_sessions_own_claude() {
    // the host names the session's binary: that one runs (the desktop's is off PATH); a name that is not claude's, or
    // none, leaves the one on PATH
    installAs('1.0.0')
    releasesAre([release('plan-progress-v1.0.1')])
    globalThis.CLI = cliAnswers([], UPDATED)
    try {
      const runWith = async execPath => {
        if (execPath) globalThis.ENV.CLAUDE_CODE_EXECPATH = execPath
        else delete globalThis.ENV.CLAUDE_CODE_EXECPATH
        const F = await boot(file)
        await F.command('plan-progress-settings')
        await pressVersion(F, 'version')
        await pressVersion(F, 'version-update')
        return F.procs.filter(c => c.includes(' plugin ')).map(c => c.split(' plugin ')[0]).join()
      }
      const exe = 'C:\\Users\\x\\AppData\\Local\\Claude\\claude-code\\2.1.295\\claude.exe'
      const own = await runWith(exe)
      const node = await runWith('/usr/local/bin/node')
      const none = await runWith('')
      return [`own ${own}; node ${node}; none ${none}`, own === `${exe},${exe}` && node === 'claude,claude' && none === 'claude,claude']
    } finally {
      clearVersion()
    }
  },
  async version_row_starts_over_after_a_reload() {
    // a reload of the mod (an option set in the window does one) cancels the old code's waits: an update cut off
    // starts over instead of hanging on Updating; an update installed but not loaded by the reload waits for a restart
    // at once, and pressed again it is offered, found installed by the CLI and reloaded
    installAs('1.0.0')
    releasesAre([release('plan-progress-v1.0.1')])
    try {
      globalThis.CLI = () => new Promise(() => {})
      const F = await boot(file)
      await F.command('plan-progress-settings')
      await pressVersion(F, 'version')
      void F.press((await versionRow(F)).w, 'version-update')
      await new Promise(r => setTimeout(r, 20))
      const during = (await versionRow(F)).line
      await F.reload()
      const cut = await versionRow(F)
      globalThis.CLI = cliAnswers([], UPDATED)
      await pressVersion(F, 'version')
      await F.press((await versionRow(F)).w, 'version-update')
      await F.reload()
      const old = (await versionRow(F)).line
      globalThis.CLI = cliAnswers([], { ...UPDATED, updateOutcome: 'up_to_date', oldVersion: '1.0.1', message: 'plan-progress is already at the latest version (1.0.1).' })
      const runs = F.commandRuns.length
      await pressVersion(F, 'version')
      const again = (await pressVersion(F, 'version-update')).line
      return [
        `during "${during}"; reloaded "${cut.line}" [${cut.buttons.filter(k => k.startsWith('version')).join()}]; old copy back "${old}"; pressed again "${again}", reloads ${F.commandRuns.length - runs}`,
        during === 'Updating to 1.0.1…' &&
          cut.line === 'Press it to look for a newer release' &&
          cut.buttons.filter(k => k.startsWith('version')).join() === 'version' &&
          old === 'Restart Claude Code to finish the update' &&
          again === 'Updating to 1.0.1…' &&
          F.commandRuns.length - runs === 1,
      ]
    } finally {
      clearVersion()
    }
  },
  async auto_check_offers_after_a_failed_check() {
    // a press that could not reach GitHub says so; the timed check that finds a release later offers it in its place
    installAs('1.0.0')
    globalThis.HTTP = async () => ({ status: 503, ok: false, headers: {}, text: '' })
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      const failed = (await pressVersion(F, 'version')).line
      releasesAre([release('plan-progress-v1.0.1')])
      await firstCheck(F)
      const offer = (await versionRow(F)).line
      return [`"${failed}" -> "${offer}", dot ${await dotOf(F, 'desktop')}`, failed === 'Could not check: HTTP 503' && offer === 'Version 1.0.1 is out' && (await dotOf(F, 'desktop'))]
    } finally {
      clearVersion()
    }
  },
  async version_row_keeps_the_keyboard_ring() {
    // a pressed check that finds a release swaps the ↻ for Update and Later: the ring goes onto Update, so Enter
    // updates; Later or Update hands it back to the version button. A release the timer found takes no ring
    installAs('1.0.0')
    releasesAre([release('plan-progress-v1.0.1')])
    globalThis.CLI = () => new Promise(() => {})
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      await pressVersion(F, 'version')
      const offer = F.rings.map(r => `${r.requestId}:${r.key}`).join()
      await pressVersion(F, 'version-later')
      const later = F.rings.map(r => r.key).join()
      await pressVersion(F, 'version')
      void F.press((await versionRow(F)).w, 'version-update')
      await new Promise(r => setTimeout(r, 20))
      const updating = F.rings.map(r => r.key).join()
      const G = await boot(file)
      await firstCheck(G)
      return [
        `offer ${offer}; later ${later}; update ${updating}; timer ${G.rings.length}`,
        offer === 'settings:version-update' && later === 'version-update,version' && updating === 'version-update,version,version-update,version' && G.rings.length === 0,
      ]
    } finally {
      clearVersion()
    }
  },
  async version_of_a_folder_install_is_not_checked() {
    // a copy no marketplace installed (--plugin-dir, a dev mod) updates with its folder: a press says so and fetches nothing
    globalThis.ROOT = '/work/plan-progress'
    globalThis.FILES = { '/work/plan-progress/.claude-plugin/plugin.json': JSON.stringify({ version: '1.0.0' }) }
    releasesAre([release('plan-progress-v1.0.1')])
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      const d = await pressVersion(F, 'version')
      return [`"${d.label}" "${d.line}"; fetched ${F.fetches.length}`, d.label === '↻ 1.0.0' && d.line === 'Installed from a folder: it updates with the folder' && F.fetches.length === 0]
    } finally {
      clearVersion()
    }
  },
  async auto_check_puts_a_dot_by_the_gear(E) {
    // 15 s after the start the session asks for releases on its own; a newer one puts a blue dot by the footer's ⚙ and
    // the offer in the window. What was found is kept in the store: a second session within six hours shows the dot
    // without asking again, and the half-hourly timer asks again once six hours have passed
    void E
    installAs('1.0.0')
    releasesAre([release('plan-progress-v1.0.1')])
    const kept = new Map()
    try {
      const F = await boot(file, kept)
      const before = await dotOf(F, 'desktop')
      await firstCheck(F)
      const desk = await dotOf(F, 'desktop')
      const term = await dotOf(F, 'terminal')
      await F.command('plan-progress-settings')
      const offer = (await versionRow(F)).line
      const G = await boot(file, kept)
      await firstCheck(G)
      const second = `${G.fetches.length} ${await dotOf(G, 'desktop')}`
      G.tick(6 * 60 * 60 * 1000)
      await G.everyTick()
      await new Promise(r => setTimeout(r, 0))
      return [
        `before ${before}; after the first check fetched ${F.fetches.length}, dot desktop ${desk} terminal ${term}; window "${offer}"; second session ${second}; six hours on fetched ${G.fetches.length}`,
        !before && F.fetches.length === 1 && desk && term && offer === 'Version 1.0.1 is out' && second === '0 true' && G.fetches.length === 1,
      ]
    } finally {
      clearVersion()
    }
  },
  async auto_check_stays_quiet_when_it_should(E) {
    // nothing is asked with the window's switch off, with non-essential traffic off, or for a folder install; a failed
    // check shows nothing; Later takes the dot away for that version, and a newer one brings it back
    void E
    releasesAre([release('plan-progress-v1.0.1')])
    const out = []
    try {
      installAs('1.0.0')
      const A = await boot(file)
      await A.command('plan-progress-settings')
      await A.press(await A.pane('settings'), 'updateCheck')
      const switchedOff = stateOf(await A.pane('settings'), 'updateCheck')
      await firstCheck(A)
      out.push(`switch ${switchedOff}: fetched ${A.fetches.length}`)
      await A.press(await A.pane('settings'), 'updateCheck')

      globalThis.ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      const B = await boot(file)
      await firstCheck(B)
      out.push(`no traffic: fetched ${B.fetches.length}`)
      delete globalThis.ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

      clearVersion()
      globalThis.ROOT = '/work/plan-progress'
      globalThis.FILES = { '/work/plan-progress/.claude-plugin/plugin.json': JSON.stringify({ version: '1.0.0' }) }
      releasesAre([release('plan-progress-v1.0.1')])
      const C = await boot(file)
      await firstCheck(C)
      out.push(`folder: fetched ${C.fetches.length}`)

      clearVersion()
      installAs('1.0.0')
      globalThis.HTTP = async () => ({ status: 500, ok: false, headers: {}, text: '' })
      const D = await boot(file)
      await firstCheck(D)
      await D.command('plan-progress-settings')
      out.push(`failed: fetched ${D.fetches.length}, dot ${await dotOf(D, 'desktop')}, line "${(await versionRow(D)).line}"`)

      releasesAre([release('plan-progress-v1.0.1')])
      const kept = new Map()
      const F = await boot(file, kept)
      await firstCheck(F)
      await F.command('plan-progress-settings')
      await F.press(await F.pane('settings'), 'version-later')
      const G = await boot(file, kept)
      await firstCheck(G)
      const afterLater = await dotOf(F, 'desktop') || (await dotOf(G, 'desktop'))
      releasesAre([release('plan-progress-v1.0.2')])
      kept.delete('updateCheckedAt')
      const H = await boot(file, kept)
      await firstCheck(H)
      out.push(`later: dot ${afterLater}; 1.0.2 out: dot ${await dotOf(H, 'desktop')}`)
      return [
        out.join('; '),
        out.join('; ') === 'switch Off: fetched 0; no traffic: fetched 0; folder: fetched 0; failed: fetched 1, dot false, line "Press it to look for a newer release"; later: dot false; 1.0.2 out: dot true',
      ]
    } finally {
      clearVersion()
    }
  },
  async settings_gear_opens_the_window(E) {
    // the ⚙ beside the footer's figure opens the settings window, and /plan-progress-settings does anywhere: a press or
    // a command is the person asking, so the pane is placed at any width; one the session cannot place says why, and so
    // does one another plugin's hook refuses
    const isRegistered = E.commands.has('plan-progress-settings')
    const pressed = await E.press(await E.footer('desktop', undefined), 'settings')
    const asked = E.panes.get('settings')
    const isAsked = asked?.title === 'Plan progress' && asked.focus === true && asked.closeOnEscape === true && asked.rows === 12
    await E.$.ui.close({ id: 'settings' })
    const said = (await E.command('plan-progress-settings')).text
    const isOpen = E.panes.has('settings')
    globalThis.PANE_WAIT = 'the terminal is 90 columns wide'
    let waits
    try {
      waits = (await E.command('plan-progress-settings')).text
    } finally {
      delete globalThis.PANE_WAIT
    }
    const open = E.$.ui.open
    E.$.ui.open = async () => {
      throw new Error('plan-progress: $.ui.open: another plugin keeps the screen')
    }
    let refused
    try {
      refused = (await E.command('plan-progress-settings')).text
    } finally {
      E.$.ui.open = open
    }
    return [
      `command registered ${isRegistered}; gear pressed ${pressed}, window asked ${JSON.stringify(asked)}; command "${said}", open ${isOpen}; unplaced "${waits}"; refused "${refused}"`,
      isRegistered && pressed && isAsked && said === 'Settings are open.' && isOpen && /wait for room: the terminal is 90/.test(waits) && /^Settings did not open: plan-progress: \$\.ui\.open: another plugin keeps the screen$/.test(refused),
    ]
  },
  async settings_window_switches_at_once(E) {
    // auto-close, the sounds and the footer's figure are kept in the store and hold at once, with no reload: each
    // press turns its button over in the window and does what it says
    const choices = nodes => ['autoclose', 'sounds', 'speed'].map(k => stateOf(nodes, k)).join()
    const w = await E.pane('settings')
    const before = choices(w)
    for (const key of ['sounds', 'speed', 'autoclose']) await E.press(w, key)
    const after = choices(await E.pane('settings'))
    // sounds off: a question, an error, a bar waiting on the person and a finish play nothing
    await create(E, 'x')
    await create(E, 'y')
    await create(E)
    await E.call({ id: 'x', state: 'error', note: 'broke' })
    await E.call({ id: 'y', state: 'needs_input', note: 'which one?' })
    await E.ask()
    await E.call({ id: 't', state: 'done' })
    const played = E.sounds.length
    // the figure off: the footer keeps its ⚙ alone
    const foot = await E.footer('desktop', undefined)
    const isGearOnly = !hasFigure(foot) && labelOf(foot, 'settings') === '⚙\uFE0E'
    // auto-close on: the finished bar leaves 30 s after it finished
    for (let i = 0; i < 31; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    const isGone = !E.bar('t')
    const kept = (await Promise.all(['autoclose', 'sounds', 'speedShown'].map(k => E.$.store.get(k)))).join()
    // and the sounds on again play the next finish
    await E.press(await E.pane('settings'), 'sounds')
    await E.call({ id: 'x', state: 'done' })
    const playedAgain = E.sounds.length
    return [
      `buttons ${before} -> ${after}; question, error, waiting and finish played ${played}; footer ⚙ alone ${isGearOnly}; finished bar gone after 31 s ${isGone}; store ${kept}; sounds on again played ${playedAgain}`,
      before === 'Off,On,On' && after === 'On,Off,Off' && played === 0 && isGearOnly && isGone && kept === 'true,false,false' && playedAgain === 1,
    ]
  },
  async settings_choice_redraws_footer_and_window(E) {
    // the engine draws a component again only when a key its last draw read was written: the footer and the window
    // read the key every choice writes, /plan-progress-autoclose's included, so a change shows at once on both
    const readBy = async draw => {
      E.$.__reads = new Set()
      try {
        await draw()
        return [...E.$.__reads]
      } finally {
        E.$.__reads = null
      }
    }
    const footer = await readBy(() => E.footer('desktop', undefined))
    const window = await readBy(() => E.pane('settings'))
    const rev = () => E.$.__get({ ref: { key: 'prefs' }, initial: null })?.rev ?? 0
    const moved = []
    for (const key of ['sounds', 'autoclose', 'speed']) {
      const before = rev()
      await E.press(await E.pane('settings'), key)
      moved.push(`${key} ${rev() > before}`)
    }
    const before = rev()
    await E.command('plan-progress-autoclose')
    moved.push(`the command ${rev() > before}`)
    return [`footer reads ${footer.join()}; window reads ${window.join()}; prefs written by ${moved.join(', ')}`, footer.includes('prefs') && window.includes('prefs') && moved.every(m => m.endsWith('true'))]
  },
  async settings_choices_survive_an_options_reload() {
    // an option set in the window reloads the mod, whose choices start over at the defaults: session.start takes them
    // back first thing, from $.state even when the store cannot keep them, and has the footer and the window drawn
    // again. Drawn while that session.start is still at work, they already show the choices
    class Broken extends Map {
      has() { return true }
      get() { return '\0\0\0' }
      set() { throw new Error('store file cannot be read') }
      delete() { throw new Error('store file cannot be read') }
      keys() { throw new Error('store file cannot be read') }
    }
    const out = []
    let ok = true
    for (const [name, store] of [['store', new Map()], ['unreadable store', new Broken()]]) {
      const F = await boot(file, store)
      for (const key of ['autoclose', 'sounds', 'speed']) await F.press(await F.pane('settings'), key)
      const rev = () => F.$.__get({ ref: { key: 'prefs' }, initial: null })?.rev ?? 0
      const shown = async () => {
        const w = await F.pane('settings')
        return `${['autoclose', 'sounds', 'speed'].map(k => stateOf(w, k)).join()} ${hasFigure(await F.footer('desktop', undefined)) ? 'figure' : 'no figure'}`
      }
      const before = rev()
      // a draw lands while session.start runs: at its tool registration
      const register = F.$.tool.register
      let during = ''
      F.$.tool.register = async spec => {
        during = await shown()
        return register(spec)
      }
      try {
        await F.reload()
      } finally {
        F.$.tool.register = register
      }
      const after = await shown()
      const isRedrawn = rev() > before
      ok &&= during === 'On,Off,Off no figure' && after === during && isRedrawn
      out.push(`${name}: drawn during the reload "${during}", after "${after}", redrawn ${isRedrawn}`)
    }
    return [out.join('; '), ok]
  },
  async settings_window_sets_options_the_config_way(E) {
    // twinkle and doneBarSeconds stay options of /config: the window sets them as the menu does, typed as the manifest
    // declares them, and the mod comes back with them (a reload, the window still open). A second press while a set is
    // on its way is dropped; a set the engine refuses is said in a toast
    await E.command('plan-progress-settings')
    const w = await E.pane('settings')
    await Promise.all([E.press(w, 'twinkle'), E.press(w, 'twinkle')])
    await E.press(w, 'stay-10')
    const sets = JSON.stringify(E.configSets)
    globalThis.OPTIONS = { twinkle: false, doneBarSeconds: 10 }
    let after
    try {
      await E.reload()
      const v = await E.pane('settings')
      const stay = v.filter(n => n.type === 'Button' && n.props.variant === 'primary' && String(n.props.key).startsWith('stay-')).map(n => n.props.key)
      after = `${stateOf(v, 'twinkle')} ${stay.join()}`
    } finally {
      delete globalThis.OPTIONS
    }
    globalThis.CONFIG_DENY = 'a policy holds this setting'
    try {
      await E.press(await E.pane('settings'), 'stay-60')
    } finally {
      delete globalThis.CONFIG_DENY
    }
    const isTold = E.notices.some(n => n.via === 'toast' && n.text.includes('a policy holds this setting'))
    return [
      `sets ${sets}; after the reload ${after}, window open ${E.panes.has('settings')}; a refused set told ${isTold}`,
      sets === '[{"key":"plan-progress.twinkle","value":false},{"key":"plan-progress.doneBarSeconds","value":10}]' && after === 'Off stay-10' && E.panes.has('settings') && isTold,
    ]
  },
  async settings_window_tries_an_option_again_when_its_row_is_missing() {
    // a real terminal refused Effects a few seconds after the session started, "no /config row with key
    // plan-progress.twinkle": the engine's plugin list was being reloaded. Such a refusal is tried again, up to three
    // times, a little later each, before it is shown; any other refusal is shown at once
    const E = await boot(file)
    const w = await E.pane('settings')
    globalThis.CONFIG_MISSING = 2
    try {
      await E.press(w, 'twinkle')
    } finally {
      delete globalThis.CONFIG_MISSING
    }
    const twice = { sets: E.configSets.length, sleeps: E.sleeps.join(), told: E.notices.filter(n => n.via === 'toast').length }
    globalThis.CONFIG_MISSING = 9
    try {
      await E.press(await E.pane('settings'), 'stay-60')
    } finally {
      delete globalThis.CONFIG_MISSING
    }
    const always = { sets: E.configSets.length - twice.sets, told: E.notices.some(n => n.via === 'toast' && n.text.includes('no /config row')) }
    const before = E.configSets.length
    globalThis.CONFIG_DENY = 'a policy holds this setting'
    try {
      await E.press(await E.pane('settings'), 'stay-10')
    } finally {
      delete globalThis.CONFIG_DENY
    }
    const other = E.configSets.length - before
    return [
      `missing twice: ${twice.sets} sets after waits ${twice.sleeps}, ${twice.told} told; missing for good: ${always.sets} sets, told ${always.told}; another refusal: ${other} set`,
      twice.sets === 3 && twice.sleeps === '400,800' && twice.told === 0 && always.sets === 4 && always.told && other === 1,
    ]
  },
  async settings_window_names_seconds_it_has_no_button_for() {
    // /config takes any number of seconds: one the window has no cell for gets its own, in order, picked
    globalThis.OPTIONS = { doneBarSeconds: 45 }
    try {
      const F = await boot(file)
      const out = []
      for (const surface of ['desktop', 'terminal']) {
        const w = await F.pane('settings', surface)
        const cells = w.filter(n => n.type === 'Button' && String(n.props.key).startsWith('stay-'))
        const picked = cells.filter(n => n.props.variant === 'primary').map(n => unpadded(n.props.label))
        out.push(`${surface}: ${cells.map(n => unpadded(n.props.label)).join()} picked ${picked.join()}`)
      }
      return [out.join('; '), out.join() === 'desktop: 10 s,30 s,45 s,60 s picked 45 s,terminal: 10 s,30 s,45 s,60 s picked 45 s']
    } finally {
      delete globalThis.OPTIONS
    }
  },
  async settings_choices_last_a_new_session() {
    // the window's choices are kept in the store: the next session starts silent and without the figure
    const kept = new Map()
    const A = await boot(file, kept)
    const w = await A.pane('settings')
    await A.press(w, 'sounds')
    await A.press(w, 'speed')
    const B = await boot(file, kept)
    await create(B)
    await B.call({ id: 't', state: 'done' })
    const figure = hasFigure(await B.footer('desktop', undefined))
    return [`next session: sounds played ${B.sounds.length}, figure in the footer ${figure}`, B.sounds.length === 0 && !figure]
  },
  async settings_window_leaves_closing_to_the_engine(E) {
    // the engine draws the pane's close control on every surface and Escape closes it (closeOnEscape), so the window
    // has no Close of its own. On the terminal the focus ring starts on Auto-close, whose press reloads nothing
    await E.command('plan-progress-settings')
    const desk = await E.pane('settings', 'desktop')
    const term = await E.pane('settings', 'terminal')
    const closes = [desk, term].map(w => w.filter(n => n.type === 'Button' && (n.props.key === 'close' || n.props.label === 'Close')).length)
    const focus = [term, desk].map(w => w.filter(n => n.props?.autoFocus).map(n => n.props.key).join())
    return [
      `Close buttons: desktop ${closes[0]}, terminal ${closes[1]}; focus starts on the terminal at "${focus[0]}", on the desktop at "${focus[1]}"`,
      closes.join() === '0,0' && focus[0] === 'autoclose' && focus[1] === '' && E.panes.get('settings')?.closeOnEscape === true,
    ]
  },
  async speed_off_writes_only_the_final_figure(E) {
    // the figure turned off in the window: a streaming response writes the footer's key at its stop only, not every
    // second, since on the desktop every write draws each component anew
    const piece = { kind: 'text', index: 0, text: 'x'.repeat(36) }
    const pieces = [[{ kind: 'engine', ref: 1 }, 0], ...Array.from({ length: 30 }, (_, i) => [piece, i === 0 ? 0 : 50])]
    const writes = async outputTokens => {
      const write = E.$.__update
      let n = 0
      E.$.__update = function (a, fn) {
        if (a.ref.key === 'speed') n++
        return write.call(this, a, fn)
      }
      try {
        await E.stream(pieces, { outputTokens })
      } finally {
        E.$.__update = write
      }
      return n
    }
    const shown = await writes(300)
    await E.press(await E.pane('settings'), 'speed')
    const hidden = await writes(600)
    const last = E.$.__get({ ref: { key: 'speed' }, initial: null })
    return [`writes of the figure over 1.5 s of streaming: shown ${shown}, turned off ${hidden}; last ${JSON.stringify(last)}`, shown >= 2 && hidden === 1 && last?.isLive === false && last.rate > 0]
  },
  async autoclose_command_and_window_agree(E) {
    // /plan-progress-autoclose and the window's button turn the same choice
    await E.command('plan-progress-autoclose')
    const shown = stateOf(await E.pane('settings'), 'autoclose')
    await E.press(await E.pane('settings'), 'autoclose')
    const said = (await E.command('plan-progress-autoclose')).text
    return [`after the command the window says ${shown}; after the window turned it off the command says "${said}"`, shown === 'On' && /leave 30 s/.test(said)]
  },
  async settings_window_speaks_the_persons_language() {
    // the window speaks the language Claude answers in (/config language: a name in English or in the language itself,
    // or a tag), read again each time it opens; with none set, the system's; English when neither is one of its 35. A
    // name every object has as a property is no language
    const intl = Intl.DateTimeFormat
    const F = await boot(file)
    const cases = [
      ['Russian', 'en-US', 'Время показа', '30 с'],
      ['日本語', 'en-US', '表示時間', '30秒'],
      ['Spanish (Latin America)', 'en-US', 'Cuánto tiempo queda una barra terminada', '30 s'],
      ['spanish', 'en-US', 'Cuánto se queda una barra terminada', '30 s'],
      ['Chinese (Traditional)', 'en-US', '停留時間', '30 秒'],
      ['pt', 'en-US', 'Fica por', '30 s'],
      ['', 'zh-Hant-HK', '停留時間', '30 秒'],
      ['', 'es-MX', 'Cuánto tiempo queda una barra terminada', '30 s'],
      ['', 'xx-YY', 'Stays for', '30 s'],
      ['Klingon', 'de-DE', 'Anzeigedauer', '30 s'],
      ['constructor', 'fr-FR', 'Reste affichée', '30 s'],
      ['Chinese', 'zh-TW', '停留時間', '30 秒'],
      ['中文', 'zh-CN', '停留时间', '30 秒'],
      ['Chinese (Taiwan)', 'en-US', '停留時間', '30 秒'],
      ['Simplified Chinese', 'zh-TW', '停留时间', '30 秒'],
      ['zh', 'zh-Hant-HK', '停留時間', '30 秒'],
      ['', 'zh-Hans-TW', '停留时间', '30 秒'],
    ]
    const out = []
    let ok = true
    try {
      for (const [language, locale, phrase, picked] of cases) {
        globalThis.LANGUAGE = language
        Intl.DateTimeFormat = function () {
          return { resolvedOptions: () => ({ locale }) }
        }
        await F.command('plan-progress-settings')
        const w = await F.pane('settings')
        const label = unpadded(w.find(n => n.type === 'Button' && n.props.key === 'stay-30')?.props.label)
        const isSaid = wordsIn(w).includes(phrase) && label === picked
        ok &&= isSaid
        out.push(`"${language}" on ${locale}: ${isSaid ? 'ok' : `missed "${phrase}" / "${picked}", got ${wordsIn(w).slice(0, 4).join(' / ')} and "${label}"`}`)
      }
    } finally {
      delete globalThis.LANGUAGE
      Intl.DateTimeFormat = intl
    }
    return [out.join('; '), ok]
  },
  async settings_window_keeps_its_language_over_a_reload() {
    // Effects or the seconds set in the window reload the mod, the window still open: the language is kept with the
    // choices in $.state, so a window drawn while session.start is still at work already speaks it, and one found
    // changed (here on the next open) is written with them, which draws the window again
    globalThis.LANGUAGE = 'Russian'
    try {
      const F = await boot(file)
      await F.command('plan-progress-settings')
      await F.press(await F.pane('settings'), 'twinkle')
      globalThis.OPTIONS = { twinkle: false }
      const register = F.$.tool.register
      let during = ''
      F.$.tool.register = async spec => {
        during = stateOf(await F.pane('settings'), 'twinkle')
        return register(spec)
      }
      try {
        await F.reload()
      } finally {
        F.$.tool.register = register
      }
      const w = await F.pane('settings')
      const state = stateOf(w, 'twinkle')
      const isNamed = wordsIn(w).includes('Эффекты: Выкл')
      const rev = () => F.$.__get({ ref: { key: 'prefs' }, initial: null })?.rev ?? 0
      const before = rev()
      await F.command('plan-progress-settings')
      const same = rev() === before
      globalThis.LANGUAGE = 'Japanese'
      await F.command('plan-progress-settings')
      const isRedrawn = rev() > before && F.$.__get({ ref: { key: 'prefs' }, initial: null })?.lang === 'ja'
      return [
        `drawn during the reload "${during}", after it "${state}", its picture named so ${isNamed}; the same language opened again writes nothing ${same}; another one is written ${isRedrawn}`,
        during === 'Выкл' && state === 'Выкл' && isNamed && same && isRedrawn,
      ]
    } finally {
      delete globalThis.LANGUAGE
      delete globalThis.OPTIONS
    }
  },
  async settings_window_follows_the_apps_language() {
    // with no /config language (its row then reads "Default (English)") the window speaks the desktop app's own (the "locale" its settings keep in config.json,
    // under APPDATA on Windows, under HOME on a Mac or Linux), else the system's: the locale variables, else Windows'
    // setting read with reg (the engine's Intl says en-US there whatever the system speaks)
    const cases = [
      ['app on Windows', { ENV: { APPDATA: 'C:/Users/x/AppData/Roaming' }, FILES: { 'C:/Users/x/AppData/Roaming/Claude/config.json': '{"locale":"ru","other":1}' } }, 'Время показа'],
      ['app on a Mac', { ENV: { HOME: '/Users/x' }, FILES: { '/Users/x/Library/Application Support/Claude/config.json': '{"locale":"ko"}' } }, '표시 시간'],
      ['app on Linux', { ENV: { HOME: '/home/x' }, FILES: { '/home/x/.config/Claude/config.json': '{"locale":"es-419"}' } }, 'Cuánto tiempo queda una barra terminada'],
      ['a language set for Claude wins', { LANGUAGE: 'Japanese', ENV: { APPDATA: 'C:/a' }, FILES: { 'C:/a/Claude/config.json': '{"locale":"ru"}' } }, '表示時間'],
      ['the unset row reads "Default (English)"', { LANGUAGE: 'Default (English)', ENV: { APPDATA: 'C:/a' }, FILES: { 'C:/a/Claude/config.json': '{"locale":"ru"}' } }, 'Время показа'],
      ['an app config that is no JSON', { ENV: { APPDATA: 'C:/a', LANG: 'de_DE.UTF-8' }, FILES: { 'C:/a/Claude/config.json': '{not json' } }, 'Anzeigedauer'],
      ['LANG', { ENV: { LANG: 'uk_UA.UTF-8' } }, 'Час показу'],
      ['LC_ALL over LANG', { ENV: { LC_ALL: 'fi_FI.UTF-8', LANG: 'uk_UA.UTF-8' } }, 'Näkyy'],
      ['LANG=C is no language', { ENV: { LANG: 'C.UTF-8' }, INTL: 'it-IT' }, 'Resta per'],
      ['LANG=C on Windows leaves it to its setting', { ENV: { LANG: 'C' }, ROOT: 'C:/plugins/plan-progress', REG_LOCALE: 'tr-TR', INTL: 'en-US' }, 'Kalma süresi'],
      ['Windows setting', { ROOT: 'C:/plugins/plan-progress', REG_LOCALE: 'tr-TR', INTL: 'en-US' }, 'Kalma süresi'],
      ['nothing anywhere', { INTL: 'en-US' }, 'Stays for'],
    ]
    const intl = Intl.DateTimeFormat
    const out = []
    let ok = true
    for (const [name, c, phrase] of cases) {
      globalThis.LANGUAGE = c.LANGUAGE ?? ''
      globalThis.ENV = c.ENV
      globalThis.FILES = c.FILES
      globalThis.REG_LOCALE = c.REG_LOCALE
      Intl.DateTimeFormat = function () {
        return { resolvedOptions: () => ({ locale: c.INTL ?? 'en-US' }) }
      }
      try {
        globalThis.ROOT = c.ROOT
        const F = await boot(file)
        await F.command('plan-progress-settings')
        const said = wordsIn(await F.pane('settings'))
        const isSaid = said.includes(phrase)
        ok &&= isSaid
        out.push(`${name}: ${isSaid ? 'ok' : `missed "${phrase}", got ${said.slice(0, 4).join(' / ')}`}`)
      } finally {
        for (const k of ['LANGUAGE', 'ENV', 'FILES', 'REG_LOCALE', 'ROOT']) delete globalThis[k]
        Intl.DateTimeFormat = intl
      }
    }
    return [out.join('; '), ok]
  },
  async settings_window_takes_a_press_anywhere_on_a_control() {
    // the desktop's button collapses a run of plain spaces into one, so a blank Button over a switch took a press only at
    // its centre: the labels of the Buttons over the pictures are widened with figure spaces, which it keeps (it draws
    // the label, never the children)
    const F = await boot(file)
    const w = await F.pane('settings', 'desktop')
    const drawn = key => w.find(n => n.type === 'Button' && n.props.key === key)?.props.label
    const switches = ['twinkle', 'speed', 'autoclose', 'sounds'].map(drawn)
    const seconds = [10, 30, 60].map(n => drawn(`stay-${n}`))
    const isWide = switches.every(x => x === FIG.repeat(4)) && seconds.every((x, i) => x === `${FIG}${[10, 30, 60][i]} s${FIG}`)
    // and it cuts a label wider than the box it sits in with an ellipsis: four figure spaces over the 36 px switch drew
    // "…", the pane's text being 13 px with 4 px of padding a side. So each picture is as wide as the Button over it, in
    // every language, counted with a face's wider letters; the switch sits at the picture's right edge, the Button
    // there too, and covers it
    const LANGS = ['am', 'bn', 'bho', 'zh-CN', 'zh-TW', 'da', 'nl', 'en', 'fil', 'fi', 'fr', 'de', 'gu', 'ha', 'hi', 'id', 'it', 'ja', 'kn', 'ko', 'ml', 'mr', 'nb', 'pt-BR', 'ru', 'es-419', 'es', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'vi']
    const em = ch =>
      /\p{M}|\p{Cf}/u.test(ch) ? 0
      : /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 1
      : ch === ' ' ? 0.28
      : /[0-9\u2007]/.test(ch) ? 0.56
      : 0.6
    const buttonPx = label => [...label].reduce((n, ch) => n + em(ch), 0) * 13 + 8
    const cut = []
    let isCovered = true
    try {
      for (const lang of LANGS) {
        globalThis.LANGUAGE = lang
        await F.command('plan-progress-settings')
        const nodes = await F.pane('settings', 'desktop')
        for (const [at, n] of nodes.entries()) {
          if (n.type !== 'Button' || !n.props.plain) continue
          const picture = nodes.slice(0, at).reverse().find(x => x.type === 'Svg')
          const room = picture?.props.width ?? 0
          if (buttonPx(n.props.label) > room) cut.push(`${lang} ${n.props.key} ${Math.round(buttonPx(n.props.label))} > ${room}`)
          const knob = picture?.props.source.match(/<rect class="sw" x="([\d.]+)" width="([\d.]+)"/)
          if (!knob) continue
          const holder = nodes.find(x => x.type === 'Box' && (x.children ?? []).includes(n))
          const isAtRight = Number(knob[1]) + Number(knob[2]) === room && holder?.props.justifyContent === 'flex-end'
          if (!isAtRight || buttonPx(n.props.label) < Number(knob[2])) isCovered = false
        }
      }
    } finally {
      delete globalThis.LANGUAGE
    }
    return [
      `switch Buttons draw ${JSON.stringify(switches)}, seconds ${JSON.stringify(seconds)}; cut ${cut.slice(0, 6).join(', ') || 'none'}${cut.length > 6 ? ` and ${cut.length - 6} more` : ''}; the switch under its Button ${isCovered}`,
      isWide && cut.length === 0 && isCovered,
    ]
  },
  async settings_window_has_every_word_in_every_language() {
    // each of the 35 languages fills every word of the window on both surfaces: nothing empty or left unfilled, the
    // footer's figure and the seconds put in, a state on every switch, none falling back to English, no two alike
    const LANGS = ['am', 'bn', 'bho', 'zh-CN', 'zh-TW', 'da', 'nl', 'en', 'fil', 'fi', 'fr', 'de', 'gu', 'ha', 'hi', 'id', 'it', 'ja', 'kn', 'ko', 'ml', 'mr', 'nb', 'pt-BR', 'ru', 'es-419', 'es', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'vi']
    const F = await boot(file)
    const bad = []
    const lists = new Set()
    try {
      for (const lang of LANGS) {
        globalThis.LANGUAGE = lang
        await F.command('plan-progress-settings')
        for (const surface of ['desktop', 'terminal']) {
          const w = await F.pane('settings', surface)
          const said = wordsIn(w)
          const heads = w.filter(n => n.type === 'Text' && n.props.bold).length
          const stays = w.filter(n => n.type === 'Button' && String(n.props.key).startsWith('stay-')).map(n => n.props.label)
          const states = ['twinkle', 'speed', 'autoclose', 'sounds'].map(k => stateOf(w, k))
          const isFull =
            heads === 3 &&
            said.every(x => x.trim() !== '' && !/[{}|]|undefined/.test(x)) &&
            said.some(x => x.includes('tok/s')) &&
            stays.length === 3 &&
            stays.every((x, i) => x.includes(String([10, 30, 60][i]))) &&
            states.every(x => x && !x.includes(':')) &&
            (lang === 'en' || !said.includes('Stays for'))
          // columns as the terminal draws them: combining marks take none, CJK, Hangul and fullwidth take two
          const columns = t => [...t.replace(/\p{M}|\p{Cf}/gu, '')].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0)
          const drawnOf = k => (w.find(n => n.type === 'Button' && n.props.key === k)?.children ?? []).flat().map(c => (typeof c === 'string' ? c : (c?.children ?? []).join(''))).join('')
          const isEven = surface !== 'terminal' || columns(drawnOf('twinkle')) === columns(drawnOf('autoclose'))
          if (!isFull || !isEven) bad.push(`${lang} ${surface}${isEven ? '' : ` uneven "${drawnOf('twinkle')}" / "${drawnOf('autoclose')}"`}: ${said.join(' / ')}`)
          if (surface === 'desktop') lists.add(said.join('/'))
        }
      }
    } finally {
      delete globalThis.LANGUAGE
    }
    return [`${LANGS.length} languages, ${lists.size} different windows; short: ${bad.join('; ') || 'none'}`, bad.length === 0 && lists.size === LANGS.length]
  },
  async settings_window_draws_switches_and_seconds_per_surface(E) {
    // the desktop draws each switch and the seconds as pictures that follow its theme (a switch blue when on, grey when
    // off; one track cut into cells, the picked one raised) under plain Buttons that take the presses; the terminal draws
    // ━━● On / ●━━ Off and [ 30 s ], the picked one primary. The seconds dim while auto-close is off, still pressable;
    // the terminal's picked one stays lit, as it draws a dim Button grey whatever its variant (a pick made then showed
    // nowhere in a real terminal)
    const desk = await E.pane('settings', 'desktop')
    const term = await E.pane('settings', 'terminal')
    const pictures = (w, mark) => w.filter(n => n.type === 'Svg' && n.props.source.includes(mark))
    const switches = pictures(desk, 'class="sw"')
    const blue = switches.filter(n => n.props.source.includes('#2C84DB')).map(n => n.props.alt)
    const isThemed = [...switches, ...pictures(desk, 'class="tr"')].every(n => n.props.source.includes('prefers-color-scheme:light'))
    // plain and blank, their hover plate cleared: the desktop draws a Button's label, never its children
    const isPlainOver = [...['twinkle', 'speed', 'autoclose', 'sounds'], 'stay-10', 'stay-30', 'stay-60'].every(k => {
      const b = desk.find(n => n.type === 'Button' && n.props.key === k)
      return b?.props.plain === true && b.props.hover?.backgroundColor === '#0000' && (b.children ?? []).length === 0
    })
    const cells = pictures(desk, 'class="tr"')
    const raised = cells.filter(n => n.props.source.includes('class="th"')).map(n => n.props.alt)
    // the terminal's switch has no label, which it would draw in place of the glyph
    const glyph = k => {
      const b = term.find(n => n.type === 'Button' && n.props.key === k)
      const t = b?.children.find(c => c?.type === 'Text')
      return `${b?.props.label === undefined ? '' : 'labelled '}${t?.children.join('')}${t?.props.color ?? ''}`
    }
    const glyphs = ['twinkle', 'autoclose'].map(glyph).join()
    const stayButtons = w => w.filter(n => n.type === 'Button' && String(n.props.key).startsWith('stay-'))
    const isDimOff = stayButtons(desk).every(n => n.props.dimColor) && stayButtons(term).every(n => !!n.props.dimColor === (n.props.variant !== 'primary'))
    const termPicked = stayButtons(term).filter(n => n.props.variant === 'primary').map(n => n.props.label).join()
    await E.press(desk, 'autoclose')
    const lit = stayButtons(await E.pane('settings', 'desktop')).filter(n => !n.props.dimColor).map(n => unpadded(n.props.label)).join()
    const termLit = stayButtons(await E.pane('settings', 'terminal')).filter(n => !n.props.dimColor).length
    return [
      `blue switches ${blue.join()}; themed ${isThemed}; plain Buttons over them ${isPlainOver}; seconds cells ${cells.length}, raised ${raised.join()}; terminal ${glyphs}, picked ${termPicked}; dim while off ${isDimOff}; lit once on: desktop ${lit}, terminal ${termLit}`,
      blue.join() === 'Effects: On,Speed: On,Sounds: On,Check for updates: On' && switches.length === 5 && isThemed && isPlainOver && cells.length === 3 && raised.join() === 'Stays for: 30 s' && glyphs === '━━●suggestion,●━━' && termPicked === '30 s' && isDimOff && lit === '30 s' && termLit === 3,
    ]
  },
  async settings_window_gives_its_lines_a_row_on_a_narrow_terminal() {
    // the dock beside a 110-column transcript is 39 columns: a title, its line and [ 10 s ][ 30 s ][ 60 s ] on one row
    // cut the titles to "Auto-cl…" and "St…" in a real terminal. There the line takes a row of its own under the title;
    // a wide pane keeps one row each, and the desktop its own layout
    const layout = async (surface, cols) => {
      globalThis.PANE_COLS = cols
      try {
        const w = await (await boot(file)).pane('settings', surface)
        return ['twinkle', 'stays'].map(k => w.find(n => n.type === 'Box' && n.props.key === `row-${k}`)?.props.flexDirection).join('/')
      } finally {
        delete globalThis.PANE_COLS
      }
    }
    const narrow = await layout('terminal', 39)
    const wide = await layout('terminal', 118)
    const desk = await layout('desktop', 39)
    return [`terminal at 39 columns ${narrow}, at 118 ${wide}; desktop at 39 ${desk}`, narrow === 'column/column' && wide === 'row/row' && desk === 'row/row']
  },
  async on_is_never_declared_again(E) {
    // the engine refuses a module that declares `on` anywhere but as register's parameter ("on is declared again
    // (shadowed)"): a dev mod's reload fails and the old code stays on. A toggle's (on: boolean) did that once. Read from
    // the syntax tree when TypeScript is at hand (TYPESCRIPT, as compile.cjs takes it), else from a pattern
    void E
    const src = readFileSync(process.env.SOURCE ?? new URL('../hooks/register.tsx', import.meta.url), 'utf8')
    let ts = null
    try {
      ts = createRequire(import.meta.url)(process.env.TYPESCRIPT || 'typescript')
    } catch {}
    let lines = []
    if (ts) {
      const sf = ts.createSourceFile('register.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const isBinding = p => ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)
      const visit = n => {
        if (ts.isIdentifier(n) && n.text === 'on' && n.parent?.name === n && isBinding(n.parent)) lines.push(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)
        ts.forEachChild(n, visit)
      }
      visit(sf)
    } else {
      lines = [...src.matchAll(/[(,{[]\s*on\s*[:,)=}\]]|:\s*on\s*[,}]|\b(?:const|let|var|function|class)\s+on\b|(?<![\w.$])on\s*=>/g)].map(m => src.slice(0, m.index).split('\n').length)
    }
    return [`on declared on line ${lines.join(', ') || 'none'} (${ts ? 'syntax tree' : 'pattern'})`, lines.length === 1]
  },
  async failed_or_waiting_bar_stays(E) {
    await create(E, 'x')
    await create(E, 'y')
    await E.call({ id: 'x', state: 'error', note: 'broke' })
    await E.call({ id: 'y', state: 'needs_input', note: 'which one?' })
    for (let i = 0; i < 60; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    return [`after 60s: error ${!!E.bar('x')}, needs input ${!!E.bar('y')}`, !!E.bar('x') && !!E.bar('y')]
  },
  async finished_bar_waits_for_its_agents(E) {
    // with auto-close on, a finished bar still waits for its agents
    await E.command('plan-progress-autoclose')
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    await E.call({ id: 't', state: 'done' })
    for (let i = 0; i < 40; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    const whileRunning = !!E.bar('t')
    await E.turnComplete('ag1')
    for (let i = 0; i < 31; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    return [`kept while its agent runs ${whileRunning}, gone after ${!E.bar('t')}`, whileRunning && !E.bar('t')]
  },
  async desktop_never_reads_the_appearance(E) {
    return withMachine({ TERM_PROGRAM: 'Apple_Terminal' }, async () => {
      await create(E)
      const pics = (await E.svgs()).length
      for (let i = 0; i < 20; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      return [`commands run ${E.procs.length}, pictures ${pics}`, E.procs.length === 0 && pics > 0]
    })
  },
  async appearance_read_at_most_every_five_seconds(E) {
    return withMachine({}, async () => {
      await E.setTheme('auto')
      await create(E)
      await E.terminal(120)
      for (let i = 0; i < 30; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      const reads = E.procs.filter(c => c.startsWith('defaults')).length
      return [`appearance read ${reads}x in 30 s`, reads >= 5 && reads <= 7]
    })
  },
  async theme_picked_in_config_applies_at_once(E) {
    return withMachine({ TERM_PROGRAM: 'iTerm.app' }, async () => {
      await create(E)
      await E.terminal(120)
      E.tick(1000)
      await E.everyTick()
      const dark = await trackTint(E)
      await E.setTheme('light')
      const light = await trackTint(E)
      return [`track ${dark.toString(16)} → ${light.toString(16)}`, lum(dark) < LUM_MID && lum(light) > LUM_MID]
    })
  },
  async terminal_buttons_only_where_clicks_land(E) {
    await create(E)
    const band = async fs => (await E.terminal(120, fs)).filter(n => n.type === 'Button').length
    const foot = async fs => (await E.footer('terminal', fs)).filter(n => n.type === 'Button').length
    const desk = (await E.footer('desktop', undefined)).filter(n => n.type === 'Button').length
    const r = [await band(false), await band(true), await foot(false), await foot(true), desk]
    // the footer's one button is the settings ⚙, drawn where a click reaches it
    return [`band ${r[0]}/${r[1]}, footer ${r[2]}/${r[3]}, desktop ${r[4]}`, r.join() === '0,1,0,1,1']
  },
  async footer_reads_tokens_per_second(E) {
    // the footer is no button but a reading: a gauge and the main conversation's tokens per second. While a response
    // streams the figure is live; at its stop it is the API's output_tokens over the time from the first piece
    const label = async surface => {
      const nodes = await E.footer(surface, true)
      const text = nodes.filter(n => n.type === 'Text').flatMap(n => n.children).join('')
      const dim = nodes.find(n => n.type === 'Text')?.props?.dimColor
      return { text, dim }
    }
    const before = await label('desktop')
    // 36 characters every 50 ms is about 200 tokens a second at 3.6 characters a token
    const piece = { kind: 'text', index: 0, text: 'x'.repeat(36) }
    const pieces = [[{ kind: 'engine', ref: 1 }, 0], ...Array.from({ length: 30 }, (_, i) => [piece, i === 0 ? 0 : 50])]
    let live = null
    // a read that throws fails the case instead of the whole run, and the timer stops even when the stream throws
    let lost
    const watch = setInterval(() => label('desktop').then(l => {
      if (!l.dim && live === null) live = l.text
    }, err => (lost ??= err)), 120)
    const started = performance.now()
    let passed
    try {
      passed = await E.stream(pieces, { outputTokens: 300 })
    } finally {
      clearInterval(watch)
    }
    if (lost) throw lost
    const took = (performance.now() - started) / 1000
    const after = await label('desktop')
    const terminal = await label('terminal')
    const rate = Number(after.text.replace(/[^\d.]/g, ''))
    // an agent's stream on another model leaves the figure alone
    await E.stream([[piece, 0], [piece, 600]], { agentId: 'ag1', outputTokens: 999 })
    const untouched = (await label('desktop')).text === after.text
    const liveRate = Number(String(live).replace(/[^\d.]/g, ''))
    const ok =
      before.text.startsWith('⚡') && before.text.includes('– tok/s') && before.dim && passed.length === 32 &&
      live !== null && liveRate > 120 && liveRate < 300 &&
      after.dim && rate >= 300 / took - 1 && rate < 300 / (took - 0.2) && terminal.text === after.text && untouched
    return [`before "${before.text}"; live "${live}"; after "${after.text}" (≈${Math.round(300 / took)} over the whole stream); terminal "${terminal.text}"; agent leaves it ${untouched}`, ok]
  },
  async hidden_thinking_counts_from_the_response_start(E) {
    // thinking arrives as empty pieces while its tokens are generated: the clock starts at the response's first piece,
    // and no live figure is shown while the model thinks out of sight
    const label = async () => {
      const t = (await E.footer('desktop', true)).find(n => n.type === 'Text')
      return { text: t.children.join(''), dim: t.props.dimColor }
    }
    const think = { kind: 'thinking', index: 0, text: '' }
    const pieces = [[{ kind: 'engine', ref: 1 }, 0], [think, 0], [think, 300], [think, 300], [think, 300], [{ kind: 'tool', index: 1, id: 'x', name: 'Read' }, 300], [{ kind: 'input', index: 1, json: '{"a":1}' }, 50]]
    let isBrightWhileThinking = false
    let lost
    const watch = setInterval(() => label().then(l => {
      if (!l.dim) isBrightWhileThinking = true
    }, err => (lost ??= err)), 100)
    const started = performance.now()
    try {
      await E.stream(pieces, { outputTokens: 120 })
    } finally {
      clearInterval(watch)
    }
    if (lost) throw lost
    const took = (performance.now() - started) / 1000
    const rate = Number((await label()).text.replace(/[^\d.]/g, ''))
    // counted from the first visible piece it would read 120 / 0.05 s
    const ok = !isBrightWhileThinking && rate >= 120 / took - 1 && rate < 120 / (took - 0.2)
    return [`${rate} tok/s over ${took.toFixed(2)} s (≈${Math.round(120 / took)}); bright while thinking ${isBrightWhileThinking}`, ok]
  },
  async speed_is_an_average_over_time(E) {
    // the figure is all the tokens over all the time of the recent responses, not a mean of their speeds: 200 tokens in
    // 1 s and 200 in 2 s read 400 / 3 s ≈ 133, not (200 + 100) / 2 = 150. Another model starts it over
    const text = async () => (await E.footer('desktop', true)).find(n => n.type === 'Text').children.join('')
    const rate = s => Number(s.replace(/[^\d.]/g, ''))
    const response = ms => [[{ kind: 'engine', ref: 1 }, 0], [{ kind: 'text', index: 0, text: 'x'.repeat(40) }, ms]]
    const t0 = performance.now()
    await E.stream(response(1000), { outputTokens: 200 })
    const a = (performance.now() - t0) / 1000
    const t1 = performance.now()
    await E.stream(response(2000), { outputTokens: 200 })
    const b = (performance.now() - t1) / 1000
    const both = rate(await text())
    const expected = 400 / (a + b)
    await E.stream(response(1000), { outputTokens: 50, model: 'claude-haiku-5-5' })
    const other = rate(await text())
    const ok = Math.abs(both - expected) <= 2 && both < 145 && other <= 50 && other > 40
    return [`two responses ${both} (time-weighted ${expected.toFixed(1)}, mean of speeds would be ${((200 / a + 200 / b) / 2).toFixed(1)}); another model ${other}`, ok]
  },
  async pill_glide_is_not_replayed(E) {
    // the desktop rebuilds the bar's picture when something near it redraws; a glide kept in it would play again and
    // the pill would jump back and slide forward each time, so once the glide has run the bar is drawn standing
    await create(E)
    await E.view('t')
    await E.call({ id: 't', next: true })
    const first = (await E.view('t')).track
    const gliding = first.includes('<animateTransform') && first.includes('begin="-0.000s"')
    E.tick(120)
    // drawn again mid-glide, it starts 0.12 s into its run, not from the old place
    const mid = (await E.view('t')).track
    const resumes = mid.includes('<animateTransform') && (mid.match(/begin="-0\.120s"/g) ?? []).length === 2
    E.tick(1000)
    const after = await E.view('t')
    const standing = !after.track.includes('<animateTransform')
    return [`glide drawn ${gliding}, drawn again mid-glide resumes at 0.12 s ${resumes}, drawn standing after ${standing}`, gliding && resumes && standing]
  },
  async finished_bar_is_drawn_standing_after_its_glide(E) {
    // a bar that jumps to done glides to the end; with nothing else to redraw it, the desktop would keep that picture
    // and replay the glide from the old place on a rebuild, so it is drawn once more, standing, after the glide
    await create(E)
    await E.view('t')
    const tickBefore = E.$.__get({ ref: { key: 'tick' }, initial: 0 })
    await E.call({ id: 't', state: 'done' })
    const gliding = (await E.view('t')).track.includes('<animateTransform')
    E.tick(700)
    await E.fireTimers()
    const redrawn = E.$.__get({ ref: { key: 'tick' }, initial: 0 }) > tickBefore
    const standing = !(await E.view('t')).track.includes('<animateTransform')
    return [`glide to done ${gliding}, redrawn after it ${redrawn}, standing ${standing}`, gliding && redrawn && standing]
  },
  async desktop_still_draws_svg(E) {
    await create(E)
    const svgs = await E.svgs()
    const term = await E.terminal(120)
    return [`${svgs.length} svg, ${term.filter(n => n.type === 'Svg').length} svg in terminal`, svgs.length > 0 && !term.some(n => n.type === 'Svg')]
  },
  async live_clock_has_an_hours_face(E) {
    // past 99m the minutes-and-seconds face wrapped to 0m; from an hour on the clock reads "1h 05m"
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    const src = (await E.view('t')).strips.join('')
    const ok = /class="ph1"/.test(src) && /class="ph2"/.test(src) && />h<\/text>/.test(src) && /\.ph2\{animation:hm 3600s/.test(src)
    return [`minutes face ${/class="ph1"/.test(src)}, hours face ${/class="ph2"/.test(src)}`, ok]
  },
  async clock_last_letter_fits_its_window(E) {
    // the hours face ended in a wide "m" past its window's right side: "1h 21m" lost the m's last stem, on the pill
    // and on an agent's strip. Every unit letter needs its own width (wide in SF Pro) inside the window
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    E.tick(81 * 60_000)
    const v = await E.view('t')
    const need = { m: 11, s: 7, h: 7 }
    // and the space after "h" in "1h 21m" is the one after "m" in "12m 05s" (letters as wide as the mod's own table)
    const wide = { m: 9.6, h: 6.3 }
    const seen = []
    for (const [where, src] of [['pill', v.clock], ['strip', v.strips.join('')]]) {
      for (const [, id, x, w] of src.matchAll(/<clipPath id="(ck[^"]+)"><rect x="(-?[\d.]+)" y="[\d.]+" width="([\d.]+)"/g)) {
        const right = Number(x) + Number(w)
        const clock = src.slice(src.indexOf(`<clipPath id="${id}"`)).split('<clipPath id="ck')[1] ?? ''
        const unitAt = [...clock.matchAll(/<text x="(-?[\d.]+)" y="[\d.]+" class="[^"]*">([msh])<\/text>/g)].map(([, ux, u]) => [u, Number(ux)])
        const units = unitAt.map(([u, ux]) => [u, right - ux])
        const reel = cls => Number(clock.match(new RegExp(`<g class="${cls}"><text[^>]*><tspan x="(-?[\\d.]+)"`))?.[1])
        const after = (u, cls) => reel(cls) - ((unitAt.find(([l]) => l === u)?.[1] ?? NaN) + wide[u])
        seen.push([where, units, after('m', 'rs10'), after('h', 'rm6')])
      }
    }
    const ok = seen.length === 2 && seen.every(([, units, m, h]) => units.length === 4 && units.every(([u, room]) => room >= need[u]) && Math.abs(m - h) <= 1)
    return [seen.map(([where, units, m, h]) => `${where}: ${units.map(([u, room]) => `${u} ${room.toFixed(1)}px`).join(', ')}, space after m ${m.toFixed(1)} / after h ${h.toFixed(1)}`).join('; '), ok]
  },
  async resend_keeps_a_repeated_title_open(E) {
    await E.call({ id: 't', title: 'Task', stages: [S('One', 'Test', 'B'), S('Two', 'Test', 'C')] })
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', stages: [S('One', 'Test', 'B'), S('Two', 'Test', 'C')] })
    return [E.steps('t'), E.steps('t') === 'Test:done B:active Test:pending C:pending']
  },
  async full_list_keeps_the_new_bar(E) {
    for (const id of ['a', 'b', 'c']) await create(E, id, three(), id)
    await E.call({ id: 'd', title: 'd', stages: [S('One', st('A', 'done'), st('B', 'done'))] })
    const ids = E.plans().map(p => p.id).join(',')
    return [ids, ids === 'b,c,d']
  },
  async agents_bar_spares_bars_waiting_on_the_person(E) {
    for (const id of ['a', 'b', 'c']) {
      await create(E, id, three(), id)
      await E.call({ id, state: 'needs_input', note: 'which one?' })
    }
    await E.spawn('x', 'Look around')
    const ids = E.plans().map(p => `${p.id}:${p.state}`).join(',')
    return [ids, ids === 'a:needs_input,b:needs_input,c:needs_input']
  },
  async store_cleanup_keeps_the_current_session(E) {
    const kept = new Map([['plans:session-1', '[]'], ...Array.from({ length: 20 }, (_, i) => [`plans:old${i}`, '[]'])])
    const F = await boot(file, kept)
    await create(F)
    await F.everyTick()
    const sessions = [...kept.keys()].filter(k => k.startsWith('plans:')).length
    return [`current kept ${kept.has('plans:session-1')}, ${sessions} sessions`, kept.has('plans:session-1') && sessions === 20]
  },
  async reopened_step_forgets_its_finish_time(E) {
    await create(E)
    E.tick(5000)
    await E.call({ id: 't', next: true })
    E.tick(5000)
    await E.call({ id: 't', active: 'A' })
    const a = E.bar('t').stages[0].steps[0]
    return [`${a.title} ${a.status} doneAt ${a.doneAt}`, a.status === 'active' && a.doneAt === undefined]
  },
  async unfinished_bar_never_reads_100(E) {
    const steps = Array.from({ length: 200 }, (_, i) => st(`S${i}`, i < 199 ? 'done' : 'active'))
    await E.call({ id: 't', title: 'Big', stages: [S('N', ...steps)] })
    const p = await pct(E, 't')
    return [`${p}, ${E.bar('t').state}`, p === '99%']
  },
  async resize_does_not_glide(E) {
    await E.call({ id: 't', title: 'R', stages: [S('One', 'A', 'B', 'C', 'D')] })
    await E.call({ id: 't', next: true })
    await E.call({ id: 't', next: true })
    const fill = async () => (await E.svgs()).map(p => p.source).find(x => x.includes('clip-path="url(#fill)"')) ?? ''
    globalThis.COLS = 120
    await fill()
    globalThis.COLS = 60
    const after = await fill()
    delete globalThis.COLS
    const glides = /<animate attributeName="width"/.test(after)
    return [`glide after resize ${glides}`, after !== '' && !glides]
  },
  async cut_title_keeps_whole_characters(E) {
    await E.call({ id: 't', title: 'a'.repeat(79) + '😀 tail', stages: [S('One', 'A')] })
    const title = E.bar('t').title
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)
    return [`length ${title.length}, lone surrogate ${lone}`, !lone]
  },
  async wide_title_keeps_its_columns(E) {
    // the title is plain Text, where CJK and an emoji with its variation selector take two columns each: the box
    // must leave room for them (the widths Bun.stringWidth gives, as the engine measures Text)
    const widths = []
    const titles = [
      ['設定の確認', 10],
      ['⚠️ Fix login', 12],
      ['1️⃣ Setup', 8],
      ['👨‍💻 Dev setup', 12],
      ['🇷🇺 Russia', 9],
      ['éclair', 6],
      ['हिन्दी परीक्षण', 9],
      ['ทำงานต่อ', 7],
      ['প্রকল্প পরীক্ষা', 10],
      ['🈐 ok', 5],
    ]
    for (const [title, want] of titles) {
      const F = await boot(file)
      await F.call({ id: 't', title, stages: three() })
      const box = (await F.terminal(200)).find(n => n.type === 'Box' && n.props.width !== undefined)
      widths.push([title, box?.props.width, want])
    }
    const wrong = widths.filter(([, got, want]) => got !== want)
    return [wrong.length ? wrong.map(([t, g, w]) => `${t} ${g}≠${w}`).join(', ') : 'every title box as wide as its text', wrong.length === 0]
  },
  async raster_cells_take_only_one_column_characters(E) {
    // the engine refuses a Raster tree holding any cell that is not one printable column, and every bar vanishes
    await E.turnStart()
    await E.call({ id: 't', title: 'Task', stages: [S('✅ Tests', st('A', 'active'), 'B'), S('⚠️ Risks', 'C'), S('Re\u00adview e\u0301clair ส่งงาน', 'D')] })
    await E.spawn('ag1', 'Проверка ✅ тестов\u200b ' + 'x'.repeat(50) + '😀😀')
    const BAD = new Set([0x2705, 0xfe0f, 0xad, 0x301, 0xe48, 0x200b])
    const bad = []
    let tracks = 0
    // the pill names only the stage at work, so each stage is made the active one in turn
    for (const move of [null, { done: ['A', 'B'] }, { done: ['C'] }]) {
      if (move) await E.call({ id: 't', ...move })
      for (const r of (await E.terminal(120)).filter(n => n.type === 'Raster')) {
        if (r.props.key === 'track-t') tracks++
        const w = new Uint32Array(Uint8Array.from(Buffer.from(r.props.cells, 'base64')).buffer)
        for (let i = 0; i < w.length; i += 3) {
          const cp = w[i]
          if (cp > 0xffff || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff) || BAD.has(cp)) bad.push(cp.toString(16))
        }
      }
    }
    return [bad.length ? `refused cells ${[...new Set(bad)].join(',')}` : `every cell one column in ${tracks} track frames`, bad.length === 0 && tracks === 3]
  },
  async letters_of_a_cluster_stay_in_the_pill(E) {
    // a cluster of letters keeps every letter that fills a cell (Thai SARA AM, a Hindi conjunct's consonants)
    const shown = []
    for (const [name, want] of [['ทำงาน', 'ทำงาน'], ['प्रगति', 'परगत']]) {
      const F = await boot(file)
      await F.call({ id: 't', title: 'Task', stages: [S(name, st('A', 'active'), 'B')] })
      const r = (await F.terminal(200)).find(n => n.type === 'Raster')
      const pill = glyphs(r.props.cells).replace(/[⠀-⣿│]/g, ' ').trim()
      shown.push([name, pill, pill.startsWith(want)])
    }
    return [shown.map(([n, p]) => `${n} → ${p.split(' ')[0]}`).join(', '), shown.every(x => x[2])]
  },
  async still_bars_redraw_the_same(E) {
    // a redraw (the end of a turn is one) must not rewrite a bar that stands still: done, or open after the turn
    await E.turnStart()
    await E.call({ id: 'a', title: 'API review', stages: [S('One', st('A', 'done'), st('B', 'done'))] })
    await E.call({ id: 'c', title: 'Docs', stages: three() })
    await E.turnComplete()
    const cells = async () => Object.fromEntries((await E.terminal(120)).filter(n => n.type === 'Raster').map(n => [n.props.key, n.props.cells]))
    const a = await cells()
    E.tick(700)
    const b = await cells()
    const changed = Object.keys(a).filter(k => a[k] !== b[k])
    return [changed.length ? `rewritten ${changed.join(', ')}` : `no cell rewritten of ${Object.keys(a).join(', ')}`, changed.length === 0 && 'track-a' in a && 'track-c' in a]
  },
  async bar_keeps_its_last_frame_once_it_stops(E) {
    // a running bar twinkled through the turn; once the turn ends, the redraw shows its last frame, unchanged later
    await E.turnStart()
    await E.call({ id: 't', title: 'Task', stages: [S('One', st('A', 'done'), st('B', 'done'), st('C', 'active'), 'D')] })
    await E.terminal(120)
    for (let i = 0; i < 12; i++) {
      E.tick(33)
      await E.frameTick()
    }
    const last = E.blits.filter(b => b.key === 'track-t').at(-1)?.cells
    E.tick(20)
    await E.turnComplete()
    const cells = async () => (await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t').props.cells
    const atEnd = await cells()
    E.tick(1500)
    const later = await cells()
    return [`turn-end redraw = last frame ${atEnd === last}, 1.5 s later the same ${later === atEnd}`, !!last && atEnd === last && later === atEnd]
  },
  async glide_lands_when_the_turn_ends(E) {
    // the last step finished just before the turn ended: its glide lands at the end of the turn instead of sending
    // frames through the engine's end-of-turn redraw
    await E.turnStart()
    await create(E)
    await E.terminal(120)
    await E.call({ id: 't', done: ['A', 'B', 'C'] })
    await E.terminal(120)
    E.tick(100)
    await E.turnComplete()
    await E.terminal(120)
    await E.everyTick()
    return [`state ${E.bar('t').state}, frame clock ${E.frameTimers()}`, E.bar('t').state === 'done' && E.frameTimers() === 0]
  },
  async redraw_starts_frames_for_its_glide(E) {
    // a bar standing still (in error) is finished: the redraw starts the glide, and the frames must carry it
    await E.turnStart()
    await E.call({ id: 't', title: 'Task', stages: [S('Build', st('A', 'active'), 'B', 'C', 'D')] })
    await E.call({ id: 't', failed: 'A', note: 'tests failed' })
    await E.terminal(120)
    E.tick(1000)
    await E.everyTick()
    await E.call({ id: 't', done: ['A', 'B', 'C', 'D'] })
    await E.terminal(120)
    const from = E.blits.length
    for (let i = 0; i < 20; i++) {
      E.tick(33)
      await E.frameTick()
    }
    const last = E.blits.slice(from).filter(b => b.key === 'track-t').at(-1)
    const filled = last ? [...glyphs(last.cells)].filter(c => c >= '\u2800' && c <= '\u28ff').length : 0
    return [`${E.blits.length - from} blits, last frame ${filled} braille cells`, filled > 60]
  },
  async refused_blits_stop_the_frames(E) {
    await E.turnStart()
    await create(E)
    await E.terminal(120)
    const before = E.frameTimers()
    globalThis.BLIT_DENY = 'no Raster of its own is mounted'
    let once
    try {
      // one refused frame is let pass (sent between a redraw and its commit); six in a row stop the frames
      E.tick(33)
      await E.frameTick()
      once = E.frameTimers()
      for (let i = 0; i < 5; i++) {
        E.tick(33)
        await E.frameTick()
      }
    } finally {
      delete globalThis.BLIT_DENY
    }
    const after = E.frameTimers()
    await E.terminal(120)
    const again = E.frameTimers()
    const sized = E.blits.every(b => b.columns > 0 && b.rows > 0)
    return [`frames ${before} → one deny → ${once} → six → ${after} → redraw → ${again}, sizes named ${sized}`, before === 1 && once === 1 && after === 0 && again === 1 && sized]
  },
  async refused_frames_try_again_without_a_redraw(E) {
    // the band folded away and shown again comes back without a redraw: the frames must not stay stopped for good
    // (a step is done, so the fill has cells that move; frames send only cells that changed)
    await E.turnStart()
    await create(E)
    await E.call({ id: 't', next: true })
    await E.terminal(120)
    globalThis.BLIT_DENY = 'no Raster of its own is mounted'
    let refused
    try {
      for (let i = 0; i < 6; i++) {
        E.tick(33)
        await E.frameTick()
      }
      refused = E.frameTimers()
      E.tick(1000)
      await E.everyTick()
    } finally {
      delete globalThis.BLIT_DENY
    }
    E.tick(1000)
    await E.everyTick()
    const from = E.blits.length
    for (let i = 0; i < 5; i++) {
      E.tick(33)
      await E.frameTick()
    }
    const sent = E.blits.length - from
    return [`frames after deny ${refused}, then ${sent} blits with no redraw`, refused === 0 && sent >= 3]
  },
  async move_after_the_turn_lands_at_once(E) {
    // a bar moved after the turn ended (no agents at work) is drawn in place: no glide, no frames
    await E.turnStart()
    await create(E)
    await E.terminal(120)
    await E.everyTick()
    const during = E.frameTimers()
    await E.turnComplete()
    await E.terminal(120)
    await E.everyTick()
    await E.call({ id: 't', done: ['A', 'B'] })
    await E.terminal(120)
    await E.everyTick()
    return [`frame clock during the turn ${during}, after the move ${E.frameTimers()}`, during === 1 && E.frameTimers() === 0]
  },
  async stale_frame_after_a_redraw_is_dropped(E) {
    // a frame that read the clock before a redraw laid the band out at another width sends nothing
    await E.turnStart()
    await create(E)
    await E.terminal(120)
    // the frames run (0.7.6 started them only on the 1 s tick), and the frame that tick sent has finished
    await E.everyTick()
    await new Promise(r => setTimeout(r, 0))
    const now = E.$.clock.now
    let release
    let isHeld = true
    E.$.clock.now = async () => {
      const t = await now()
      if (isHeld) {
        isHeld = false
        await new Promise(r => (release = r))
      }
      return t
    }
    E.tick(33)
    await E.frameTick()
    // only the frame's clock read is held; the redraw below must not wait on it
    const isFrameHeld = !isHeld
    isHeld = false
    const width = (await E.terminal(80)).find(n => n.type === 'Raster').props.columns
    const from = E.blits.length
    release?.()
    await new Promise(r => setTimeout(r, 10))
    E.$.clock.now = now
    const stale = E.blits.slice(from).filter(b => b.columns !== width).length
    return [`frame held over the redraw ${isFrameHeld}, stale blits ${stale}`, isFrameHeld && stale === 0]
  },
  async agent_title_cut_keeps_whole_characters(E) {
    await E.spawn('ag1', 'x'.repeat(59) + '😀 and more')
    const t = E.bar('agents:auto').agents[0].title
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t)
    return [`title length ${t.length}, lone surrogate ${lone}`, !lone]
  },
  async child_sits_under_its_parent_only_where_the_parent_is(E) {
    // the parent's Agents bar was pushed out; its children land on a new Agents bar side by side, not one under another
    await E.turnStart()
    await E.spawn('P', 'Parent agent')
    for (const id of ['a', 'b', 'c']) await create(E, id, three(), id)
    await E.spawn('C1', 'First child', 'P')
    await E.spawn('C2', 'Second child', 'P')
    const depths = (E.bar('agents:auto')?.agents ?? []).map(a => `${a.id}:${a.depth}`).join(' ')
    return [depths || 'no agents bar', depths === 'C1:0 C2:0']
  },
  async fold_button_folds_a_bars_agent_strips(E) {
    // issue #11: the chevron before ✕ folds the strips away and keeps the bar; ▸ shows them again
    await E.turnStart()
    // agents land on the newest open bar, so the bar that gets them is made last
    await create(E, 'u', three(), 'Docs')
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    await E.spawn('ag2', 'Read cart store')
    const desktop = async () => {
      const nodes = walkAll(await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } }))
      const chip = nodes.find(n => n.props?.key === 'foldchip-t')
      const icon = walkAll(chip?.children ?? []).find(n => n.type === 'Svg')?.props.source ?? ''
      return { fold: nodes.find(n => n.props?.key === 'fold-t'), arrow: icon.includes('m6 9 6 6 6-6') ? 'down' : icon.includes('m18 15-6-6-6 6') ? 'up' : 'none', foldU: nodes.find(n => n.props?.key === 'fold-u'), strips: nodes.filter(n => String(n.props?.key ?? '').startsWith('strip-t-')).length }
    }
    const a = await desktop()
    await a.fold.props.onPress()
    const b = await desktop()
    await b.fold.props.onPress()
    const c = await desktop()
    const ok = a.strips === 2 && a.arrow === 'up' && !a.foldU && b.strips === 0 && b.arrow === 'down' && !!E.bar('t') && c.strips === 2
    return [`strips ${a.strips} → fold → ${b.strips} (arrow ${a.arrow} → ${b.arrow}) → unfold → ${c.strips}; bar without agents has a button ${!!a.foldU}`, ok]
  },
  async folded_bar_in_the_terminal(E) {
    // fullscreen: the button and every row keeping its cell; outside fullscreen no button; folded: no strips and no
    // strip blits, so the frames never hit a Raster that is gone
    await E.turnStart()
    // agents land on the newest open bar, so the bar that gets them is made last
    await create(E, 'u', three(), 'Docs')
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    const full = await E.terminal(120, true)
    const cells = full.filter(n => n.type === 'Box' && n.props.width === 1).length
    const button = full.find(n => n.props?.key === 'fold-t')
    const plain = (await E.terminal(120)).some(n => n.props?.key === 'fold-t')
    await button.props.onPress()
    const folded = await E.terminal(120)
    const from = E.blits.length
    for (let i = 0; i < 5; i++) {
      E.tick(33)
      await E.frameTick()
    }
    const stripBlits = E.blits.slice(from).filter(b => b.key.startsWith('strips-')).length
    const hasStrips = folded.some(n => n.type === 'Raster' && n.props.key === 'strips-t')
    const ok = cells === 2 && !!button && !plain && !hasStrips && stripBlits === 0 && E.blits.length > from
    return [`fold cells ${cells}, button ${!!button}, outside fullscreen ${plain}; folded: strips ${hasStrips}, strip blits ${stripBlits}`, ok]
  },
  async progress_agents_folds_every_bar(E) {
    const none = await E.command('progress-agents')
    await E.turnStart()
    // agents land on the newest open bar: v gets none, u and t one each
    await create(E, 'v', three(), 'Notes')
    await create(E, 'u', three(), 'Docs')
    await E.spawn('a1', 'Scan routes')
    await create(E)
    await E.spawn('a2', 'Read cart store')
    const a = await E.command('progress-agents')
    const folded = E.plans().filter(p => p.isFolded).map(p => p.id).join(',')
    // an agent started on a folded bar keeps it folded
    await E.spawn('a3', 'Third')
    const still = E.bar('t').isFolded === true
    const b = await E.command('progress-agents')
    const shown = E.plans().every(p => !p.isFolded)
    const ok = /No agent strips/.test(none.text) && /folded/.test(a.text) && folded === 'u,t' && still && /shown/.test(b.text) && shown
    return [`${none.text} | ${a.text} [${folded}] | still folded ${still} | ${b.text}`, ok]
  },
  async fold_lasts_through_bar_updates(E) {
    // Claude moves a bar after every step: the fold must not come undone with it
    await E.turnStart()
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    await E.command('progress-agents')
    for (const op of [{ next: true }, { done: ['B'] }, { note: 'checking' }, { stages: three() }]) await E.call({ id: 't', ...op })
    const nodes = walkAll(await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } }))
    const strips = nodes.filter(n => String(n.props?.key ?? '').startsWith('strip-t-')).length
    return [`folded ${E.bar('t').isFolded}, strips ${strips}`, E.bar('t').isFolded === true && strips === 0]
  },
  async fold_keeps_the_rows_lined_up(E) {
    // every row keeps the fold cell, and the tracks give it its room, on the desktop and in the fullscreen terminal
    await E.turnStart()
    await create(E, 'u', three(), 'Docs')
    const plainDesktop = walkAll(await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } }))
    const plainTrack = plainDesktop.find(n => n.type === 'Svg' && /^Docs:/.test(n.props.alt)).props.width
    const plainColumns = (await E.terminal(120, true)).find(n => n.props?.key === 'track-u').props.columns
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    const desktop = walkAll(await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } }))
    const cells = desktop.filter(n => n.type === 'Box' && n.props.width === 5 && !n.props.key).length
    const track = desktop.find(n => n.type === 'Svg' && /^Docs:/.test(n.props.alt)).props.width
    const terminal = await E.terminal(120, true)
    const columns = terminal.find(n => n.props?.key === 'track-u').props.columns
    const ok = cells === 2 && track === plainTrack - 40 && columns === plainColumns - 2
    return [`desktop cells ${cells}, track ${plainTrack} → ${track}; terminal track ${plainColumns} → ${columns}`, ok]
  },
  async folded_agents_stay_out_of_the_pill(E) {
    // folded means folded: the pill keeps its stage and step and does not count the agents, here or in the terminal
    await E.turnStart()
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    await E.spawn('ag2', 'Read cart store')
    await E.command('progress-agents')
    const track = (await E.svgs()).find(s => /^Task:/.test(s.alt)).source
    const row = glyphs((await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t').props.cells).trim()
    const counted = /running|\d done/.test(track) || /·/.test(row)
    return [`desktop counts ${/running|\d done/.test(track)}; terminal ${row}`, !counted && row.includes('One')]
  },
  async strip_dots_stay_inside_and_sit_close(E) {
    // the running strip's dots stay inside its rounded ends, and with one-digit numbers the strip starts close to them
    await E.turnStart()
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    const src = (await E.view('t')).strips[0]
    const strip = src.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="16" rx="8" fill="#/)
    const [x0, y0, w] = strip.slice(1, 4).map(Number)
    const inside = (x, y) => Math.hypot(x - Math.max(x0 + 8, Math.min(x0 + w - 8, x)), y - (y0 + 8)) <= 8
    let dots = 0
    let out = 0
    for (const d of src.matchAll(/class="t\d" fill="[^"]+" fill-opacity="\.32" d="([^"]+)"/g))
      for (const m of d[1].matchAll(/M([\d.]+) ([\d.]+)/g)) {
        const [x, y] = [Number(m[1]), Number(m[2])]
        dots++
        if (![[x, y], [x + 2, y], [x, y + 2], [x + 2, y + 2]].every(([a, b]) => inside(a, b))) out++
      }
    return [`strip at x ${x0}, ${dots} dots, ${out} outside`, dots > 50 && out === 0 && x0 <= 30]
  },
  async fold_comes_back_after_a_restart(E) {
    // a restored bar keeps the choice but shows no button while it has no strips; its next agents arrive folded
    const kept = new Map()
    const A = await boot(file, kept)
    await A.turnStart()
    await create(A)
    await A.spawn('ag1', 'Scan routes')
    await A.command('progress-agents')
    A.tick(1000)
    await A.everyTick()
    const B = await boot(file, kept)
    const before = (await B.terminal(120, true)).some(n => n.props?.key === 'fold-t')
    await B.turnStart()
    await B.spawn('ag2', 'Next batch')
    const after = await B.terminal(120, true)
    const button = after.find(n => n.props?.key === 'fold-t')?.props.label
    const strips = after.some(n => n.props?.key === 'strips-t')
    const ok = B.bar('t')?.isFolded === true && !before && button === '▸' && !strips
    return [`restored folded ${B.bar('t')?.isFolded}, button before agents ${before}, then ${button}, strips ${strips}`, ok]
  },
  async restore_drops_the_agents_bar(E) {
    const kept = new Map()
    const A = await boot(file, kept)
    await A.turnStart()
    await A.spawn('ag1', 'Scan routes')
    await A.spawn('ag2', 'Read cart store')
    await A.turnComplete()
    A.tick(1000)
    await A.everyTick()
    const before = A.plans().map(p => p.id).join(',')
    const B = await boot(file, kept)
    const ids = B.plans().map(p => p.id).join(',')
    return [`before: ${before || 'nothing'}, restored: ${ids || 'nothing'}`, before.includes('agents:auto') && !ids.includes('agents:auto')]
  },
  async reload_keeps_following_running_agents(E) {
    await E.turnStart()
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    await E.reload()
    await E.agentTool('ag1', 'Read')
    await E.turnComplete('ag1')
    await E.turnComplete()
    E.tick(1000)
    await E.everyTick()
    const a = E.bar('t').agents[0]
    return [`agent ${a.state} ${a.tool}`, a.state === 'done']
  },
  async agent_heard_before_the_reload_rebuilt_its_map(E) {
    // the reloaded module's hooks are live before its session.start runs: a call and the finish that come first still
    // find the agent by its strip
    await E.turnStart()
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    const start = E.sessionStart
    E.sessionStart = async () => {
      await E.agentTool('ag1', 'Read')
      await E.turnComplete('ag1')
      return E.raw('session.start', {})
    }
    try {
      await E.reload()
    } finally {
      E.sessionStart = start
    }
    const a = E.bar('t').agents[0]
    return [`agent ${a.state} ${a.tool}`, a.state === 'done']
  },
  async spawn_after_its_bar_closed_finds_the_agents_bar(E) {
    await E.turnStart()
    await create(E)
    await E.spawn('P', 'Parent agent')
    const tree = await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 120, hasSurvey: false } })
    let press
    const walk = n => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      if (n.props?.key === 'close-t') press = n.props.onPress
      ;(n.children ?? []).forEach(walk)
    }
    walk(tree)
    await press()
    await E.spawn('C', 'Child agent', 'P')
    await E.turnComplete('C')
    E.tick(1000)
    await E.everyTick()
    const c = E.bar('agents:auto')?.agents.find(a => a.id === 'C')
    return [`child on ${c ? 'agents bar' : 'nothing'}: ${c?.state}, depth ${c?.depth}`, c?.state === 'done' && c.depth === 0]
  },
  async windows_sound_path_goes_through_env(E) {
    E.$.plugin.root = "C:/Users/O'Brien/.claude/plugins/cache/zycck-mods/plan-progress/0.7.7"
    await E.ask()
    await new Promise(r => setTimeout(r, 10))
    const at = E.procs.findIndex(p => p.startsWith('powershell'))
    const wav = E.procEnvs[at]?.PLAN_PROGRESS_WAV ?? ''
    const ok = at >= 0 && !E.procs[at].includes("O'Brien") && wav.includes("O'Brien") && wav.endsWith('decision.wav')
    return [`command quotes the path ${E.procs[at]?.includes("O'Brien")}, env ${wav.slice(-40)}`, ok]
  },
  async desktop_strip_text_reads_in_light_and_dark(E) {
    // issue #13: on the desktop a strip is a picture over a background the plugin is never told; every word on it
    // reads at WCAG AA in either scheme its media query picks, over the strip's own backing
    await create(E)
    for (const [id, title] of [['g1', 'Run the tests'], ['g2', 'Ask first'], ['g3', 'Break'], ['g4', 'Old one'], ['g5', 'Old two'], ['g6', 'Old three'], ['g7', 'Last one']]) await E.spawn(id, title)
    await E.step('g1', 'high')
    await E.agentTool('g1', 'Bash')
    await E.hold('g2')
    await E.turnComplete('g3', 'error')
    for (const id of ['g4', 'g5', 'g6', 'g7']) await E.turnComplete(id)
    const v = await E.view('t')
    const sheet = v.strips[0]?.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
    // the sheet as a browser applies it in each scheme: the rules outside any @media, then those under the scheme's query
    const blocks = []
    let flat = ''
    for (let i = 0; i < sheet.length; ) {
      const at = sheet.indexOf('@media', i)
      if (at < 0) {
        flat += sheet.slice(i)
        break
      }
      flat += sheet.slice(i, at)
      const open = sheet.indexOf('{', at)
      let depth = 1
      let end = open + 1
      for (; end < sheet.length && depth > 0; end++) depth += sheet[end] === '{' ? 1 : sheet[end] === '}' ? -1 : 0
      blocks.push({ query: sheet.slice(at + 6, open).trim(), body: sheet.slice(open + 1, end - 1) })
      i = end
    }
    const rules = css => Object.fromEntries([...css.matchAll(/\.([\w-]+)\{(?:fill|color):(#[0-9A-Fa-f]{6})\}/g)].map(m => [m[1], toRgb(m[2])]))
    const under = q => rules(blocks.filter(b => b.query === q).map(b => b.body).join(''))
    const schemes = { dark: { ...rules(flat), ...under('(prefers-color-scheme:dark)') }, light: { ...rules(flat), ...under('(prefers-color-scheme:light)') } }
    // the gutter sits on the app's own background, not on the strip's backing
    const PAGES = { dark: ['#1F1E1D', '#262624'], light: ['#FFFFFF', '#FAF9F5'] }
    const worst = {}
    const seen = new Set()
    const isDark = c => c !== undefined && luminance(c) < 0.05
    const isLight = c => c !== undefined && luminance(c) > 0.7
    if (!(isDark(schemes.dark.sb) && isLight(schemes.dark.sn))) seen.add('the dark scheme is not light text on a dark backing')
    if (!(isLight(schemes.light.sb) && isDark(schemes.light.sn))) seen.add('the light scheme is not dark text on a light backing')
    for (const [name, k] of Object.entries(schemes)) {
      let min = Infinity
      const check = (fg, bg, what) => {
        if (!fg || !bg) {
          seen.add(`${name} ${what} unpaired`)
          min = 0
          return
        }
        min = Math.min(min, contrast(fg, bg))
      }
      for (const src of v.strips) {
        const sb = src.indexOf('class="sb"')
        if (sb < 0) seen.add('no backing')
        else if ([src.search(/class="g[um]"/), src.search(/fill-opacity="\.1\d"/)].some(x => x >= 0 && x < sb)) seen.add('backing drawn over the gutter or the tint')
        if (/style="fill:/.test(src)) seen.add('inline fill')
        const tint = src.match(/fill="(#[0-9A-Fa-f]{6})" fill-opacity="(\.\d+)"/)
        const back = tint && k.sb ? over(k.sb, toRgb(tint[1]), Number(tint[2])) : null
        if (src.includes('class="sn"')) check(k.sn, back, 'name')
        if (/class="(?:sn )?st"/.test(src)) check(k.st, back, 'dim')
        for (const m of src.matchAll(/ w-(\w+)/g)) check(k[`w-${m[1]}`], back, `word ${m[1]}`)
        for (const page of PAGES[name]) {
          if (src.includes('class="gu"')) check(k.gu, toRgb(page), 'gutter')
          if (src.includes('class="gm"')) check(k.gm, toRgb(page), 'more gutter')
        }
      }
      worst[name] = min
    }
    const words = new Set([...v.strips.join('').matchAll(/class="sn w-(\w+)/g)].map(m => m[1]))
    const kc = v.track.match(/\.kc\{[^}]*\}/)?.[0] ?? ''
    const ok = worst.dark >= 4.5 && worst.light >= 4.5 && seen.size === 0 && words.has('running') && words.has('waiting') && v.strips.some(s => s.includes('class="gm"')) && !kc.includes('opacity')
    return [`worst dark ${worst.dark.toFixed(2)}, light ${worst.light.toFixed(2)}; words ${[...words]}; ${[...seen].join(', ') || 'backed, no inline fills'}; pill count ${kc}`, ok]
  },
  async terminal_strip_text_reads_in_light_and_dark() {
    // issue #13 in the terminal: the name, its model, the tool word, the time and the pill's count read at AA in either
    // theme, as the engine paints them (4-bit colour)
    const q = c => c.map(v => Math.round(v / 17) * 17)
    const parts = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
    const worst = {}
    for (const theme of ['light', 'dark']) {
      await withMachine({ MAC: false, THEME: theme }, async () => {
        const F = await boot(file)
        await create(F)
        for (const [id, title] of [['g1', 'Run the tests'], ['g2', 'Ask first'], ['g3', 'Break'], ['g4', 'Old one'], ['g5', 'Old two'], ['g6', 'Old three'], ['g7', 'Last one']]) await F.spawn(id, title)
        await F.step('g1', 'high')
        await F.agentTool('g1', 'Bash')
        await F.hold('g2')
        await F.turnComplete('g3', 'error')
        for (const id of ['g4', 'g5', 'g6', 'g7']) await F.turnComplete(id)
        const nodes = await F.terminal(120)
        let min = Infinity
        for (const key of ['strips-t', 'track-t']) {
          const r = nodes.find(n => n.type === 'Raster' && n.props.key === key)
          const w = new Uint32Array(Uint8Array.from(Buffer.from(r?.props.cells ?? '', 'base64')).buffer)
          if (w.length === 0) min = 0
          for (let i = 0; i < w.length; i += 3) {
            const ch = String.fromCodePoint(w[i])
            if (ch === ' ' || ch === '●' || ch === '│' || (w[i] >= 0x2800 && w[i] <= 0x28ff) || w[i + 1] & 0x01000000) continue
            min = Math.min(min, contrast(q(parts(w[i + 1])), q(parts(w[i + 2]))))
          }
        }
        worst[theme] = min
      })
    }
    return [`worst light ${worst.light.toFixed(2)}, dark ${worst.dark.toFixed(2)}`, worst.light >= 4.5 && worst.dark >= 4.5]
  },
  async bars_keep_what_is_drawn_under_them(E) {
    // issue #15: the host's own line above the prompt, and other plugins', stay under the bars on both surfaces
    let asked = 0
    globalThis.BELOW = () => (asked++, { type: 'Text', props: { key: 'host' }, children: ['host line'] })
    try {
      await create(E)
      const desktop = walkAll(await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } }))
      const terminal = await E.terminal(120)
      const deskHost = desktop.findIndex(n => n.props?.key === 'host')
      const termHost = terminal.findIndex(n => n.props?.key === 'host')
      const deskBar = desktop.findIndex(n => n.type === 'Svg')
      const termBar = terminal.findIndex(n => n.type === 'Raster')
      const ok = deskBar >= 0 && deskHost > deskBar && termBar >= 0 && termHost > termBar && asked === 2
      return [`desktop bar at ${deskBar}, host at ${deskHost}; terminal bar at ${termBar}, host at ${termHost}; next asked ${asked}x in 2 draws`, ok]
    } finally {
      delete globalThis.BELOW
    }
  },
  async empty_drawing_below_adds_no_gap(E) {
    // an empty Box from below would only leave the gap under the bars, so the band is taller at the bottom than the top
    globalThis.BELOW = () => ({ type: 'Box', props: {}, children: [] })
    try {
      await create(E)
      const desktop = await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } })
      const terminal = await E.raw('ui.render', { component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 120, hasSurvey: false } })
      const gapped = [desktop, terminal].filter(t => { const last = t?.children?.at(-1); return Number(t?.props?.gap) > 0 && last?.type === 'Box' && (last.children ?? []).length === 0 && Object.keys(last.props ?? {}).length === 0 })
      const drawn = [desktop, terminal].filter(t => (t?.children ?? []).length > 1).length
      return [`gap over an empty drawing on ${gapped.length} surface(s), bars on ${drawn}`, gapped.length === 0 && drawn === 2]
    } finally {
      delete globalThis.BELOW
    }
  },
  async drawing_below_without_children_stays(E) {
    // issue #15: what is drawn under the bars stays while they show. Another mod's divider is a Box that draws by
    // itself (a border, a background) with no children; it keeps its place under the bars, the gap above it
    const seen = []
    try {
      await create(E)
      for (const [name, props] of [['bordered rule', { key: 'host', borderStyle: 'single', borderTop: true, width: 40 }], ['coloured block', { key: 'host', backgroundColor: 'red', height: 1 }]]) {
        globalThis.BELOW = () => ({ type: 'Box', props, children: [] })
        const desktop = await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } })
        const terminal = await E.raw('ui.render', { component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 120, hasSurvey: false } })
        const kept = [desktop, terminal].map(t => t?.children?.at(-1)?.props?.key === 'host' && Number(t?.props?.gap) === 1)
        seen.push([name, ...kept])
      }
    } finally {
      delete globalThis.BELOW
    }
    return [seen.map(([n, d, t]) => `${n}: desktop ${d}, terminal ${t}`).join('; '), seen.every(([, d, t]) => d && t)]
  },
  async cut_labels_keep_emoji_whole(E) {
    // a step title with emoji, cut to fit the pill or a tip, loses whole characters: half an emoji shows as "�" and
    // the picture's source no longer encodes
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    let total = 0
    const broken = []
    try {
      for (const cols of [60, 75, 95, 130]) {
        for (const n of [4, 6, 10, 20]) {
          globalThis.COLS = cols
          await E.call({ id: 'e', title: 'Emoji', stages: [S('Build', st('A', 'done'), st('Ship 🚀 '.repeat(n).trim(), 'active'), 'B'), S('Two', 'C')] })
          for (const s of await E.svgs()) {
            total++
            let encodes = true
            try {
              encodeURIComponent(s.source)
            } catch {
              encodes = false
            }
            if (lone.test(s.source) || !encodes) broken.push(`${cols}/${n}`)
          }
        }
      }
    } finally {
      delete globalThis.COLS
    }
    return [`${broken.length} of ${total} pictures with half an emoji${broken.length ? `: ${broken.slice(0, 4).join(', ')}` : ''}`, total > 0 && broken.length === 0]
  },
  async long_tips_are_cut_in_one_pass(E) {
    // a narrow track with many long step titles: each tip was cut a letter at a time, measuring the whole title again,
    // so a redraw after a plan change took ~70 times as long as the same plan with short titles; one pass takes ~10
    // times. The two are timed in turn, so the ratio holds on a busy machine (~20 there), unlike a time in ms
    const long = i => `Step ${i}: update the request handler and all of its tests so that the new contract holds in every single caller`
    const short = i => `Step ${i}`
    const plan = title => Array.from({ length: 10 }, (_, s) => S(`Stage ${s + 1}`, ...Array.from({ length: 30 }, (_, j) => title(s * 30 + j))))
    const ratios = []
    let drawn = 0
    const Short = await boot(file)
    try {
      await E.call({ id: 'b', title: 'B', stages: plan(long) })
      await Short.call({ id: 'b', title: 'B', stages: plan(short) })
      globalThis.COLS = 60
      drawn = (await E.svgs()).length
      await Short.svgs()
      const redraw = async (T, title, k) => {
        await T.call({ id: 'b', active: title(k + 1) })
        T.tick(1000)
        const t0 = performance.now()
        await T.svgs()
        return performance.now() - t0
      }
      for (let k = 0; k < 5; k++) ratios.push((await redraw(E, long, k)) / (await redraw(Short, short, k)))
    } finally {
      delete globalThis.COLS
    }
    const median = [...ratios].sort((a, b) => a - b)[2]
    return [`redraw with long titles ${ratios.map(r => r.toFixed(1)).join('/')}x the short ones, median ${median.toFixed(1)}x, pictures ${drawn}`, drawn > 0 && median < 40]
  },
  async same_plan_again_runs_again(E) {
    // the same plan sent again to its finished bar, steps open ("deploy again", a plan approved twice): a new run from
    // the start with its own clock, not finished at once with the first run's time. Sent again all done, it stays as it was
    const stages = () => [S('Build', 'Compile', 'Test'), S('Ship', 'Deploy')]
    await E.call({ id: 'deploy', title: 'Deploy', stages: stages() })
    E.tick(60_000)
    for (let i = 0; i < 3; i++) await E.call({ id: 'deploy', next: true })
    const first = E.bar('deploy')
    E.tick(600_000)
    await E.call({ id: 'deploy', title: 'Deploy', stages: stages() })
    const again = E.bar('deploy')
    const isNewRun = first.state === 'done' && again.state === 'running' && E.steps('deploy') === 'Compile:active Test:pending Deploy:pending' && again.startedAt > first.endedAt
    for (let i = 0; i < 3; i++) await E.call({ id: 'deploy', next: true })
    const second = E.bar('deploy')
    await E.call({ id: 'deploy', title: 'Deploy', stages: [S('Build', st('Compile', 'done'), st('Test', 'done')), S('Ship', st('Deploy', 'done'))] })
    const restated = E.bar('deploy')
    const isKept = restated.state === 'done' && restated.startedAt === second.startedAt && restated.endedAt === second.endedAt
    // the same plan approved twice in plan mode
    const md = '# Release\n## Build\n- Compile\n- Test\n## Ship\n- Deploy\n'
    await E.exitPlan({ result: { plan: md } })
    for (let i = 0; i < 3; i++) await E.call({ id: 'plan', next: true })
    E.tick(3_600_000)
    await E.exitPlan({ result: { plan: md } })
    const approved = `${E.bar('plan').state} ${E.steps('plan')}`
    const ok = isNewRun && isKept && approved === 'running Compile:active Test:pending Deploy:pending'
    return [`sent again: new run ${isNewRun}; sent all done: kept ${isKept}; approved again: ${approved}`, ok]
  },
  async next_task_leaves_the_last_ones_strips(E) {
    // the next task under a finished bar's id starts without the last task's strips: a failed one would stay for good
    await E.call({ id: 'work', title: 'Fix login', stages: [S('A', 'Patch', 'Test')] })
    await E.spawn('ag1', 'Run e2e suite')
    await E.agentTool('ag1', 'Bash')
    await E.turnComplete('ag1', 'error')
    await E.call({ id: 'work', next: true })
    await E.call({ id: 'work', next: true })
    E.tick(3_600_000)
    const r = await E.call({ id: 'work', title: 'Add dark mode', stages: [S('B', 'Tokens', 'Toggle')] })
    const v = await E.view('work')
    const ok = (E.bar('work').agents ?? []).length === 0 && v.strips.length === 0 && !/agents/.test(res(r))
    return [`agents ${(E.bar('work').agents ?? []).length}, strips ${v.strips.length}, reply "${res(r)}"`, ok]
  },
  async turn_end_question_after_asking_marks_nothing_more(E) {
    // Claude set its bar waiting and then ends the turn with the question: the Stop hook leaves the other bar at work
    // and does not chime a second time
    await E.turnStart()
    await E.call({ id: 'api', title: 'API v2', stages: [S('A', 'Routes', 'Docs')] })
    await E.call({ id: 'ui', title: 'UI polish', stages: [S('B', 'Colors', 'Spacing')] })
    await E.work('Edit')
    const s0 = E.sounds.length
    await E.call({ id: 'api', state: 'needs_input', note: 'Keep v1 routes?' })
    await E.stop('Should I keep the v1 routes alongside v2?')
    const states = E.plans().map(p => `${p.id}:${p.state}`).join(' ')
    const sounds = E.sounds.length - s0
    return [`${states}, ${sounds} chime(s)`, states === 'api:needs_input ui:running' && sounds === 1]
  },
  async main_loop_leaves_a_subagents_bar_alone(E) {
    // a bar a subagent made is its own: the main loop's question does not turn it amber, nor does the main loop's next
    // agent land under it
    await E.turnStart()
    await E.call({ id: 'main', title: 'Refactor auth', stages: [S('A', 'Split module', 'Update callers')] })
    await E.spawn('sub', 'Audit tests')
    await E.call({ agentId: 'sub', id: 'subbar', title: 'Audit tests', stages: [S('X', 'List', 'Check')] })
    await E.spawn('B', 'Agent B')
    const home = E.plans().find(p => (p.agents ?? []).some(a => a.id === 'B'))?.id
    const states = () => E.plans().map(p => `${p.id}:${p.state}`).join(' ')
    let asking = ''
    await E.ask(undefined, () => {
      asking = states()
      return { result: {} }
    })
    await E.work('Edit')
    await E.stop('Should I also rename the helpers?')
    const stopped = states()
    const ok = asking === 'main:needs_input subbar:running' && stopped === 'main:needs_input subbar:running' && home === 'main'
    return [`while asking ${asking}; question at the end ${stopped}; the next agent on ${home}`, ok]
  },
  async pane_teammate_strip_wakes_for_its_next_turn(E) {
    // a teammate in a pane of its own sends nothing here: the list says idle between its turns, which ends its strip
    // for now, and running again when its next turn starts, which sets the strip going again
    await E.call({ id: 'main', title: 'Main', stages: [S('One', st('A', 'active'), 'B')] })
    await E.spawn('T', 'Pane teammate')
    E.tick(1000)
    await E.everyTick()
    E.agentRows.get('T').status = 'idle'
    E.tick(1000)
    await E.everyTick()
    const idle = E.bar('main').agents.find(a => a.id === 'T')?.state
    E.agentRows.get('T').status = 'running'
    E.tick(1000)
    await E.everyTick()
    const again = E.bar('main').agents.find(a => a.id === 'T')?.state
    E.tick(15_000)
    await E.everyTick()
    const strips = (await E.view('main')).strips.length
    return [`idle → ${idle}, running again → ${again}, strips 15 s later ${strips}`, idle === 'done' && again === 'running' && strips === 1]
  },
  async terminal_frames_send_only_changed_cells(E) {
    // during a turn a bar with no fill out from under its pill has nothing that moves: no frame is sent; one with a
    // fill sends its changes
    const sent = []
    for (const done of [0, 3]) {
      const T = await boot(file)
      await T.turnStart()
      const steps = Array.from({ length: 10 }, (_, i) => st(`Step ${i}`, i < done ? 'done' : i === done ? 'active' : 'pending'))
      await T.call({ id: 't', title: 'Task', stages: [S('Build', ...steps.slice(0, 5)), S('Ship', ...steps.slice(5))] })
      await T.terminal(120)
      T.tick(1000)
      await T.everyTick()
      const start = T.blits.length
      for (let i = 0; i < 30; i++) {
        T.tick(33)
        await T.frameTick()
      }
      const bl = T.blits.slice(start).filter(b => b.key === 'track-t')
      sent.push([done, bl.length, bl.filter((b, i) => i > 0 && b.cells === bl[i - 1].cells).length])
    }
    void E
    const [[, idleSent], [, movingSent, same]] = sent
    return [sent.map(([d, n, s]) => `${d}/10 done: ${n} frames, ${s} the same as the one before`).join('; '), idleSent === 0 && movingSent > 10 && same === 0]
  },
  async narrow_terminal_row_fits_the_band(E) {
    // under ~33 columns the row (glyph, title, track, percent) ran past the band: the title gives way first, then goes
    const seen = []
    for (const cols of [16, 20, 25, 29, 32, 40, 80]) {
      const T = await boot(file)
      await T.call({ id: 't', title: 'Refactor the auth module', stages: [S('One', st('A', 'active'), 'B'), S('Two', 'C')] })
      const nodes = await T.terminal(cols)
      const r = nodes.find(n => n.type === 'Raster' && n.props.key === 'track-t')
      const box = nodes.find(n => n.type === 'Box' && n.props.width !== undefined)
      const title = box ? box.props.width + 1 : 0
      seen.push([cols, 1 + 1 + title + r.props.columns + 1 + 4, box?.props.width ?? 0])
    }
    void E
    const ok = seen.every(([cols, row]) => row <= cols) && seen.at(-1)[2] > 0
    return [seen.map(([c, row, t]) => `${c}: row ${row}${t ? '' : ' (no title)'}`).join(', '), ok]
  },
  async footer_speed_is_not_written_twice(E) {
    // response after response (an agent loop), the footer is written only when its figure changes, and the live
    // figure at most once a second across responses: a write redraws the footer and the pictures by it
    const writes = []
    const orig = E.$.__update.bind(E.$)
    E.$.__update = function (a, fn) {
      const v = orig(a, fn)
      if (a.ref.key === 'speed') writes.push({ at: performance.now(), v: JSON.stringify(v) })
      return v
    }
    const piece = { kind: 'text', index: 0, text: 'x'.repeat(36) }
    const resp = n => [[{ kind: 'engine', ref: 1 }, 0], ...Array.from({ length: n }, (_, i) => [piece, i === 0 ? 0 : 50])]
    for (let i = 0; i < 3; i++) await E.stream(resp(30), { outputTokens: 300 })
    const same = writes.filter((w, i) => i > 0 && w.v === writes[i - 1].v).length
    const live = writes.filter(w => JSON.parse(w.v).isLive)
    const quick = live.filter((w, i) => i > 0 && w.at - live[i - 1].at < 1000).length
    return [`${writes.length} writes, ${same} the same as the one before, ${quick} live ones under a second apart`, writes.length > 0 && same === 0 && quick === 0]
  },
  async missing_tool_asks_nothing_of_claude(E) {
    // issue #22: once the mod knows the tool never reached the session, nothing asks Claude to use it: no refused edit,
    // no turn sent back over an open bar, no line about open bars, no plan-mode hint
    globalThis.NO_TOOL = true
    try {
      const T = await boot(file)
      await T.turnStart()
      const edits = []
      for (let i = 0; i < 5; i++) edits.push(await T.raw('tool.call', { tool: 'Edit', tool_use_id: `e${i}` }))
      const plan = await T.exitPlan({ result: { plan: ['# Fix login', '## A', '- One', '- Two', '## B', '- Three'].join('\n') } })
      await T.turnStart()
      await T.raw('tool.call', { tool: 'Edit', tool_use_id: 'z' })
      const stop = await T.stop('Done.')
      // the plan's bar is open, so a message would carry the open-bars line
      const submit = await T.submit()
      const denied = edits.filter(r => r?.deny).length
      const hints = [...(plan?.context ?? []), ...submit].filter(l => /plan-progress/.test(l))
      delete globalThis.NO_TOOL
      await E.turnStart()
      await E.call({ id: 'open', title: 'Open', stages: [S('A', 'One', 'Two')] })
      const withTool = (await E.submit()).filter(l => /plan-progress open bars/.test(l)).length
      const ok = denied === 0 && !stop?.block && hints.length === 0 && T.notices.length === 2 && withTool === 1
      return [`edits refused ${denied}, turn sent back ${!!stop?.block}, hints ${hints.length}, notices ${T.notices.length}; with the tool the line is there ${withTool === 1}`, ok]
    } finally {
      delete globalThis.NO_TOOL
    }
  },
  async missing_tool_is_looked_up_before_the_first_turn(E) {
    // the mod learns the tool is missing at turn.start; before it (a reload mid-turn, a resumed session's first
    // message) it looks the tool up itself, so Claude is not refused an edit or told of open bars it cannot move
    const store = new Map()
    const W = await boot(file, store)
    await W.turnStart()
    await W.call({ id: 't', title: 'T', stages: [S('A', 'One', 'Two'), S('B', 'Three')] })
    await W.sessionEnd('resume')
    globalThis.NO_TOOL = true
    try {
      const R = await boot(file, store)
      const restored = R.plans().length
      const first = (await R.submit()).filter(l => /plan-progress/.test(l)).length
      const T = await boot(file)
      await T.turnStart()
      await T.reload()
      const edits = []
      for (let i = 0; i < 5; i++) edits.push(await T.raw('tool.call', { tool: 'Edit', tool_use_id: `r${i}` }))
      const denied = edits.filter(r => r?.deny).length
      void E
      return [`restored bars ${restored}, lines on the first message ${first}; after a reload mid-turn, edits refused ${denied}`, restored === 1 && first === 0 && denied === 0]
    } finally {
      delete globalThis.NO_TOOL
    }
  },
  async resent_redo_keeps_the_run(E) {
    // a finished bar's plan resent with a later step active redoes that step: the others stay done with their times,
    // the bar keeps its clock. With only its first step active, as with no statuses, it is a new run
    const plan = active => [S('Build', st('Compile', active === 0 ? 'active' : 'pending'), st('Test', active === 1 ? 'active' : 'pending')), S('Ship', st('Deploy', 'pending'))]
    await E.call({ id: 'deploy', title: 'Deploy', stages: plan(-1) })
    for (let i = 0; i < 3; i++) {
      E.tick(60_000)
      await E.call({ id: 'deploy', next: true })
    }
    const first = E.bar('deploy')
    const doneAt = () => E.bar('deploy').stages.flatMap(s => s.steps.map(x => x.doneAt ?? '-'))
    const before = doneAt()
    E.tick(600_000)
    await E.call({ id: 'deploy', title: 'Deploy', stages: plan(1) })
    const redo = `${E.bar('deploy').state} ${E.steps('deploy')}`
    const isKept = E.bar('deploy').startedAt === first.startedAt && doneAt()[0] === before[0] && doneAt()[2] === before[2]
    await E.call({ id: 'deploy', next: true })
    const finished = E.bar('deploy')
    E.tick(600_000)
    await E.call({ id: 'deploy', title: 'Deploy', stages: plan(0) })
    const again = `${E.bar('deploy').state} ${E.steps('deploy')}`
    const isNewRun = again === 'running Compile:active Test:pending Deploy:pending' && E.bar('deploy').startedAt > finished.endedAt
    const ok = redo === 'running Compile:done Test:active Deploy:done' && isKept && finished.state === 'done' && isNewRun
    return [`redo the middle step: ${redo}, times kept ${isKept}; first step active: ${again}, new clock ${isNewRun}`, ok]
  },
  async bar_finished_early_runs_again(E) {
    // a bar finished with state "done" while its last step was still active: the same plan sent again later is a new
    // run, not the old one picked up with the gap counted in its time
    const stages = () => [S('Build', 'Compile', 'Test'), S('Ship', 'Deploy')]
    await E.call({ id: 'deploy', title: 'Deploy', stages: stages() })
    for (let i = 0; i < 2; i++) {
      E.tick(60_000)
      await E.call({ id: 'deploy', next: true })
    }
    await E.call({ id: 'deploy', state: 'done' })
    const first = E.bar('deploy')
    const finished = `${first.state} ${E.steps('deploy')}`
    E.tick(3_600_000)
    await E.call({ id: 'deploy', title: 'Deploy', stages: stages() })
    const again = E.bar('deploy')
    const steps = E.steps('deploy')
    const ok = finished === 'done Compile:done Test:done Deploy:active' && again.state === 'running' && steps === 'Compile:active Test:pending Deploy:pending' && again.startedAt > first.endedAt
    return [`finished: ${finished}; sent again: ${again.state} ${steps}, new clock ${again.startedAt > first.endedAt}`, ok]
  },
  async resting_teammate_survives_a_new_helper(E) {
    // a pane teammate resting between turns keeps its strip when the main loop starts another agent on that bar, so
    // its next turn still has a strip to wake
    await E.call({ id: 'main', title: 'Main', stages: [S('One', st('A', 'active'), 'B')] })
    await E.spawn('T', 'Pane teammate')
    E.tick(1000)
    await E.everyTick()
    E.agentRows.get('T').status = 'idle'
    E.tick(1000)
    await E.everyTick()
    await E.spawn('C', 'Helper')
    const strips = () => (E.bar('main').agents ?? []).map(a => `${a.id}:${a.state}`).join(' ')
    const withHelper = strips()
    E.agentRows.get('T').status = 'running'
    E.tick(1000)
    await E.everyTick()
    const woken = strips()
    return [`helper started: ${withHelper}; teammate at work again: ${woken}`, withHelper === 'T:done C:running' && woken === 'T:running C:running']
  },
  async next_task_child_without_its_parent_is_on_top(E) {
    // the next task keeps the last one's strips still at work; a child whose parent finished is drawn at the top, not
    // under an arrow pointing at a row that is no longer there
    await E.call({ id: 'work', title: 'Fix login', stages: [S('A', 'Patch', 'Test')] })
    await E.spawn('P', 'Parent')
    await E.spawn('K', 'Child', 'P')
    await E.turnComplete('P')
    await E.call({ id: 'work', next: true })
    await E.call({ id: 'work', next: true })
    await E.call({ id: 'work', title: 'Add dark mode', stages: [S('B', 'Tokens', 'Toggle')] })
    const kept = (E.bar('work').agents ?? []).map(a => `${a.id}:${a.state}:${a.depth}`).join(' ')
    const v = await E.view('work')
    const arrows = v.strips.filter(x => x.includes('\u21b3')).length
    return [`kept ${kept}, strips ${v.strips.length}, with an arrow ${arrows}`, kept === 'K:running:0' && v.strips.length === 1 && arrows === 0]
  },
  async footer_dims_when_a_wait_follows_a_write(E) {
    // a zero-size chunk (a block's end, a server tool starting) writes the live figure just before the wait clock sees
    // the wait: the dim figure still goes out on that tick, or the footer stays bright through the whole wait
    const text = { kind: 'text', index: 0, text: 'x'.repeat(36) }
    await E.stream([[{ kind: 'engine', ref: 1 }, 0], ...Array.from({ length: 30 }, (_, i) => [text, i ? 50 : 0])], { outputTokens: 300 })
    // when the last text piece and the chunk after it arrive: the chunk comes inside the second that still counts as
    // writing, the clock's tick just past it
    const seen = {}
    const marked = (name, chunk) => ({
      ...chunk,
      get kind() {
        seen[name] ??= performance.now()
        return chunk.kind
      },
    })
    const pieces = Array.from({ length: 23 }, (_, i) => [i === 22 ? marked('text', text) : text, i ? 50 : 0])
    const run = E.stream([[{ kind: 'engine', ref: 2 }, 0], ...pieces, [marked('chunk', { kind: 'engine', ref: 3 }), 900], [{ kind: 'engine', ref: 4 }, 800]], { outputTokens: 400 })
    while (seen.chunk === undefined || performance.now() < Math.max(seen.chunk + 20, seen.text + 1050)) await new Promise(r => setTimeout(r, 5))
    const speed = () => E.$.__get({ ref: { key: 'speed' }, initial: null })
    const written = speed()?.isLive
    await E.everyTick()
    const waiting = speed()?.isLive
    await run
    return [`after the chunk live ${written}; on the wait clock's tick live ${waiting}`, written === true && waiting === false]
  },
  async footer_speed_comes_back_after_a_clear(E) {
    // /clear wipes the footer's figure with the state; the next response writes it again even when it reads the same
    const text = { kind: 'text', index: 0, text: 'x'.repeat(36) }
    const label = async () => (await E.footer('terminal', false)).filter(n => n.type === 'Text').map(n => (n.children ?? []).join('')).join(' ')
    await E.stream([[{ kind: 'engine', ref: 1 }, 0], ...Array.from({ length: 30 }, (_, i) => [text, i ? 50 : 0])], { outputTokens: 300 })
    const before = await label()
    await E.sessionEnd('clear')
    E.switchSession('session-2')
    const wiped = await label()
    await E.stream([[{ kind: 'engine', ref: 2 }, 0], [text, 0], [text, 50]], { outputTokens: 10 })
    const after = await label()
    const figure = x => x.match(/\d+ tok\/s/)?.[0] ?? null
    return [`before "${before.trim()}", wiped "${wiped.trim()}", after a short reply "${after.trim()}"`, figure(before) !== null && figure(wiped) === null && figure(after) === figure(before)]
  },
  async slow_hook_below_leaves_the_band_to_the_newest_draw(E) {
    // a hook below that answers late must not let an older terminal draw take the band after a newer one: the frames
    // would repaint the bar where it was
    let asked = 0
    globalThis.BELOW = () => (asked++ === 0 ? new Promise(r => setTimeout(() => r(null), 30)) : null)
    try {
      await E.turnStart()
      await create(E)
      const older = E.terminal(120)
      await new Promise(r => setTimeout(r, 0))
      await E.call({ id: 't', next: true })
      await E.call({ id: 't', next: true })
      const drawn = (await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t')
      await older
      const before = E.blits.length
      E.tick(40)
      await E.frameTick()
      const frame = E.blits.slice(before).filter(b => b.key === 'track-t').at(-1)
      const shown = glyphs(drawn.props.cells)
      const painted = frame ? glyphs(frame.cells) : ''
      const ok = shown.includes('Two') && painted.includes('Two')
      return [`drawn "${shown.match(/[A-Za-z]+ [\d/]+/)?.[0]}", frame paints "${painted.match(/[A-Za-z]+ [\d/]+/)?.[0] ?? 'nothing'}"`, ok]
    } finally {
      delete globalThis.BELOW
    }
  },
  async missing_tool_says_why_once() {
    // the engine's loopback link to the mod's tools broke (an antivirus web filter, a proxy): the first turn
    // tells the person why there are no bars and how to fix it, in the transcript and a toast, and only once
    globalThis.NO_TOOL = true
    try {
      const F = await boot(file)
      await F.turnStart()
      await F.turnStart()
      const via = F.notices.map(n => n.via).join('+')
      const text = F.notices[0]?.text ?? ''
      const ok = via === 'log+toast' && text.includes('127.0.0.1') && text.includes('NO_PROXY') && F.notices.every(n => n.text === text)
      return [`${via || 'nothing'}: ${text.slice(0, 60)}`, ok]
    } finally {
      delete globalThis.NO_TOOL
    }
  },
  async present_tool_says_nothing(E) {
    await E.turnStart()
    await E.turnStart()
    return [`${E.notices.length} notices`, E.notices.length === 0]
  },
  async pill_names_the_stage_it_stands_in(E) {
    // Claude finishes steps out of order: a step ahead marked done with the old one left active, or a jump to a later
    // step over open ones. The pill sits by the finished share, so its name is the stage at that place, in the app
    // and in the terminal, never the stage of a step the bar has not reached (or one it has passed)
    const stages = [S('Audit', 'Crawl', 'Check live', 'List issues'), S('Fix', 'Meta', 'Images'), S('Ship', 'Deploy', 'Verify')]
    const pill = async () => {
      const app = (await E.view('t')).track.match(/class="kt">([^<]*)/)?.[1]
      const term = glyphs(await latestTrack(E)).match(/Audit|Fix|Ship/)?.[0]
      return `${app}/${term}`
    }
    await E.call({ id: 't', title: 'Site', stages })
    await E.call({ id: 't', done: ['Check live', 'List issues', 'Meta'] })
    const ahead = await pill()
    await E.call({ id: 'q', title: 'Jump', stages })
    await E.call({ id: 'q', active: 'Deploy' })
    const jumpApp = (await E.view('q')).track.match(/class="kt">([^<]*)/)?.[1]
    const ok = ahead === 'Fix/Fix' && jumpApp === 'Audit'
    return [`done ahead: ${ahead}; jump to Deploy at 1/7: ${jumpApp}`, ok]
  },
  async mark_ahead_names_what_starts_there(E) {
    // a mark the bar has passed names what ended there; one still ahead names what starts there
    await E.call({ id: 'p', title: 'Site', stages: [S('Audit', 'Crawl', 'Check live'), S('Fix', 'Meta', 'Images')] })
    await E.call({ id: 'p', next: true })
    const tips = [...(await E.view('p')).overlay.matchAll(/class="tt">([^<]*)</g)].map(m => m[1].replace('&gt;', '>'))
    const ok = tips[0]?.startsWith('Crawl') && tips[1] === 'Fix' && tips[2] === 'Images'
    return [tips.join(' | '), ok]
  },
  async pill_names_stage_and_step(E) {
    // the pill reads "stage | step" at its place, the separator being the mark it stands on: a stage's capsule at a
    // stage's first step, a step's dot past it; a long step is shortened first, the stage name kept whole
    const label = async id => {
      const track = (await E.view(id)).track
      const texts = [...track.matchAll(/class="kt(?: kp)?">(.*?)<\/text>/g)].map(m => m[1])
      const sep = /<rect x="[\d.-]+" y="6" width="2" height="10" rx="1" fill="#FFFFFF"/.test(track) ? ' | ' : /<circle cx="[\d.-]+" cy="11" r="1.7"/.test(track) ? ' • ' : ' '
      return texts.join(sep)
    }
    await E.call({ id: 't', title: 'Site', stages: [S('Audit', 'Crawl', 'Check live'), S('Fix', 'Meta')] })
    await E.call({ id: 't', next: true })
    const plain = await label('t')
    const long = 'Rewrite every meta description on the marketing pages so each one fits the snippet length'
    await E.call({ id: 'u', title: 'Long', stages: [S('Audit', long)] })
    const cut = await label('u')
    const term = glyphs(await latestTrack(E)).match(/Audit . .*?\d+\/\d+/)?.[0]
    await E.call({ id: 't', next: true })
    const head = await label('t')
    const termHead = glyphs(await latestTrack(E)).match(/Fix . .*?\d+\/\d+/)?.[0]
    const ok = plain === 'Audit • Check live' && cut.startsWith('Audit | Rewrite') && cut.endsWith('…') && term === 'Audit • Check live 2/2' && head === 'Fix | Meta' && termHead === 'Fix │ Meta 1/1'
    return [`${plain} | ${cut} | ${head} | terminal: ${term}, ${termHead}`, ok]
  },
  async tip_fits_its_words(E) {
    // a tip's box is sized from a measured guess of its words (spaces, the dot and narrow letters count narrow), and its
    // text is centred in it, so "Crawl · 8s" gets no long empty tail on the right
    await E.call({ id: 't', title: 'Site', stages: [S('Audit', 'Crawl', 'Check live', 'List issues'), S('Fix', 'Meta')] })
    E.tick(8000)
    await E.call({ id: 't', next: true })
    const ov = (await E.view('t')).overlay
    const tip = ov.match(/<g class="tp p1"><rect x="[\d.]+" y="2" width="([\d.]+)"[^>]*\/><text[^>]*text-anchor="middle"[^>]*>([^<]*)</)
    const width = Number(tip?.[1])
    // Segoe UI draws "Crawl · 8s" at 11px about 46px wide; 8px of padding each side
    const ok = tip?.[2] === 'Crawl · 8s' && width >= 60 && width <= 70
    return [`"${tip?.[2]}" in a ${width}px box`, ok]
  },
  // audit render-cache: B40, B50, B38
  async pill_glide_goes_on_through_an_agent_event(E) {
    // the bar moves on and an agent calls a tool a moment later: the pill keeps gliding from where it set off instead
    // of jumping to its new place, and the agent's strip keeps its change of word when the band is drawn again
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    await E.view('t')
    await E.call({ id: 't', next: true })
    const from = (await E.view('t')).track.match(/<animateTransform[^>]*from="([\d.]+) 0"/)?.[1]
    E.tick(100)
    await E.agentTool('ag1', 'Grep')
    const mid = await E.view('t')
    const goesOn = from !== undefined && mid.track.match(/<animateTransform[^>]*from="([\d.]+) 0"[^>]*begin="-0\.100s"/)?.[1] === from
    const morphs = mid.strips[0]?.includes(' mo ') ?? false
    E.tick(50)
    const kept = (await E.view('t')).strips[0]?.includes(' mo ') ?? false
    return [`glide from ${from}, 0.1 s later after an agent's tool it goes on ${goesOn}, word morph ${morphs}, kept on a redraw ${kept}`, goesOn && morphs && kept]
  },
  async reduced_motion_stills_glides_and_flows(E) {
    // with "reduce motion" on, the pill and the fill stand at their new place at once and a strip takes its new colour
    // without a flow: every SMIL animation sits in an element that reduced motion hides, a still copy shown instead
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    await E.view('t')
    await E.call({ id: 't', next: true })
    await E.turnComplete('ag1')
    const v = await E.view('t')
    const check = src => {
      const at = src.indexOf('@media (prefers-reduced-motion:reduce){')
      let end = src.indexOf('{', at) + 1
      for (let depth = 1; at >= 0 && depth > 0 && end < src.length; end++) depth += src[end] === '{' ? 1 : src[end] === '}' ? -1 : 0
      const reduced = at >= 0 ? src.slice(at, end) : ''
      const outside = at >= 0 ? src.slice(0, at) + src.slice(end) : src
      const hidden = new Set([...reduced.matchAll(/\.([\w-]+)\{display:none\}/g)].map(m => m[1]))
      const still = new Set([...outside.matchAll(/\.([\w-]+)\{display:none\}/g)].map(m => m[1]).filter(c => new RegExp(`\\.${c}\\{display:(?!none)`).test(reduced)))
      const classes = attrs => (attrs.match(/class="([^"]*)"/)?.[1] ?? '').split(' ')
      const moving = [...src.matchAll(/<\w+([^<>]*)><animate/g)].map(m => classes(m[1]))
      const copies = [...src.matchAll(/<\w+([^<>]*?)\/?>/g)].filter(m => classes(m[1]).some(c => still.has(c))).length
      return { animations: moving.length, isHidden: moving.length > 0 && moving.every(cs => cs.some(c => hidden.has(c))), copies }
    }
    const track = check(v.track)
    const strip = check(v.strips[0] ?? '')
    const ok = track.isHidden && track.copies >= track.animations && strip.isHidden && strip.copies >= strip.animations
    return [`track: ${track.animations} animations, hidden under reduced motion ${track.isHidden}, ${track.copies} still copies; strip: ${strip.animations}, ${strip.isHidden}, ${strip.copies}`, ok]
  },
  async long_plan_keeps_every_bar_drawn(E) {
    // a plan of 360 steps with ordinary titles next to a small bar: past 131072 characters in one picture the engine
    // draws none of the bars, so every picture stays under it, and the long bar keeps its tips where they fit
    const title = i => `Step ${i}: update the handler and its tests so the new contract holds in every caller`
    const stages = [0, 1, 2, 3, 4].map(s => S(`Stage ${s + 1}`, ...Array.from({ length: 72 }, (_, j) => title(s * 72 + j))))
    await E.call({ id: 'big', title: 'Big', stages })
    await create(E, 's', three(), 'Small')
    globalThis.COLS = 200
    let svgs
    try {
      svgs = await E.svgs()
    } finally {
      delete globalThis.COLS
    }
    const longest = Math.max(...svgs.map(s => s.source.length))
    const bigAt = svgs.findIndex(s => s.alt.startsWith('Big:'))
    const tips = (svgs.slice(bigAt + 1).find(s => s.isInteractive)?.source.match(/class="tp p/g) ?? []).length
    const hasSmall = svgs.some(s => s.alt.startsWith('Small:'))
    return [`longest picture ${longest} characters, ${tips} tips on the long bar, small bar drawn ${hasSmall}`, longest <= 131072 && tips > 50 && hasSmall]
  },
  // audit look: B44, B45, B48, B47
  async russian_and_wide_names_fit_their_pill() {
    // a stage and step named in Russian, Korean or with emoji stay inside the pill and inside the tip over their mark,
    // as Segoe UI really draws them (whole labels measured in Chromium: the stage at 12px 500, the step at 11px 400)
    const STAGE_W = { 'Сборка': 41.5, 'Фиксы': 37.4, 'Шаблоны': 55.2, '데이터베이스': 72.0, '🚀 Deploy': 58.4 }
    const STEP_W = { 'Пишем шаблоны': 86.7, 'Щупаем мышью': 83.3, 'Сжимаем шрифты': 92.7, '스키마 작성': 58.0, '✅ Check 🔥': 65.6 }
    const seen = []
    let ok = true
    for (const [stage, step] of [['Сборка', 'Пишем шаблоны'], ['Фиксы', 'Щупаем мышью'], ['Шаблоны', 'Сжимаем шрифты'], ['데이터베이스', '스키마 작성'], ['🚀 Deploy', '✅ Check 🔥']]) {
      const E = await boot(file)
      await E.call({ id: 't', title: 'Task', stages: [S(stage, st('a', 'done'), st(step, 'active'), 'b'), S('Two', 'c')] })
      const track = (await E.view('t')).track
      const kw = Number(track.match(/<rect x="[-\d.]+" y="0" width="([\d.]+)" height="22" rx="11"/)?.[1])
      const line = Number(track.match(/<text x="([-\d.]+)"[^>]*text-anchor="end" class="kt">/)?.[1])
      const stepX = Number(track.match(/<text x="([-\d.]+)"[^>]*class="kt kp">/)?.[1])
      const left = line - STAGE_W[stage] + kw / 2
      const right = kw / 2 - (stepX + STEP_W[step])
      const F = await boot(file)
      await F.call({ id: 't', title: 'Task', stages: [S('One', st('x', 'active'), step, 'z'), S('Two', 'c')] })
      const tw = Number((await F.view('t')).overlay.match(/<g class="tp p1"><rect x="[\d.]+" y="2" width="([\d.]+)"/)?.[1])
      const tip = (tw - STEP_W[step]) / 2
      if (!(left >= 4 && right >= 4 && tip >= 4)) ok = false
      seen.push(`${stage} | ${step}: pill ${left.toFixed(1)}/${right.toFixed(1)}, tip ${tip.toFixed(1)}`)
    }
    return [seen.join('; '), ok]
  },
  async marks_show_in_the_light_theme() {
    // in a light theme the stage capsules and step dots behind and ahead of the pill stand out from the track at 3:1
    // (WCAG 1.4.11), on the desktop as in the dark theme, and so does the terminal's passed stage boundary
    const steps = n => Array.from({ length: n }, (_, i) => `S${i}`)
    const stages = () => [S('One', st('S0', 'done'), st('S1', 'done'), st('S2', 'done')), S('Two', st('S0', 'done'), st('S1', 'done'), st('S2', 'done')), S('Three', st('S0', 'done'), st('S1', 'active'), 'S2'), S('Four', ...steps(3))]
    const color = c => (c.startsWith('rgb') ? c.match(/\d+/g).map(Number) : toRgb(c))
    const E = await boot(file)
    await E.call({ id: 't', title: 'Task', stages: stages() })
    const t = (await E.view('t')).track
    const fx = Number(t.match(/<clipPath id="fill"><rect width="([\d.]+)"/)[1])
    const grad = [...t.matchAll(/stop-color="(rgb\([^)]*\))" stop-opacity="([.\d]+)"/g)].map(m => ({ c: color(m[1]), a: Number(m[2]) }))
    const lightCss = t.match(/@media \(prefers-color-scheme:light\)\{((?:\.[\w-]+\{[^}]*\})*)\}/)?.[1] ?? ''
    const rules = Object.fromEntries([...lightCss.matchAll(/\.([\w-]+)\{([^}]*)\}/g)].map(m => [m[1], Object.fromEntries(m[2].split(';').map(d => d.split(':')))]))
    const worst = { light: Infinity, dark: Infinity }
    let marks = 0
    for (const [theme, page] of [['light', [255, 255, 255]], ['dark', [31, 30, 29]]]) {
      const track = over(page, [128, 128, 128], 0.16)
      for (const m of t.matchAll(/<(rect|circle)(?: class="([\w-]+)")? (?:x|cx)="([\d.]+)"[^>]*?fill="([^"]+)" opacity="([.\d]+)"\/>/g)) {
        const x = Number(m[3]) + (m[1] === 'rect' ? 1.5 : 0)
        const rule = theme === 'light' ? (rules[m[2]] ?? {}) : {}
        const g = grad[0].a + (grad[1].a - grad[0].a) * Math.min(1, x / fx)
        const under = x < fx ? over(track, grad[0].c, g) : track
        const mark = over(under, color(rule.fill ?? m[4]), Number(rule.opacity ?? m[5]))
        worst[theme] = Math.min(worst[theme], contrast(mark, under))
        if (theme === 'light') marks++
      }
    }
    const term = await withMachine({ MAC: false, THEME: 'light' }, async () => {
      const F = await boot(file)
      await F.call({ id: 't', title: 'Task', stages: stages() })
      const r = (await F.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t')
      const w = new Uint32Array(Uint8Array.from(Buffer.from(r.props.cells, 'base64')).buffer)
      const q = c => c.map(v => Math.round(v / 17) * 17)
      const parts = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
      let min = Infinity
      for (let i = 0; i < w.length; i += 3) if (String.fromCodePoint(w[i]) === '│') min = Math.min(min, contrast(q(parts(w[i + 1])), q(parts(w[i + 2]))))
      return min
    })
    const ok = marks >= 10 && worst.light >= 3 && worst.dark >= 3 && term >= 3
    return [`${marks} marks: worst light ${worst.light.toFixed(2)}, dark ${worst.dark.toFixed(2)}; terminal light │ ${term.toFixed(2)}`, ok]
  },
  async step_name_reads_on_the_amber_pill(E) {
    // a bar waiting for an answer turns its pill amber, and the step name on it still reads at AA (4.5:1)
    await E.call({ id: 'p', title: 'Site', stages: [S('Audit', 'Crawl', 'Check live'), S('Fix', 'Meta')] })
    await E.call({ id: 'p', next: true })
    await E.call({ id: 'p', state: 'needs_input', note: 'Which pages?' })
    const track = (await E.view('p')).track
    const pill = track.match(/<rect x="[-\d.]+" y="0" width="[\d.]+" height="22" rx="11" fill="(#[0-9A-F]{6})"/i)?.[1]
    const kp = track.match(/\.kp\{([^}]*)\}/)?.[1] ?? ''
    const op = Number(kp.match(/fill-opacity:([.\d]+)/)?.[1] ?? 1)
    const step = track.match(/class="kt kp">([^<]*)</)?.[1]
    const c = contrast(over(toRgb(pill), [255, 255, 255], op), toRgb(pill))
    return [`"${step}" white at ${op} on ${pill}: ${c.toFixed(2)}:1`, pill === '#AD6400' && step === 'Check live' && c >= 4.5]
  },
  async alt_says_failed_or_waiting(E) {
    // a screen reader hears that a bar waits for an answer or failed (and where), note or not, and the hover layer
    // reads the step times instead of asking for a mouse
    await E.call({ id: 't', title: 'Deploy', stages: [S('Audit', 'Crawl', 'Check live'), S('Fix', 'Meta')] })
    E.tick(8000)
    await E.call({ id: 't', next: true })
    const alts = async () => (await E.svgs()).filter(s => s.alt.startsWith('Deploy:')).map(s => s.alt)
    const running = await alts()
    await E.call({ id: 't', state: 'needs_input' })
    const waiting = await alts()
    await E.call({ id: 't', failed: 'Check live' })
    const failed = await alts()
    const ok =
      !/waiting|failed/.test(running[0]) && waiting[0]?.includes('waiting for your answer') && failed[0]?.includes('failed at Check live') &&
      [running, waiting, failed].every(a => a.length === 2 && !/hover/.test(a[1])) && running[1] === 'Deploy: Crawl took 8s'
    return [[running, waiting, failed].map(a => a.join(' / ')).join(' | '), ok]
  },
  // audit agent-text: B15, B05, B06
  async mcp_strip_word_names_the_action(E) {
    // an agent at work in the browser reads "browser_take_screenshot" on its strip, not "mcp__plugin_playwr…"
    await create(E)
    await E.spawn('ag1', 'Check the page')
    await E.agentTool('ag1', 'mcp__plugin_playwright_playwright__browser_take_screenshot')
    const desk = (await E.view('t')).strips[0]
    const word = desk.match(/text-anchor="end" class="sn w-running[^"]*">([^<]*)</)?.[1]
    const r = (await E.terminal(140)).find(n => n.type === 'Raster' && n.props.key === 'strips-t')
    const row = glyphs(r.props.cells).replace(/[⠀-⣿]/g, ' ')
    const ok = word === 'browser_take_screenshot' && /browser_take_screenshot \d+s/.test(row) && !row.includes('mcp__')
    return [`desktop "${word}", terminal ${row.trim()}`, ok]
  },
  async long_tool_word_leaves_the_name_alone(E) {
    // in a half-screen window a long tool name is cut short before the clock, so it never lies over the agent's name
    await create(E)
    await E.spawn('ag1', 'Check the checkout page in the browser')
    await E.agentTool('ag1', 'mcp__plugin_playwright_playwright__a_very_long_tool_name_for_the_browser_screenshot')
    globalThis.COLS = 80
    let strip
    try {
      strip = (await E.svgs()).find(s => s.alt?.startsWith('agent '))
    } finally {
      delete globalThis.COLS
    }
    const tw = s => [...s].reduce((w, ch) => w + (/[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMW]/.test(ch) ? 9.5 : 6.2), 0)
    const word = strip.source.match(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end" class="sn w-running[^"]*">([^<]*)</)
    const name = strip.source.match(/<text x="([\d.]+)" y="[\d.]+" class="sn">(.*?)<\/text>/)
    const nameText = name[2].replace(/<[^>]*>/g, '')
    const nameEnd = Number(name[1]) + tw(nameText)
    const wordStart = Number(word[1]) - tw(word[2])
    const ok = wordStart > nameEnd && word[2].endsWith('…') && nameText.length > 10
    return [`name "${nameText}" ends x=${nameEnd.toFixed(0)}, word "${word[2]}" starts x=${wordStart.toFixed(0)}`, ok]
  },
  async bracket_in_agent_title_stays_bright(E) {
    // "Fix login (part 2) of the form" reads whole in the name's colour; only "(haiku 4.5)" after it is dim
    await create(E)
    await E.spawn('ag1', 'Fix login (part 2) of the form')
    const desk = (await E.view('t')).strips[0]
    const dim = desk.match(/<tspan class="st">([^<]*)</)?.[1]
    const r = (await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'strips-t')
    const w = new Uint32Array(Uint8Array.from(Buffer.from(r.props.cells, 'base64')).buffer)
    const row = glyphs(r.props.cells)
    const fg = i => w[i * 3 + 1]
    const at = row.indexOf('Fix login')
    const isBright = fg(row.indexOf('part 2')) === fg(at) && fg(row.indexOf('form')) === fg(at)
    const isModelDim = fg(row.indexOf('haiku')) !== fg(at)
    const ok = dim === ' (haiku 4.5)' && isBright && isModelDim
    return [`desktop dim "${dim}", terminal title bright ${isBright}, model dim ${isModelDim}`, ok]
  },
  // audit terminal: B04, B07
  async terminal_resize_draws_the_head_in_place(E) {
    // the window narrows (or a longer title beside it takes room) while Claude works: the bar is drawn at its share of
    // the new width at once, never first fuller and then sliding back as if progress was lost
    await E.turnStart()
    await E.call({ id: 't', title: 'Task', stages: [S('One', st('A', 'done'), st('B', 'done'), st('C', 'active')), S('Two', 'E', 'F', 'G')] })
    const filled = cells => {
      const backs = backsOf(cells)
      return backs.filter(c => c !== backs.at(-1)).length
    }
    const at = async cols => filled((await E.terminal(cols)).find(n => n.type === 'Raster' && n.props.key === 'track-t').props.cells)
    await at(200)
    E.tick(1500)
    const seen = [await at(80)]
    for (let i = 0; i < 14; i++) {
      E.tick(33)
      await E.frameTick()
      const b = E.blits.filter(b => b.key === 'track-t').at(-1)
      if (b) seen.push(filled(b.cells))
    }
    E.tick(1000)
    const settled = await at(80)
    return [`filled cells after narrowing ${[...new Set(seen)].join(' → ')}, settled ${settled}`, seen.every(n => n === settled)]
  },
  async light_terminal_first_bar_is_light(E) {
    // a light Mac with the "auto" theme, or a light Omarchy theme: the session's first bar shows light from its very
    // first frame, with no dark flash until the second timer repaints it
    const first = async (E, set) =>
      withMachine(set, async () => {
        await E.setTheme('auto')
        await create(E)
        return backOf((await E.terminal(120)).find(n => n.type === 'Raster' && n.props.key === 'track-t').props.cells)
      })
    const mac = await first(E, { TERM_PROGRAM: 'iTerm.app' })
    const omarchy = await first(await boot(file), { MAC: false, OMARCHY: OMARCHY_LIGHT })
    return [`first track on a light Mac ${mac.toString(16)}, on light Omarchy ${omarchy.toString(16)}`, lum(mac) > LUM_MID && lum(omarchy) > LUM_MID]
  },
  // audit agents: B09, B11, B16, B19
  async resumed_agent_shows_its_new_work(E) {
    // an agent that finished and is sent another message works again under the same id: its strip runs again,
    // stays in view while it works and shows how the new run ended, instead of a green "Done" that folds away
    await create(E)
    await E.spawn('ag1', 'Scan imports')
    await E.agentTool('ag1', 'Grep')
    await E.turnComplete('ag1')
    const first = E.bar('t').agents[0]
    await E.agentTool('ag1', 'Bash')
    const again = E.bar('t').agents[0]
    for (let i = 0; i < 7; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    const strips = (await E.view('t')).strips.length
    await E.turnComplete('ag1', 'error')
    const last = E.bar('t').agents[0]
    const shown = `${first.state}/${first.tool} → ${again.state}/${again.tool}, ${strips} strips after 7 s → ${last.state}/${last.tool}`
    return [shown, first.state === 'done' && again.state === 'running' && again.tool === 'Bash' && strips === 1 && last.state === 'error' && last.tool === 'Failed']
  },
  async agent_with_no_end_settles_by_the_list(E) {
    // a teammate in a terminal pane of its own sends no turn.complete here: once the engine's list says it waits for a
    // message its strip is done, and the finished bar leaves with auto-close on instead of ticking for an hour
    await E.command('plan-progress-autoclose')
    await create(E, 't', [S('One', st('A', 'active'))])
    await E.spawn('reviewer@team', 'Reviewer teammate')
    await E.call({ id: 't', state: 'done' })
    await E.terminal(120)
    E.tick(1000)
    await E.everyTick()
    E.agentRows.get('reviewer@team').status = 'idle'
    for (let i = 0; i < 60; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    const isGone = !E.bar('t')
    // the band redraws without the bar, and the 30 fps clock it no longer needs stops
    await E.terminal(120)
    E.tick(1000)
    await E.everyTick()
    const frames = E.frameTimers()
    // an agent whose row the engine dropped after it was listed has ended; a workflow's, never listed, waits for its end
    await create(E, 'u', [S('One', st('A', 'active'))])
    await E.spawn('lost', 'Lost finish')
    await E.spawn('wf', 'Workflow agent')
    E.agentRows.delete('wf')
    E.tick(1000)
    await E.everyTick()
    E.agentRows.delete('lost')
    E.tick(1000)
    await E.everyTick()
    const states = E.bar('u').agents.map(a => `${a.id}:${a.state}`).join(' ')
    return [`teammate bar gone ${isGone}, ${frames} frame clocks, ${states}`, isGone && frames === 0 && states === 'lost:done wf:running']
  },
  async fold_waits_for_its_own_bar(E) {
    // finished strips fold 5 s after their own batch ends, though another bar's batch finishes in the meantime
    await create(E, 'a')
    await create(E, 'b')
    await E.spawn('x1', 'Scan')
    await create(E, 'c')
    await E.spawn('y1', 'Write')
    await E.turnComplete('x1')
    const redraws = []
    let last = E.$.__get({ ref: { key: 'tick' }, initial: 0 })
    for (let s = 1; s <= 12; s++) {
      E.tick(1000)
      if (s === 4) await E.turnComplete('y1')
      await E.everyTick()
      const t = E.$.__get({ ref: { key: 'tick' }, initial: 0 })
      if (t !== last) redraws.push(s)
      last = t
    }
    return [`fold redraws at ${redraws.join(', ')} s`, redraws[0] === 6 && redraws.includes(10)]
  },
  // audit plan-state: B29, B22, B30, B51, B33, B55, B17
  async turn_end_keeps_failed_and_waiting_bars(E) {
    // every step closed, then a failed deploy or a question: the bar stays red or amber when the turn (or an agent)
    // ends, with no success chime
    await E.call({ id: 'x', title: 'Deploy', stages: [S('Ship', 'Build', 'Deploy')] })
    await E.call({ id: 'x', done: ['Build', 'Deploy'], state: 'error', note: 'Deploy failed: 502' })
    await E.call({ id: 'y', title: 'Push', stages: [S('Ship', 'Commit')] })
    await E.call({ id: 'y', done: ['Commit'], state: 'needs_input', note: 'Push to main?' })
    const before = E.sounds.length
    await E.spawn('ag1', 'Scan tests')
    await E.turnComplete('ag1')
    await E.turnComplete(undefined)
    const states = `${E.bar('x').state}, ${E.bar('y').state}`
    const played = E.sounds.slice(before)
    return [`after the turn ${states}; sounds ${played.join(', ') || 'none'}`, states === 'error, needs_input' && played.length === 0]
  },
  async answer_on_a_finished_bar_closes_it(E) {
    // all steps done, Claude asks "Publish now?" and the person answers: the bar is done with its tick, not running
    // at 99%, and with auto-close on it leaves
    await E.command('plan-progress-autoclose')
    await E.call({ id: 'rel', title: 'Release', stages: [S('Ship', st('Publish', 'active'))] })
    await E.call({ id: 'rel', next: true })
    await E.call({ id: 'rel', state: 'needs_input', note: 'Publish to npm now?' })
    await E.raw('prompt.submit', { origin: { kind: 'composer' }, text: 'yes', context: [] })
    const after = `${E.bar('rel')?.state} ${(await E.view('rel'))?.alt}`
    for (let i = 0; i < 40; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    return [`after the answer: ${after}; there after 40 s ${!!E.bar('rel')}`, after.startsWith('done Release: done') && !E.bar('rel')]
  },
  async new_task_on_a_finished_bar_starts_fresh(E) {
    // a second plan approved after the first finished, or a new plan sent to a finished bar's id (one that leaves out
    // the steps the last one finished), starts at 0% on its own clock; a plan revised mid-work still keeps its finished steps
    await E.exitPlan({ result: { plan: '# Add login\n## Build\n- Add route\n- Run tests\n## Ship\n- Update docs' } })
    for (let i = 0; i < 3; i++) await E.call({ id: 'plan', next: true })
    const first = E.bar('plan').state
    E.tick(45 * 60_000)
    const at = await E.$.clock.now()
    await E.exitPlan({ result: { plan: '# Add logout\n## Build\n- Add button\n- Wire handler\n- Run tests\n## Ship\n- Update docs' } })
    const plan = `${E.steps('plan')}, started ${(at - E.bar('plan').startedAt) / 60_000} min before`
    await E.call({ id: 'fix', title: 'Fix tests', stages: [S('Work', 'Find failure')] })
    await E.call({ id: 'fix', next: true })
    E.tick(60_000)
    await E.call({ id: 'fix', title: 'Fix tests', stages: [S('Work', 'Patch', 'Run tests')] })
    const fix = `${E.steps('fix')}, ${E.bar('fix').state}, started ${(at + 60_000 - E.bar('fix').startedAt) / 60_000} min before`
    await E.call({ id: 'fix', next: true })
    await E.call({ id: 'fix', stages: [S('Work', 'Patch', 'Run tests', 'Commit')] })
    const kept = E.steps('fix')
    const ok =
      first === 'done' &&
      plan === 'Add button:active Wire handler:pending Run tests:pending Update docs:pending, started 0 min before' &&
      fix === 'Patch:active Run tests:pending, running, started 0 min before' &&
      kept === 'Patch:done Run tests:active Commit:pending'
    return [`plan ${plan}; fix ${fix}; revised ${kept}`, ok]
  },
  async answer_from_remote_control_clears_waiting(E) {
    // the person answers from the phone (Remote Control) or a claude -p host: the amber bar goes back to work and the
    // next turn's 4th edit is not refused; a background task's notice is no answer
    const seen = []
    await E.turnStart()
    await E.call({ id: 'db', title: 'Migrate DB', stages: [S('Schema', 'Add table', 'Backfill'), S('Check', 'Run tests')] })
    for (const kind of ['bridge', 'sdk', 'task-notification']) {
      await E.work('Edit')
      await E.work('Edit')
      await E.stop('Batches of 1000 or all at once?')
      await E.turnComplete(undefined)
      await E.raw('prompt.submit', { origin: { kind }, text: 'batches', context: [] })
      const state = E.bar('db').state
      if (kind === 'task-notification') {
        seen.push(`${kind}: ${state}`)
        break
      }
      await E.turnStart()
      let refused = 0
      for (let i = 0; i < 4; i++) if ((await E.work('Edit')).deny) refused++
      seen.push(`${kind}: ${state}, ${refused} refused`)
    }
    return [seen.join('; '), seen.join('; ') === 'bridge: running, 0 refused; sdk: running, 0 refused; task-notification: needs_input']
  },
  async waiting_bar_asks_with_one_chime(E) {
    // Claude sets the bar waiting as its rules say, then opens the question or the plan to approve: one chime each,
    // and the answer in the dialog takes the amber off
    await create(E)
    await E.call({ id: 't', state: 'needs_input', note: 'Which DB?' })
    await E.ask()
    const asked = `${E.bar('t').state} ${E.bar('t').note}`
    await E.call({ id: 't', state: 'needs_input', note: 'Approve the plan?' })
    await E.exitPlan({ result: { plan: null } })
    const approved = `${E.bar('t').state} ${E.bar('t').note}`
    const ok = asked === 'running null' && approved === 'running null' && E.sounds.join() === 'sounds/decision.wav,sounds/decision.wav'
    return [`after the question ${asked}, after the plan ${approved}; sounds ${E.sounds.join(', ')}`, ok]
  },
  async question_colours_the_task_bar(E) {
    // agents started while the task bar showed an error sit on the Agents bar; Claude's question turns the task bar
    // amber, never the Agents bar, which stays amber only while an agent's own dialog is up
    await E.call({ id: 'fix', title: 'Fix login', stages: [S('Work', st('Reproduce', 'active'), 'Patch', 'Test')] })
    await E.call({ id: 'fix', state: 'error', note: 'repro failed' })
    await E.spawn('ag1', 'Find the crash')
    await E.call({ id: 'fix', state: 'running' })
    let open = ''
    let held
    await E.ask(undefined, async () => {
      await E.agentTool('ag1', 'Read')
      open = `fix ${E.bar('fix').state}, agents ${E.bar('agents:auto').state}`
      held = await E.hold('ag1')
      return { result: {} }
    })
    const answered = `fix ${E.bar('fix').state}, agents ${E.bar('agents:auto').state}`
    await held.release()
    return [`question open: ${open}; answered: ${answered}`, open === 'fix needs_input, agents running' && answered === 'fix running, agents needs_input']
  },
  async agents_bar_leaves_with_autoclose(E) {
    // with auto-close on, the Agents bar leaves 30 s after its last agent finished, like a finished task bar
    await E.command('plan-progress-autoclose')
    await E.spawn('ag1', 'Scan tests')
    await E.spawn('ag2', 'Read docs')
    E.tick(10_000)
    await E.turnComplete('ag1')
    await E.turnComplete('ag2')
    const state = E.bar('agents:auto')?.state
    for (let i = 0; i < 10; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    const stays = !!E.bar('agents:auto')
    for (let i = 0; i < 30; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    return [`${state}; there after 10 s ${stays}, after 40 s ${!!E.bar('agents:auto')}`, state === 'done' && stays && !E.bar('agents:auto')]
  },
  async agents_bar_stays_while_a_new_batch_runs(E) {
    // a batch started after the last one finished makes the Agents bar run again, so it does not leave under it, and it
    // leaves 30 s after that batch ends (from #24)
    await E.command('plan-progress-autoclose')
    const ticks = async n => {
      for (let i = 0; i < n; i++) {
        E.tick(1000)
        await E.everyTick()
      }
    }
    await E.spawn('ag1', 'Scan tests')
    await E.turnComplete('ag1')
    await ticks(20)
    await E.spawn('ag2', 'Scan docs')
    await ticks(40)
    const whileRunning = E.bar('agents:auto')?.state
    await E.turnComplete('ag2')
    await ticks(29)
    const at29 = !!E.bar('agents:auto')
    await ticks(2)
    const at31 = !!E.bar('agents:auto')
    return [`after 40 s of the second batch ${whileRunning}, shown 29 s after it ${at29}, 31 s after ${at31}`, whileRunning === 'running' && at29 && !at31]
  },
  async agents_bar_keeps_an_agent_that_lands_as_it_leaves(E) {
    // the clock lets the finished Agents bar go and takes it away a moment later: an agent landing on it in between runs
    // it again, so the bar stays with the agent's strip rather than taking it along for good
    await E.command('plan-progress-autoclose')
    await E.spawn('ag1', 'Scan tests')
    await E.turnComplete('ag1')
    for (let i = 0; i < 29; i++) {
      E.tick(1000)
      await E.everyTick()
    }
    E.tick(1500)
    await Promise.all([E.everyTick(), E.spawn('ag2', 'Scan docs')])
    const strip = () => E.bar('agents:auto')?.agents?.find(a => a.id === 'ag2')?.state ?? 'gone'
    const landed = `${E.bar('agents:auto')?.state ?? 'no bar'}, ag2 ${strip()}`
    await E.agentTool('ag2', 'Read')
    await E.turnComplete('ag2')
    const finished = strip()
    return [`as the bar left: ${landed}; after its work ag2 ${finished}`, landed === 'running, ag2 running' && finished === 'done']
  },
  // audit gate: B53, B54
  async subagent_bar_is_not_main_update(E) {
    // a subagent keeping its own bar does not count as Claude updating the main one: Claude is still asked for a bar
    // before multi-step work, and a main bar left on its first step is still reminded of
    await E.turnStart()
    await E.spawn('ag1', 'Research API')
    await E.call({ agentId: 'ag1', id: 'api-notes', title: 'API notes', stages: [S('Read', 'Docs', 'Code')] })
    await E.call({ agentId: 'ag1', id: 'api-notes', done: ['Docs', 'Code'] })
    await E.turnComplete('ag1')
    const first = []
    for (let i = 0; i < 4; i++) first.push(await E.work('Edit'))
    const isRefused = !!first[3].deny
    await E.turnStart()
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two', 'Three')] })
    await E.spawn('ag2', 'Long scan')
    await E.call({ agentId: 'ag2', id: 'scan', title: 'Scan', stages: [S('Scan', 'P1', 'P2', 'P3', 'P4', 'P5')] })
    let hit = -1
    for (let i = 0; i < 6; i++) {
      const r = await E.work('Edit')
      if (hit < 0 && (r.context ?? []).some(c => c.includes('main') && c.includes('not updated'))) hit = i
      if (i === 4) await E.call({ agentId: 'ag2', id: 'scan', next: true })
    }
    return [`4th edit ${isRefused ? 'refused' : 'ran'}, main reminded on edit #${hit + 1}`, isRefused && hit === 5]
  },
  async finished_bar_gets_no_reminder(E) {
    // once the bar reads 100% done, a few follow-up edits in the same turn bring no "the bar not updated" line
    await E.turnStart()
    await E.call({ id: 'rename-api', title: 'Rename API', stages: [S('Code', 'Rename calls', 'Update docs')] })
    for (let i = 0; i < 3; i++) await E.work('Edit')
    await E.call({ id: 'rename-api', next: true })
    await E.call({ id: 'rename-api', next: true })
    const state = E.plans().find(p => p.id === 'rename-api')?.state
    let reminders = 0
    let isRefused = false
    for (let i = 0; i < 12; i++) {
      const r = await E.work('Edit')
      if (r.deny) isRefused = true
      if ((r.context ?? []).some(c => c.includes('not updated'))) reminders++
    }
    return [`bar ${state}, 12 edits after: ${reminders} reminders${isRefused ? ', refused' : ''}`, state === 'done' && reminders === 0 && !isRefused]
  },
  // audit persist: B39, B57, B31
  async idle_bars_are_not_saved_again(E) {
    // a finished bar left alone, or no bars after /progress-clear, leaves the plugin's file on disk alone: it is
    // written when the bars change, not once a second
    const writes = []
    const { set, delete: drop } = E.$.store
    E.$.store.set = async (k, v) => (writes.push('set'), set(k, v))
    E.$.store.delete = async k => (writes.push('delete'), drop(k))
    const idle = async () => {
      writes.length = 0
      for (let i = 0; i < 60; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      return writes.length
    }
    await create(E)
    await E.call({ id: 't', state: 'done' })
    await E.everyTick()
    const saved = writes.length
    const done = await idle()
    await E.command('progress-clear')
    await E.everyTick()
    const cleared = await idle()
    return [`writes on the change ${saved}, in 60 s idle: done bar ${done}, after clear ${cleared}`, saved > 0 && done === 0 && cleared === 0]
  },
  async store_trim_drops_the_session_left_longest(E) {
    // a session saved long ago but worked in just now keeps its bars when a new session pushes the store past
    // 20 sessions; the one left alone longest goes instead
    const kept = new Map([['plans:session-1', JSON.stringify([])]])
    const A = await boot(file, kept)
    await create(A)
    await A.everyTick()
    for (let i = 1; i < 20; i++) kept.set(`plans:s${i}`, kept.get('plans:session-1'))
    const resumed = await boot(file, kept)
    await resumed.call({ id: 't', next: true })
    resumed.tick(1000)
    await resumed.everyTick()
    globalThis.SESSION = 'session-2'
    try {
      const fresh = await boot(file, kept)
      await create(fresh, 'u')
      await fresh.everyTick()
    } finally {
      delete globalThis.SESSION
    }
    const again = await boot(file, kept)
    const ok = kept.has('plans:session-1') && !kept.has('plans:s1') && again.steps('t') === resumed.steps('t')
    return [`worked-in session kept ${kept.has('plans:session-1')}, oldest untouched kept ${kept.has('plans:s1')}, resumed bar ${again.steps('t') || 'none'}`, ok]
  },
  async resume_inside_the_app_brings_its_bars_back(E) {
    // /resume to an older conversation without restarting shows that conversation's bars where it left them, and
    // neither its saved bars nor the ones of the session left behind are wiped; a /clear and a /resume back does too
    const kept = new Map()
    globalThis.SESSION = 'session-old'
    try {
      const old = await boot(file, kept)
      await create(old, 'mig', [S('Move', st('Schema', 'done'), st('Data', 'active'))], 'Migration')
      await old.everyTick()
    } finally {
      delete globalThis.SESSION
    }
    const F = await boot(file, kept)
    await create(F, 'today', three(), 'Today')
    await F.everyTick()
    await F.sessionEnd('resume')
    // a tick can come between the wipe and the new id
    F.tick(1000)
    await F.everyTick()
    F.switchSession('session-old')
    F.tick(1000)
    await F.everyTick()
    F.tick(1000)
    await F.everyTick()
    const shown = F.plans().map(p => p.id).join(',')
    const isSaved = kept.has('plans:session-old') && kept.has('plans:session-1')
    await F.sessionEnd('clear')
    F.switchSession('session-new')
    F.tick(1000)
    await F.everyTick()
    const cleared = F.plans().length
    await F.sessionEnd('resume')
    F.switchSession('session-1')
    F.tick(1000)
    await F.everyTick()
    const back = F.plans().map(p => p.id).join(',')
    const ok = shown === 'mig' && F.steps('today') !== '' && isSaved && cleared === 0 && back === 'today' && kept.has('plans:session-old')
    return [`after /resume: ${shown || 'none'}, both saved ${isSaved}; after /clear ${cleared} bars, /resume back: ${back || 'none'}`, ok]
  },
  // audit parse: B23, B26
  async plan_code_block_is_not_markup(E) {
    // a plan's code block stays code: its "# run the unit tests" is neither the bar's name nor a stage, and its diff
    // lines are not steps; the bar is "Plan" with the stages the plan wrote
    const plan = '## Steps\n1. Add refresh call\n2. Retry the request\n```diff\n- const old = a()\n+ const now = b()\n```\n## Verification\n```bash\n# run the unit tests\nnpm test\n# then the e2e suite\n```\n- Log in, wait 1 h, reload'
    await E.exitPlan({ result: { plan } })
    const p = E.bar('plan')
    const shape = `${p.title}: ${p.stages.map(s => `${s.name}[${s.steps.map(x => x.title)}]`).join(' ')}`
    return [shape, shape === 'Plan: Steps[Add refresh call,Retry the request] Verification[Log in, wait 1 h, reload]']
  },
  async plan_heading_steps_are_steps(E) {
    // steps written as "### 1. Add a token bucket" with prose under them are the bar's steps, so the pill reads
    // "Implementation | Add a token bucket", not the first path of the files list
    const plan = '# Add rate limiting\n## Context\nClients hammer /search.\n## Implementation\n### 1. Add a token bucket\nA bucket per key.\n### 2. Wire it into the router\nAnswer 429 when empty.\n### 3. Expose the limits in config\nRead RATE_LIMIT.\n## Files to change\n- src/limit/bucket.ts (new)\n## Verification\n- npm test'
    await E.exitPlan({ result: { plan } })
    const shape = E.bar('plan').stages.map(s => `${s.name}[${s.steps.map(x => x.title)}]`).join(' ')
    const want = 'Implementation[Add a token bucket,Wire it into the router,Expose the limits in config] Files to change[src/limit/bucket.ts (new)] Verification[npm test]'
    return [`${shape}; ${E.steps('plan').split(' ')[0]}`, shape === want && E.steps('plan').startsWith('Add a token bucket:active')]
  },
  // audit meter: B01
  async server_tool_wait_is_not_writing(E) {
    // a response that waits mid-way on a tool the API runs itself (the advisor) reads its writing speed, not 3x less:
    // the figure dims through the wait instead of standing bright and frozen, and does not drop once the text resumes
    const label = async () => {
      const t = (await E.footer('desktop', true)).find(n => n.type === 'Text')
      return { text: t.children.join(''), dim: Boolean(t.props.dimColor) }
    }
    const rate = s => Number(s.replace(/[^\d.]/g, ''))
    // when the last piece before the wait and the one that ends it really arrive: a busy machine delays both
    const seen = {}
    const marked = (name, chunk) => ({
      ...chunk,
      get kind() {
        seen[name] ??= performance.now()
        return chunk.kind
      },
    })
    // 18 characters every 60 ms is about 83 tokens a second at 3.6 characters a token
    const piece = () => ({ kind: 'text', index: 0, text: 'x'.repeat(18) })
    const run = n => Array.from({ length: n }, () => [piece(), 60])
    const before = [...run(19), [marked('last', piece()), 60]]
    const pieces = [[{ kind: 'engine', ref: 1 }, 0], ...before, [{ kind: 'engine', ref: 2 }, 0], [marked('back', { kind: 'engine', ref: 3 }), 2500], ...run(25)]
    const serverToolUses = [{ id: 'a1', name: 'advisor', input: {}, startedAt: 1000, endedAt: 3500 }]
    const started = performance.now()
    const samples = []
    const ticks = []
    // the engine's clock goes on while no piece comes; the footer is read as the person would see it
    // a tick or a read that throws fails the case instead of the whole run, and the timers stop even when the stream throws
    let lost
    const clock = setInterval(() => {
      const at = performance.now()
      E.everyTick().then(() => ticks.push({ at, done: performance.now() }), err => (lost ??= err))
    }, 500)
    const watch = setInterval(() => label().then(l => samples.push({ at: performance.now(), ...l }), err => (lost ??= err)), 100)
    try {
      await E.stream(pieces, { outputTokens: 225, serverToolUses })
    } finally {
      clearInterval(clock)
      clearInterval(watch)
    }
    if (lost) throw lost
    const took = (performance.now() - started) / 1000
    const after = rate((await label()).text)
    // the wait is seen on the first clock tick a second past the last piece; from then until the text resumes
    const seenAt = ticks.find(k => k.at >= seen.last + 1000)?.done ?? Infinity
    const waiting = samples.filter(s => s.at >= seenAt && s.at < seen.back)
    const resumed = samples.filter(s => s.at > seen.back && !s.dim).at(-1)
    const writing = 225 / (took - 2.5)
    const whole = 225 / took
    const ok = waiting.length > 0 && waiting.every(s => s.dim) && resumed !== undefined && rate(resumed.text) > (writing + whole) / 2 && Math.abs(after - writing) <= 4
    const shown = waiting.map(s => `${s.text}${s.dim ? ' dim' : ' BRIGHT'}`).join(', ')
    return [`during the wait: ${shown}; after it "${resumed?.text}"; final ${after} (writing ≈${Math.round(writing)}, whole stream ≈${Math.round(whole)})`, ok]
  },
  // audit review
  async finished_plan_that_grows_keeps_its_steps(E) {
    // the plan finished, then the person asks for one more step and Claude resends the stages under the same id, as
    // its rules say: the finished steps stay done and the clock goes on. A plan-mode plan revised after it finished,
    // under the same title, does the same
    await E.turnStart()
    await E.call({ id: 'auth', title: 'Add login', stages: [S('Build', 'Add route', 'Add form'), S('Check', 'Run tests')] })
    E.tick(20 * 60_000)
    for (let i = 0; i < 3; i++) await E.call({ id: 'auth', next: true })
    const first = E.bar('auth').state
    await E.turnComplete(undefined)
    E.tick(60_000)
    await E.raw('prompt.submit', { origin: { kind: 'composer' }, text: 'also add logout', context: [] })
    await E.turnStart()
    const r = await E.call({ id: 'auth', title: 'Add login', stages: [S('Build', 'Add route', 'Add form', 'Add logout'), S('Check', 'Run tests')] })
    const ago = ((await E.$.clock.now()) - E.bar('auth').startedAt) / 60_000
    const grown = `${E.steps('auth')}, ${E.bar('auth').state}, started ${ago} min before; ${res(r)}`
    await E.exitPlan({ result: { plan: '# Add export\n## Build\n- Add route\n- Run tests' } })
    for (let i = 0; i < 2; i++) await E.call({ id: 'plan', next: true })
    E.tick(5 * 60_000)
    await E.exitPlan({ result: { plan: '# Add export\n## Build\n- Add route\n- Run tests\n- Commit' } })
    const revised = `${E.steps('plan')}, started ${((await E.$.clock.now()) - E.bar('plan').startedAt) / 60_000} min before`
    const ok =
      first === 'done' &&
      grown === 'Add route:done Add form:done Add logout:active Run tests:done, running, started 21 min before; auth: 3/4, running, active "Add logout"' &&
      revised === 'Add route:done Run tests:done Commit:active, started 5 min before'
    return [`grown ${grown}; plan revised ${revised}`, ok]
  },
  async numbered_sections_with_prose_intro_stay_stages(E) {
    // numbered sections that carry lists stay stages when one of them ("1. Context") is prose only: their list items
    // are the steps the bar draws, and the prose section is left out, not made a step to work through
    const shapes = []
    for (const plan of [
      '# Add export\n## 1. Context\nUsers want CSV export.\n## 2. Backend\n- Add /export route\n- Stream rows as CSV\n## 3. Frontend\n- Add Export button\n- Show progress\n## 4. Verification\n- npm test\n- Export 10k rows by hand',
      '# Refresh tokens\n## Plan\n### 1. Summary\nTokens expire mid-session.\n### 2. Server\n- Add refresh endpoint\n- Rotate tokens\n### 3. Client\n- Call refresh on 401\n- Retry request',
      '# Fix cookie\n## 1. Root cause\nThe cookie is dropped on redirect.\n## 2. Fix\n- Set SameSite=Lax\n- Keep the cookie on 302\n## 3. Tests\n- Add e2e test',
    ]) {
      await E.exitPlan({ result: { plan } })
      shapes.push(E.bar('plan').stages.map(s => `${s.name}[${s.steps.map(x => x.title)}]`).join(' '))
    }
    const want = [
      'Backend[Add /export route,Stream rows as CSV] Frontend[Add Export button,Show progress] Verification[npm test,Export 10k rows by hand]',
      'Server[Add refresh endpoint,Rotate tokens] Client[Call refresh on 401,Retry request]',
      'Fix[Set SameSite=Lax,Keep the cookie on 302] Tests[Add e2e test]',
    ]
    return [shapes.join('; '), shapes.every((s, i) => s === want[i])]
  },
  async subagent_bar_is_left_to_its_agent(E) {
    // a bar a subagent made and keeps open is its own: the main loop's 4th edit without a bar of its own is still
    // refused, and its reminders name only the main loop's bar, never one the subagent has just moved
    await E.turnStart()
    await E.spawn('ag1', 'Research API')
    await E.call({ agentId: 'ag1', id: 'api-notes', title: 'API notes', stages: [S('Read', 'Docs', 'Code', 'Tests')] })
    const first = []
    for (let i = 0; i < 4; i++) first.push(await E.work('Edit'))
    const isRefused = !!first[3].deny
    await E.turnStart()
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two', 'Three')] })
    await E.spawn('ag2', 'Long scan')
    await E.call({ agentId: 'ag2', id: 'scan', title: 'Scan', stages: [S('Scan', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7')] })
    const said = []
    for (let i = 0; i < 6; i++) {
      const r = await E.work('Edit')
      said.push(...(r.context ?? []).filter(c => c.includes('not updated')))
      await E.call({ agentId: 'ag2', id: 'scan', next: true })
    }
    const ok = isRefused && said.length === 1 && said[0].startsWith('plan-progress: main not updated')
    return [`4th edit ${isRefused ? 'refused' : 'ran'}; reminders: ${said.join(' | ') || 'none'}`, ok]
  },
  async subagent_amber_is_not_the_question(E) {
    // a subagent set its own bar waiting, quietly; then the main loop asks the person: the question chimes and turns
    // the main bar amber, and the answer leaves the subagent's waiting bar and its note alone
    await E.turnStart()
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two')] })
    await E.spawn('ag', 'Scan repo')
    await E.call({ agentId: 'ag', id: 'scan', title: 'Scan', stages: [S('Scan', 'P1', 'P2')] })
    await E.call({ agentId: 'ag', id: 'scan', state: 'needs_input', note: 'which folder?' })
    const before = E.sounds.length
    let during
    await E.ask(undefined, () => ((during = `main ${E.bar('main').state}, scan ${E.bar('scan').state}`), { result: {} }))
    const after = `main ${E.bar('main').state}, scan ${E.bar('scan').state} (${E.bar('scan').note})`
    const chimes = E.sounds.length - before
    const ok = chimes === 1 && during === 'main needs_input, scan needs_input' && after === 'main running, scan needs_input (which folder?)'
    return [`chimes ${chimes}; during: ${during}; after: ${after}`, ok]
  },
  async session_end_save_survives_a_cut(E) {
    // session.end runs under a short bound that can cut a store call: a save cut there leaves the last save in place
    // rather than no save at all, so the next --resume still finds the bars
    await create(E)
    await E.everyTick()
    await E.call({ id: 't', next: true })
    const set = E.$.store.set
    E.$.store.set = async () => {
      throw new Error('aborted')
    }
    try {
      await E.sessionEnd('exit')
    } catch {}
    E.$.store.set = set
    const saved = await E.$.store.get('plans:session-1')
    const kept = Array.isArray(saved) ? saved.map(p => p.id).join() : 'nothing'
    return [`after a cut save at session end, saved bars: ${kept}`, kept === 't']
  },
  async strip_morph_plays_once(E) {
    // a strip's change of word or colour morphs once: a redraw inside the morph's 0.2 s goes on with it from where it
    // got to, and later redraws, for another agent's work, show the strip standing, no word blurring in again
    await E.call({ id: 't', title: 'Task', stages: [S('A', 'a1', 'a2'), S('B', 'b1')] })
    await E.spawn('ag1', 'Scan tests')
    await E.spawn('ag2', 'Read docs')
    await E.agentTool('ag1', 'Read')
    await E.view('t')
    await E.agentTool('ag1', 'Grep')
    const has = s => ({ mo: s.includes(' mo '), mi: /class="[^"]* mi"/.test(s), flow: s.includes('<animate attributeName="fill"') })
    const changed = has((await E.view('t')).strips[0])
    E.tick(100)
    const mid = (await E.view('t')).strips[0]
    const goesOn = mid.includes(' mo ') && mid.includes('animation-delay:-0.100s')
    const later = []
    for (let i = 0; i < 2; i++) {
      E.tick(5000)
      await E.agentTool('ag2', 'Bash')
      later.push(has((await E.view('t')).strips[0]))
    }
    await E.turnComplete('ag2')
    const done = has((await E.view('t')).strips[1])
    E.tick(5000)
    await E.agentTool('ag1', 'Edit')
    const settled = has((await E.view('t')).strips[1])
    const isStill = m => !m.mo && !m.mi && !m.flow
    const ok = changed.mo && changed.mi && goesOn && later.every(isStill) && done.flow && isStill(settled)
    const shown = later.map(m => (isStill(m) ? 'still' : JSON.stringify(m))).join(', ')
    return [`change ${JSON.stringify(changed)}, 0.1 s on ${goesOn}, later ${shown}; done ${JSON.stringify(done)}, 5 s on ${JSON.stringify(settled)}`, ok]
  },
  async long_plan_keeps_its_stage_marks(E) {
    // thinning a long plan's marks and tips keeps every stage capsule and its stage-name tip, whatever the stage size;
    // the step dots give way first
    const seen = []
    let ok = true
    for (const [n, per] of [[300, 2], [5, 72], [20, 20]]) {
      const stages = Array.from({ length: n }, (_, s) => S(`Stage ${s + 1}`, ...Array.from({ length: per }, (_, j) => `Step ${s * per + j}: update the handler and its tests`)))
      await E.call({ id: `big${n}`, title: `Big ${n}`, stages })
      const v = await E.view(`big${n}`)
      const capsules = (v.track.match(/<rect class="m[pa]"/g) ?? []).length
      const tips = (v.overlay.match(/>Stage \d+</g) ?? []).length
      seen.push(`${n}x${per}: capsules ${capsules}/${n - 1}, stage tips ${tips}, source ${v.track.length + v.overlay.length}`)
      ok &&= capsules === n - 1 && tips === n - 1 && v.track.length < 131072 && v.overlay.length < 131072
      await E.command('progress-clear')
    }
    return [seen.join('; '), ok]
  },
  async next_with_active_leaves_the_jumped_step_open(E) {
    // next with active names the new step itself: the step finished moves on to it, and the step jumped over in
    // between stays open rather than being finished on the way
    await E.call({ id: 't', title: 'Task', stages: [S('One', st('A', 'active'), 'B', 'C'), S('Two', 'D')] })
    const r = await E.call({ id: 't', next: true, active: 'C' })
    const seen = `${E.steps('t')}; ${res(r)}`
    return [seen, seen === 'A:done B:pending C:active D:pending; t: 1/4, running, active "C"']
  },
  async punctuation_id_never_lands_on_the_plan_bar(E) {
    // an id of emoji or punctuation alone names no bar of its own: with a title the title names the bar, with none
    // the call is refused, and the plan-mode bar "plan" is never taken over or moved
    await E.exitPlan({ result: { plan: '# Add export\n## Build\n- Add route\n- Run tests' } })
    const named = await E.call({ id: '🚀🚀', title: 'Fix login', stages: [S('Work', 'One', 'Two')] })
    const bare = await E.call({ id: '!!!', stages: [S('Work', 'X', 'Y')] })
    const moved = await E.call({ id: '✨', next: true })
    const refusal = 'plan_progress: the id needs a letter or a digit, like "fix-login".'
    const bars = E.plans().map(p => `${p.id}(${p.title})`).join(' ')
    const ok =
      res(named) === 'fix-login: 0/2, running, active "One"' && bare.deny === refusal && moved.deny === refusal &&
      bars === 'plan(Add export) fix-login(Fix login)' && E.steps('plan') === 'Add route:active Run tests:pending'
    return [`${res(named)} | ${res(bare)} | ${res(moved)} | bars ${bars}; plan ${E.steps('plan')}`, ok]
  },
  async long_id_cut_keeps_whole_letters(E) {
    // an id cut at 40 keeps whole characters: a letter outside the BMP (two UTF-16 units) across the edge goes whole
    const r = await E.call({ id: 'x'.repeat(39) + '𠀀𠀁', title: 'Task', stages: [S('Work', 'One')] })
    const id = E.plans()[0]?.id ?? ''
    const isHalf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(id)
    return [`id ${JSON.stringify(id)} (${id.length} units), half a letter ${isHalf}`, id === 'x'.repeat(39) && !isHalf && res(r).startsWith(id + ': ')]
  },
  async refusal_step_list_keeps_whole_emoji(E) {
    // the refusal's list of steps is cut at 400 as the tool cuts text: an emoji across the edge goes whole, never
    // half of it (a lone surrogate) at the end of the message
    const titles = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(93) + '🚀🚀']
    await E.call({ id: 't', title: 'Task', stages: [S('Work', ...titles)] })
    const r = await E.call({ id: 't', done: ['Nope'] })
    const text = r.deny ?? ''
    const isHalf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)
    const ok = !isHalf && text.startsWith('plan_progress: "t" has no step "Nope". Its steps: aaa') && text.endsWith(', ' + 'd'.repeat(93))
    return [`refusal of ${text.length} units ends ${JSON.stringify(text.slice(-6))}, half an emoji ${isHalf}`, ok]
  },
  async plan_mode_step_cut_keeps_whole_emoji(E) {
    // a plan-mode step longer than 120 is cut as the tool cuts titles: an emoji across the edge goes whole, never half
    await E.exitPlan({ result: { plan: `# Ship it\n## Build\n- ${'a'.repeat(119)}🚀 and the rest\n- Run tests\n## Check\n- npm test` } })
    const t = E.bar('plan')?.stages[0]?.steps[0]?.title ?? ''
    const isHalf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t)
    return [`step of ${t.length} units ends ${JSON.stringify(t.slice(-3))}, half an emoji ${isHalf}`, !isHalf && t === 'a'.repeat(119)]
  },
  async plan_mode_headings_are_capped(E) {
    // plan-mode headings are capped as the tool caps them: the H1 title at 80, a stage name (a heading may become a
    // step) at 120
    const h1 = 'Refactor ' + 'the session store '.repeat(8)
    const h2 = 'Move '.repeat(40)
    await E.exitPlan({ result: { plan: `# ${h1}\n## ${h2}\n- Add route\n- Run tests\n## Check\n- npm test` } })
    const b = E.bar('plan')
    const seen = `title ${b.title.length} of ${h1.trim().length}, stage ${b.stages[0].name.length} of ${h2.trim().length}`
    return [seen, b.title === h1.slice(0, 80).trimEnd() && b.stages[0].name === h2.slice(0, 120).trimEnd()]
  },
  async finished_plan_bar_resent_with_long_title_keeps_progress(E) {
    // a finished plan-mode bar resent through the tool under its own H1 longer than 80 (the tool cuts it at 80, as
    // the parse does) is the same plan grown, not the next task: its finished steps stay done
    const h1 = 'Move the session store to SQLite and keep the old JSON files readable for one more release'
    await E.exitPlan({ result: { plan: `# ${h1}\n## Build\n- Add table\n- Copy rows\n## Check\n- Run tests` } })
    for (let i = 0; i < 3; i++) await E.call({ id: 'plan', next: true })
    const was = E.bar('plan').state
    const r = await E.call({ id: 'plan', title: h1, stages: [S('Build', 'Add table', 'Copy rows'), S('Check', 'Run tests', 'Commit')] })
    const seen = `${was} -> ${E.steps('plan')}; ${res(r)}`
    return [seen, seen === 'done -> Add table:done Copy rows:done Run tests:done Commit:active; plan: 3/4, running, active "Commit"']
  },
  async finished_plan_bar_resent_with_markdown_title_keeps_progress(E) {
    // a plan-mode title is stored without its markdown: the finished bar resent through the tool with the H1 as
    // written (bold, backticks) is the same plan grown, not the next task, so its finished steps stay done
    const h1 = 'Fix **login** in `auth.ts`'
    await E.exitPlan({ result: { plan: `# ${h1}\n## Build\n- Add route\n- Add form\n## Check\n- Run tests` } })
    for (let i = 0; i < 3; i++) await E.call({ id: 'plan', next: true })
    const was = `${E.bar('plan').state} "${E.bar('plan').title}"`
    const r = await E.call({ id: 'plan', title: h1, stages: [S('Build', 'Add route', 'Add form'), S('Check', 'Run tests', 'Commit')] })
    const seen = `${was} -> ${E.steps('plan')}; ${res(r)}`
    return [seen, seen === 'done "Fix login in auth.ts" -> Add route:done Add form:done Run tests:done Commit:active; plan: 3/4, running, active "Commit"']
  },
  async inline_code_line_opens_no_fence(E) {
    // a plan-mode line opening with inline code (```js``` ...) is not a fence and swallows nothing after it; the
    // shell comments and list lines of a real ``` or ~~~ block are still skipped
    const plan = [
      '# Speed up tests',
      '## Context',
      '```js``` files load the old config on every run.',
      '## Build',
      '- Cache deps',
      '- Split suites',
      '```bash',
      '# not a heading',
      '- not a step',
      '```',
      '## Check',
      '- Run CI',
      '~~~',
      '- not a step either',
      '~~~',
    ].join('\n')
    await E.exitPlan({ result: { plan } })
    const shape = (E.bar('plan')?.stages ?? []).map(s => `${s.name}[${s.steps.map(x => x.title)}]`).join(' ')
    return [shape, shape === 'Build[Cache deps,Split suites] Check[Run CI]']
  },
  async subagent_bar_goes_before_the_main_bar(E) {
    // three helpers each make a bar of their own and fill the list: the bar that goes is the oldest a subagent made, not
    // the main loop's running bar, which keeps its progress and its strips and can still be moved
    await E.turnStart()
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two', 'Three')] })
    await E.call({ id: 'main', next: true })
    for (const a of ['a1', 'a2', 'a3']) await E.spawn(a, `Helper ${a}`)
    for (const a of ['a1', 'a2', 'a3']) await E.call({ agentId: a, id: `sub-${a}`, title: `Sub ${a}`, stages: [S('Go', 'X', 'Y')] })
    const bars = E.plans().map(p => p.id).join(',')
    const strips = (E.bar('main')?.agents ?? []).map(a => a.id).join(',')
    const r = res(await E.call({ id: 'main', next: true }))
    const ok = bars === 'main,sub-a2,sub-a3' && strips === 'a1,a2,a3' && r.startsWith('main: 2/3, running')
    return [`bars ${bars}; main's strips ${strips || 'none'}; main moved: ${r}`, ok]
  },
  async ended_subagent_leaves_its_bar_to_the_main_loop(E) {
    // a bar a subagent made outlives its run as the main loop's: once the agent fails the main loop's Stop asks about
    // it; a teammate only resting between its turns keeps its own bar, and Stop leaves that one alone
    await E.turnStart()
    await E.spawn('X', 'Helper')
    await E.call({ agentId: 'X', id: 'sub', title: 'Sub', stages: [S('Go', 'One', 'Two', 'Three')] })
    await E.call({ agentId: 'X', id: 'sub', next: true })
    await E.spawn('T', 'Teammate')
    E.agentRows.get('T').teammateId = 'T@team'
    await E.call({ agentId: 'T', id: 'mate', title: 'Mate', stages: [S('Go', 'A', 'B')] })
    await E.turnComplete('X', 'error')
    await E.turnComplete('T')
    await E.work('Edit')
    const owners = E.plans().filter(p => p.id !== 'agents:auto').map(p => `${p.id}@${p.byAgent ?? 'main'}`).join(' ')
    const stop = (await E.stop('Done.'))?.block ?? 'none'
    const ok = owners === 'sub@main mate@T' && stop.startsWith('plan-progress: sub still open.')
    return [`owners ${owners}; Stop: ${stop.slice(0, 40)}`, ok]
  },
  async restored_bar_has_no_agent_owner(E) {
    // agents do not outlive the process: a bar a subagent made comes back after a restart as the main loop's, so the
    // main loop's Stop asks about it
    const store = new Map()
    const W = await boot(file, store)
    await W.turnStart()
    await W.spawn('X', 'Helper')
    await W.call({ agentId: 'X', id: 'sub', title: 'Sub', stages: [S('Go', 'One', 'Two')] })
    const before = `${W.bar('sub').byAgent}`
    await W.sessionEnd('exit')
    const R = await boot(file, store)
    const after = R.bar('sub') ? `${R.bar('sub').byAgent ?? 'main'}` : 'gone'
    await R.turnStart()
    await R.work('Edit')
    const stop = (await R.stop('Done.'))?.block ?? 'none'
    void E
    return [`owner before ${before}, after the restart ${after}; Stop: ${stop.slice(0, 40)}`, before === 'X' && after === 'main' && stop.startsWith('plan-progress: sub still open.')]
  },
  async resumed_agent_gets_its_strip_back_after_the_next_batch(E) {
    // an agent resumed under the same id (a message sent to it, an in-process teammate's next turn) after the next
    // spawn cleared its finished batch gets its strip back on the main loop's bar, and its end shows there
    const strips = () => (E.bar('main').agents ?? []).map(a => `${a.id}:${a.state}`).join(' ')
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two')] })
    await E.spawn('a1', 'Scan')
    await E.turnComplete('a1')
    await E.spawn('a2', 'Fix')
    const cleared = strips()
    await E.agentTool('a1', 'Grep')
    const back = strips()
    await E.turnComplete('a1')
    const ended = strips()
    return [`next batch: ${cleared}; a1 resumed: ${back}; a1 ends: ${ended}`, cleared === 'a2:running' && back === 'a2:running a1:running' && ended === 'a2:running a1:done']
  },
  async resting_teammate_survives_the_next_task(E) {
    // a pane teammate resting between turns keeps its strip when the bar gets its next task, so its next turn still has
    // a strip to wake
    const strips = () => (E.bar('main').agents ?? []).map(a => `${a.id}:${a.state}`).join(' ')
    await E.call({ id: 'main', title: 'Fix login', stages: [S('A', st('Patch', 'active'))] })
    await E.spawn('T', 'Pane teammate')
    E.agentRows.get('T').status = 'idle'
    E.tick(1000)
    await E.everyTick()
    await E.call({ id: 'main', next: true })
    await E.call({ id: 'main', title: 'Add dark mode', stages: [S('B', 'Tokens', 'Toggle')] })
    const kept = strips()
    E.agentRows.get('T').status = 'running'
    E.tick(1000)
    await E.everyTick()
    const woken = strips()
    return [`next task: ${kept || 'no strips'}; teammate's next turn: ${woken || 'no strips'}`, kept === 'T:done' && woken === 'T:running']
  },
  async agent_resumed_after_the_fold_comes_back_alone(E) {
    // a batch finished and folded away; one agent resumed later comes back alone, not with the batch's other Done
    // strips and their old times, and a second one resumed after it comes back next to it
    const strips = () => (E.bar('main').agents ?? []).map(a => `${a.id}:${a.state}`).join(' ')
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two')] })
    for (const a of ['a1', 'a2', 'a3']) await E.spawn(a, `Helper ${a}`)
    for (const a of ['a1', 'a2', 'a3']) await E.turnComplete(a)
    E.tick(6000)
    const folded = (await E.view('main')).strips.length
    await E.agentTool('a2', 'Read')
    const one = `${strips()} (${(await E.view('main')).strips.length} drawn)`
    await E.agentTool('a3', 'Grep')
    const two = `${strips()} (${(await E.view('main')).strips.length} drawn)`
    const ok = folded === 0 && one === 'a2:running (1 drawn)' && two === 'a2:running a3:running (2 drawn)'
    return [`folded ${folded} drawn; a2 resumed: ${one}; a3 too: ${two}`, ok]
  },
  async agents_bar_clock_starts_over_after_a_finished_batch(E) {
    // the Agents bar's clock starts over for work after its batch finished: a resting teammate's next turn and a helper
    // spawned 20 minutes later count from their own start, not from the first batch
    const clock = async () => ((await E.$.clock.now()) - E.bar('agents:auto').startedAt) / 1000
    await E.spawn('T', 'Pane teammate')
    await E.spawn('a1', 'First')
    E.agentRows.get('T').status = 'idle'
    E.tick(1000)
    await E.everyTick()
    await E.turnComplete('a1')
    const over = E.bar('agents:auto').state
    E.tick(20 * 60_000)
    E.agentRows.get('T').status = 'running'
    E.tick(1000)
    await E.everyTick()
    const woken = `${E.bar('agents:auto').state} ${await clock()}s`
    E.agentRows.get('T').status = 'idle'
    E.tick(1000)
    await E.everyTick()
    E.tick(20 * 60_000)
    await E.spawn('a2', 'Second')
    const spawned = `${E.bar('agents:auto').state} ${await clock()}s`
    const ok = over === 'done' && woken === 'running 0s' && spawned === 'running 0s'
    return [`first batch ${over}; teammate's next turn 20 min on: ${woken}; helper 20 min after that: ${spawned}`, ok]
  },
  async reload_keeps_the_fold_and_a_resting_teammate(E) {
    // the mod reloaded just after a batch finished: its strips still fold away on time (a redraw comes), and a pane
    // teammate resting before the reload still wakes for its next turn
    const tick = () => E.$.__get({ ref: { key: 'tick' }, initial: 0 })
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two')] })
    await E.spawn('T', 'Pane teammate')
    await E.spawn('a1', 'Helper')
    E.agentRows.get('T').status = 'idle'
    E.tick(1000)
    await E.everyTick()
    await E.turnComplete('a1')
    E.tick(1500)
    await E.reload()
    const before = tick()
    E.tick(4000)
    await E.everyTick()
    const redraws = tick() - before
    E.agentRows.get('T').status = 'running'
    E.tick(1000)
    await E.everyTick()
    const woken = E.bar('main').agents.find(a => a.id === 'T')?.state
    return [`redraws when the fold is due ${redraws}; teammate's next turn: T ${woken}`, redraws === 1 && woken === 'running']
  },
  async grandchild_sits_under_its_parent(E) {
    // a grandchild strip goes right under its parent, one level deeper, before the parent's later siblings; a second
    // grandchild follows the first, and a later child of the top agent goes after them all
    const order = () => E.bar('main').agents.map(a => `${a.id}/${a.depth}`).join(' ')
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two')] })
    await E.spawn('P', 'Parent')
    await E.spawn('C1', 'Child one', 'P')
    await E.spawn('C2', 'Child two', 'P')
    await E.spawn('G', 'Grandchild', 'C1')
    const first = order()
    await E.spawn('G2', 'Grandchild two', 'C1')
    await E.spawn('C3', 'Child three', 'P')
    const second = order()
    return [`${first}; then ${second}`, first === 'P/0 C1/1 G/2 C2/1' && second === 'P/0 C1/1 G/2 G2/2 C2/1 C3/1']
  },
  async next_task_child_goes_under_its_nearest_kept_ancestor(E) {
    // the next task keeps the last one's strips still at work: a grandchild whose own parent finished moves up under
    // the grandparent still at work, and a child whose parent finished goes to the top
    await E.call({ id: 'work', title: 'Fix login', stages: [S('A', 'Patch', 'Test')] })
    await E.spawn('P', 'Parent')
    await E.spawn('C', 'Child', 'P')
    await E.spawn('G', 'Grandchild', 'C')
    await E.spawn('Q', 'Other')
    await E.spawn('K', 'Kid', 'Q')
    await E.turnComplete('C')
    await E.turnComplete('Q')
    await E.call({ id: 'work', next: true })
    await E.call({ id: 'work', next: true })
    await E.call({ id: 'work', title: 'Add dark mode', stages: [S('B', 'Tokens', 'Toggle')] })
    const kept = (E.bar('work').agents ?? []).map(a => `${a.id}:${a.state}:${a.depth}`).join(' ')
    return [`kept ${kept}`, kept === 'P:running:0 G:running:1 K:running:0']
  },
  async closing_a_bar_keeps_an_agent_end_written_meanwhile(E) {
    // two agents end together while their bar is finished but still running: one's turn.complete closes the bar from
    // the latest stored copy, so the other's end written meanwhile stays; so does Stop when it sets a bar waiting.
    // The second end runs inside the first one's await: its clock read in the close, Stop's read in waitingIds
    const strips = id => (E.bar(id).agents ?? []).map(a => `${a.id}:${a.state}`).join(' ')
    await E.turnStart()
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two')] })
    for (const a of ['X', 'Y']) await E.spawn(a, `Helper ${a}`)
    // workflow agents: never listed, so nothing heals a strip left running
    E.agentRows.clear()
    await E.call({ id: 'main', next: true })
    await E.call({ id: 'main', next: true, state: 'running' })
    const now = E.$.clock.now
    let isFired = false
    E.$.clock.now = async () => {
      if (!isFired && E.bar('main').agents.find(a => a.id === 'X').state === 'done') {
        isFired = true
        await E.turnComplete('Y')
      }
      return now()
    }
    await E.turnComplete('X')
    E.$.clock.now = now
    E.tick(5000)
    await E.everyTick()
    const closed = `${E.bar('main').state}; ${strips('main')}`
    await E.call({ id: 'next', title: 'Next', stages: [S('Work', 'One', 'Two')] })
    for (const a of ['V', 'U']) await E.spawn(a, `Helper ${a}`)
    E.agentRows.clear()
    const get = E.$.__get
    let reads = 0
    E.$.__get = function (a) {
      if (a.ref.key === 'plans' && ++reads === 2) {
        E.$.__get = get
        return E.turnComplete('U').then(() => get.call(this, a))
      }
      return get.call(this, a)
    }
    await E.stop('Which one do you want?')
    E.$.__get = get
    const asked = `${E.bar('next').state}; ${strips('next')}`
    const ok = isFired && reads === 2 && closed === 'done; X:done Y:done' && asked === 'needs_input; V:running U:done'
    return [`Y ended inside X's close ${isFired}: ${closed}; U ended inside Stop ${reads === 2}: ${asked}`, ok]
  },
  async subagent_plan_leaves_the_main_bar(E) {
    // a subagent's or teammate's ExitPlanMode is its own plan: the main "plan" bar keeps its stages, no "shows this plan"
    // line, no chime. E.exitPlan names no agent, so the hooks loaded again over E.$ take the call; the main loop's call
    // through them, which does take the bar, shows they reach the hook
    await E.exitPlan({ result: { plan: '# Fix login\n## A\n- One\n- Two' } })
    await E.spawn('ag', 'Plan the cache')
    const hooks = []
    ;(await import(new URL(file, import.meta.url).href + '?n=' + Math.random())).register((ev, m, fn) => hooks.push(fn ? { ev, m, fn } : { ev, m: null, fn: m }), {})
    const send = (e, plan) => {
      const chain = hooks.filter(h => h.ev === 'tool.call' && (!h.m || Object.entries(h.m).every(([k, v]) => e[k] === v)))
      const run = (i, x) => (i < chain.length ? chain[i].fn(E.$, x, y => run(i + 1, y)) : Promise.resolve({ result: { plan } }))
      return run(0, e)
    }
    const shown = () => `${E.bar('plan').title} [${E.steps('plan')}]`
    const lines = r => (r.context ?? []).filter(c => c.startsWith('plan-progress')).length
    const before = E.sounds.length
    const theirs = await send({ tool: 'ExitPlanMode', agentId: 'ag', tool_use_id: 'x1' }, '# Add cache\n## B\n- Three\n- Four')
    const kept = shown()
    const chimes = E.sounds.length - before
    const ours = await send({ tool: 'ExitPlanMode', tool_use_id: 'x2' }, '# Add cache\n## B\n- Three\n- Four')
    const ok = kept === 'Fix login [One:active Two:pending]' && lines(theirs) === 0 && chimes === 0 && shown().startsWith('Add cache [') && lines(ours) === 1
    return [`after the agent's plan: ${kept}, lines ${lines(theirs)}, chimes ${chimes}; after the main loop's: ${shown()}, lines ${lines(ours)}`, ok]
  },
  async plan_file_writes_are_not_work(E) {
    // in plan mode Claude builds its plan in ~/.claude/plans/<name>.md a write at a time: that is planning, so no write
    // of it is refused or counted, and the gate still refuses the 4th edit of another file
    await E.turnStart()
    const plan = 'C:\\Users\\me\\.claude\\plans\\fix-login.md'
    let refused = 0
    for (let i = 0; i < 6; i++) if ((await E.raw('tool.call', { tool: i ? 'Edit' : 'Write', file_path: plan, tool_use_id: `p${i}` })).deny) refused++
    const edits = []
    for (let i = 0; i < 4; i++) edits.push((await E.work('Edit')).deny ? 'refused' : 'ran')
    return [`plan file writes refused ${refused}/6; then edits elsewhere: ${edits.join(', ')}`, refused === 0 && edits.join() === 'ran,ran,ran,refused']
  },
  async plan_file_named_by_plan_mode_is_not_work(E) {
    // plan mode's note can name a plan file outside ~/.claude/plans: writes to that file (by any spelling of its path)
    // are planning too, while edits of the files next to it are work, the 4th refused
    await E.raw('prompt.attachment', { type: 'plan_mode', detail: { planFilePath: 'D:\\work\\docs\\plans\\PLAN.md' } })
    await E.turnStart()
    let refused = 0
    for (let i = 0; i < 6; i++) if ((await E.raw('tool.call', { tool: 'Write', file_path: 'D:/work/docs/plans/PLAN.md', tool_use_id: `p${i}` })).deny) refused++
    const edits = []
    for (let i = 0; i < 4; i++) edits.push((await E.raw('tool.call', { tool: 'Edit', file_path: `D:/work/docs/plans/notes${i}.md`, tool_use_id: `e${i}` })).deny ? 'refused' : 'ran')
    return [`plan file writes refused ${refused}/6; then edits next to it: ${edits.join(', ')}`, refused === 0 && edits.join() === 'ran,ran,ran,refused']
  },
  async question_in_any_script_marks_the_bar_waiting(E) {
    // a turn ending on a question waits on the person whatever mark asks it: the full-width one (zh, ja), the Arabic
    // one, or one closed by markdown; each turns the bar amber, a statement does not
    await create(E)
    const seen = []
    for (const msg of ['要先修复测试吗？', 'هل أتابع؟', 'Should I **drop the old cache?**', 'Done.']) {
      await E.stop(msg)
      seen.push(E.bar('t').state)
      await E.submit()
    }
    return [`？ ؟ ?** and a statement: ${seen.join(', ')}`, seen.join() === 'needs_input,needs_input,needs_input,running']
  },
  async question_waits_while_background_work_runs(E) {
    // a question at the end of a turn waits on the person even while a dev server or a build runs in the background:
    // the bar turns amber, and the turn is not sent back
    await E.turnStart()
    await create(E)
    await E.raw('tool.call', { tool: 'Bash', command: 'npm run dev', run_in_background: true, tool_use_id: 'b1' })
    const msg = 'The dev server is up on :5173. Which page should I check first?'
    const r = await E.raw('classic.Stop', { stop_hook_active: false, last_assistant_message: msg, background_tasks: [{ id: 'b1', description: 'npm run dev' }] })
    return [`bar ${E.bar('t').state}, stop ${r.block ? 'sent back' : 'passes'}`, E.bar('t').state === 'needs_input' && !r.block]
  },
  async background_work_is_not_sent_back(E) {
    // a turn that did work and ends with something still running in the background is not sent back for its open bar,
    // whether the engine lists the task or the turn's last call started it; the same turn with neither is
    await E.turnStart()
    await create(E)
    await E.work('Edit')
    const stop = tasks => E.raw('classic.Stop', { stop_hook_active: false, last_assistant_message: 'Started it.', background_tasks: tasks })
    const listed = await stop([{ id: 'b1', description: 'npm run build' }])
    await E.raw('tool.call', { tool: 'Bash', command: 'npm run dev', run_in_background: true, tool_use_id: 'b2' })
    const started = await stop([])
    await E.work('Edit')
    const neither = await stop([])
    const b = r => (r.block ? 'sent back' : 'passes')
    return [`task listed: ${b(listed)}; started by the last call: ${b(started)}; neither: ${b(neither)}`, !listed.block && !started.block && !!neither.block]
  },
  async cleared_bars_stay_gone_after_a_reload(E) {
    // /progress-clear saves at once: a reload of the mod right after it, before the clock's next tick, does not bring
    // the session's saved bars back
    await create(E)
    await create(E, 'u')
    E.tick(1000)
    await E.everyTick()
    const saved = (await E.$.store.get('plans:session-1'))?.length ?? 0
    await E.command('progress-clear')
    await E.reload()
    const back = E.plans().map(p => p.id).join() || 'none'
    return [`saved ${saved} bars; after /progress-clear and a reload: ${back}`, saved === 2 && back === 'none']
  },
  async closed_bar_stays_gone_after_a_reload(E) {
    // closing the last bar with its ✕ saves at once: a reload right after, before the clock's next tick, does not bring
    // it back from the session's save
    await create(E)
    E.tick(1000)
    await E.everyTick()
    const saved = (await E.$.store.get('plans:session-1'))?.length ?? 0
    let press
    const walk = n => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      if (n.props?.key === 'close-t') press = n.props.onPress
      ;(n.children ?? []).forEach(walk)
    }
    walk(await E.raw('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 120, hasSurvey: false } }))
    await press()
    const closed = E.plans().length
    await E.reload()
    const back = E.plans().map(p => p.id).join() || 'none'
    return [`saved ${saved} bar; bars after ✕ ${closed}; after a reload: ${back}`, saved === 1 && closed === 0 && back === 'none']
  },
  async autoclosed_bar_stays_gone_after_a_reload(E) {
    // a finished bar leaving on its own is saved gone in the same tick: the tick does not save over it the list it read
    // before the bar left, so a reload right after does not bring the bar back
    await E.command('plan-progress-autoclose')
    await create(E)
    await E.call({ id: 't', state: 'done' })
    E.tick(1000)
    await E.everyTick()
    const saved = (await E.$.store.get('plans:session-1'))?.length ?? 0
    E.tick(30_000)
    await E.everyTick()
    const left = !E.bar('t')
    const after = (await E.$.store.get('plans:session-1'))?.length ?? 0
    await E.reload()
    const back = E.plans().map(p => p.id).join() || 'none'
    return [`saved ${saved}; left at 31 s ${left}, saved then ${after}; after a reload: ${back}`, saved === 1 && left && after === 0 && back === 'none']
  },
  async cut_session_end_still_rewrites_the_footer(E) {
    // a session.end whose save is cut short still notes the end: the host wipes the footer's figure with the state, and
    // the next session's first short reply writes the same figure again rather than leaving the footer blank
    const text = { kind: 'text', index: 0, text: 'x'.repeat(36) }
    const label = async () => (await E.footer('terminal', false)).filter(n => n.type === 'Text').map(n => (n.children ?? []).join('')).join(' ').trim()
    await E.stream([[{ kind: 'engine', ref: 1 }, 0], [text, 0], [text, 520], [text, 520]], { outputTokens: 300 })
    const before = await label()
    await create(E)
    // the save is cut at the bound: the session's last read of its bars rejects, and the handler goes on to its finally
    const get = E.$.__get
    let cut = false
    E.$.__get = function (a) {
      if (a.ref.key === 'plans' && !cut) {
        cut = true
        throw new Error('aborted')
      }
      return get.call(this, a)
    }
    try {
      await E.sessionEnd('clear')
    } catch {
      // the cut handler rejects, as it does at the bound
    } finally {
      E.$.__get = get
    }
    // the host wipes the state after a cut session.end as well
    E.$.__update({ ref: { key: 'speed' } }, () => ({ rate: null, isLive: false }))
    E.$.__update({ ref: { key: 'plans' } }, () => [])
    E.switchSession('session-2')
    const wiped = await label()
    await E.stream([[{ kind: 'engine', ref: 2 }, 0], [text, 0], [text, 50]], { outputTokens: 10 })
    const after = await label()
    const figure = x => x.match(/\d+ tok\/s/)?.[0] ?? null
    return [`cut ${cut}; before "${before}", wiped "${wiped}", after a short reply "${after}"`, cut && figure(before) !== null && figure(wiped) === null && figure(after) === figure(before)]
  },
  async cut_session_end_keeps_the_clock_off_the_wiped_state(E) {
    // a session.end whose save is cut short still marks the session ended: the clock's tick before the next id shows
    // keeps off the wiped state, so it does not delete the bars the session saved last, and a later resume finds them
    await create(E)
    E.tick(1000)
    await E.everyTick()
    await E.call({ id: 't', next: true })
    // the save is cut at the bound: the session's last read of its bars rejects, and the handler goes on to its finally
    const get = E.$.__get
    let cut = false
    E.$.__get = function (a) {
      if (a.ref.key === 'plans' && !cut) {
        cut = true
        throw new Error('aborted')
      }
      return get.call(this, a)
    }
    try {
      await E.sessionEnd('clear')
    } catch {
      // the cut handler rejects, as it does at the bound
    } finally {
      E.$.__get = get
    }
    E.$.__update({ ref: { key: 'plans' } }, () => [])
    E.tick(1000)
    await E.everyTick()
    E.switchSession('session-2')
    E.tick(1000)
    await E.everyTick()
    const saved = await E.$.store.get('plans:session-1')
    const kept = Array.isArray(saved) ? saved.map(p => p.id).join() : 'nothing'
    return [`cut ${cut}; after a tick on the wiped state and the next id, session-1 keeps: ${kept}`, cut && kept === 't']
  },
  // final review, drawing: #17/#45
  async wave_goes_on_from_a_whole_column(E) {
    // a bar that changes state (running, waiting, running, done) sets its wave on from a whole column: the .wm delay
    // times its speed is an integer, so the wave's steps stay on the flicker's 50 ms beat
    await E.call({ id: 'w', title: 'Wave', stages: [S('A', st('One', 'active'), 'Two'), S('B', 'Three')] })
    await E.view('w')
    const seen = []
    for (const [ms, state] of [[1234, 'needs_input'], [2345, 'running'], [777, 'done']]) {
      E.tick(ms)
      await E.call({ id: 'w', state })
      const [, dur, delay] = (await E.view('w')).track.match(/\.wm\{animation:wm ([\d.]+)s steps\(\d+\) infinite;animation-delay:calc\(var\(--w\) - ([\d.]+)s\)/) ?? []
      const speed = Math.round(233 / Number(dur))
      seen.push([E.bar('w').state, Number(delay), speed, Number(delay) * speed])
    }
    const ok = seen.length === 3 && seen.every(([, d, , cols]) => d > 0 && Math.abs(cols - Math.round(cols)) < 1e-6)
    return [seen.map(([s, d, v, cols]) => `${s} ${d}s x ${v}/s = ${+cols.toFixed(4)} cols`).join('; '), ok]
  },
  // final review, drawing: #18
  async hover_words_count_steps_without_times(E) {
    // the hover layer's words for steps finished with no time to read (the Agents bar's agents, steps sent done, a bar
    // closed by its state) count them instead of saying no step finished yet, which stays for a bar with none
    await E.spawn('a1', 'Scan')
    await E.spawn('a2', 'Read')
    await E.turnComplete('a1')
    await E.call({ id: 's', title: 'Sent', stages: [S('A', st('One', 'done'), st('Two', 'done'), st('Three', 'active'))] })
    await E.call({ id: 'c', title: 'Closed', stages: [S('A', 'x', 'y')] })
    const alts = async () => (await E.svgs()).filter(s => s.isInteractive && /^(Agents|Sent|Closed):/.test(s.alt)).map(s => s.alt)
    const open = (await alts()).at(-1)
    await E.call({ id: 'c', state: 'done' })
    const shown = await alts()
    const want = 'Agents: 1 of 2 steps finished, no times|Sent: 2 of 3 steps finished, no times|Closed: 2 of 2 steps finished, no times'
    return [`${shown.join('; ')}; before the close "${open}"`, shown.join('|') === want && open === 'Closed: no step finished yet']
  },
  // final review, drawing: #19
  async control_characters_never_reach_a_picture(E) {
    // an ANSI colour code's ESC, a bell or U+FFFE in a title, a step, an agent's description or a plan-mode line never
    // lands in a picture: XML has no place for them, escaped or not, and the whole picture would draw as broken
    const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/
    await E.call({ id: 't', title: 'Build \u001b[31mred\u001b[0m', stages: [S('Make\u0007', st('Compile \u001b[1mall\uFFFE', 'active'), 'Test\u0007 it'), S('Ship\uFFFE', 'Deploy \u001b[32mnow')] })
    await E.spawn('ag', 'Scan \u001b[33mlogs\u0007\uFFFE')
    await E.exitPlan({ result: { plan: '# Fix \u001b[31mcolour\u001b[0m\n## Steps\n1. Strip \u0007bells\n2. Keep \uFFFEtext' } })
    const svgs = await E.svgs()
    const all = svgs.map(s => s.source).join('')
    const broken = svgs.filter(s => bad.test(s.source)).map(s => s.alt.split(':')[0])
    const words = ['Make', 'Compile [1mall', 'Scan [33mlogs', 'Strip bells'].filter(w => all.includes(w))
    return [`${broken.length} of ${svgs.length} pictures carry a control character${broken.length ? ` (${broken.join(', ')})` : ''}; words drawn ${words.join(', ')}`, svgs.length >= 5 && broken.length === 0 && words.length === 4]
  },
  // final review, drawing: #20
  async korean_agent_name_fits_a_narrow_strip(E) {
    // in a narrow window (50-60 columns) an agent's Korean name is cut to its strip, ellipsis and all: measured as
    // Latin letters it was cut about half as short as it needed and ran past the strip's end
    await E.call({ id: 't', title: 'T', stages: [S('A', st('One', 'active'), 'Two')] })
    await E.spawn('ag', '데이터베이스 마이그레이션 스크립트를 검토하고 모든 테스트를 실행합니다')
    // the strip's 11.5 px regular face: a Hangul syllable an em wide, a space and the ellipsis as the mod measures them
    const width = s => (([...s].reduce((w, ch) => w + (/[가-힣]/.test(ch) ? 12 : ch === '…' ? 10.8 : 3.3), 0) * 11.5) / 12) * 0.96 * 1.06
    const seen = []
    let ok = true
    try {
      for (const cols of [50, 55, 60]) {
        globalThis.COLS = cols
        const strip = (await E.svgs()).find(s => s.alt?.startsWith('agent '))
        const [, x, name] = strip.source.match(/<text x="([\d.]+)" y="[\d.]+" class="sn">(.*?)<\/text>/)
        const end = Number(x) + width(name)
        seen.push(`${cols} cols "${name}" ends at ${end.toFixed(1)} of ${strip.width}`)
        ok &&= name.endsWith('…') && name.length > 4 && end <= strip.width - 5 + 0.01
      }
    } finally {
      delete globalThis.COLS
    }
    return [seen.join('; '), ok]
  },
  async more_agents_line_fits_a_narrow_strip(E) {
    // the "+N more agents" line of a big batch in a narrow window (50-60 columns, a long title beside the bar) ends
    // inside its strip: the done count gives way first, then the words are cut with an ellipsis
    await E.call({ id: 't', title: 'Refactor the payment service and all of its tests', stages: [S('A', st('One', 'active'), 'Two')] })
    for (let i = 1; i <= 8; i++) await E.spawn(`a${i}`, `Agent ${i}`)
    await E.turnComplete('a1')
    await E.turnComplete('a2')
    // the strip's text as the mod measures it (textWidth at 6.2 px): narrow and wide Latin letters, the rest 6.2
    const tw = s => [...s].reduce((w, ch) => w + (/[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMW]/.test(ch) ? 9.5 : 6.2), 0)
    const seen = []
    let ok = true
    try {
      for (const cols of [50, 60]) {
        globalThis.COLS = cols
        const more = (await E.svgs()).find(s => s.alt === 'more agents')
        const [, x, text] = more.source.match(/<text x="([\d.]+)" y="[\d.]+" class="sn st">(.*?)<\/text>/)
        const end = Number(x) + tw(text)
        seen.push(`${cols} cols "${text}" ends at ${end.toFixed(1)} of ${more.width}`)
        // at 50 columns even "4 more agents" is too long and takes the ellipsis
        ok &&= text.startsWith('4 more') && end <= more.width - 4 + 0.01 && (cols !== 50 || text.endsWith('…'))
      }
    } finally {
      delete globalThis.COLS
    }
    return [seen.join('; '), ok]
  },
  // final review, drawing: #21
  async long_pill_labels_keep_the_pill_to_320_px(E) {
    // on a wide track the pill is at most 320 px whatever its stage and step say: a label cut to its room keeps room
    // for its ellipsis, which used to push the pill up to a dozen px past it
    const seen = []
    globalThis.COLS = 200
    try {
      for (const [stage, step] of [['W'.repeat(40), 'Deploy'], ['Build', 'W'.repeat(60)], ['Build', 'M'.repeat(60)]]) {
        await E.call({ id: 'p', title: 'Pill', stages: [S(stage, st(step, 'active'), 'Next')] })
        const track = (await E.svgs()).find(s => !s.isInteractive && s.alt.startsWith('Pill:'))
        const widths = [...track.source.matchAll(/<rect x="-[\d.]+" y="0" width="([\d.]+)" height="22" rx="11"/g)].map(m => Number(m[1]))
        seen.push([`${stage.slice(0, 6)}…/${step.slice(0, 6)}…`, widths.length ? Math.max(...widths) : NaN, track.width])
      }
    } finally {
      delete globalThis.COLS
    }
    const ok = seen.every(([, w, W]) => w > 250 && w <= 320 && W >= 640)
    return [seen.map(([l, w, W]) => `${l} pill ${w} px on ${W}`).join('; '), ok]
  },
  // final review, drawing: #22
  async terminal_glide_is_drawn_again_once_over(E) {
    // a terminal bar that moves while frames can run glides there; a timer then bumps the tick once the glide is over,
    // so a band folded and shown again, which mounts its kept tree glide start and all, is drawn standing
    await E.turnStart()
    await create(E)
    await E.terminal(120)
    await E.call({ id: 't', next: true })
    E.tick(20)
    await E.terminal(120)
    const tick = () => E.$.__get({ ref: { key: 'tick' }, initial: 0 })
    const before = tick()
    E.tick(400)
    await E.fireTimers()
    const during = tick() - before
    E.tick(300)
    await E.fireTimers()
    const after = tick() - before
    return [`tick bumped ${during} times 0.4 s into the glide, ${after} by 0.7 s, once it is over`, during === 0 && after === 1]
  },
  // final review, drawing: #23
  async agent_model_name_drops_its_date(E) {
    // an agent's model, read from its first turn step, says "sonnet 4" for claude-sonnet-4-20250514 (a date is no minor
    // version) and still "haiku 4.5" for claude-haiku-4-5-20251001
    await create(E)
    await E.spawn('s', 'Sonnet helper')
    await E.stream([], { agentId: 's', model: 'claude-sonnet-4-20250514' })
    await E.spawn('h', 'Haiku helper')
    await E.step('h')
    const names = (await E.view('t')).strips.map(src => (src.match(/class="sn">(.*?)<\/text>/)?.[1] ?? '').replace(/<[^>]*>/g, ''))
    return [names.join('; '), names.join('|') === 'Sonnet helper (sonnet 4)|Haiku helper (haiku 4.5)']
  },
  async live_speed_learns_a_character_by_time(E) {
    // a short tool call pays ~120 tokens no character shows, written before its first piece: what a character is worth
    // is learned by time, so the long text after it reads bright within a quarter of its final figure, not half again
    // as high as the tokens over characters had it (#29). performance.now plays a clock the pieces move
    const was = Object.getOwnPropertyDescriptor(globalThis, 'performance')
    let T = 5000
    Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true })
    // pieces as [chunk, ms after the one before]: the clock moves as the engine pulls each one
    const timed = ps => (function* () { for (const [c, ms] of ps) { T += ms; yield [c, 0] } })()
    const size = ps => ps.reduce((n, [c]) => n + (c.text ?? c.json ?? c.name ?? '').length, 0)
    const writes = []
    const orig = E.$.__update.bind(E.$)
    E.$.__update = (a, fn) => { const v = orig(a, fn); if (a.ref.key === 'speed') writes.push(v); return v }
    try {
      // 27 characters every 50 ms: 150 tokens a second at 3.6 characters a token, the call's overhead too (0.8 s)
      const x = { kind: 'text', index: 0, text: 'x'.repeat(27) }
      const call = [[{ kind: 'engine', ref: 1 }, 0], [x, 800], [{ kind: 'tool', index: 1, id: 'r', name: 'Read' }, 50], ...Array.from({ length: 21 }, () => [{ kind: 'input', index: 1, json: 'a'.repeat(27) }, 50])]
      await E.stream(timed(call), { outputTokens: 120 + Math.round(size(call) / 3.6) })
      const from = writes.length
      const long = [[{ kind: 'engine', ref: 2 }, 0], ...Array.from({ length: 301 }, (_, i) => [x, i ? 50 : 0])]
      await E.stream(timed(long), { outputTokens: Math.round(size(long) / 3.6) })
      const bright = writes.slice(from).filter(w => w.isLive).map(w => Math.round(w.rate))
      const t = (await E.footer('desktop', true)).find(n => n.type === 'Text')
      const final = Number(t.children.join('').replace(/[^\d.]/g, ''))
      const off = Math.max(...bright.map(r => Math.abs(r / final - 1)))
      return [`15 s of text after the call: bright ${Math.min(...bright)}..${Math.max(...bright)} in ${bright.length} writes, final ${final}${t.props.dimColor ? ' dim' : ' BRIGHT'}, up to ${Math.round(off * 100)}% off`, bright.length >= 3 && off <= 0.25 && t.props.dimColor === true]
    } finally {
      Object.defineProperty(globalThis, 'performance', was)
    }
  },
  async live_speed_takes_the_lower_median(E) {
    // of an even count of learned factors the live estimate takes the lower one: after a short reply worth 0.4 token a
    // character and a long one worth 0.25, the next long text reads bright near its final figure, not 0.4/0.25 as high
    const was = Object.getOwnPropertyDescriptor(globalThis, 'performance')
    let T = 5000
    Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true })
    const timed = ps => (function* () { for (const [c, ms] of ps) { T += ms; yield [c, 0] } })()
    const writes = []
    const orig = E.$.__update.bind(E.$)
    E.$.__update = (a, fn) => { const v = orig(a, fn); if (a.ref.key === 'speed') writes.push(v); return v }
    try {
      // 27 characters every 50 ms; a reply of n pieces runs (n - 1) x 50 ms, its first piece not timed
      const x = { kind: 'text', index: 0, text: 'x'.repeat(27) }
      const reply = n => timed([[{ kind: 'engine', ref: 1 }, 0], ...Array.from({ length: n }, (_, i) => [x, i ? 50 : 0])])
      await E.stream(reply(23), { outputTokens: Math.round(0.4 * 22 * 27) })
      await E.stream(reply(61), { outputTokens: Math.round(0.25 * 60 * 27) })
      const from = writes.length
      await E.stream(reply(601), { outputTokens: Math.round(0.25 * 600 * 27) })
      const bright = writes.slice(from).filter(w => w.isLive).map(w => Math.round(w.rate))
      const t = (await E.footer('desktop', true)).find(n => n.type === 'Text')
      const final = Number(t.children.join('').replace(/[^\d.]/g, ''))
      const off = Math.max(...bright.map(r => Math.abs(r / final - 1)))
      return [`30 s of text: bright from ${bright[0]} to ${bright.at(-1)} in ${bright.length} writes, final ${final}${t.props.dimColor ? ' dim' : ' BRIGHT'}, up to ${Math.round(off * 100)}% off`, bright.length >= 5 && off <= 0.25 && Math.abs(bright.at(-1) / final - 1) <= 0.05 && t.props.dimColor === true]
    } finally {
      Object.defineProperty(globalThis, 'performance', was)
    }
  },
  async retried_response_is_timed_from_the_retry(E) {
    // an engine piece, then 1.5 s of backoff and the new request's wait, then the response: the marker does not start
    // its clock, so 210 tokens written in 1 s read 210 tok/s, not 210 over the 2.5 s from the marker (#30)
    const was = Object.getOwnPropertyDescriptor(globalThis, 'performance')
    let T = 5000
    Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true })
    const timed = ps => (function* () { for (const [c, ms] of ps) { T += ms; yield [c, 0] } })()
    try {
      const x = { kind: 'text', index: 0, text: 'x'.repeat(36) }
      await E.stream(timed([[{ kind: 'engine', ref: 1 }, 0], [{ kind: 'engine', ref: 2 }, 1500], ...Array.from({ length: 21 }, (_, i) => [x, i ? 50 : 0])]), { outputTokens: 210 })
      const t = (await E.footer('desktop', true)).find(n => n.type === 'Text')
      const text = t.children.join('').trim()
      return [`"${text}"${t.props.dimColor ? ' dim' : ' BRIGHT'} (210 tokens: 1 s from the retry = 210, 2.5 s from the marker = 84)`, text.replace(/\s+/g, ' ') === '⚡ 210 tok/s' && t.props.dimColor === true]
    } finally {
      Object.defineProperty(globalThis, 'performance', was)
    }
  },
  async server_tool_gap_is_no_retry(E) {
    // a 1.2 s gap before the text that the API spent running a tool itself (the advisor) looks like a retry, but its
    // wait is taken off already: the clock is not started over too, so 480 tokens in 2.4 s of writing read 200, not 400
    const was = Object.getOwnPropertyDescriptor(globalThis, 'performance')
    let T = 5000
    Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true })
    const timed = ps => (function* () { for (const [c, ms] of ps) { T += ms; yield [c, 0] } })()
    try {
      const x = { kind: 'text', index: 0, text: 'x'.repeat(36) }
      const serverToolUses = [{ id: 'a1', name: 'advisor', input: {}, startedAt: 1000, endedAt: 2200 }]
      await E.stream(timed([[{ kind: 'engine', ref: 1 }, 0], [{ kind: 'engine', ref: 2 }, 1200], ...Array.from({ length: 49 }, (_, i) => [x, i ? 50 : 0])]), { outputTokens: 480, serverToolUses })
      const t = (await E.footer('desktop', true)).find(n => n.type === 'Text')
      const text = t.children.join('').trim()
      return [`"${text}"${t.props.dimColor ? ' dim' : ' BRIGHT'} (480 tokens in 2.4 s of writing = 200; the wait taken off twice = 400)`, text.replace(/\s+/g, ' ') === '⚡ 200 tok/s' && t.props.dimColor === true]
    } finally {
      Object.defineProperty(globalThis, 'performance', was)
    }
  },
  // final review, follow-ups found while writing its tests
  async finished_plan_bar_resent_with_long_markdown_title_keeps_progress(E) {
    // a long plan-mode H1 in bold is stored without its markdown and then cut at 80: resent through the tool as written,
    // cut the tool's way, it is still the same plan grown, so its finished steps stay done
    const h1 = '**Move the session store to SQLite and keep the old JSON files readable for one more release**'
    await E.exitPlan({ result: { plan: `# ${h1}\n## Build\n- Add table\n- Copy rows\n## Check\n- Run tests` } })
    for (let i = 0; i < 3; i++) await E.call({ id: 'plan', next: true })
    const was = E.bar('plan').state
    const r = await E.call({ id: 'plan', title: h1, stages: [S('Build', 'Add table', 'Copy rows'), S('Check', 'Run tests', 'Commit')] })
    const seen = `${was} -> ${E.steps('plan')}; ${res(r)}`
    return [seen, seen === 'done -> Add table:done Copy rows:done Run tests:done Commit:active; plan: 3/4, running, active "Commit"']
  },
  async finished_bar_resent_with_link_or_marker_in_title_keeps_progress(E) {
    // a plan-mode H1 loses a link's address and a list marker as it is stored; a tool-made title kept as sent is matched
    // by the same title resent without its markdown. Another title is still the next task
    await E.exitPlan({ result: { plan: '# 1. Fix [login](https://example.com/issue/7) flow\n## Build\n- Add route\n## Check\n- Run tests' } })
    for (let i = 0; i < 2; i++) await E.call({ id: 'plan', next: true })
    await E.call({ id: 'plan', title: '1. Fix [login](https://example.com/issue/7) flow', stages: [S('Build', 'Add route'), S('Check', 'Run tests', 'Commit')] })
    await E.call({ id: 'tool', title: 'Fix `auth.ts`', stages: [S('Work', 'One', 'Two')] })
    for (let i = 0; i < 2; i++) await E.call({ id: 'tool', next: true })
    await E.call({ id: 'tool', title: 'Fix auth.ts', stages: [S('Work', 'One', 'Two', 'Three')] })
    await E.call({ id: 'other', title: 'Ship it', stages: [S('Work', 'Go')] })
    await E.call({ id: 'other', next: true })
    await E.call({ id: 'other', title: 'Ship it again', stages: [S('Work', 'Go')] })
    const seen = `${E.steps('plan')} | ${E.steps('tool')} | ${E.steps('other')}`
    return [seen, seen === 'Add route:done Run tests:done Commit:active | One:done Two:done Three:active | Go:active']
  },
  async long_id_cut_drops_its_trailing_dash(E) {
    // an id cut at 40 right after a separator ends on the letter before it, not on a dash
    await E.call({ id: 'a'.repeat(39) + ' b', title: 'Task', stages: [S('Work', 'One')] })
    const id = E.plans()[0]?.id ?? ''
    return [`id ${JSON.stringify(id)}`, id === 'a'.repeat(39)]
  },
  async resumed_subagent_takes_back_its_bar(E) {
    // a subagent's bar goes to the main loop when its run ends; resumed under the same id (a message sent to it) and
    // moving that bar again, it is the subagent's once more, and the main loop is not reminded of it
    await E.turnStart()
    await E.call({ id: 'main', title: 'Main', stages: [S('Work', 'One', 'Two', 'Three')] })
    await E.spawn('X', 'Helper')
    await E.call({ agentId: 'X', id: 'sub', title: 'Sub', stages: [S('Scan', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7')] })
    await E.turnComplete('X')
    const ended = E.bar('sub').byAgent ?? 'main'
    E.agentRows.get('X').status = 'running'
    await E.agentTool('X', 'Read')
    await E.call({ agentId: 'X', id: 'sub', next: true })
    const resumed = E.bar('sub').byAgent ?? 'main'
    await E.turnStart()
    await E.call({ id: 'main', next: true })
    const said = []
    for (let i = 0; i < 6; i++) {
      const r = await E.work('Edit')
      said.push(...(r.context ?? []).filter(c => c.includes('not updated')))
      await E.call({ agentId: 'X', id: 'sub', next: true })
    }
    const named = said.some(c => /\bsub\b/.test(c))
    return [`owner when X ended ${ended}, after it moved the bar again ${resumed}; reminders ${said.length}, naming sub ${named}`, ended === 'main' && resumed === 'X' && said.length > 0 && !named]
  },
  async resting_teammate_kept_by_the_next_task_still_folds(E) {
    // a pane teammate resting between its turns keeps its Done strip under the next task; with nothing else at work it
    // folds away when its batch did, as it would have under the last task
    await E.call({ id: 'main', title: 'Fix login', stages: [S('A', st('Patch', 'active'), 'Test')] })
    await E.spawn('T', 'Pane teammate')
    E.agentRows.get('T').status = 'idle'
    E.tick(1000)
    await E.everyTick()
    await E.call({ id: 'main', next: true })
    await E.call({ id: 'main', next: true })
    await E.call({ id: 'main', title: 'Add dark mode', stages: [S('B', 'Tokens', 'Toggle')] })
    const kept = (E.bar('main').agents ?? []).map(a => `${a.id}:${a.state}`).join(' ')
    const drawn = []
    for (const s of [0, 6, 60]) {
      E.tick(s * 1000)
      await E.everyTick()
      drawn.push(`${s}s:${(await E.view('main')).strips.length}`)
    }
    return [`kept ${kept}; strips drawn ${drawn.join(' ')}`, kept === 'T:done' && drawn.join(' ') === '0s:1 6s:0 60s:0']
  },
  async control_characters_never_reach_text_or_alt(E) {
    // an ANSI colour code's ESC, a bell, a C1 code or U+FFFF in a title, a note, a step or an agent's description never
    // reaches the terminal's text (it would run there as a command) nor a picture's alt text
    const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/
    await E.call({ id: 't', title: 'Build \u001b[31mred\u001b[0m', state: 'needs_input', note: 'Pick \u0007one\u009b2J', stages: [S('Make\u0007', st('Compile \u001b[1mall\uFFFF', 'active'), 'Test')] })
    await E.spawn('ag', 'Scan \u001b[33mlogs\u0007')
    const strings = []
    const collect = v => {
      if (typeof v === 'string') strings.push(v)
      else if (Array.isArray(v)) v.forEach(collect)
      else if (v && typeof v === 'object') Object.values(v).forEach(collect)
    }
    collect(await E.terminal(120))
    const alts = (await E.svgs()).map(s => s.alt)
    collect(alts)
    const found = strings.filter(t => bad.test(t)).map(t => JSON.stringify(t.slice(0, 40)))
    const title = E.bar('t').title
    return [`${found.length} strings with a control character${found.length ? ` (${found.slice(0, 3).join(', ')})` : ''}; title ${JSON.stringify(title)}`, found.length === 0 && title === 'Build [31mred[0m' && alts.length > 0]
  },
  // the pill jumping back as a bar finishes: the desktop shows the picture as an image and, rebuilt from the very same
  // source, starts its glide over; rebuilt from a new one, puts it where the source says
  async glide_offset_is_to_the_millisecond(E) {
    // a picture drawn again in the glide's steep start puts the pill where its time has got to: at a tenth of a second
    // the pill sat up to 40% of the way back, and two draws within the same tenth were the very same source
    await create(E)
    await E.view('t')
    await E.call({ id: 't', next: true })
    const begins = s => (s.match(/begin="-([\d.]+)s"/g) ?? []).join(' ')
    const first = (await E.view('t')).track
    E.tick(37)
    const mid = (await E.view('t')).track
    E.tick(3)
    const next = (await E.view('t')).track
    const ok = begins(first) === 'begin="-0.000s" begin="-0.000s"' && begins(mid) === 'begin="-0.037s" begin="-0.037s"' && mid !== next
    return [`at the move ${begins(first)}; 37 ms on ${begins(mid)}; 3 ms later a new source ${mid !== next}`, ok]
  },
  async footer_figure_change_redraws_a_gliding_bar(E) {
    // the footer's figure changes 120 ms into the finishing glide and the desktop asks the band again. Drawn anew, the
    // glide goes on from 0.12 s; handed back as drawn at the move, that very source rebuilt would play the glide over
    // (the pill back where it set off, then sliding again). With nothing written, the last answer comes back as it was
    await create(E)
    await E.reask()
    await E.call({ id: 't', state: 'done' })
    const track = svgs => svgs.find(s => s.alt.startsWith('Task:') && !s.isInteractive)?.source ?? ''
    const begin = s => s.match(/<animateTransform[^>]*begin="-([\d.]+)s"/)?.[1]
    const atMove = track(await E.reask())
    E.tick(120)
    E.$.__update({ ref: { key: 'speed' }, initial: { rate: null, isLive: false } }, s => ({ ...s, rate: 142, isLive: true }))
    const after = track(await E.reask())
    E.tick(40)
    const quiet = track(await E.reask())
    const ok = begin(atMove) === '0.000' && begin(after) === '0.120' && quiet === after
    return [`at the move ${begin(atMove)} s; after the footer's change ${begin(after)} s; with nothing written ${quiet === after ? 'handed back' : 'drawn anew'}`, ok]
  },
  async standing_picture_comes_as_the_glide_ends(E) {
    // the .3 s glide is drawn standing from .25 s on, timed from the move, with the pill all but there: a draw late in
    // the glide does not hold the gliding picture on, where a rebuild from that source would play the glide again,
    // and the picture is asked for then, so it is in place about as the glide ends
    await create(E)
    await E.view('t')
    const tickOf = () => E.$.__get({ ref: { key: 'tick' }, initial: 0 })
    await E.call({ id: 't', next: true })
    const gliding = (await E.view('t')).track.includes('<animateTransform')
    E.tick(200)
    const late = (await E.view('t')).track.includes('<animateTransform')
    const before = tickOf()
    E.tick(60)
    await E.fireTimers()
    const redrawn = tickOf() > before
    const standing = !(await E.view('t')).track.includes('<animateTransform')
    return [`glide ${gliding}, still at 200 ms ${late}, redrawn by 260 ms ${redrawn}, standing ${standing}`, gliding && late && redrawn && standing]
  },
  async sooner_end_is_drawn_first(E) {
    // an agent's strip changes its word, and 100 ms on the bar moves: the strip's .2 s morph ends before the glide is
    // drawn standing, and the band is drawn again at the morph's end, not held for the glide's
    await create(E)
    await E.spawn('ag1', 'Scan tests')
    await E.agentTool('ag1', 'Read')
    await E.view('t')
    E.tick(1000)
    await E.fireTimers()
    await E.agentTool('ag1', 'Grep')
    await E.view('t')
    E.tick(100)
    await E.call({ id: 't', next: true })
    const moved = await E.view('t')
    const morphing = moved.strips[0]?.includes(' mo ') ?? false
    const gliding = moved.track.includes('<animateTransform')
    const tickOf = () => E.$.__get({ ref: { key: 'tick' }, initial: 0 })
    const before = tickOf()
    E.tick(110)
    await E.fireTimers()
    const redrawn = tickOf() > before
    const then = await E.view('t')
    const still = !(then.strips[0]?.includes(' mo ') ?? true)
    const glidesOn = then.track.includes('<animateTransform')
    return [`morph ${morphing}, glide ${gliding}, drawn again by the morph's end (210 ms) ${redrawn}, strip standing then ${still}, glide still on ${glidesOn}`, morphing && gliding && redrawn && still && glidesOn]
  },
  async dollar_goes_only_to_top_level_functions(E) {
    // the engine scans a module before it loads it and refuses one that hands a hook's $ to anything but a function
    // declared at the top of the file, or keeps $ in a variable: a dev mod's reload fails and the old code stays on,
    // an install draws nothing. isToolMissing, declared inside register, was handed $ that way. Read from the source,
    // whatever build the cases run on
    void E
    const src = readFileSync(process.env.SOURCE ?? new URL('../hooks/register.tsx', import.meta.url), 'utf8')
    const top = new Set([...src.matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*=\s*(?:async\s*)?(?:function\b|\()/gm)].map(m => m[1] ?? m[2]))
    const handed = [...src.matchAll(/(?<![\w.$])(\w+)\(\$[,)]/g)].map(m => m[1]).filter(n => n !== 'read' && n !== 'update')
    const stray = [...new Set(handed.filter(n => !top.has(n)))]
    const kept = [...src.matchAll(/^.*[^=!<>]=\s*\$\s*[;\n].*$/gm)].map(m => m[0].trim())
    return [`$ handed to ${new Set(handed).size} functions, ${stray.length ? `not declared at the top: ${stray.join(', ')}` : 'all declared at the top'}; $ kept in a variable ${kept.length ? kept.join(' | ') : 'nowhere'}`, handed.length > 0 && stray.length === 0 && kept.length === 0]
  },
}

let failed = 0
for (const [id, fn] of Object.entries(C)) {
  if (process.env.ONLY && !process.env.ONLY.split(",").includes(id)) continue
  const E = await boot(file)
  let observed, ok
  try {
    ;[observed, ok] = await fn(E)
  } catch (err) {
    ;[observed, ok] = ['THREW ' + (err?.stack ?? err), false]
  }
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(32)} ${observed}`)
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exitCode = failed ? 1 : 0
