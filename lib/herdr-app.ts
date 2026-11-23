// Thin wrappers around the Herdr Mac app CLIs:
//   hc        (herdr-core)  terminals: get, ls, send, keys, read, label
//   herdr-app (the window)  spaces, tabs, panes: ls, status, do <command>
// The old `herdr` TUI CLI (HERDR_ENV / HERDR_PANE_ID) is not used: its terminals are invisible in the app.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Exec = ExtensionAPI["exec"];
export interface RunOpts { timeout?: number; signal?: AbortSignal }

/** Label keys this package puts on hc terminals. */
export const LABEL_NAME = "pi.team.name"; // addressable agent name (pane.split cannot set an hc name)
export const LABEL_TITLE = "pi.team.title";
export const LABEL_MONITOR = "pi.monitor"; // monitor command key

export const SHELLS = ["bash", "zsh", "fish", "sh", "dash", "ksh"];

/** This pi's hc terminal address (e.g. `t3y`), or "" outside the Herdr app. */
export function selfTerminal(): string {
  return process.env.HC_TERMINAL_ID ?? "";
}
export function inHerdrApp(): boolean {
  return !!selfTerminal();
}

const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trim();

export class HerdrError extends Error {
  kind?: string;
  constructor(message: string, kind?: string) { super(message); this.kind = kind; }
}

async function run(exec: Exec, bin: string, args: string[], opts: RunOpts = {}): Promise<any> {
  opts.signal?.throwIfAborted();
  const res = await exec(bin, args, { timeout: opts.timeout ?? 15000, signal: opts.signal });
  opts.signal?.throwIfAborted();
  const out = (res.stdout || "").trim();
  const err = (res.stderr || "").trim();
  let parsed: any;
  try { parsed = out ? JSON.parse(out) : undefined; } catch { parsed = out; }
  if (res.code !== 0 || res.killed || parsed?.error) {
    let message = err || out || `${bin} ${args[0] ?? ""} failed (exit ${res.code})`;
    let kind: string | undefined;
    try {
      const j = parsed?.error ? parsed : JSON.parse(err || out);
      const e = j?.error;
      if (typeof e === "string") message = e;
      else if (e?.message) { message = e.kind ? `${e.kind}: ${e.message}` : e.message; kind = e.kind; }
    } catch {}
    throw new HerdrError(clean(message), kind);
  }
  return parsed;
}

export const hc = (exec: Exec, args: string[], opts?: RunOpts) => run(exec, "hc", [...args, "--json"], opts);
export const herdrApp = (exec: Exec, args: string[], opts?: RunOpts) => run(exec, "herdr-app", args, opts);
/** `herdr-app do <command> <json-args>` */
export const appDo = (exec: Exec, command: string, args: Record<string, unknown> = {}, opts?: RunOpts) =>
  herdrApp(exec, ["do", command, JSON.stringify(args)], opts);

// ───────────── terminals (hc) ─────────────

export interface TerminalInfo {
  address: string;
  /** hc name, else our `pi.team.name` label */
  name?: string;
  hcName?: string;
  app?: string; // reported agent app ("pi", "claude-code"), else foreground program name
  status?: string; // idle | working | done | blocked | error
  live: boolean;
  cwd?: string;
  space?: string;
  tab?: string;
  labels: Record<string, string>;
  pid?: number;
  foreground?: { name?: string; pid?: number; argv?: string[] };
}

function toInfo(j: any): TerminalInfo | undefined {
  if (!j?.address) return undefined;
  const labels: Record<string, string> = j.labels ?? {};
  return {
    address: j.address,
    hcName: j.name ?? undefined,
    name: j.name ?? labels[LABEL_NAME] ?? undefined,
    app: j.status?.app ?? j.foreground?.name ?? undefined,
    status: j.status?.state ?? undefined,
    live: j.state === "live",
    cwd: j.foreground?.cwd ?? j.cwd,
    space: labels["herdr.space"],
    tab: labels["herdr.tab"],
    labels,
    pid: j.pid ?? undefined,
    foreground: j.foreground ?? undefined,
  };
}

/** One terminal by address or hc name; undefined when it does not exist. */
export async function terminalGet(exec: Exec, target: string, opts?: RunOpts): Promise<TerminalInfo | undefined> {
  try {
    return toInfo(await hc(exec, ["get", target], opts));
  } catch (e) {
    opts?.signal?.throwIfAborted();
    if (e instanceof HerdrError && (e.kind === "not_found" || e.kind === "usage")) return undefined;
    throw e;
  }
}

/** All live local terminals with full details (labels included). */
export async function terminalList(exec: Exec, opts?: RunOpts): Promise<TerminalInfo[]> {
  const j = await hc(exec, ["ls"], opts);
  const addresses: string[] = (j?.terminals ?? [])
    .filter((t: any) => t?.state === "live" && typeof t.address === "string" && !t.address.includes("/"))
    .map((t: any) => t.address);
  const got = await Promise.all(addresses.map((a) => terminalGet(exec, a, opts).catch(() => undefined)));
  return got.filter((t): t is TerminalInfo => !!t && t.live);
}

/** Resolve an address, hc name, or `pi.team.name` label to a live terminal. */
export async function resolveTerminal(exec: Exec, id: string, opts?: RunOpts): Promise<TerminalInfo | undefined> {
  if (!id) return undefined;
  const direct = await terminalGet(exec, id, opts).catch(() => undefined);
  if (direct?.live) return direct;
  return (await terminalList(exec, opts)).find((t) => t.name === id);
}

export async function setLabels(exec: Exec, terminal: string, labels: Record<string, string | undefined>, opts?: RunOpts) {
  const kv = Object.entries(labels).map(([k, v]) => `${k}=${v ?? ""}`);
  if (kv.length) await hc(exec, ["label", terminal, ...kv], opts);
}

export async function readTerminal(exec: Exec, terminal: string, lines: number, opts?: RunOpts): Promise<string> {
  const j = await hc(exec, ["read", terminal, "--lines", String(lines)], opts);
  return String(j?.text ?? "");
}

/** True when the terminal's foreground is something other than its idle root shell. */
export function isBusy(t: TerminalInfo): boolean {
  const fg = t.foreground;
  if (!fg?.pid || !fg.name) throw new Error(`Cannot establish shell readiness for ${t.address}`);
  return !(fg.pid === t.pid && SHELLS.includes(fg.name.replace(/^-/, "")));
}

// ───────────── window (herdr-app) ─────────────

export interface AppTerminal { terminal: string; pane: string; name?: string | null; status?: string | null; app?: string | null }
export interface AppTab { id: string; name: string; active: boolean; terminals: AppTerminal[] }
export interface AppSpace { id: string; name: string; folder?: string; tabs: AppTab[] }

export async function appSpaces(exec: Exec, opts?: RunOpts): Promise<AppSpace[]> {
  const j = await herdrApp(exec, ["ls"], opts);
  return Array.isArray(j?.spaces) ? j.spaces : [];
}

export interface Location { space: AppSpace; tab: AppTab; pane: string }
export function findTerminal(spaces: AppSpace[], terminal: string): Location | undefined {
  for (const space of spaces) for (const tab of space.tabs ?? []) for (const t of tab.terminals ?? []) {
    if (t.terminal === terminal) return { space, tab, pane: t.pane };
  }
  return undefined;
}
export async function locate(exec: Exec, terminal: string, opts?: RunOpts): Promise<Location | undefined> {
  return findTerminal(await appSpaces(exec, opts), terminal);
}

async function focusedPane(exec: Exec, opts?: RunOpts): Promise<string | undefined> {
  try { return (await herdrApp(exec, ["status"], opts))?.focused_pane ?? undefined; } catch { return undefined; }
}

/**
 * How to start pi in a new pane. Default `pi` from the login shell's PATH;
 * `PI_HERDR_PI_ARGV` (JSON array, e.g. `["pi","-ne","-e","/path/ext.ts"]`) overrides it.
 */
export function piArgv(): string[] {
  try {
    const v = JSON.parse(process.env.PI_HERDR_PI_ARGV ?? "");
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return v;
  } catch {}
  return ["pi"];
}

/**
 * argv that starts `argv` in `cwd` with this process's PATH. New panes get the core's login
 * environment, which may lack PATH entries the user's interactive shell adds (mise, nvm, …).
 */
export function inFolder(cwd: string, argv: string[]): string[] {
  const env = process.env.PATH ? [`PATH=${process.env.PATH}`] : [];
  return ["/usr/bin/env", ...env, "/bin/sh", "-c", 'cd -- "$1" && shift && exec "$@"', "pi-herdr", cwd, ...argv];
}

/**
 * Split `pane` right/down with a new terminal running `argv` in `cwd`.
 * pane.split takes focus; give it back to whatever had it so the user is not moved.
 */
export async function splitPane(
  exec: Exec,
  o: { pane: string; direction: "right" | "down"; cwd: string; argv: string[] },
  opts?: RunOpts,
): Promise<{ pane: string; terminal: string }> {
  const before = await focusedPane(exec, opts);
  const made = await appDo(exec, "pane.split", { direction: o.direction, pane: o.pane, argv: inFolder(o.cwd, o.argv) }, opts);
  if (typeof made?.pane !== "string" || typeof made?.terminal !== "string") throw new Error(`pane.split returned no ids: ${JSON.stringify(made)}`);
  // Only undo the focus move the split itself made; never fight the person's own navigation.
  if (before && before !== made.pane && (await focusedPane(exec, opts)) === made.pane) {
    await appDo(exec, "pane.focus", { pane: before }, opts).catch(() => {});
  }
  return { pane: made.pane, terminal: made.terminal };
}

export async function swapPanes(exec: Exec, pane: string, target: string, opts?: RunOpts) {
  await appDo(exec, "pane.swap", { pane, target }, opts);
}
