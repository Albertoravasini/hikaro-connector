/**
 * HermesAcpBackend — talks to Hermes profiles through the Agent Client Protocol
 * (`hermes -p <profile> acp`, hermes-agent v0.18.2 acp_adapter/), one long-lived child
 * process per profile, JSON-RPC 2.0 over stdio (newline-delimited JSON).
 *
 * Why: with `gateway.multiplex_profiles` on, ONE gateway serves every profile's Discord bot
 * but only the default profile can have an API server (and there is no /p/<profile> routing
 * for the API). ACP runs the same agent (same config, memory, skills, model, MCP servers)
 * without starting any messaging platform, so it never conflicts with the Discord gateway.
 *
 * Protocol facts (acp SDK 0.9 / ACP v1, verified on the Hermes source):
 *  - initialize {protocolVersion:1, clientCapabilities, clientInfo} → {protocolVersion, agentInfo,
 *    agentCapabilities{loadSession,…}, authMethods}. No `authenticate` needed: Hermes uses the
 *    profile's configured provider; authMethods without a provider id = no model configured.
 *    We declare NO fs/terminal capabilities so the agent uses its own tools.
 *  - session/new {cwd (absolute), mcpServers: []} → {sessionId}. Sessions are persisted to the
 *    profile's state.db with source "acp"; `session/prompt` on an unknown-in-memory id restores it
 *    from the db (SessionManager.get_session → _restore), and answers stopReason "refusal" if gone.
 *  - session/prompt {sessionId, prompt:[{type:"text",text}]} → {stopReason: end_turn|cancelled|refusal}
 *    while streaming session/update notifications: {sessionId, update:{sessionUpdate:"agent_message_chunk",
 *    content:{type:"text",text}}} (+ tool_call, agent_thought_chunk, usage_update… ignored here).
 *    Agent errors come back as a final message "Error: …" with end_turn.
 *  - session/request_permission {sessionId, toolCall{title,kind,rawInput{command,description}}, options[
 *    {optionId: allow_once|allow_session|allow_always|deny|deny_always, kind, name}]} → we answer
 *    {outcome:{outcome:"selected", optionId}} or {outcome:{outcome:"cancelled"}}. Hermes waits 60 s,
 *    then denies by itself.
 *  - session/cancel {sessionId} (notification) interrupts a running prompt.
 *  - There is no per-turn "instructions" field: the Hikaro card instructions are prepended to the first
 *    prompt of each session (and repeated every few turns).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { truncate } from "../cards/shaper.js";
import { AGENT_INSTRUCTIONS } from "../cards/instructions.js";
import { VERSION, type AcpLink, type StateStore } from "../config.js";
import type {
  AgentBackend,
  BackendAgent,
  BackendHealth,
  BackendSession,
  CardDraft,
  SessionSelection,
  TurnResult,
  TurnSink,
} from "../core/backend.js";
import { DeckError, ERROR_MESSAGES, ERROR_VARIANTS } from "../core/errors.js";
import { logger } from "../core/log.js";
import { toDeckSession } from "./backend.js";
import { JsonRpcPeer, RpcClosedError, RpcError } from "./jsonrpc.js";
import { readSessionOrigins } from "./profiles.js";
import { SQLITE_BIN, listDiscordSessions, readTranscript, type DiscordSessionRow, type TranscriptMessage } from "./statedb.js";

const log = logger("acp");

export const ACP_PROTOCOL_VERSION = 1;

// ── process ────────────────────────────────────────────────────────────

export interface AcpCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** `hermes -p <profile> acp` with HERMES_HOME = the Hermes root (works for a scratch copy too). */
export function hermesAcpCommand(hermesBin: string, hermesRoot: string, profile: string): AcpCommand {
  return {
    command: hermesBin,
    args: ["-p", profile, "acp"],
    env: { ...process.env, HERMES_HOME: hermesRoot, PYTHONUNBUFFERED: "1" },
    cwd: homedir(),
  };
}

export interface InitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: Record<string, unknown>;
  authMethods?: Array<{ id?: string; name?: string; type?: string }>;
}

export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "hikaro-connector", title: "Hikaro", version: VERSION },
  };
}

/** Did Hermes advertise a usable provider (an auth method other than the terminal setup)? */
export function hasModelProvider(init: InitializeResult | undefined): boolean {
  return !!init?.authMethods?.some((m) => m && m.id && m.id !== "hermes-setup" && m.type !== "terminal");
}

export interface SessionUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  [k: string]: unknown;
}

export interface PermissionParams {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: { command?: unknown; description?: unknown; [k: string]: unknown } };
  options?: Array<{ optionId: string; kind?: string; name?: string }>;
}

export type PermissionOutcome = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };

export interface AcpProcessOpts {
  profile: string;
  command: () => AcpCommand;
  initTimeoutMs?: number;
  /** restart automatically after a crash (with backoff) */
  autoRestart?: boolean;
  /** no info/warn logs (doctor/setup print their own lines) */
  quiet?: boolean;
}

const BACKOFF_MAX_MS = 5 * 60_000;
const HEALTHY_AFTER_MS = 60_000;

/** One `hermes -p <profile> acp` child + its JSON-RPC connection. */
export class AcpProcess {
  private child: ChildProcess | null = null;
  private peer: JsonRpcPeer | null = null;
  private starting: Promise<JsonRpcPeer> | null = null;
  private stopped = false;
  private failures = 0;
  private notBefore = 0;
  private startedAt = 0;
  private respawnTimer: NodeJS.Timeout | null = null;
  private readonly stderrTail: string[] = [];
  init: InitializeResult | undefined;
  lastError: string | undefined;
  readonly updates = new Map<string, (u: SessionUpdate) => void>();
  readonly permissions = new Map<string, (p: PermissionParams) => Promise<PermissionOutcome>>();

  constructor(private readonly o: AcpProcessOpts) {}

  get profile(): string {
    return this.o.profile;
  }

  get ready(): boolean {
    return !!this.peer && !this.peer.isClosed;
  }

  /** Last lines Hermes printed on stderr (for doctor / error details; Hermes redacts secrets). */
  stderr(): string {
    return this.stderrTail.join("\n");
  }

  /** Spawn (if needed) and complete the initialize handshake. */
  ensure(): Promise<JsonRpcPeer> {
    if (this.stopped) return Promise.reject(new DeckError("hermes_down", ERROR_MESSAGES.hermes_down, "acp stopped"));
    if (this.peer && !this.peer.isClosed) return Promise.resolve(this.peer);
    if (!this.starting) {
      this.starting = this.spawnAndInit().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async spawnAndInit(): Promise<JsonRpcPeer> {
    const wait = this.notBefore - Date.now();
    if (wait > 0) {
      if (wait > 5_000) {
        throw new DeckError("hermes_down", ERROR_MESSAGES.hermes_down, `acp ${this.o.profile}: restarting in ${Math.round(wait / 1000)} s (${this.lastError ?? "crash"})`);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    const cmd = this.o.command();
    if (!this.o.quiet) log.info(`avvio Hermes ACP per il profilo ${this.o.profile}`);
    const child = spawn(cmd.command, cmd.args, { env: cmd.env ?? process.env, cwd: cmd.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.startedAt = Date.now();
    const peer = new JsonRpcPeer(child.stdout!, child.stdin!);
    this.peer = peer;
    peer.onGarbage = (line) => log.debug(`acp ${this.o.profile} stdout (non JSON): ${line.slice(0, 200)}`);
    peer.handleNotifications((method, params) => this.onNotification(method, params));
    peer.handleRequests((method, params) => this.onRequest(method, params));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line.slice(0, 400));
        if (this.stderrTail.length > 30) this.stderrTail.shift();
        log.debug(`hermes[${this.o.profile}] ${line.slice(0, 300)}`);
      }
    });
    let exited = false;
    const onGone = (why: string) => {
      if (exited) return;
      exited = true;
      peer.close(new RpcClosedError(`hermes acp (${this.o.profile}) ${why}`));
      if (this.child === child) {
        this.child = null;
        this.peer = null;
      }
      this.onExit(why);
    };
    child.once("error", (e) => onGone(`spawn error: ${e.message}`));
    child.once("exit", (code, sig) => onGone(`exited (${sig ?? code})`));
    // EPIPE on a dead child must not crash the connector.
    child.stdin!.on("error", () => undefined);

    try {
      this.init = await peer.request<InitializeResult>("initialize", initializeParams(), { timeoutMs: this.o.initTimeoutMs ?? 90_000 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.lastError = `${detail}${this.stderrTail.length ? ` — ${this.stderrTail.slice(-3).join(" | ")}` : ""}`;
      this.kill(child);
      throw new DeckError("hermes_down", ERROR_MESSAGES.hermes_down, `acp ${this.o.profile} initialize: ${this.lastError}`);
    }
    if (!this.o.quiet) log.info(`Hermes ACP pronto per ${this.o.profile} (${this.init?.agentInfo?.name ?? "hermes"} ${this.init?.agentInfo?.version ?? ""})`.trim());
    return peer;
  }

  private onExit(why: string): void {
    if (this.stopped) return;
    if (this.o.autoRestart === false) {
      this.lastError = why;
      return;
    }
    const lived = Date.now() - this.startedAt;
    this.failures = lived > HEALTHY_AFTER_MS ? 1 : this.failures + 1;
    const delay = Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** (this.failures - 1));
    this.notBefore = Date.now() + delay;
    this.lastError = `${why}${this.stderrTail.length ? ` — ${this.stderrTail.slice(-2).join(" | ")}` : ""}`;
    log.warn(`Hermes ACP (${this.o.profile}) si è fermato: ${why}; riparto tra ${Math.round(delay / 1000)} s`);
    // In-flight prompts were rejected by peer.close(); their permission cards are cleared by runPrompt.
    if (!this.respawnTimer) {
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        if (!this.stopped) this.ensure().catch((e) => log.debug(`respawn ${this.o.profile} failed`, e));
      }, delay);
      this.respawnTimer.unref();
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !params || typeof params !== "object") return;
    const p = params as { sessionId?: string; update?: SessionUpdate };
    if (!p.sessionId || !p.update) return;
    this.updates.get(p.sessionId)?.(p.update);
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      const p = (params ?? {}) as PermissionParams;
      const h = this.permissions.get(p.sessionId);
      if (!h) return { outcome: { outcome: "cancelled" } };
      return h(p);
    }
    // fs/*, terminal/*: we declared no such capability.
    throw new RpcError(-32601, `Method not found: ${method}`);
  }

  /** A request to the agent, with process errors mapped to Deck errors. */
  async request<T>(method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const peer = await this.ensure();
    try {
      return await peer.request<T>(method, params, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (err instanceof RpcClosedError) {
        throw new DeckError("hermes_down", ERROR_MESSAGES.hermes_down, `${err.message}${this.stderrTail.length ? ` — ${this.stderrTail.slice(-2).join(" | ")}` : ""}`);
      }
      if (err instanceof RpcError) throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, `${method}: ${err.code} ${err.message}`);
      throw err;
    }
  }

  notify(method: string, params: unknown): void {
    this.peer?.notify(method, params);
  }

  private kill(child: ChildProcess): void {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    const t1 = setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2_000);
    const t2 = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5_000);
    t1.unref();
    t2.unref();
    child.once("exit", () => {
      clearTimeout(t1);
      clearTimeout(t2);
    });
  }

  /** Graceful shutdown: close stdin (Hermes exits on EOF), then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    const child = this.child;
    this.peer?.close();
    this.child = null;
    this.peer = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      this.kill(child);
      setTimeout(resolve, 6_000).unref();
    });
  }
}

/** One-shot liveness check (doctor/setup): spawn, initialize, stop. */
export async function acpHandshake(cmd: AcpCommand, timeoutMs = 90_000): Promise<{ ok: boolean; ms: number; init?: InitializeResult; error?: string }> {
  const t0 = Date.now();
  const p = new AcpProcess({ profile: cmd.args[1] ?? "?", command: () => cmd, initTimeoutMs: timeoutMs, autoRestart: false, quiet: true });
  try {
    await p.ensure();
    const r: { ok: boolean; ms: number; init?: InitializeResult } = { ok: true, ms: Date.now() - t0 };
    if (p.init) r.init = p.init;
    return r;
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err instanceof DeckError ? (err.detail ?? err.message) : String(err) };
  } finally {
    await p.stop();
  }
}

// ── permission cards ───────────────────────────────────────────────────

export interface PermissionChoice {
  optionId: string;
  label: string;
}

/** ACP permission options → ≤3 wheel options: allow once · allow session/always · deny. */
export function permissionChoices(options: PermissionParams["options"]): PermissionChoice[] {
  const opts = (options ?? []).filter((o) => o && typeof o.optionId === "string");
  const out: PermissionChoice[] = [];
  const once = opts.find((o) => o.kind === "allow_once" || o.optionId === "allow_once");
  if (once) out.push({ optionId: once.optionId, label: "Sì, solo ora" });
  const session = opts.find((o) => o.optionId === "allow_session");
  const always = opts.find((o) => o !== session && (o.optionId === "allow_always" || o.kind === "allow_always"));
  if (session) out.push({ optionId: session.optionId, label: "Sì, per la sessione" });
  else if (always) out.push({ optionId: always.optionId, label: "Sì, sempre" });
  const deny = opts.find((o) => o.kind === "reject_once" || o.optionId === "deny") ?? opts.find((o) => o.kind === "reject_always");
  if (deny) out.push({ optionId: deny.optionId, label: "No" });
  if (!out.length && opts[0]) out.push({ optionId: opts[0].optionId, label: truncate(opts[0].name ?? "Ok", 24) });
  return out.slice(0, 3);
}

export function permissionCard(p: PermissionParams, choices: PermissionChoice[]): CardDraft & { kind: "request"; options: string[] } {
  const raw = p.toolCall?.rawInput ?? {};
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const kind = p.toolCall?.kind;
  const title = command ? "Posso eseguire questo comando?" : kind === "edit" ? "Posso modificare questo file?" : "Posso procedere?";
  const card: CardDraft & { kind: "request"; options: string[] } = { kind: "request", title, options: choices.map((c) => c.label) };
  const line = description || (!command ? (p.toolCall?.title ?? "").trim() : "");
  if (line) card.lines = [truncate(line, 60)];
  if (command) card.quote = truncate(command, 140);
  return card;
}

// ── prompt text ────────────────────────────────────────────────────────

const MAX_MSG_CHARS = 500;
const MAX_CONTEXT_CHARS = 6_000;

export function instructionsBlock(instructions: string): string {
  return `[Istruzioni Hikaro: valgono per tutta questa conversazione]\n${instructions}\n[Fine istruzioni]`;
}

/** Compact, clearly delimited transcript of a Discord sub-chat (oldest first, newest kept when too long). */
export function discordContextBlock(title: string, msgs: TranscriptMessage[], update: boolean): string {
  const lines = msgs.map((m) => `${m.role === "user" ? "Utente" : "Tu"}: ${truncate(m.content.replace(/\s+/g, " ").trim(), MAX_MSG_CHARS)}`);
  while (lines.length > 1 && lines.join("\n").length > MAX_CONTEXT_CHARS) lines.shift();
  const head = update
    ? `[Nuovi messaggi nella sottochat Discord «${title}» dall'ultima volta, solo come contesto]`
    : `[Contesto: ultimi messaggi della sottochat Discord «${title}». Questa chat del Deck è collegata a quella sottochat; i messaggi del Deck non compaiono su Discord]`;
  return `${head}\n${lines.join("\n")}\n[Fine contesto]`;
}

export function buildPrompt(text: string, o: { instructions?: string; context?: string }): string {
  const parts: string[] = [];
  if (o.instructions) parts.push(instructionsBlock(o.instructions));
  if (o.context) parts.push(o.context);
  if (!parts.length) return text;
  parts.push(`Messaggio dell'utente: ${text}`);
  return parts.join("\n\n");
}

// ── backend ────────────────────────────────────────────────────────────

export interface AcpAgentSpec {
  /** agent id = profile name */
  id: string;
  name: string;
  profile: string;
  /** the profile's HERMES_HOME */
  home: string;
}

export interface HermesAcpBackendOpts {
  /** Hermes root (default profile home) */
  hermesRoot: string;
  state: StateStore;
  /** how to start `hermes acp` for a profile (null = Hermes not installed) */
  command: ((profile: string) => AcpCommand) | null;
  instructions?: string;
  /** repeat the instructions every N prompts of a session (0 = only the first) */
  instructionsEvery?: number;
  /** cwd of new ACP sessions (absolute) */
  cwd?: string;
  sqliteBin?: string;
  initTimeoutMs?: number;
  promptTimeoutMs?: number;
  /** Hermes auto-denies a permission after 60 s; we expire the card at the same time */
  permissionTimeoutMs?: number;
  /** start the processes on start() instead of at the first message */
  eager?: boolean;
}

interface PendingPermission {
  agent: string;
  sessionId: string;
  choices: PermissionChoice[];
  answer: (o: PermissionOutcome) => void;
  sink: TurnSink;
  timer: NodeJS.Timeout;
}

interface Target {
  /** state key: "deck" or the Discord session id */
  key: string;
  deck: boolean;
  discord?: DiscordSessionRow;
  title?: string;
}

let permSeq = 0;

export class HermesAcpBackend implements AgentBackend {
  readonly kind = "hermes-acp";
  private specs = new Map<string, AcpAgentSpec>();
  private readonly procs = new Map<string, AcpProcess>();
  private readonly perms = new Map<string, PendingPermission>();
  private started = false;

  constructor(private readonly o: HermesAcpBackendOpts) {}

  /** Which profiles this backend serves (called by the router at every discovery). */
  setAgents(specs: AcpAgentSpec[]): void {
    const next = new Map(specs.map((s) => [s.id, s]));
    for (const [id, p] of this.procs) {
      if (!next.has(id)) {
        void p.stop();
        this.procs.delete(id);
      }
    }
    this.specs = next;
    if (this.started && this.o.eager) for (const id of next.keys()) this.warm(id);
  }

  getSpecs(): AcpAgentSpec[] {
    return [...this.specs.values()];
  }

  private proc(agentId: string): AcpProcess {
    const spec = this.specs.get(agentId);
    if (!spec) throw new DeckError("bad_message", ERROR_VARIANTS.unknownAgent, `unknown agent ${agentId}`);
    let p = this.procs.get(agentId);
    if (!p) {
      const command = this.o.command;
      if (!command) throw new DeckError("hermes_down", ERROR_MESSAGES.hermes_down, "hermes binary not found");
      const opts: AcpProcessOpts = { profile: spec.profile, command: () => command(spec.profile) };
      if (this.o.initTimeoutMs) opts.initTimeoutMs = this.o.initTimeoutMs;
      p = new AcpProcess(opts);
      this.procs.set(agentId, p);
    }
    return p;
  }

  private warm(agentId: string): void {
    try {
      const p = this.proc(agentId);
      if (!p.ready) p.ensure().catch((e) => log.warn(`Hermes ACP (${agentId}) non parte`, e instanceof DeckError ? e.detail : e));
    } catch (e) {
      log.debug(`warm ${agentId}`, e);
    }
  }

  start(): void {
    this.started = true;
    if (this.o.eager) for (const id of this.specs.keys()) this.warm(id);
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const pending of this.perms.values()) {
      clearTimeout(pending.timer);
      pending.answer({ outcome: { outcome: "cancelled" } });
    }
    this.perms.clear();
    await Promise.all([...this.procs.values()].map((p) => p.stop()));
    this.procs.clear();
  }

  async listAgents(): Promise<BackendAgent[]> {
    return [...this.specs.values()].map((s) => ({ id: s.id, name: s.name }));
  }

  async health(): Promise<BackendHealth> {
    const ids = [...this.specs.keys()];
    const ready = ids.filter((id) => this.procs.get(id)?.ready);
    return {
      ok: !!this.o.command && ids.length > 0,
      agents: ids.length,
      detail: ids.map((id) => `${id}@acp:${this.procs.get(id)?.ready ? "up" : "idle"}`).join(" "),
    };
  }

  // ── selection (same state fields as the API backend) ──

  getSelection(agentId: string): SessionSelection {
    return this.o.state.get().selected[agentId] ?? "deck";
  }

  setSelection(agentId: string, sel: SessionSelection): void {
    this.o.state.update((s) => {
      if (sel === "deck") delete s.selected[agentId];
      else s.selected[agentId] = sel;
    });
  }

  deckUpdated(agentId: string): number {
    return this.o.state.get().deckUpdated[agentId] ?? 0;
  }

  private dbs(spec: AcpAgentSpec) {
    return { profile: spec.profile, home: spec.home, root: this.o.hermesRoot };
  }

  private async discordRows(spec: AcpAgentSpec, limit: number): Promise<DiscordSessionRow[]> {
    return listDiscordSessions(this.dbs(spec), limit, this.o.sqliteBin ?? SQLITE_BIN);
  }

  private origins(spec: AcpAgentSpec): Map<string, { chatName?: string; displayName?: string }> {
    const m = readSessionOrigins(this.o.hermesRoot);
    if (spec.home !== this.o.hermesRoot) for (const [k, v] of readSessionOrigins(spec.home)) m.set(k, v);
    return m;
  }

  private toSession(spec: AcpAgentSpec, r: DiscordSessionRow, origins: Map<string, { chatName?: string; displayName?: string }>): BackendSession {
    const o = origins.get(r.id);
    const origin: { chatName?: string; displayName?: string } = {};
    const chatName = r.chatName ?? o?.chatName;
    const displayName = r.displayName ?? o?.displayName;
    if (chatName) origin.chatName = chatName;
    if (displayName) origin.displayName = displayName;
    const info: Parameters<typeof toDeckSession>[0] = { id: r.id, source: "discord", title: r.title ?? null, preview: r.preview ?? null, last_active: r.last_active ?? null };
    if (r.started_at !== undefined) info.started_at = r.started_at;
    return toDeckSession(info, origin);
  }

  async listSessions(agentId: string): Promise<BackendSession[]> {
    const spec = this.specs.get(agentId);
    if (!spec) throw new DeckError("bad_message", ERROR_VARIANTS.unknownAgent, `unknown agent ${agentId}`);
    const origins = this.origins(spec);
    return (await this.discordRows(spec, 30)).map((r) => this.toSession(spec, r, origins)).sort((a, b) => b.updated - a.updated);
  }

  private async target(spec: AcpAgentSpec): Promise<Target> {
    const sel = this.getSelection(spec.id);
    if (sel === "deck") return { key: "deck", deck: true };
    const rows = await this.discordRows(spec, sel === "latest" ? 1 : 200);
    const row = sel === "latest" ? rows[0] : rows.find((r) => r.id === sel);
    if (!row) {
      if (sel === "latest") return { key: "deck", deck: true };
      throw new DeckError("bad_message", ERROR_VARIANTS.sessionGone, `discord session ${sel} not found`);
    }
    const title = this.toSession(spec, row, this.origins(spec)).title;
    return { key: row.id, deck: false, discord: row, title };
  }

  private link(agentId: string, key: string): AcpLink | undefined {
    return this.o.state.get().acp[agentId]?.[key];
  }

  private saveLink(agentId: string, key: string, link: AcpLink | null): void {
    this.o.state.update((s) => {
      const m = (s.acp[agentId] ??= {});
      if (link) m[key] = link;
      else delete m[key];
    });
  }

  private async newSession(proc: AcpProcess): Promise<string> {
    const r = await proc.request<{ sessionId?: string }>("session/new", { cwd: this.o.cwd ?? homedir(), mcpServers: [] }, { timeoutMs: 120_000 });
    if (!r?.sessionId) throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, "session/new without sessionId");
    return r.sessionId;
  }

  /** Start a fresh Deck conversation for an agent. */
  resetSession(agentId: string): void {
    this.saveLink(agentId, "deck", null);
  }

  async send(agentId: string, text: string, sink: TurnSink, signal?: AbortSignal): Promise<TurnResult> {
    const spec = this.specs.get(agentId);
    if (!spec) throw new DeckError("bad_message", ERROR_VARIANTS.unknownAgent, `unknown agent ${agentId}`);
    const proc = this.proc(agentId);
    const target = await this.target(spec);

    for (let attempt = 0; ; attempt++) {
      let link = this.link(agentId, target.key);
      if (!link) {
        link = { id: await this.newSession(proc), turns: 0 };
        this.saveLink(agentId, target.key, link);
        log.info(`${agentId}: nuova sessione ACP ${link.id}${target.discord ? ` collegata alla sottochat ${target.discord.id}` : ""}`);
      }

      const every = this.o.instructionsEvery ?? 8;
      const withInstructions = link.turns === 0 || (every > 0 && link.turns % every === 0);
      let context: string | undefined;
      let newestTs = link.seededTs ?? 0;
      if (target.discord) {
        const msgs = await readTranscript(target.discord.db, target.discord.id, 20, link.seededTs ?? 0, this.o.sqliteBin ?? SQLITE_BIN);
        if (msgs.length) {
          context = discordContextBlock(target.title ?? "Discord", msgs, link.seededTs !== undefined && link.turns > 0);
          newestTs = Math.max(newestTs, ...msgs.map((m) => m.ts));
        }
      }
      const promptOpts: { instructions?: string; context?: string } = {};
      if (withInstructions) promptOpts.instructions = this.o.instructions ?? AGENT_INSTRUCTIONS;
      if (context) promptOpts.context = context;
      const prompt = buildPrompt(text, promptOpts);

      const r = await this.runPrompt(agentId, proc, link.id, prompt, sink, signal);
      if (r.stopReason === "refusal" && attempt === 0 && !r.text) {
        // Hermes no longer knows this session (deleted/pruned): start over once.
        log.warn(`${agentId}: la sessione ACP ${link.id} non esiste più, ne creo una nuova`);
        this.saveLink(agentId, target.key, null);
        continue;
      }
      const next: AcpLink = { id: link.id, turns: link.turns + 1 };
      if (target.discord) next.seededTs = newestTs;
      this.saveLink(agentId, target.key, next);
      if (target.deck) this.o.state.update((s) => {
        s.deckUpdated[agentId] = Date.now();
      });
      if (r.stopReason === "cancelled") throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, "prompt cancelled");
      if (r.stopReason === "refusal" && !r.text) throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, "prompt refused");
      return { text: r.text };
    }
  }

  private async runPrompt(
    agentId: string,
    proc: AcpProcess,
    sessionId: string,
    prompt: string,
    sink: TurnSink,
    signal?: AbortSignal,
  ): Promise<{ stopReason: string; text: string }> {
    let text = "";
    // Hermes reports agent errors as a single final "Error: …" message: hold it back until we know.
    let held = "";
    proc.updates.set(sessionId, (u) => {
      if (u.sessionUpdate !== "agent_message_chunk") return;
      const t = u.content?.type === "text" && typeof u.content.text === "string" ? u.content.text : "";
      if (!t) return;
      if (!text && !held && /^Error: /.test(t)) {
        held = t;
        return;
      }
      if (held) {
        text += held;
        sink.delta(held);
        held = "";
      }
      text += t;
      sink.delta(t);
    });
    proc.permissions.set(sessionId, (p) => this.askPermission(agentId, sessionId, p, sink));
    const onAbort = () => proc.notify("session/cancel", { sessionId });
    signal?.addEventListener("abort", onAbort, { once: true });
    log.info(`prompt ACP per ${agentId} (sessione ${sessionId}, ${prompt.length} caratteri)`);
    try {
      const opts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: this.o.promptTimeoutMs ?? 30 * 60_000 };
      if (signal) opts.signal = signal;
      const res = await proc.request<{ stopReason?: string }>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: prompt }] },
        opts,
      );
      if (held && !text) throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, truncate(held, 300));
      if (held) {
        text += held;
        sink.delta(held);
      }
      return { stopReason: res?.stopReason ?? "end_turn", text };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      proc.updates.delete(sessionId);
      proc.permissions.delete(sessionId);
      for (const [ref, p] of this.perms) {
        if (p.sessionId !== sessionId) continue;
        clearTimeout(p.timer);
        p.answer({ outcome: { outcome: "cancelled" } });
        this.perms.delete(ref);
      }
    }
  }

  private askPermission(agentId: string, sessionId: string, p: PermissionParams, sink: TurnSink): Promise<PermissionOutcome> {
    const choices = permissionChoices(p.options);
    if (!choices.length) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const ref = `acp_${agentId}_${++permSeq}`;
    return new Promise<PermissionOutcome>((answer) => {
      const timer = setTimeout(() => {
        // Hermes has denied it by now; a late choice gets "card expired".
        if (this.perms.delete(ref)) answer({ outcome: { outcome: "cancelled" } });
      }, this.o.permissionTimeoutMs ?? 60_000);
      timer.unref();
      this.perms.set(ref, { agent: agentId, sessionId, choices, answer, sink, timer });
      log.info(`${agentId}: Hermes chiede un permesso (${choices.map((c) => c.optionId).join("/")})`);
      sink.approval({ ref, card: permissionCard(p, choices) });
    });
  }

  async resolve(_agentId: string, ref: string, index: number, _option?: string): Promise<void> {
    const pending = this.perms.get(ref);
    if (!pending) throw new DeckError("bad_message", ERROR_VARIANTS.cardExpired, `no pending permission ${ref}`);
    const choice = pending.choices[index];
    if (!choice) throw new DeckError("bad_message", ERROR_VARIANTS.cardExpired, `bad index ${index}`);
    clearTimeout(pending.timer);
    this.perms.delete(ref);
    pending.answer({ outcome: { outcome: "selected", optionId: choice.optionId } });
    pending.sink.resumed?.();
  }

  /** For doctor: is the process for this agent running? */
  processFor(agentId: string): AcpProcess | undefined {
    return this.procs.get(agentId);
  }
}
