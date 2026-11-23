/**
 * Herdr worker — orchestrator/worker messaging between pi agents living in Herdr app panes.
 * Terminals are driven with `hc` (herdr-core) and the window with `herdr-app`; the old `herdr` TUI CLI is not used.
 *
 * Orchestrator side:
 *   /team add [right|down|left|up] [name]   start a pi worker agent-<name> (default agent-N) beside this
 *                                          pane; further workers stack along that side
 *   /team list                              show workers
 *   /team release <name>                    drop a worker (pane stays open)
 *   /team adopt <name>                      control an existing agent (hc address, hc name or team name) without creating a pane
 *
 * Worker side:
 *   pi --orchestrated-by <id>      (this is what /team add passes when starting the worker)
 *   /team from <id>                adopt an orchestrator after startup
 *   /orchestrated-by <id>          same
 *
 * Both sides get the SendToAgent tool. Delivery goes through a per-pane inbox that this
 * extension watches; receivers inject a durable custom message (steer when priority,
 * follow-up otherwise). Targets that are not a listening pi fall back to `hc send`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
	LABEL_NAME,
	LABEL_TITLE,
	appSpaces,
	findTerminal,
	hc,
	inHerdrApp,
	piArgv,
	resolveTerminal,
	selfTerminal,
	setLabels,
	splitPane,
	swapPanes,
	terminalGet,
	terminalList,
	type TerminalInfo,
} from "../lib/herdr-app.js";

// ───────────────────────── herdr app env ─────────────────────────

const IN_APP = inHerdrApp();
/** This pi's hc terminal address. Mailboxes and peer identity are keyed by it. */
const SELF = selfTerminal();
const ENTRY_TYPE = "herdr-worker";
const STATUS_KEY = "herdr-worker";
const TOOL_NAME = "SendToAgent";
const CREATE_TOOL = "CreateAgentPanel";
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(["add", "list", "release", "from", "status", "help", "adopt", "right", "down", "left", "up"]);
type Direction = "right" | "down" | "left" | "up";
const DIRECTIONS: Direction[] = ["right", "down", "left", "up"];
const isDirection = (s: string | undefined): s is Direction => !!s && (DIRECTIONS as string[]).includes(s);
const WORKER_PREFIX = "agent-";

function mailboxRoot(): string {
	const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
	return path.join(base, "pi-herdr-worker");
}
function sanitize(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function mailboxDir(terminal: string): string {
	return path.join(mailboxRoot(), sanitize(terminal));
}
function inboxDir(terminal: string): string {
	return path.join(mailboxDir(terminal), "inbox");
}
function listeningFile(terminal: string): string {
	return path.join(mailboxDir(terminal), "listening.json");
}

// ───────────────────────── types ─────────────────────────

interface WorkerMeta {
	type?: string; // e.g. "explore", "implement", "review"
	purpose?: string; // free text, e.g. "explore only, never edit files"
	model?: string; // provider/id
	terminal?: string; // hc terminal address
	pane?: string; // herdr-app pane id
	direction?: Direction; // side of the orchestrator this worker's stack lives on
}

interface State {
	version?: 1;
	sessionId?: string;
	teamMode?: boolean; // set once /team is used here -> this pi is an orchestrator
	workers: string[]; // agent names (or hc addresses) we orchestrate
	meta?: Record<string, WorkerMeta>;
	orchestratedBy?: string; // agent name or hc terminal address
	role?: { type?: string; purpose?: string }; // what our orchestrator said we are for
}

/** Agent types with a preferred model. Anything else defaults to the orchestrator's model. */
const TYPE_MODELS: Record<string, string> = {
	explore: "xai/grok-4.6",
	research: "xai/grok-4.6",
};
const TYPE_HINTS: Record<string, string> = {
	explore: "Explore only: read, search, run read-only commands, and report findings. Do not create, edit, or delete files, and do not commit.",
	research: "Research only: gather facts, read code/docs, and report. No file modifications.",
	review: "Review only: read diffs/code and report actionable findings. Do not modify files.",
	implement: "Implement: make the requested code changes, verify them, and report what changed and how it was tested.",
	test: "Testing: write/run tests, report failures with repro steps. Avoid unrelated changes.",
};

interface AgentInfo {
	terminal: string; // hc address
	tabId?: string;
	name?: string;
	kind?: string;
	status?: string;
	cwd?: string;
}

interface Envelope {
	type: "message" | "control";
	from: { id: string; terminal: string; name?: string; role: "orchestrator" | "worker" | "agent" };
	message: string;
	priority: boolean;
	ts: number;
	// control
	action?: "orchestrated-by" | "released";
}

// ───────────────────────── message framing ─────────────────────────

function roleLabel(role: Envelope["from"]["role"]): string {
	return role === "orchestrator" ? "Orchestrator" : role === "worker" ? "Worker" : "Agent";
}

function frameMessage(env: Envelope): string {
	const label = roleLabel(env.from.role);
	const who = env.from.name ? `${label} "${env.from.name}" in terminal ${env.from.terminal}` : `${label} in terminal ${env.from.terminal}`;
	return [
		`[agent] A message just arrived from another of your user's agents: ${who}.`,
		"This is another agent reaching out — not the user typing here. It arrived asynchronously, and your user can already see it in this chat.",
		"",
		env.message.trim(),
		"",
		`If it needs a reply or an action, handle it: reply to ${label} with SendToAgent (their id: ${env.from.id}), which reaches them on a later turn — not a live back-and-forth. If it is just an FYI with nothing for you to do, it is fine to stay silent — no need to reply just to acknowledge it.`,
	].join("\n");
}

// ───────────────────────── extension ─────────────────────────

export default function (pi: ExtensionAPI) {
	let state: State = { workers: [] };
	let ctxRef: ExtensionContext | undefined;
	let selfInfo: AgentInfo | undefined;
	let watcher: fs.FSWatcher | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	let draining = false;
	let stopped = false;
	const lifetime = new AbortController();
	let createQueue = Promise.resolve();
	const inFlightEnvelopes = new Set<string>();
	const interactive = () => IN_APP && !!SELF && ctxRef?.mode === "tui" && !stopped;

	pi.registerFlag("orchestrated-by", {
		description: "Herdr worker: id (agent name or hc terminal address) of the orchestrator controlling this pi",
		type: "string",
	});
	pi.registerFlag("team-name", {
		description: "Herdr worker: this worker's team name (set by the orchestrator; also stored as an hc label)",
		type: "string",
	});
	pi.registerFlag("team-role", {
		description: "Herdr worker: '<type>: <purpose>' describing what this worker is for (set by the orchestrator)",
		type: "string",
	});

	// ── herdr app helpers ──

	function opts(o: { timeout?: number; signal?: AbortSignal } = {}) {
		const operationSignal = o.signal ?? ctxRef?.signal;
		const signal = operationSignal ? AbortSignal.any([operationSignal, lifetime.signal]) : lifetime.signal;
		signal.throwIfAborted();
		return { timeout: o.timeout ?? 15000, signal };
	}

	function toAgentInfo(t: TerminalInfo): AgentInfo {
		return { terminal: t.address, tabId: t.tab, name: t.name, kind: t.app, status: t.status, cwd: t.cwd };
	}

	async function agentGet(target: string): Promise<AgentInfo | undefined> {
		try {
			// Workers we created are known by terminal; confirm it still carries that name.
			const known = state.meta?.[target]?.terminal;
			if (known) {
				const t = await terminalGet(pi.exec, known, opts());
				if (t?.live && t.name === target) return toAgentInfo(t);
			}
			const t = await resolveTerminal(pi.exec, target, opts());
			return t ? toAgentInfo(t) : undefined;
		} catch {
			return undefined;
		}
	}

	async function agentList(): Promise<AgentInfo[]> {
		try {
			return (await terminalList(pi.exec, opts())).map(toAgentInfo);
		} catch {
			return [];
		}
	}

	async function refreshSelf(): Promise<AgentInfo> {
		const t = SELF ? await terminalGet(pi.exec, SELF, opts()).catch(() => undefined) : undefined;
		selfInfo = t ? toAgentInfo(t) : { terminal: SELF };
		const flagName = pi.getFlag("team-name");
		if (!selfInfo.name && typeof flagName === "string" && flagName) {
			selfInfo.name = flagName;
			await setLabels(pi.exec, SELF, { [LABEL_NAME]: flagName }, opts()).catch(() => {});
		}
		return selfInfo;
	}

	function selfId(): string {
		return selfInfo?.name || selfInfo?.terminal || SELF || "unknown";
	}

	function myRoleToward(targetId: string, target?: AgentInfo): Envelope["from"]["role"] {
		const ids = [targetId, target?.name, target?.terminal].filter(Boolean) as string[];
		if (ids.some((id) => state.workers.includes(id))) return "orchestrator";
		if (state.orchestratedBy && ids.includes(state.orchestratedBy)) return "worker";
		return "agent";
	}

	// ── persistence + ui ──

	function persist() {
		if (stopped || !ctxRef) return;
		state.version = 1;
		state.sessionId = ctxRef.sessionManager.getSessionId();
		pi.appendEntry(ENTRY_TYPE, structuredClone(state));
	}

	function restore(ctx: ExtensionContext) {
		let found: State | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) found = entry.data as State;
		}
		// A clone must not acquire the source session's live team authority.
		if (found?.sessionId && found.sessionId !== ctx.sessionManager.getSessionId()) found = undefined;
		state = found && Array.isArray(found.workers) ? structuredClone(found) : { workers: [] };
	}

	function statusText(): string | undefined {
		const parts: string[] = [];
		if (state.workers.length) parts.push(`team · ${state.workers.length} worker${state.workers.length === 1 ? "" : "s"} · /team list`);
		else if (state.teamMode && !state.orchestratedBy) parts.push("team · orchestrator");
		if (state.orchestratedBy) parts.push(`team ⇐ ${state.orchestratedBy.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 40)}`);
		return parts.length ? parts.join(" · ") : undefined;
	}

	function inTeam(): boolean {
		return interactive() && (state.workers.length > 0 || !!state.orchestratedBy);
	}

	function isOrchestrator(): boolean {
		return interactive() && !!state.teamMode && !state.orchestratedBy;
	}

	/**
	 * SendToAgent exists only while we are part of a team (orchestrating or orchestrated).
	 * CreateAgentPanel exists only for an orchestrator (after /team was used here; never for workers).
	 */
	function syncTool() {
		const active = pi.getActiveTools();
		const want = new Map<string, boolean>([
			[TOOL_NAME, inTeam()],
			[CREATE_TOOL, isOrchestrator()],
		]);
		let next = active.filter((t) => want.get(t) !== false);
		for (const [tool, on] of want) if (on && !next.includes(tool)) next = [...next, tool];
		if (next.length !== active.length || next.some((t, i) => t !== active[i])) pi.setActiveTools(next);
	}

	function updateUi() {
		syncTool();
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		const text = statusText();
		ctx.ui.setStatus(STATUS_KEY, text);
		void updatePaneTitle();
	}

	async function updatePaneTitle() {
		if (!IN_APP || !SELF) return;
		// herdr-app has no per-pane title API; keep the team role visible as an hc label.
		let title: string | undefined;
		if (state.orchestratedBy) title = `${selfInfo?.name ? `${selfInfo.name} ` : ""}⇐ ${state.orchestratedBy}`;
		else if (state.workers.length) title = `orchestrating ${state.workers.join(", ")}`;
		try {
			await setLabels(pi.exec, SELF, { [LABEL_TITLE]: title }, opts());
		} catch {}
	}

	// ── inbox (receiving) ──

	function startListening() {
		if (!interactive() || watcher || poller) return;
		const dir = inboxDir(SELF);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(listeningFile(SELF), JSON.stringify({ pid: process.pid, ts: Date.now(), id: selfId() }));
		try {
			watcher = fs.watch(dir, () => void drainInbox());
		} catch {}
		poller = setInterval(() => void drainInbox(), 3000);
		poller.unref?.();
		void drainInbox();
	}

	function stopListening() {
		watcher?.close();
		watcher = undefined;
		if (poller) clearInterval(poller);
		poller = undefined;
		try {
			fs.rmSync(listeningFile(SELF), { force: true });
		} catch {}
	}

	async function drainInbox() {
		if (draining || !interactive()) return;
		draining = true;
		try {
			const dir = inboxDir(SELF);
			let files: string[] = [];
			try {
				files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
			} catch {
				return;
			}
			for (const f of files) {
				if (stopped) return;
				if (inFlightEnvelopes.has(f)) continue;
				const full = path.join(dir, f);
				const acknowledged = ctxRef?.sessionManager.getEntries().some((e) => e.type === "custom_message" && e.customType === "herdr-worker.message" && (e.details as { envelopeId?: string })?.envelopeId === f);
				if (acknowledged) { fs.rmSync(full, { force: true }); continue; }
				let env: Envelope | undefined;
				try {
					env = JSON.parse(fs.readFileSync(full, "utf8"));
				} catch {
					continue; // probably mid-write; next drain picks it up
				}
				if (env) await deliver(env, f);
				if (!stopped && !inFlightEnvelopes.has(f)) fs.rmSync(full, { force: true });
			}
		} catch (error) {
			if (!stopped && ctxRef?.hasUI) ctxRef.ui.notify(`Team inbox: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			draining = false;
		}
	}

	/**
	 * Resolve our known peers (workers + orchestrator) to live pane ids. A sender is trusted only if
	 * its claimed pane currently hosts one of those peers — the inbox is writable by anyone local.
	 */
	async function knownPeerPanes(): Promise<Map<string, string>> {
		const ids = [...state.workers, ...(state.orchestratedBy ? [state.orchestratedBy] : [])];
		const out = new Map<string, string>(); // terminal -> id we know it by
		if (!ids.length) return out;
		const agents = await agentList();
		for (const id of ids) {
			const a = agents.find((x) => x.name === id || x.terminal === id);
			if (a) out.set(a.terminal, id);
		}
		return out;
	}

	async function deliver(env: Envelope, envelopeId: string) {
		const ctx = ctxRef;
		if (!env.from || typeof env.from.id !== "string" || typeof env.message !== "string") return;
		const peers = await knownPeerPanes();
		if (stopped) return;
		const known = env.from?.terminal ? peers.get(env.from.terminal) : undefined;

		if (env.type === "control") {
			if (env.action === "orchestrated-by") {
				// Adoption handshake: only while we have no orchestrator (or it is the current one re-asserting).
				if (state.orchestratedBy && !known) {
					ctx?.hasUI && ctx.ui.notify(`Ignored adoption request from ${env.from.id} (terminal ${env.from.terminal}); already orchestrated by ${state.orchestratedBy}.`, "warning");
					return;
				}
				state.orchestratedBy = env.from.id;
				persist();
				updateUi();
				ctx?.hasUI && ctx.ui.notify(`Now orchestrated by ${env.from.id}`, "info");
			} else if (env.action === "released" && known && state.orchestratedBy === env.from.id) {
				state.orchestratedBy = undefined;
				persist();
				updateUi();
				ctx?.hasUI && ctx.ui.notify(`Released by orchestrator ${env.from.id}`, "info");
			}
			return;
		}

		if (!known) {
			ctx?.hasUI &&
				ctx.ui.notify(
					`Dropped message from unknown agent ${env.from?.id ?? "?"} (terminal ${env.from?.terminal ?? "?"}). Only your orchestrator and workers may message you; use /team adopt or /orchestrated-by to allow it.`,
					"warning",
				);
			return;
		}
		inFlightEnvelopes.add(envelopeId);
		// The mailbox is the outbox until pi actually persists this custom message.
		pi.sendMessage({ customType: "herdr-worker.message", content: frameMessage(env), display: true,
			details: { envelopeId, from: env.from } }, { triggerTurn: true, deliverAs: env.priority ? "steer" : "followUp" });
	}

	// ── sending ──

	function isListening(terminal: string): boolean {
		try {
			const j = JSON.parse(fs.readFileSync(listeningFile(terminal), "utf8"));
			if (typeof j.pid !== "number") return false;
			process.kill(j.pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	function writeEnvelope(terminal: string, env: Envelope) {
		const dir = inboxDir(terminal);
		fs.mkdirSync(dir, { recursive: true });
		const name = `${String(env.ts).padStart(15, "0")}-${Math.random().toString(36).slice(2, 8)}.json`;
		const tmp = path.join(dir, `.${name}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
		fs.renameSync(tmp, path.join(dir, name));
	}

	async function makeEnvelope(targetId: string, target: AgentInfo | undefined, message: string, priority: boolean, extra: Partial<Envelope> = {}): Promise<Envelope> {
		if (!selfInfo) await refreshSelf();
		return {
			type: "message",
			from: { id: selfId(), terminal: SELF, name: selfInfo?.name, role: myRoleToward(targetId, target) },
			message,
			priority,
			ts: Date.now(),
			...extra,
		};
	}

	async function send(targetId: string, message: string, priority: boolean, signal?: AbortSignal): Promise<string> {
		if (!IN_APP) throw new Error("Not running inside the Herdr app (no HC_TERMINAL_ID); SendToAgent is unavailable.");
		const target = await agentGet(targetId);
		if (!target) {
			const known = (await agentList()).map((a) => a.name ?? a.terminal);
			throw new Error(`No live agent "${targetId}". Known agents: ${known.join(", ") || "(none)"}${state.workers.length ? `. Your workers: ${state.workers.join(", ")}` : ""}${state.orchestratedBy ? `. Your orchestrator: ${state.orchestratedBy}` : ""}`);
		}
		if (target.terminal === SELF) throw new Error("Refusing to send a message to yourself.");
		const peer = state.workers.includes(targetId) || state.workers.includes(target.name ?? "") || state.workers.includes(target.terminal) || [state.orchestratedBy].includes(targetId) || [state.orchestratedBy].includes(target.name ?? "") || [state.orchestratedBy].includes(target.terminal);
		if (!peer) {
			throw new Error(
				`"${targetId}" is not in your team (it would drop the message anyway). Workers: ${state.workers.join(", ") || "(none)"}; orchestrator: ${state.orchestratedBy ?? "(none)"}. Use /team add or /team adopt first.`,
			);
		}

		const env = await makeEnvelope(targetId, target, message, priority);
		const label = target.name ?? target.terminal;

		if (target.kind === "pi" && isListening(target.terminal)) {
			writeEnvelope(target.terminal, env);
			return `Delivered to ${label} (terminal ${target.terminal}, ${target.status ?? "unknown"}) via inbox as ${priority ? "steer (priority)" : "follow-up"}. Replies arrive on a later turn.`;
		}

		// Fallback: type it into the agent's pane. No steer/follow-up control here.
		// hc send holds while a person has an unfinished draft (up to ~60s), so allow for that.
		await hc(pi.exec, ["send", target.terminal, frameMessage(env)], opts({ timeout: 90000, signal }));
		return `Typed into ${label} (terminal ${target.terminal}, ${target.kind ?? "agent"}, no inbox listener) via \`hc send\`. Priority flag not applicable there.`;
	}

	async function sendControl(targetId: string, action: NonNullable<Envelope["action"]>): Promise<boolean> {
		const target = await agentGet(targetId);
		if (!target || !isListening(target.terminal)) return false;
		const env = await makeEnvelope(targetId, target, "", false, { type: "control", action });
		writeEnvelope(target.terminal, env);
		return true;
	}

	// ── tool ──

	pi.registerTool({
		name: "SendToAgent",
		label: "Send To Agent",
		description:
			"Send a message to another of your user's agents running in a Herdr app pane (an orchestrator or a worker). " +
			"The message is delivered asynchronously and shows up in their chat as an '[agent] ...' custom message; replies come back the same way on a later turn. " +
			"target_id is the agent name (e.g. a worker name) or hc terminal address (e.g. t3y). priority=true steers the target mid-task (interrupts its current turn); priority=false queues a follow-up after its current work finishes.",
		promptSnippet: "Message another Herdr-hosted agent (orchestrator ↔ worker) asynchronously",
		promptGuidelines: [
			"Use SendToAgent to delegate to workers or report back to your orchestrator; write self-contained messages with goal, context, constraints, and what to report back.",
			"SendToAgent is fire-and-forget: do not wait or poll for a reply — end your turn and react when the '[agent]' message arrives.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Full message body (Markdown). Self-contained: the recipient does not see your conversation." }),
			target_id: Type.String({ description: "Agent name or hc terminal address of the recipient" }),
			priority: Type.Optional(Type.Boolean({ description: "true = steer (interrupt recipient's current turn). false/omitted = follow-up after its current work.", default: false })),
		}),
		async execute(_id, params, signal) {
			const text = await send(params.target_id, params.message, params.priority ?? false, signal);
			return { content: [{ type: "text", text }], details: { target: params.target_id, priority: params.priority ?? false, message: params.message, status: text } };
		},
		// Inline UX: the interesting part is the message itself, not that one was sent.
		renderCall(args, theme) {
			const arrow = args.priority ? theme.fg("warning", " ⇨ ") : theme.fg("muted", " → ");
			let head = theme.fg("toolTitle", theme.bold("SendToAgent")) + arrow + theme.fg("accent", args.target_id ?? "…");
			if (args.priority) head += theme.fg("warning", " (priority / steer)");
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const d = (result.details ?? {}) as { message?: string; status?: string };
			const message = d.message ?? (context.args as any)?.message ?? "";
			if (isPartial) return new Text(theme.fg("dim", "sending…"), 0, 0);
			if (context.isError) {
				const err = result.content?.map((c: any) => c.text ?? "").join("\n") ?? "failed";
				return new Text(theme.fg("error", err), 0, 0);
			}
			const lines = message.split("\n");
			const maxLines = expanded ? Number.POSITIVE_INFINITY : 12;
			const shown = lines.slice(0, maxLines);
			let out = shown.map((l: string) => theme.fg("accent", "│ ") + l).join("\n");
			if (lines.length > shown.length) out += "\n" + theme.fg("dim", `│ … ${lines.length - shown.length} more lines`);
			if (d.status) out += "\n" + theme.fg("dim", d.status);
			return new Text(out, 0, 0);
		},
	});

	// ── orchestrator commands ──

	async function adopt(name: string): Promise<string> {
		const existing = await agentGet(name);
		if (!existing) throw new Error(`No live agent "${name}" to adopt.`);
		if (existing.terminal === SELF) throw new Error("That is this terminal.");
		await refreshSelf();
		if (!state.workers.includes(name)) state.workers.push(name);
		persist();
		updateUi();
		const ok = await sendControl(name, "orchestrated-by");
		return ok
			? `Adopted existing agent ${name} (terminal ${existing.terminal}) as worker.`
			: `Adopted ${name} (terminal ${existing.terminal}) — it is not a listening pi; run \`/orchestrated-by ${selfId()}\` inside it (or it can't SendToAgent back).`;
	}

	/**
	 * All workers are named `agent-<something>` (team names are global labels, so the prefix both
	 * avoids clashes with hand-started agents and marks the pane as part of the worker stack).
	 * `/team add`           -> agent-1, agent-2, … (first free number)
	 * `/team add ci`        -> agent-ci, or agent-ci-2, … if taken
	 */
	async function uniqueName(requested: string): Promise<string> {
		const taken = new Set((await agentList()).flatMap((a) => (a.name ? [a.name] : [])));
		if (!requested) {
			for (let i = 1; i < 1000; i++) if (!taken.has(`${WORKER_PREFIX}${i}`)) return `${WORKER_PREFIX}${i}`;
			throw new Error("Could not find a free agent-N name");
		}
		const base = (requested.startsWith(WORKER_PREFIX) ? requested : `${WORKER_PREFIX}${requested}`).slice(0, 32);
		if (!taken.has(base)) return base;
		for (let i = 2; i < 1000; i++) {
			const suffix = `-${i}`;
			const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
			if (!taken.has(candidate)) return candidate;
		}
		throw new Error(`Could not find a free name based on "${base}"`);
	}

	/**
	 * Workers live in a stack on one side of the orchestrator (default: a column to the right).
	 * herdr-app reports no pane geometry, so the stack is tracked in our own state:
	 * - No live worker of ours on that side in this tab -> split the orchestrator toward `dir`.
	 *   Panes split only right/down, so left/up = split right/down, then swap the two panes.
	 * - Otherwise -> split the most recent live worker on that side along the stack
	 *   (down for a left/right column, right for an up/down row).
	 */
	async function pickSplit(dir: Direction): Promise<{ selfPane: string; pane: string; direction: "right" | "down"; swap: boolean; how: string }> {
		const spaces = await appSpaces(pi.exec, opts());
		const here = findTerminal(spaces, SELF);
		if (!here) throw new Error(`Terminal ${SELF} is not shown in the Herdr app window.`);
		const panesInTab = new Map(here.tab.terminals.map((t) => [t.terminal, t.pane]));
		const stack = state.workers
			.map((w) => state.meta?.[w])
			.filter((m): m is WorkerMeta => !!m?.terminal && (m.direction ?? "right") === dir && panesInTab.has(m.terminal));
		const last = stack.at(-1);
		if (!last) {
			const native: "right" | "down" = dir === "left" || dir === "right" ? "right" : "down";
			return { selfPane: here.pane, pane: here.pane, direction: native, swap: dir === "left" || dir === "up", how: `new ${native === "right" ? "column" : "row"} ${dir}` };
		}
		const along: "right" | "down" = dir === "left" || dir === "right" ? "down" : "right";
		const pane = panesInTab.get(last.terminal!)!;
		return { selfPane: here.pane, pane, direction: along, swap: false, how: `stacked ${along === "down" ? "below" : "right of"} ${last.terminal}` };
	}

	interface CreateOpts {
		name?: string;
		direction?: Direction;
		type?: string;
		purpose?: string;
		model?: string;
		thinking?: string;
		initialPrompt?: string;
	}

	async function createAgent(o: CreateOpts, ctx: ExtensionContext): Promise<{ name: string; terminal: string; pane?: string; model?: string; how: string; adopted?: boolean }> {
		if (!IN_APP || !SELF) throw new Error("Not running inside the Herdr app.");
		const dir: Direction = o.direction ?? "right";
		const type = o.type?.trim().toLowerCase() || undefined;
		const requested = (o.name?.trim() || type || "").toLowerCase();
		if (requested && (!NAME_RE.test(requested) || RESERVED.has(requested))) throw new Error(`Invalid worker name "${requested}" (use [a-z][a-z0-9_-]{0,31}; not ${[...RESERVED].join("/")})`);
		const model = o.model?.trim() || (type && TYPE_MODELS[type]) || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

		await refreshSelf();
		const me = selfId();

		// Re-adopt an existing same-tab worker with that name (e.g. after /reload or a dropped session).
		if (requested) {
			const wanted = requested.startsWith(WORKER_PREFIX) ? requested : `${WORKER_PREFIX}${requested}`;
			const existing = await agentGet(wanted);
			if (existing && existing.terminal !== SELF && existing.tabId === selfInfo?.tabId && !state.workers.includes(wanted)) {
				await adopt(wanted);
				if (o.initialPrompt) await send(wanted, o.initialPrompt, false);
				return { name: wanted, terminal: existing.terminal, how: "re-adopted existing pane", adopted: true };
			}
		}
		const name = await uniqueName(requested);

		// Create the pane running pi: start a worker stack on the requested side, or extend the existing one.
		const target = await pickSplit(dir);
		const piArgs = ["--orchestrated-by", me, "--team-name", name];
		if (model) piArgs.push("--model", o.thinking ? `${model}:${o.thinking}` : model);
		const role = [type, o.purpose?.trim()].filter(Boolean).join(": ");
		if (role) piArgs.push("--team-role", role);
		const made = await splitPane(pi.exec, { pane: target.pane, direction: target.direction, cwd: ctx.cwd, argv: [...piArgv(), ...piArgs] }, opts({ timeout: 30000 }));
		pi.appendEntry("herdr-worker.operation.v1", { name, terminal: made.terminal, pane: made.pane, phase: "pane-created", at: Date.now() });
		// pane.split cannot name the terminal; the label makes it addressable by name.
		await setLabels(pi.exec, made.terminal, { [LABEL_NAME]: name }, opts()).catch(() => {});
		if (target.swap) await swapPanes(pi.exec, target.selfPane, made.pane, opts()).catch(() => {});

		// Wait for the worker's extension to come up and register its inbox.
		for (let i = 0; i < 120 && !isListening(made.terminal) && !stopped; i++) {
			await new Promise((r) => setTimeout(r, 500));
			if (i % 4 !== 3 || isListening(made.terminal)) continue;
			const t = await terminalGet(pi.exec, made.terminal, opts()).catch(() => undefined);
			if (!t?.live) {
				if (!stopped) pi.appendEntry("herdr-worker.operation.v1", { name, terminal: made.terminal, phase: "start-failed", at: Date.now() });
				throw new Error(`Pane ${made.pane} was created but pi exited. Check \`hc read ${made.terminal} --lines 80\`.`);
			}
		}
		if (!state.workers.includes(name)) state.workers.push(name);
		state.meta = { ...(state.meta ?? {}), [name]: { type, purpose: o.purpose?.trim() || undefined, model, terminal: made.terminal, pane: made.pane, direction: dir } };
		persist();
		updateUi();
		if (o.initialPrompt?.trim()) await send(name, o.initialPrompt, false);
		return { name, terminal: made.terminal, pane: made.pane, model, how: target.how };
	}

	async function release(name: string): Promise<string> {
		if (!state.workers.includes(name)) throw new Error(`Not orchestrating "${name}". Workers: ${state.workers.join(", ") || "(none)"}`);
		state.workers = state.workers.filter((w) => w !== name);
		if (state.meta) delete state.meta[name];
		persist();
		updateUi();
		await sendControl(name, "released").catch(() => false);
		return `Released ${name}. Its pane stays open.`;
	}

	async function setOrchestrator(id: string): Promise<string> {
		if (!id) throw new Error("Usage: /orchestrated-by <agent name or hc terminal address>");
		state.orchestratedBy = id;
		persist();
		updateUi();
		return `This agent is now orchestrated by ${id}.`;
	}

	// ── CreateAgentPanel tool (orchestrator only) ──

	pi.registerTool({
		name: CREATE_TOOL,
		label: "Create Agent Panel",
		description:
			"Create a new team member: splits a Herdr app pane next to you and starts a pi worker there that is orchestrated by you. " +
			"Workers are named agent-<name> (default agent-<type> or agent-N). Use `type` to describe the kind of agent (explore, research, review, implement, test, …) and `purpose` for a one-line charter " +
			"(e.g. 'explore only, never edit files'). `model` defaults to your own model, except explore/research default to xai/grok-4.6. " +
			"`initial_prompt` is delivered as the worker's first brief right after startup. Returns the worker's id for SendToAgent.",
		promptSnippet: "Spawn a new orchestrated pi worker in a neighboring Herdr pane (type, purpose, model, initial brief)",
		promptGuidelines: [
			"Use CreateAgentPanel when the user asks for a new team member / worker / agent panel, or when a task benefits from a separate agent (e.g. an explore-only scout). Give it a concrete initial_prompt.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Short name; becomes agent-<name>. Defaults to the type or a number." })),
			direction: Type.Optional(StringEnum(["right", "down", "left", "up"] as const, { description: "Side of your pane to place the worker (default right). Further workers on that side stack." })),
			type: Type.Optional(Type.String({ description: "Kind of agent: explore | research | review | implement | test | <anything>" })),
			purpose: Type.Optional(Type.String({ description: "One-line charter for this worker, e.g. 'explore only, report findings, never edit files'" })),
			model: Type.Optional(Type.String({ description: "provider/id, e.g. xai/grok-4.6 or anthropic/claude-sonnet-4-5. Default: your model (explore/research: xai/grok-4.6)." })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Thinking level for the worker (default: model default)" })),
			initial_prompt: Type.Optional(Type.String({ description: "First brief for the worker (Markdown). Self-contained: goal, context, constraints, what to report back." })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			if (!isOrchestrator()) throw new Error("CreateAgentPanel is only available to an orchestrator (run /team here first).");
			onUpdate?.({ content: [{ type: "text", text: "Splitting pane and starting worker…" }], details: {} });
			const create = () => createAgent(
				{ name: params.name, direction: params.direction as Direction | undefined, type: params.type, purpose: params.purpose, model: params.model, thinking: params.thinking, initialPrompt: params.initial_prompt },
				ctx,
			);
			const pending = createQueue.then(() => { _signal?.throwIfAborted(); return create(); });
			createQueue = pending.then(() => {}, () => {});
			const r = await pending;
			const meta = state.meta?.[r.name];
			const text = [
				`Worker ${r.name} ready in terminal ${r.terminal}${r.pane ? ` / pane ${r.pane}` : ""} (${r.how}).`,
				meta?.type || meta?.purpose ? `Role: ${[meta?.type, meta?.purpose].filter(Boolean).join(" — ")}` : undefined,
				r.model ? `Model: ${r.model}` : undefined,
				params.initial_prompt ? "Initial brief delivered; its report will arrive as an [agent] message on a later turn." : `No initial brief given; use SendToAgent({ target_id: "${r.name}", … }) to task it.`,
			]
				.filter(Boolean)
				.join("\n");
			return { content: [{ type: "text", text }], details: { ...r, type: meta?.type, purpose: meta?.purpose, initial_prompt: params.initial_prompt } };
		},
		renderCall(args, theme) {
			const bits = [theme.fg("toolTitle", theme.bold("CreateAgentPanel")), theme.fg("accent", `agent-${args.name ?? args.type ?? "N"}`)];
			if (args.direction) bits.push(theme.fg("muted", args.direction));
			if (args.type) bits.push(theme.fg("muted", `type=${args.type}`));
			if (args.model) bits.push(theme.fg("dim", args.model));
			return new Text(bits.join(" "), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("dim", "starting worker…"), 0, 0);
			const txt = result.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
			if (context.isError) return new Text(theme.fg("error", txt), 0, 0);
			const d = (result.details ?? {}) as { purpose?: string; initial_prompt?: string };
			let out = theme.fg("success", txt);
			if (d.purpose) out += "\n" + theme.fg("muted", `purpose: ${d.purpose}`);
			if (d.initial_prompt) {
				const lines = d.initial_prompt.split("\n");
				const shown = expanded ? lines : lines.slice(0, 8);
				out += "\n" + shown.map((l) => theme.fg("accent", "│ ") + l).join("\n");
				if (shown.length < lines.length) out += "\n" + theme.fg("dim", `│ … ${lines.length - shown.length} more lines`);
			}
			return new Text(out, 0, 0);
		},
	});

	/** /team add → enable team mode and ask the orchestrator LLM to create the member with CreateAgentPanel. */
	function requestAdd(words: string[], ctx: ExtensionContext): string {
		let dir: Direction | undefined;
		let type: string | undefined;
		const rest: string[] = [];
		for (const w of words) {
			if (!dir && isDirection(w)) dir = w;
			else if (!type) type = w;
			else rest.push(w);
		}
		const purpose = rest.join(" ").replace(/^["']|["']$/g, "").trim();
		const lines = [
			`Add a team member now using the CreateAgentPanel tool (do not use hc / herdr-app commands for this).`,
			`- direction: ${dir ?? "right"}`,
			type ? `- type: ${type}${TYPE_HINTS[type] ? ` (${TYPE_HINTS[type]})` : ""}` : `- type: (none given — pick one that fits, or leave it generic)`,
			purpose ? `- purpose: ${purpose}` : `- purpose: (not given — write a one-line charter${type ? ` for a ${type} agent` : ""})`,
			`- model: ${type && TYPE_MODELS[type] ? `default for ${type} is ${TYPE_MODELS[type]}` : "default (same as yours) unless there is a reason otherwise"}`,
			`- initial_prompt: write a concrete first brief from the current conversation context and the purpose. If there is genuinely nothing to do yet, a short orientation brief (repo, cwd, purpose, how to report back) is fine.`,
			`Then tell me briefly who was created and what you asked it to do.`,
		];
		const text = lines.join("\n");
		if (ctx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
		return `Asked the orchestrator to create a ${type ? `${type} ` : ""}team member${dir ? ` (${dir})` : ""}${ctx.isIdle() ? "" : " (queued as follow-up)"}.`;
	}

	pi.registerCommand("team", {
		description: "Herdr team: /team add [right|down|left|up] [type] [purpose…] → orchestrator creates a pi worker via CreateAgentPanel · list · release <name> · adopt <name> · from <id>",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "add ", label: "add [direction] [type] [purpose…]", description: "Have the orchestrator create a worker (default: stack right)" },
				...DIRECTIONS.map((d) => ({ value: `add ${d} `, label: `add ${d} [type] [purpose…]`, description: `Worker ${d} of this pane` })),
				{ value: "add right explore ", label: "add right explore [purpose…]", description: "Explore-only scout on xai/grok-4.6" },
				{ value: "list", label: "list", description: "Show workers / orchestrator" },
				...state.workers.map((w) => ({ value: `release ${w}`, label: `release ${w}`, description: "Stop orchestrating this worker" })),
				{ value: "from ", label: "from <id>", description: "Mark this pi as a worker of <id>" },
				{ value: "adopt ", label: "adopt <name>", description: "Control an existing agent without creating a pane" },
			].filter((i) => i.value.startsWith(prefix));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!interactive()) { ctx.ui.notify("Teams require an interactive pi in the Herdr app.", "error"); return; }
			try {
				let msg: string;
				if (!state.orchestratedBy && !state.teamMode) {
					state.teamMode = true; // this pane is now an orchestrator -> CreateAgentPanel becomes available
					persist();
					updateUi();
				}
				if (!verb || verb === "list" || verb === "status") {
					msg = [statusText(), ...state.workers.map((w) => `${w}${state.meta?.[w]?.terminal ? ` · ${state.meta[w].terminal}` : ""}`)].filter(Boolean).join("\n") || "No team.";
				} else if (verb === "release") {
					msg = await release(rest[0] ?? "");
				} else if (verb === "from") {
					msg = await setOrchestrator(rest[0] ?? "");
				} else if (verb === "adopt") {
					msg = await adopt(rest[0] ?? "");
				} else if (verb === "help") {
					msg = "/team add [right|down|left|up] [type] [purpose…] | list | release <name> | adopt <name> | from <id>";
				} else if (verb === "add" || isDirection(verb)) {
					if (state.orchestratedBy) throw new Error(`This pane is a worker of ${state.orchestratedBy}; only orchestrators add team members.`);
					msg = requestAdd(verb === "add" ? rest : [verb, ...rest], ctx);
				} else {
					throw new Error(`Unknown subcommand "${verb}". Usage: /team add [right|down|left|up] [type] [purpose…] | list | release <name> | adopt <name> | from <id>`);
				}
				ctx.ui.notify(msg, "info");
			} catch (e: any) {
				ctx.ui.notify(e.message ?? String(e), "error");
			}
		},
	});

	pi.registerCommand("orchestrated-by", {
		description: "Herdr: mark this pi as a worker controlled by <agent name or hc terminal address>",
		handler: async (args, ctx) => {
			try {
				if (!interactive()) throw new Error("Teams require an interactive pi in the Herdr app.");
				ctx.ui.notify(await setOrchestrator(args.trim()), "info");
			} catch (e: any) {
				ctx.ui.notify(e.message ?? String(e), "error");
			}
		},
	});

	// ── system prompt ──

	pi.on("before_agent_start", async (event) => {
		if (!inTeam() && !isOrchestrator()) return;
		const me = selfId();
		const sections: string[] = ["## Herdr orchestration"];
		if (isOrchestrator()) {
			const roster = state.workers.map((w) => {
				const m = state.meta?.[w];
				const bits = [m?.terminal ? `terminal ${m.terminal}` : undefined, m?.type, m?.purpose, m?.model ? `model ${m.model}` : undefined].filter(Boolean);
				return bits.length ? `${w} (${bits.join("; ")})` : w;
			});
			sections.push(
				state.workers.length
					? `You are the orchestrator for ${roster.join(", ")} — you work through them, but you work hard on giving them the right tasks. Each worker is a separate pi agent in its own Herdr pane (same working directory, its own context; it sees nothing of this conversation).`
					: `You are an orchestrator with no workers yet. Create team members with CreateAgentPanel (type/purpose/model/initial_prompt); they become pi agents in neighboring Herdr panes that you task through SendToAgent.`,
				`- Add workers with CreateAgentPanel. Explore/research scouts default to xai/grok-4.6; implementers default to your model. Always hand over a concrete initial_prompt.`,
				`- Respect each worker's charter: do not ask an explore-only agent to edit files; spawn an implement agent instead.`,
				`- Delegate with SendToAgent({ target_id, message, priority }). Briefs must be self-contained: goal, relevant context you already have, constraints, definition of done, and what to report back.`,
				`- priority: true steers the worker mid-task (interrupts its current turn) — use for corrections/stop. priority: false (default) queues a follow-up after its current work.`,
				`- Replies arrive asynchronously as "[agent]" custom messages on a later turn. Do not poll or block for them; finish your turn. To peek at a worker: \`hc get <terminal>\`, \`hc read <terminal> --lines 80\` (terminal addresses are in /team list).`,
				`- Your id (workers reply to it): ${me}.`,
			);
		}
		if (state.orchestratedBy) {
			sections.push(
				`You are being controlled by an orchestrator: ${state.orchestratedBy} — another of your user's pi agents in a neighboring Herdr pane. Task briefs arrive as "[agent]" custom messages; your user sees them too and may chime in directly.`,
				...(state.role?.type || state.role?.purpose
					? [
							`- Your role in the team: ${[state.role.type, state.role.purpose].filter(Boolean).join(" — ")}.${state.role.type && TYPE_HINTS[state.role.type] ? ` ${TYPE_HINTS[state.role.type]}` : ""} Stay within this charter; if a request falls outside it, say so to the orchestrator instead of doing it.`,
						]
					: []),
				`- Do the work, then report back with SendToAgent({ target_id: "${state.orchestratedBy}", message }): what you did, where (files/PRs), how you verified, open questions or blockers. Be concise and concrete.`,
				`- If a brief is ambiguous or blocked, ask the orchestrator via SendToAgent rather than guessing. You have no live back-and-forth; end your turn after sending.`,
				`- Your id: ${me}.`,
			);
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${sections.join("\n")}` };
	});

	// ── lifecycle ──

	pi.on("session_start", async (event, ctx) => {
		ctxRef = ctx;
		restore(ctx);
		if (!interactive()) {
			state = { workers: [] };
			syncTool(); // no herdr app -> no team -> no tool
			return;
		}
		await refreshSelf();

		const flag = pi.getFlag("orchestrated-by");
		if (typeof flag === "string" && flag && event.reason === "startup" && !state.orchestratedBy) {
			state.orchestratedBy = flag;
			const role = pi.getFlag("team-role");
			if (typeof role === "string" && role) {
				const m = role.match(/^([a-z0-9_-]+):\s*(.*)$/i);
				state.role = m ? { type: m[1].toLowerCase(), purpose: m[2] || undefined } : { type: role.toLowerCase() };
			}
			persist();
		}

		startListening();
		updateUi(); // also gates the SendToAgent tool
	});

	function acknowledgePersistedInbox(ctx: ExtensionContext) {
		if (!inFlightEnvelopes.size) return;
		// message_end precedes persistence; only acknowledge records actually in SessionManager.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== "herdr-worker.message") continue;
			const id = (entry.details as { envelopeId?: string })?.envelopeId;
			if (id && inFlightEnvelopes.delete(id) && /^[a-zA-Z0-9_.-]+\.json$/.test(id)) {
				try { fs.rmSync(path.join(inboxDir(SELF), id), { force: true }); } catch {}
			}
		}
	}
	pi.on("context", (_event, ctx) => acknowledgePersistedInbox(ctx));
	pi.on("agent_settled", (_event, ctx) => acknowledgePersistedInbox(ctx));
	pi.on("session_tree", (_event, ctx) => {
		ctxRef = ctx;
		restore(ctx);
		updateUi();
	});
	pi.on("session_shutdown", async () => {
		// Headless sessions must not remove the interactive pane's listener file.
		const wasListening = !!watcher || !!poller;
		stopped = true;
		lifetime.abort();
		if (wasListening) stopListening();
		if (ctxRef?.hasUI) ctxRef.ui.setStatus(STATUS_KEY, undefined);
		ctxRef = undefined;
	});
}
