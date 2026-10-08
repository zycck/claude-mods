# Claude Code mods

**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Deutsch](README.de.md) · [Français](README.fr.md)

## plan-progress

Live progress bars above the Claude Code prompt. Claude splits a task into stages and steps, and the bar fills as it works. The subagents for each task are listed under its bar.

![plan-progress: two tasks with their agents, a question, an error, a plan rewritten mid-run, both tasks done](media/plan-progress.gif)

[Watch with sound (MP4, 14 s)](media/plan-progress.mp4)

- One row per task: state, title, bar, percent, close button
- The pill on the bar shows the current stage and step; hover it for the time spent so far
- Stages are capsules, steps are dots; hover one to see when it was reached
- A finished bar turns green and shows the total time, then leaves after 30 s (`doneBarSeconds` in `/config`)
- Four states: running, needs input, error, done
- Each subagent gets a row under its task: name, model and effort, current tool, time
- The plan can change mid-run; finished steps are kept by title
- Bars are saved per session and come back when the session is resumed
- Short sounds for a question, an error and completion
- Works in the desktop app and in the terminal
- In the terminal the bar follows a light or dark GNOME desktop with the `auto` theme, and takes the colors of the active Omarchy theme

### Install

Requires Claude Code 2.1.286 or newer (`claude --version`; `claude update` to upgrade). On older versions the hooks module does not load and no bars appear; the startup banner says `plan-progress: hooks module did not load`.

```
/plugin marketplace add zycck/claude-mods
/plugin install plan-progress@zycck-mods
```

Update:

```
claude plugin marketplace update zycck-mods
claude plugin update plan-progress@zycck-mods
```

### Commands

- `/progress` shows or hides the bars
- `/progress-clear` removes all bars
- `/progress-agents` folds the agent strips under the bars, or shows them again (the chevron button next to a bar's ✕ does it for that bar)
- `/plan-progress-autoclose` turns off finished bars leaving on their own, or turns it back on; the choice is kept across sessions

The **Progress** button in the footer does the same as `/progress`.

### How it works

The mod registers a `plan_progress` tool. Claude sends the plan once, then short updates such as `{id, next: true}` or `{id, done: ["Routes"]}`. An unknown step name is refused with the list of the bar's steps. A plan approved in plan mode becomes the bar `plan`. Agent rows come from engine events and cost no tokens.

On the desktop the bar is an SVG image with a hover layer on top. In the terminal it is a character grid that animates only while Claude is working.

### Tests

`plugins/plan-progress/tests` runs the real module against a stub engine: `node compile.cjs ../hooks/register.tsx register.mjs`, then `node regress.mjs` and `node scenarios.mjs`.

## License

MIT
