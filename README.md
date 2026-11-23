# pi-herdr-workers

One Pi package for **teams of agents in [Herdr](https://herdr.dev) app panes**, **`/split-handoff` / `/split-fork`**, **scheduled/event/idle `/loop` re-wakes**, and **background monitors** that are just Herdr panes.

No extra npm dependencies. Peer APIs come from Pi (`pi-coding-agent`, `pi-tui`, `typebox`).

Requires the **Herdr Mac app**: pi must run in an app terminal (`HC_TERMINAL_ID` is set), with `hc` (herdr-core) and `herdr-app` on `PATH`. Terminals are driven with `hc` (get / send / keys / read / label) and the window with `herdr-app` (`ls`, `status`, `do pane.split|pane.swap|pane.focus|tab.new`). The old `herdr` TUI CLI (`HERDR_ENV=1`, `herdr pane|agent …`) is not used: its terminals are invisible in the app.

New panes start pi through `/usr/bin/env PATH=<this pi's PATH> /bin/sh -c 'cd … && exec pi …'`, because app terminals get the core's login environment, which can lack mise/nvm entries. Set `PI_HERDR_PI_ARGV` (JSON array, e.g. `["pi","-ne","-e","/path/ext.ts"]`) to start something other than `pi`.

```bash
pi install git:github.com/tobi/pi-herdr-workers
```

Or a local checkout:

```bash
pi install /path/to/pi-herdr-workers
```

Then `/reload` (or start a new session).

---

## `/team` — orchestrator and workers

Turns this pane into an orchestrator and puts other Pi agents in neighboring Herdr app panes.

| Command | Effect |
|---|---|
| `/team add [right\|down\|left\|up] [type] [purpose…]` | Enable team mode and have the LLM create a worker with `CreateAgentPanel` |
| `/team list` | Show workers / orchestrator |
| `/team release <name>` | Stop orchestrating that worker (pane stays open) |
| `/team adopt <name>` | Control an existing agent (hc address, hc name or team name) without creating a pane |
| `/team from <id>` | Worker: adopt an orchestrator after startup |

`/team` once flips **team mode**: status shows `Orchestrator …`, the system prompt gets the orchestrator brief, and `CreateAgentPanel` appears. The orchestrator is addressed by its hc terminal address (e.g. `t3y`) unless its terminal has an hc name.

### `CreateAgentPanel`

```json
{ "name": "scout", "direction": "right", "type": "explore",
  "purpose": "explore only, never edit files", "model": "xai/grok-4.6",
  "thinking": "low", "initial_prompt": "…" }
```

Workers are named `agent-<name>` (or `agent-<type>` / `agent-N`); `herdr-app do pane.split` cannot name a terminal, so the name is stored as the hc label `pi.team.name`. First worker on a side splits toward it (left/up = split, then `pane.swap`); further workers on that side stack below / right of the last one (tracked in team state, since herdr-app reports no pane geometry). The split runs `pi --orchestrated-by … --team-name …` directly, and focus is handed back if the split took it.

### `SendToAgent`

```json
{ "target_id": "agent-explore", "message": "…", "priority": false }
```

`priority: true` steers; otherwise follow-up. Transport is a per-terminal inbox under `$XDG_RUNTIME_DIR/pi-herdr-worker/<hc address>/`. Pi receives a durable, model-visible custom message attributed to the sending agent, not a fabricated user message. Non-Pi targets fall back to `hc send`.

---

## `/split-handoff` and `/split-fork`

Unfocused named Pi splits in the current Herdr app tab (first split right of this pane, later ones below the most recent split of this session still open in the tab). The new pi gets the handoff/fork prompt as its first message (argv), and its terminal is labelled `pi.team.name=split-…`.

| Command | Effect |
|---|---|
| `/split-handoff [goal]` | Runs a **summarize/crystallize** pass on this thread (current model), then starts a new Pi in a split with that handoff — not a raw transcript dump |
| `/split-fork [instruction]` | Clones the active session branch into a new pane; this pane keeps going |
| `/splits` | Durable split history; `/splits cancel` aborts a startup |

Status bar shows `split · summarizing` then pane/prompt.

---

## `/loop` — re-wake this agent

Same session, no extra workers. Idle-safe wakes when Pi is sitting there.

```text
/loop 5m check the deploy
/loop event tool_execution_end review that tool
/loop finish the release
```

Tools: `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete`.

- Cron: `5m`, `2h`, or a five-field cron expression
- Event: a Pi event source
- Idle/dynamic: `/loop <goal>` then `LoopUpdate` with `continue` / `paused` / `completed`

State is journaled in pi's session JSONL via `appendEntry` by default. Existing session-specific `.pi/loops/` snapshots are imported on first use, without deleting the originals. Explicit project/shared-file scopes still use the locked file store, with a session-log audit mirror. `PI_LOOP_SCOPE=memory` remains ephemeral.

Recurring loops expire after seven days unless recreated. Cap: 25 loops. `LoopCreate` defaults to 25 wakes unless `maxFires` is supplied; `/loop` scheduled/event loops cap at 25, and dynamic goals at 20.

Event subscriptions survive reload/resume. Wakes wait for `agent_settled`, not the end of an individual retry or tool cycle. Built-in `tool_execution_start`, `tool_execution_end`, `turn_start`, `turn_end`, and `agent_settled` events are bridged onto the extension bus; Loop tools do not trigger their own tool-event loops. Other sources must be emitted by an extension.

Read-only wakes enforce a tool-call gate (read/search/list and loop bookkeeping only); shell commands and arbitrary custom tools are blocked until the run settles. This deliberately stays conservative if other work is queued during that run.

---

## Monitors — Herdr app panes, not hidden processes

`MonitorCreate` / `MonitorList` / `MonitorStop`

- Ensures a **Monitor** tab in the current space (`herdr-app do tab.new … --focus false`)
- Each command gets a **down-split** pane whose terminal carries the hc label `pi.monitor=<hash>`; the command is typed with `hc send`
- **The same command in the same cwd reuses that pane**
- Panes **stay open** when the command finishes
- Creating an already-running monitor attaches to it; it never sends `ctrl+c` or restarts it
- `MonitorStop` validates the terminal's label and current foreground process before sending `ctrl+c` (`hc keys`) — it does not close the pane
- Handles and command/cwd metadata survive reload; restored process status starts **unknown**, and `MonitorList` refreshes it

```text
MonitorCreate command="npm test" description="Run test suite"
MonitorList
MonitorStop monitorId="1"
```

---

## Durable state and lifecycle

- Team snapshots are immutable, versioned, restored on `session_start` and `/tree`, and scoped to the source session. A new fork does not inherit another session's worker-control authority. Legacy unversioned team records remain readable.
- Loops and monitor handles are **operational facts**: `/tree` does not undo an external launch or resurrect a deleted controller. New session IDs do not inherit active controllers or monitor handles. In explicit shared-store mode, the shared file remains authoritative.
- Pending loop wakes are journaled before delivery and acknowledged only after their custom message is present in SessionManager. Team messages retain their mailbox file until that same persistence boundary. `message_end` is too early: pi invokes that hook before saving the message.
- Restoring state never creates panes, restarts commands, or re-sends an already recorded wake. A dynamic iteration awaiting `LoopUpdate` stays awaiting an update after reload; interrupted external work is not blindly repeated. Inspect it and provide the update, or pause/resume it explicitly from `/loop` when safe. A reached fire cap cannot be resumed; renewal requires a new authorized controller.
- Timers, subscriptions, in-flight requests, sampled process status and UI contexts are runtime resources, not replayed state. Shutdown aborts/cleans them without killing worker or monitor panes. Headless pi instances do not claim a pane's team mailbox.
- Status items are compact counts, next-wake/awaiting-update state and unverified/unavailable monitors. Detailed rosters remain in `/team list`, `LoopList`, and `MonitorList`.
- Durability follows pi's session storage contract: `--no-session` is still ephemeral, and a brand-new session may buffer entries until its first assistant response. External side effects and local journal appends are not a distributed transaction; inspect ambiguous interrupted operations rather than automatically retrying them.

## What’s not in this package

- `@trevonistrevon/pi-loop` kitchen sink (workflows, native tasks, pi-subagents batches)
- `OrchestrationCreate` — use `/team` + `CreateAgentPanel` instead

---

## Layout

```text
lib/herdr-app.ts             hc / herdr-app wrappers shared by everything below
extensions/herdr-worker.ts   /team, CreateAgentPanel, SendToAgent
extensions/split-handoff.ts  /split-handoff, /split-fork, /splits
loop/                        /loop + Monitor* (Herdr app-backed)
```
