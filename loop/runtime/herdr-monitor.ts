import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LABEL_MONITOR, appDo, appSpaces, findTerminal, hc, isBusy, readTerminal, selfTerminal, setLabels, splitPane, terminalGet,
} from "../../lib/herdr-app.js";

export type HerdrMonitorStatus = "running" | "idle" | "stopped" | "error" | "unknown";
export interface HerdrMonitor {
  id: string;
  key: string;
  command: string;
  cwd: string;
  description?: string;
  paneId: string; // herdr-app pane
  terminalId: string; // hc terminal address
  tabId: string;
  status: HerdrMonitorStatus;
  startedAt: number;
  reused: boolean;
}
export interface MonitorSnapshot { nextId: number; monitors: HerdrMonitor[] }
export const commandKey = (command: string, cwd: string) => createHash("sha256").update(`${cwd}\0${command.trim()}`).digest("hex").slice(0, 12);
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export class HerdrMonitorManager {
  private byId = new Map<string, HerdrMonitor>();
  private nextId = 1;
  private mutation = Promise.resolve();
  private lifetime = new AbortController();
  dispose() { this.lifetime.abort(); this.onChange = undefined; }
  onChange?: (snapshot: MonitorSnapshot) => void;
  constructor(private exec: ExtensionAPI["exec"]) {}

  snapshot(): MonitorSnapshot { return structuredClone({ nextId: this.nextId, monitors: this.list() }); }
  restore(snapshot: MonitorSnapshot) {
    if (!Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < 1 || !Array.isArray(snapshot.monitors)) throw new Error("Invalid monitor snapshot");
    this.nextId = snapshot.nextId;
    // Last observed process state is not proof it is still running.
    // Handles from the old `herdr` TUI backend (no hc terminal) cannot be reattached.
    this.byId = new Map(snapshot.monitors.filter((m) => typeof m.terminalId === "string" && typeof m.key === "string")
      .map((m) => [m.id, { ...m, status: "unknown" }]));
  }
  list(): HerdrMonitor[] { return [...this.byId.values()]; }
  get(id: string): HerdrMonitor | undefined { return this.byId.get(id); }
  private persist() { this.onChange?.(this.snapshot()); }
  private opts(signal?: AbortSignal, timeout = 15000) {
    if (!selfTerminal()) throw new Error("Monitors require a pi running in the Herdr app (no HC_TERMINAL_ID).");
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    return { signal, timeout };
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(fn);
    this.mutation = next.then(() => {}, () => {});
    return next;
  }
  create(command: string, description?: string, cwd = process.cwd(), signal?: AbortSignal): Promise<HerdrMonitor> {
    return this.serialize(async () => {
      signal?.throwIfAborted();
      if (!command.trim()) throw new Error("Monitor command cannot be empty.");
      const key = commandKey(command, cwd);
      const tab = await this.ensureMonitorTab(cwd, signal);
      const panes = await this.panes(tab.tabId, signal);
      const existing = panes.find((p) => p.labels[LABEL_MONITOR] === key);
      const previous = this.list().find((m) => m.key === key && m.terminalId === existing?.terminal);
      let paneId: string;
      let terminalId: string;
      if (existing) ({ pane: paneId, terminal: terminalId } = existing);
      else {
        if (this.list().filter((m) => m.status === "running" || m.status === "unknown").length >= 25) throw new Error("25 monitors tracked; inspect MonitorList before starting more.");
        const root = panes[0];
        if (panes.length === 1 && !root.labels[LABEL_MONITOR] && !(await this.terminalIsBusy(root.terminal, signal))) ({ pane: paneId, terminal: terminalId } = root);
        else {
          const from = panes.at(-1)?.pane || tab.rootPaneId;
          const shell = process.env.SHELL || "/bin/zsh";
          ({ pane: paneId, terminal: terminalId } = await splitPane(this.exec, { pane: from, direction: "down", cwd, argv: [shell, "-l"] }, this.opts(signal, 30000)));
        }
        await setLabels(this.exec, terminalId, { [LABEL_MONITOR]: key, [`${LABEL_MONITOR}.command`]: clean(command).slice(0, 80) }, this.opts(signal));
      }
      const monitor: HerdrMonitor = previous || {
        id: String(this.nextId++), key, command, cwd, description, paneId, terminalId, tabId: tab.tabId,
        status: "unknown", startedAt: Date.now(), reused: !!existing,
      };
      monitor.reused = !!existing;
      monitor.paneId = paneId;
      this.byId.set(monitor.id, monitor);
      this.persist(); // Keep a recoverable handle BEFORE running anything.
      if (await this.terminalIsBusy(terminalId, signal)) {
        monitor.status = "running";
        this.persist();
        return monitor; // Attach; NEVER interrupt an existing process on create/recovery.
      }
      try {
        const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
        // hc send holds while a person has an unfinished draft in that terminal.
        await hc(this.exec, ["send", terminalId, `cd -- ${quote(cwd)} && ${command}`], this.opts(signal, 90000));
        monitor.status = "running";
        monitor.startedAt = Date.now();
        this.persist();
        return monitor;
      } catch (error) {
        monitor.status = "unknown"; // The CLI may have sent input before timing out.
        this.persist();
        throw new Error(`Monitor terminal ${terminalId} (pane ${paneId}) needs inspection before retrying`, { cause: error });
      }
    });
  }
  private async ownsPane(m: HerdrMonitor, signal?: AbortSignal) {
    const t = await terminalGet(this.exec, m.terminalId, this.opts(signal));
    return !!t?.live && t.labels[LABEL_MONITOR] === m.key;
  }
  async refresh(m: HerdrMonitor, signal?: AbortSignal): Promise<HerdrMonitor> {
    const old = m.status;
    try {
      if (!(await this.ownsPane(m, signal))) m.status = "error";
      else m.status = await this.terminalIsBusy(m.terminalId, signal) ? "running" : old === "stopped" ? "stopped" : "idle";
    } catch { signal?.throwIfAborted(); m.status = "error"; }
    if (m.status !== old) this.persist();
    return m;
  }
  async readTail(terminalId: string, lines = 5, signal?: AbortSignal): Promise<string[]> {
    const text = await readTerminal(this.exec, terminalId, lines, this.opts(signal));
    return text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-lines);
  }
  stop(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.serialize(async () => {
      const m = this.get(id);
      if (!m || (await this.refresh(m, signal)).status !== "running") return false;
      await hc(this.exec, ["keys", m.terminalId, "ctrl+c"], this.opts(signal));
      m.status = "stopped";
      this.persist();
      return true;
    });
  }
  /** Panes of a tab (from herdr-app) with their terminals' labels (from hc). */
  private async panes(tabId: string, signal?: AbortSignal): Promise<{ pane: string; terminal: string; labels: Record<string, string> }[]> {
    const spaces = await appSpaces(this.exec, this.opts(signal));
    const tab = spaces.flatMap((s) => s.tabs ?? []).find((t) => t.id === tabId);
    return Promise.all((tab?.terminals ?? []).map(async (t) => ({
      pane: t.pane, terminal: t.terminal,
      labels: (await terminalGet(this.exec, t.terminal, this.opts(signal)).catch(() => undefined))?.labels ?? {},
    })));
  }
  private async ensureMonitorTab(cwd: string, signal?: AbortSignal): Promise<{ tabId: string; rootPaneId: string }> {
    const spaces = await appSpaces(this.exec, this.opts(signal));
    const here = findTerminal(spaces, selfTerminal());
    if (!here) throw new Error(`Terminal ${selfTerminal()} is not shown in the Herdr app window.`);
    const tab = here.space.tabs.find((t) => t.name === "Monitor");
    if (tab) {
      const root = tab.terminals[0];
      if (!root) throw new Error("Monitor tab has no available root pane.");
      return { tabId: tab.id, rootPaneId: root.pane };
    }
    const made = await appDo(this.exec, "tab.new", { space: here.space.id, name: "Monitor", folder: cwd, focus: false }, this.opts(signal, 30000));
    const tabId = made?.tab;
    const rootPaneId = tabId ? findTerminal(await appSpaces(this.exec, this.opts(signal)), made.terminal)?.pane : undefined;
    if (!tabId || !rootPaneId) throw new Error(`herdr-app tab.new returned no IDs: ${JSON.stringify(made)}`);
    return { tabId, rootPaneId };
  }
  private async terminalIsBusy(terminalId: string, signal?: AbortSignal): Promise<boolean> {
    // A just-started terminal reports its foreground process after a moment.
    for (let attempt = 0; ; attempt++) {
      const t = await terminalGet(this.exec, terminalId, this.opts(signal));
      if (!t?.live) throw new Error(`Terminal ${terminalId} is gone`);
      // Unknown is NOT an available shell. Never type into an unclassified foreground process.
      if (t.foreground?.pid || attempt >= 20) return isBusy(t);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
