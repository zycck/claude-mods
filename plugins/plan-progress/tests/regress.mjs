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
const MACHINE = ['MAC', 'DARK', 'TERM_PROGRAM', 'THEME']
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
  async same_bar_same_source_while_time_passes(E) {
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
      return [`track ${tint.toString(16)}, commands run ${E.procs.length}`, lum(tint) > LUM_MID && E.procs.length === 0]
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
      return [`commands run ${E.procs.length}, track ${tint.toString(16)}`, E.procs.length === 1 && lum(tint) < LUM_MID]
    })
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
