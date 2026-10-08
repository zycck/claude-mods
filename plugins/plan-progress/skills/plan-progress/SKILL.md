---
name: plan-progress
description: Reference for the plan_progress bars (tool ops, /progress commands). The working rules are already in the system prompt; load only when the user asks about the bars or a call was refused.
---

# plan_progress

Create once with the whole plan, then move it with short ops.

Create: `{id, title, stages:[{name, steps:[{title}]}]}`; `kind:"todo"` for one flat list. 2-7 stages, titles of at most 4 words, in the user's language, one `id` per task. A step's `status` defaults to `pending`; the first open step becomes active.

Ops:
- `{id, next:true}` — active step done, next one active (past the last step, the first one left open)
- `{id, done:["A"], active:"B"}` — mark done, pick current; steps active before B count as done
- `{id, failed:"B", note}` — error
- `{id, state:"needs_input", note}` — before asking the user
- `{id, state:"done"}` — finish

The plan changed: resend `stages` under the same `id`. Steps sent without a status keep their done by title; send `status:"active"` to redo one. Short ops sent along apply on top.

A title the bar does not have is refused with the bar's step list. A title used twice means the one still open.

A plan approved in plan mode lands on the bar `plan`; move that one.

The result says `done/total, state, active step`; no need to check the bar.

User commands: `/progress` toggles the bars, `/progress-clear` removes them, `/progress-agents` folds or shows the agent strips (on the desktop and in the fullscreen terminal each bar with strips also has a fold button), `/plan-progress-autoclose` turns off or on a finished bar leaving on its own after `doneBarSeconds` (30 s by default). The **Progress** button in the footer is always shown while the mod is loaded.

No `plan_progress` tool in the session means the mod's hooks module did not load: it needs Claude Code 2.1.286 or newer (`claude --version`).
