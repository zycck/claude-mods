// a stand-in engine around the real, compiled register.tsx: hooks run as written, only $ is faked
globalThis.h = (type, props, ...children) => ({ type, props: props ?? {}, children })

export const TOOL = 'mcp__plan-progress__plan_progress'

export async function boot(file, kept = new Map()) {
  // a fresh module instance per scenario, so its module-level maps start empty
  const mod = await import(new URL(file, import.meta.url).href + '?n=' + Math.random())
  const hooks = []
  mod.register((event, a, b) => hooks.push(b ? { event, matcher: a, fn: b } : { event, matcher: null, fn: a }), {})

  const state = new Map()
  let now = 1_000_000
  const timers = []
  const every = []
  const sounds = []
  let toolSpec = null
  const blits = []
  // the machine the stub plays: globalThis.MAC (default true), DARK for the macOS appearance,
  // TERM_PROGRAM for the terminal, THEME for Claude Code's theme setting
  const procs = []
  const $ = {
    __get(a) {
      return state.has(a.ref.key) ? state.get(a.ref.key) : a.initial
    },
    __update(a, fn) {
      const v = fn(this.__get(a))
      state.set(a.ref.key, v)
      return v
    },
    clock: { now: async () => now, after: (ms, cb) => void timers.push({ at: now + ms, cb }), every: (ms, cb) => {
        const t = { ms, cb, isOn: true }
        every.push(t)
        return { cancel: () => void (t.isOn = false) }
      },
    },
    // the plugin's store outlives a boot when the caller passes the same map, as it outlives a restart
    store: {
      get: async k => (kept.has(k) ? JSON.parse(kept.get(k)) : undefined),
      set: async (k, v) => void kept.set(k, JSON.stringify(v)),
      delete: async k => void kept.delete(k),
      keys: async () => [...kept.keys()],
    },
    session: { id: async () => 'session-1' },
    audio: { play: async ({ asset }) => void sounds.push(asset) },
    process: {
      run: async argv => {
        procs.push(argv.join(' '))
        if (globalThis.MAC === false) throw new Error(`${argv[0]}: not found`)
        if (argv[0] === 'defaults') return { exitCode: globalThis.DARK ? 0 : 1, stdout: globalThis.DARK ? 'Dark\n' : '', stderr: '' }
        if (argv[0] === '/bin/sh') return { exitCode: 0, stdout: globalThis.TERM_PROGRAM ?? '', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    plugin: { root: '/plugin' },
    tool: { register: async spec => void (toolSpec = spec) },
    command: { register: async () => {} },
    config: { list: async () => (globalThis.THEME === undefined ? [] : [{ key: 'theme', value: globalThis.THEME }]) },
    ui: {
      resolve: e => (e?.surface === 'terminal' ? { Box: 'Box', Button: 'Button', Text: 'Text', Raster: 'Raster' } : { Box: 'Box', Button: 'Button', Text: 'Text', Svg: 'Svg' }),
      toast: () => {},
      blit: async args => {
        blits.push(args)
        return {}
      },
    },
  }
  const matches = (m, e) => !m || Object.entries(m).every(([k, v]) => e[k] === v)
  const dispatch = (event, e, core) => {
    const chain = hooks.filter(h => h.event === event && matches(h.matcher, e))
    const run = (i, ev) => (i < chain.length ? chain[i].fn($, ev, ev2 => run(i + 1, ev2)) : Promise.resolve(core(ev)))
    return run(0, e)
  }

  let use = 0
  const uid = () => 'u' + ++use
  const coreRuns = []
  const api = {
    $,
    sounds,
    blits,
    procs,
    setTheme: value => dispatch('config.set', { key: 'theme', value, previous: globalThis.THEME ?? 'dark' }, () => ({ value })),
    coreRuns,
    get toolSpec() {
      return toolSpec
    },
    tick: ms => (now += ms),
    // one period of every live timer; a timer started during the pass waits for the next one
    everyTick: async () => {
      for (const t of [...every]) if (t.isOn) await t.cb()
    },
    frameTimers: () => every.filter(t => t.isOn && t.ms < 100).length,
    fireTimers: async () => {
      for (const t of timers.splice(0)) await t.cb()
    },
    call: input => dispatch('tool.call', { tool: TOOL, tool_use_id: uid(), ...input }, () => ({ result: 'core reached' })),
    work: (tool = 'Edit', isReadOnly = false) =>
      dispatch('tool.call', { tool, command: 'x', tool_use_id: uid() }, () => {
        coreRuns.push(tool)
        return isReadOnly ? { result: {}, text: '', isReadOnly: true } : { result: {}, text: '' }
      }),
    exitPlan: result => dispatch('tool.call', { tool: 'ExitPlanMode', tool_use_id: uid() }, () => result),
    spawn: (agentId, description, parentAgentId) => dispatch('agent.spawn', { description, subagentType: 'general-purpose', parentAgentId }, () => ({ agentId, model: 'claude-haiku-4-5-20251001' })),
    step: (agentId, effort) => (async () => { const g = hooks.find(h => h.event === 'turn.step').fn($, { agentId, model: 'claude-haiku-4-5-20251001', effort, turnId: 't', index: 0, messageCount: 1 }, async function* () {}); for await (const _ of g); })(),
    agentTool: (agentId, tool) => dispatch('tool.call', { tool, agentId, tool_use_id: uid() }, () => ({ result: {} })),
    turnComplete: (agentId, reason = 'answer') => dispatch('turn.complete', { agentId, reason }, () => ({})),
    turnStart: () => dispatch('turn.start', {}, () => ({})),
    // a question from the main loop, or from a subagent's loop when agentId is given
    ask: agentId => dispatch('tool.call', { tool: 'AskUserQuestion', agentId, tool_use_id: uid() }, () => ({ result: {} })),
    // an agent's call held for approval: the permission check answers "ask" and the call stays open until release()
    hold: async agentId => {
      const id = uid()
      let release
      const held = new Promise(r => (release = r))
      let checked
      const asked = new Promise(r => (checked = r))
      const call = dispatch('tool.call', { tool: 'Bash', agentId, tool_use_id: id }, async () => {
        await dispatch('tool.check', { tool: 'Bash', tool_use_id: id }, () => ({ decision: 'ask' }))
        checked()
        await held
        return { result: {} }
      })
      await asked
      return { release: async () => (release(), call) }
    },
    command: name => dispatch('command.run', { command: name, args: '' }, () => ({})),
    sessionStart: () => dispatch('session.start', {}, () => ({})),
    stop: (msg = 'Done.') => dispatch('classic.Stop', { stop_hook_active: false, last_assistant_message: msg, background_tasks: [] }, () => ({})),
    plans: () => $.__get({ ref: { key: 'plans' }, initial: [] }),
    bar: id => api.plans().find(p => p.id === id),
    steps: id => (api.bar(id)?.stages ?? []).flatMap(s => s.steps.map(st => `${st.title}:${st.status}`)).join(' '),
    // what the person sees, read from the real AbovePrompt render: the Svg alt text and source of one bar
    svgs: async () => {
      const tree = await dispatch('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: globalThis.COLS ?? 120, hasSurvey: false } }, () => null)
      const found = []
      const walk = n => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object') return
        if (n.type === 'Svg') found.push(n.props)
        ;(n.children ?? []).forEach(walk)
      }
      walk(tree)
      return found
    },
    terminal: async (cols = 120, isFullscreen = false) => {
      const tree = await dispatch('ui.render', { component: 'AbovePrompt', surface: 'terminal', requestId: 'band', viewport: { columns: cols, rows: 40, isFullscreen }, props: { bodyColumns: cols, hasSurvey: false } }, () => null)
      const found = []
      const walk = n => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object') return
        found.push(n)
        ;(n.children ?? []).forEach(walk)
      }
      walk(tree)
      return found
    },
    footer: async (surface, isFullscreen) => {
      const tree = await dispatch('ui.render', { component: 'SessionMode', surface, viewport: { columns: 120, rows: 40, isFullscreen }, props: { modes: [] } }, () => null)
      const found = []
      const walk = n => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object') return
        found.push(n)
        ;(n.children ?? []).forEach(walk)
      }
      walk(tree)
      return found
    },
    view: async id => {
      const tree = await dispatch('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 140, hasSurvey: false } }, () => null)
      const found = []
      // a strip's drawing sits in a keyed row with its open button; it takes the row's key
      const walk = (n, key) => {
        if (Array.isArray(n)) return n.forEach(c => walk(c, key))
        if (!n || typeof n !== 'object') return
        if (n.type === 'Svg') found.push({ ...n.props, key: n.props.key ?? key })
        ;(n.children ?? []).forEach(c => walk(c, n.props?.key ?? key))
      }
      walk(tree)
      const title = api.bar(id)?.title
      const svg = found.find(p => p.alt.startsWith(title + ':'))
      // the bar's agent strips are separate drawings keyed after it
      const strips = found.filter(p => String(p.key ?? '').startsWith(`strip-${id}-`))
      // the see-through hover layer drawn over the track
      const overlay = found.slice(found.indexOf(svg) + 1).find(p => p.isInteractive)
      return svg ? { alt: svg.alt, source: svg.source + strips.map(p => p.source).join('') + (overlay?.source ?? ''), track: svg.source, overlay: overlay?.source ?? '', strips: strips.map(p => p.source), height: svg.height } : null
    },
  }
  await api.sessionStart()
  return api
}

export const S = (name, ...steps) => ({ name, steps: steps.map(s => (typeof s === 'string' ? { title: s, status: 'pending' } : s)) })
export const st = (title, status) => ({ title, status })
