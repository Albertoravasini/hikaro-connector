import { randomBytes } from "node:crypto";
import { truncate } from "../cards/shaper.js";
import { AGENT_INSTRUCTIONS } from "../cards/instructions.js";
import type { AgentOverride, StateStore } from "../config.js";
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
import { HermesClient, type HermesEvent, type HermesSessionInfo, type HistoryMessage } from "./client.js";
import { readSessionOrigins, resolveEndpoints, splitChatName, type HermesEndpoint } from "./profiles.js";

const log = logger("hermes");

type ApprovalChoice = "once" | "session" | "always" | "deny";

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: "Sì, solo ora",
  session: "Sì, per la sessione",
  always: "Sì, sempre",
  deny: "No",
};

/** Hermes approval choices → at most 3 wheel options (once, session|always, deny). */
export function approvalOptions(choices: string[] | undefined): ApprovalChoice[] {
  const valid = (choices ?? ["once", "deny"]).filter((c): c is ApprovalChoice => c in CHOICE_LABEL);
  const picked: ApprovalChoice[] = [];
  if (valid.includes("once")) picked.push("once");
  if (valid.includes("session")) picked.push("session");
  else if (valid.includes("always")) picked.push("always");
  if (valid.includes("deny")) picked.push("deny");
  return picked.length ? picked : ["once", "deny"];
}

export function approvalCard(ev: HermesEvent, choices: ApprovalChoice[]): CardDraft & { kind: "request"; options: string[] } {
  const description = typeof ev.description === "string" ? ev.description.trim() : "";
  const command = typeof ev.command === "string" ? ev.command.trim() : "";
  const card: CardDraft & { kind: "request"; options: string[] } = {
    kind: "request",
    title: command ? "Posso eseguire questo comando?" : "Posso procedere?",
    options: choices.map((c) => CHOICE_LABEL[c]),
  };
  if (description) card.lines = [truncate(description, 60)];
  if (command) card.quote = truncate(command, 140);
  return card;
}

/** Where Deck conversations come from in Hermes' session list. */
export const EXTERNAL_SOURCE = "discord";

const toMs = (t: number | null | undefined): number => (typeof t === "number" && t > 0 ? Math.round(t < 1e12 ? t * 1000 : t) : 0);

/** Hermes session row (+ sessions.json origin) → Deck session item. */
export function toDeckSession(s: HermesSessionInfo, origin?: { chatName?: string; displayName?: string }): BackendSession {
  const { channel, thread } = splitChatName(origin?.chatName ?? origin?.displayName);
  const title = (thread || s.title || s.preview || (channel ? `#${channel}` : "") || "Conversazione").replace(/\s+/g, " ").trim();
  const item: BackendSession = {
    id: s.id,
    title: truncate(title, 60),
    source: s.source ?? EXTERNAL_SOURCE,
    updated: toMs(s.last_active) || toMs(s.started_at),
  };
  if (channel) item.channel = channel;
  return item;
}

export interface HermesBackendOpts {
  hermesHome: string;
  hermesUrl?: string | undefined;
  hermesApiKey?: string | undefined;
  overrides: Record<string, AgentOverride>;
  state: StateStore;
  instructions?: string;
}

export class HermesBackend implements AgentBackend {
  readonly kind = "hermes";
  private endpoints: HermesEndpoint[] = [];
  private readonly clients = new Map<string, HermesClient>();
  /** run id → choices shown on the card, in order */
  private readonly approvals = new Map<string, { agent: string; choices: ApprovalChoice[] }>();
  /** fallback history when Hermes cannot return the session transcript */
  private readonly localHistory = new Map<string, HistoryMessage[]>();

  constructor(private readonly o: HermesBackendOpts) {
    this.refresh();
  }

  /** Re-read profiles from disk. */
  refresh(): HermesEndpoint[] {
    this.endpoints = resolveEndpoints({
      hermesHome: this.o.hermesHome,
      hermesUrl: this.o.hermesUrl,
      hermesApiKey: this.o.hermesApiKey,
      overrides: this.o.overrides,
    });
    this.clients.clear();
    for (const e of this.endpoints) this.clients.set(e.id, new HermesClient(e.url, e.key));
    return this.endpoints;
  }

  getEndpoints(): readonly HermesEndpoint[] {
    return this.endpoints;
  }

  async listAgents(): Promise<BackendAgent[]> {
    this.refresh();
    return this.endpoints.map((e) => ({ id: e.id, name: e.name }));
  }

  async health(): Promise<BackendHealth> {
    const results = await Promise.all(this.endpoints.map((e) => this.clients.get(e.id)!.health()));
    const up = results.filter(Boolean).length;
    return {
      ok: up > 0,
      agents: this.endpoints.length,
      detail: this.endpoints.map((e, i) => `${e.id}@${e.url}:${results[i] ? "up" : "down"}`).join(" "),
    };
  }

  private client(agentId: string): HermesClient {
    const c = this.clients.get(agentId);
    if (!c) throw new DeckError("bad_message", ERROR_VARIANTS.unknownAgent, `unknown agent ${agentId}`);
    return c;
  }

  private sessionId(agentId: string): string {
    const existing = this.o.state.get().sessions[agentId];
    if (existing) return existing;
    const sid = `hikaro_${agentId}_${randomBytes(4).toString("hex")}`;
    this.o.state.update((s) => {
      s.sessions[agentId] = sid;
    });
    return sid;
  }

  /** The Deck's own conversation (one per agent, created on first use). */
  private deckSessionId(agentId: string): string {
    return this.sessionId(agentId);
  }

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

  async listSessions(agentId: string): Promise<BackendSession[]> {
    const client = this.client(agentId);
    const ep = this.endpoints.find((e) => e.id === agentId);
    const rows = await client.listSessions(EXTERNAL_SOURCE, 30);
    const origins = ep?.home ? readSessionOrigins(ep.home) : new Map();
    return rows.map((r) => toDeckSession(r, origins.get(r.id))).sort((a, b) => b.updated - a.updated);
  }

  /** Session id for the next message, following the key's selection. */
  async resolveSession(agentId: string): Promise<{ id: string; deck: boolean }> {
    const sel = this.getSelection(agentId);
    if (sel === "latest") {
      try {
        const latest = (await this.client(agentId).listSessions(EXTERNAL_SOURCE, 1))[0];
        if (latest) return { id: latest.id, deck: false };
      } catch (err) {
        if (err instanceof DeckError && err.code === "hermes_down") throw err;
        log.warn(`latest session of ${agentId} unavailable, using the Deck chat`, err);
      }
      return { id: this.deckSessionId(agentId), deck: true };
    }
    if (sel !== "deck") return { id: sel, deck: false };
    return { id: this.deckSessionId(agentId), deck: true };
  }

  /** Start a fresh conversation for an agent (next message gets a new session). */
  resetSession(agentId: string): void {
    this.o.state.update((s) => {
      delete s.sessions[agentId];
    });
  }

  async send(agentId: string, text: string, sink: TurnSink, signal?: AbortSignal): Promise<TurnResult> {
    const client = this.client(agentId);
    const { id: sessionId, deck } = await this.resolveSession(agentId);

    let history: HistoryMessage[] | null = null;
    try {
      history = await client.sessionHistory(sessionId);
    } catch (err) {
      if (err instanceof DeckError && err.code === "hermes_down") throw err;
      log.debug(`history unavailable for ${agentId}`, err);
    }
    if (!history) history = this.localHistory.get(sessionId) ?? [];

    const runInput: Parameters<HermesClient["startRun"]>[0] = {
      input: text,
      sessionId,
      instructions: this.o.instructions ?? AGENT_INSTRUCTIONS,
      history,
    };
    const runId = await client.startRun(runInput, signal);
    log.info(`run ${runId} started for ${agentId} (session ${sessionId}, ${history.length} msgs of history)`);
    const onAbort = () => void client.stop(runId);
    signal?.addEventListener("abort", onAbort, { once: true });

    let streamed = "";
    let output: string | undefined;
    try {
      for await (const ev of client.events(runId, signal)) {
        switch (ev.event) {
          case "message.delta":
            if (typeof ev.delta === "string" && ev.delta) {
              streamed += ev.delta;
              sink.delta(ev.delta);
            }
            break;
          case "approval.request": {
            const choices = approvalOptions(ev.choices);
            this.approvals.set(runId, { agent: agentId, choices });
            sink.approval({ ref: runId, card: approvalCard(ev, choices) });
            break;
          }
          case "approval.responded":
            this.approvals.delete(runId);
            sink.resumed?.();
            break;
          case "run.completed":
            output = typeof ev.output === "string" ? ev.output : streamed;
            break;
          case "run.failed":
            throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, String(ev.error ?? "run failed"));
          case "run.cancelled":
            throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, "run cancelled");
          default:
            break; // tool.*, reasoning.* → not shown on the Deck
        }
      }
      if (output === undefined) {
        const st = await client.runStatus(runId);
        if (st?.status === "failed") throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, st.error ?? "failed");
        output = st?.output ?? streamed;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.approvals.delete(runId);
    }

    const hist = this.localHistory.get(sessionId) ?? [];
    hist.push({ role: "user", content: text }, { role: "assistant", content: output });
    this.localHistory.set(sessionId, hist.slice(-30));
    if (deck) this.o.state.update((s) => {
      s.deckUpdated[agentId] = Date.now();
    });
    return { text: output };
  }

  async resolve(agentId: string, ref: string, index: number, _option?: string): Promise<void> {
    const pending = this.approvals.get(ref);
    if (!pending) throw new DeckError("bad_message", ERROR_VARIANTS.cardExpired, `no pending approval for ${ref}`);
    const choice = pending.choices[index];
    if (!choice) throw new DeckError("bad_message", ERROR_VARIANTS.cardExpired, `bad index ${index}`);
    await this.client(agentId).approve(ref, choice);
  }
}
