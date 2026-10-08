// the audit's cases after the fixes: each check states the behaviour the mod should have now
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
    const req = E.toolSpec.inputSchema.properties.stages.items.properties.steps.items.required
    return [`${E.steps('t')}; ${res(r)}; required ${req}`, E.steps('t') === 'A:active B:pending' && req.join() === 'title']
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
    return [`#${hit + 1}: ${out[hit]?.context}`, hit === 5 && out[hit].context.some(c => c.includes('t '))]
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
    const step = E.toolSpec.inputSchema.properties.stages.items.properties.steps.items.properties
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
    // the track picture stays as it was; a strip's clock offset follows the time passed, since the desktop
    // rebuilds the band on every redraw and a reused offset would restart the clock from the earlier draw
    const delay = v => v.strips.join('').match(/--d:-([\d.]+)s/)?.[1]
    const a = await E.view('t')
    E.tick(7000)
    const b = await E.view('t')
    const ok = a.track === b.track && delay(a) === '0.0' && delay(b) === '7.0'
    return [`track same ${a.track === b.track}, strip clock ${delay(a)}s → ${delay(b)}s`, ok]
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
    const ok = seen.every((d, i) => d === (3.5 + i).toFixed(1))
    return [seen.join(' '), ok]
  },
  async running_pill_has_live_clock(E) {
    await create(E)
    E.tick(83_000)
    await E.call({ id: 't', next: true })
    const src = (await E.view('t')).overlay
    const delay = src.match(/--d:-([\d.]+)s/)?.[1]
    return [`clock ${src.includes('class="kc0 ')}, delay ${delay}s`, src.includes('class="kc0 ') && delay === '83.0' && !src.includes('{{T:')]
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
    const first = await boot('./register.mjs', kept)
    await create(first)
    await first.spawn('ag1', 'Scan tests')
    await first.call({ id: 't', next: true })
    await first.everyTick()
    const second = await boot('./register.mjs', kept)
    const bar = second.bar('t')
    const ok = !!bar && second.steps('t') === first.steps('t') && (bar.agents ?? []).length === 0
    return [`restored ${!!bar}, same steps ${bar ? second.steps('t') === first.steps('t') : false}, strips dropped ${bar ? (bar.agents ?? []).length === 0 : false}`, ok]
  },
  async done_bar_twinkles_like_running(E) {
    await create(E)
    await E.call({ id: 't', state: 'done' })
    const src = (await E.view('t')).track
    return [`twinkle ${/class="b\d t\d"/.test(src)}`, /class="b\d t\d"/.test(src)]
  },
  async pill_covers_checkpoints(E) {
    await create(E)
    const src = (await E.view('t')).overlay
    const hit = src.indexOf('class="h'), pill = src.indexOf('<g transform="translate('), tip = src.indexOf('class="tp')
    return [`hit ${hit} < pill ${pill} < tip ${tip}`, hit > 0 && hit < pill && pill < tip]
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
    return [out.map(o => `${o.cols}: ${o.row.trim()}`).join(' | '), fits && out.every(o => o.row.includes('One 1/2'))]
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
    return [`frame timers ${E.frameTimers()}`, E.frameTimers() === 0]
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
  async finished_bar_leaves_after_30s(E) {
    await create(E)
    await E.call({ id: 't', state: 'done' })
    const ticks = async n => {
      for (let i = 0; i < n; i++) {
        E.tick(1000)
        await E.everyTick()
      }
    }
    await ticks(29)
    const at29 = !!E.bar('t')
    await ticks(2)
    const at31 = !!E.bar('t')
    return [`shown at 29s ${at29}, at 31s ${at31}`, at29 && !at31]
  },
  async autoclose_command_keeps_finished_bars(E) {
    // /plan-progress-autoclose turns auto-close off and on again; off, a finished bar stays until closed
    const ticks = async n => {
      for (let i = 0; i < n; i++) {
        E.tick(1000)
        await E.everyTick()
      }
    }
    const off = (await E.command('plan-progress-autoclose')).text
    await create(E)
    await E.call({ id: 't', state: 'done' })
    await ticks(60)
    const kept = !!E.bar('t')
    const on = (await E.command('plan-progress-autoclose')).text
    await ticks(1)
    const gone = !E.bar('t')
    return [`off: "${off}"; kept a minute ${kept}; on: "${on}"; gone ${gone}`, /stay until closed/.test(off) && kept && /leave 30 s/.test(on) && gone]
  },
  async autoclose_choice_lasts_a_new_session(E) {
    // the choice is kept in the store, so the next session starts with auto-close off as well
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
    return [`stored ${kept.get('autoclose')}, bar after 40 s in the next session ${!!B.bar('t')}`, kept.get('autoclose') === 'false' && !!B.bar('t')]
  },
  async done_bar_seconds_comes_from_the_config() {
    // the doneBarSeconds option sets how long a finished bar stays
    globalThis.OPTIONS = { doneBarSeconds: 10 }
    try {
      const F = await boot(file)
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
      await E.svgs()
      for (let i = 0; i < 20; i++) {
        E.tick(1000)
        await E.everyTick()
      }
      return [`commands run ${E.procs.length}`, E.procs.length === 0]
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
    return [`band ${r[0]}/${r[1]}, footer ${r[2]}/${r[3]}, desktop ${r[4]}`, r.join() === '0,1,0,1,1']
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
    // the pill names only the stage at work, so each stage is made the active one in turn
    for (const move of [null, { done: ['A', 'B'] }, { done: ['C'] }]) {
      if (move) await E.call({ id: 't', ...move })
      for (const r of (await E.terminal(120)).filter(n => n.type === 'Raster')) {
        const w = new Uint32Array(Uint8Array.from(Buffer.from(r.props.cells, 'base64')).buffer)
        for (let i = 0; i < w.length; i += 3) {
          const cp = w[i]
          if (cp > 0xffff || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff) || BAD.has(cp)) bad.push(cp.toString(16))
        }
      }
    }
    return [bad.length ? `refused cells ${[...new Set(bad)].join(',')}` : 'every cell one column', bad.length === 0]
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
    return [changed.length ? `rewritten ${changed.join(', ')}` : 'no cell rewritten', changed.length === 0]
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
    await E.turnStart()
    await create(E)
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
    await E.turnComplete()
    await E.terminal(120)
    await E.everyTick()
    await E.call({ id: 't', done: ['A', 'B'] })
    await E.terminal(120)
    await E.everyTick()
    return [`frame clock ${E.frameTimers()}`, E.frameTimers() === 0]
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
  async folded_bar_on_the_desktop_counts_its_agents(E) {
    // folded, the strips are gone, so the pill says how many agents are at work
    await E.turnStart()
    await create(E)
    await E.spawn('ag1', 'Scan routes')
    await E.spawn('ag2', 'Read cart store')
    await E.command('progress-agents')
    const track = (await E.svgs()).find(s => /^Task:/.test(s.alt)).source
    return [`pill says running ${/2 running/.test(track)}`, /2 running/.test(track)]
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
    const B = await boot(file, kept)
    const ids = B.plans().map(p => p.id).join(',')
    return [`restored: ${ids || 'nothing'}`, !ids.includes('agents:auto')]
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
}

let failed = 0
for (const [id, fn] of Object.entries(C)) {
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
