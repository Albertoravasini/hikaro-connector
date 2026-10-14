/**
 * Hub — the connector's brain. Transport-agnostic: device sessions (WebSocket today,
 * Bluetooth bridge tomorrow) attach as `DeviceLink`s; agent runtimes plug in as an
 * `AgentBackend`. Owns agent LED states, last cards, pending choices and the
 * voice → STT → agent → card/TTS pipeline.
 */
import { finalizeCard, shapeText, visibleText } from "../cards/shaper.js";
import { DEFAULT_COLOR } from "../config.js";
import type {
  Agent,
  AgentState,
  Card,
  ConnectorMessage,
  ErrorCode,
  HapticPattern,
  HealthResponse,
  KeyIndex,
} from "../protocol.js";
import type { AgentOverride } from "../config.js";
import type { AgentBackend, BackendEvent, CardDraft, SessionSelection, TurnSink } from "./backend.js";
import { DeckError, ERROR_MESSAGES, ERROR_VARIANTS, toDeckError } from "./errors.js";
import { logger } from "./log.js";
import type { SttProvider } from "../voice/stt.js";
import type { TtsProvider } from "../voice/tts.js";
import { SentenceSplitter, SpeechPipeline, type SplitterOpts } from "../voice/speech.js";
import { pcmDurationMs } from "../voice/wav.js";

const log = logger("hub");

export interface DevicePrefs {
  /** TTS voice override (already validated) */
  voice?: string;
  /** false = text only, never send `audio` to this device */
  speak?: boolean;
}

export interface DeviceLink {
  readonly id: string;
  /** current preferences (from the `prefs` message) */
  readonly prefs?: DevicePrefs;
  send(msg: ConnectorMessage): void;
}

/** Fan-out speech: one TTS pipeline per distinct voice, each sending only to its devices. */
class MultiSpeech {
  constructor(private readonly pipes: SpeechPipeline[]) {}
  push(s: string): void {
    for (const p of this.pipes) p.push(s);
  }
  async finish(): Promise<void> {
    await Promise.all(this.pipes.map((p) => p.finish()));
  }
  abort(): void {
    for (const p of this.pipes) p.abort();
  }
}

export interface PushNotifier {
  onCard(agent: Agent, card: Card, state: AgentState): void;
}

interface Pending {
  agent: string;
  origin: "backend" | "question";
  ref?: string;
  options: string[];
  card: Card;
}

export interface HubOptions {
  backend: AgentBackend;
  stt: SttProvider | null;
  tts: TtsProvider | null;
  push?: PushNotifier | null;
  mac: string;
  version: string;
  overrides?: Record<string, AgentOverride>;
  doneHoldMs?: number;
  /** recordings shorter than this are treated as empty */
  minVoiceMs?: number;
  /** sentence chunking for TTS (local TTS uses smaller chunks) */
  splitter?: SplitterOpts | undefined;
}

export const DECK_SESSION_TITLE = "Chat del Deck";
const MAX_SESSIONS = 30;

/** Assign display data + keys 0..3 (overrides first, then the first free keys in order). */
export function buildAgents(list: { id: string; name: string }[], overrides: Record<string, AgentOverride> = {}): Agent[] {
  const visible = list.filter((a) => !overrides[a.id]?.hidden);
  const taken = new Set<number>();
  for (const a of visible) {
    const k = overrides[a.id]?.key;
    if (k !== undefined && k !== null) taken.add(k);
  }
  const free = [0, 1, 2, 3].filter((k) => !taken.has(k)) as KeyIndex[];
  return visible.map((a) => {
    const o = overrides[a.id] ?? {};
    let key: KeyIndex | null;
    if (o.key !== undefined) key = o.key;
    else key = free.shift() ?? null;
    return { id: a.id, name: o.name ?? a.name, color: o.color ?? DEFAULT_COLOR, key };
  });
}

export class Hub {
  private agents: Agent[] = [];
  private readonly links = new Set<DeviceLink>();
  private readonly states = new Map<string, AgentState>();
  private readonly lastCard = new Map<string, Card>();
  private readonly pending = new Map<string, Pending>();
  private readonly offTimers = new Map<string, NodeJS.Timeout>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly aborts = new Set<AbortController>();
  private readonly doneHoldMs: number;
  private readonly minVoiceMs: number;

  constructor(private readonly o: HubOptions) {
    this.doneHoldMs = o.doneHoldMs ?? 30_000;
    this.minVoiceMs = o.minVoiceMs ?? 250;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.refreshAgents();
    await this.o.backend.start?.((e) => this.onBackendEvent(e));
  }

  async stop(): Promise<void> {
    for (const t of this.offTimers.values()) clearTimeout(t);
    this.offTimers.clear();
    for (const a of this.aborts) a.abort();
    await this.o.backend.stop?.();
  }

  async refreshAgents(): Promise<Agent[]> {
    try {
      this.agents = buildAgents(await this.o.backend.listAgents(), this.o.overrides);
    } catch (err) {
      log.warn("agent discovery failed", err);
    }
    return this.agents;
  }

  getAgents(): readonly Agent[] {
    return this.agents;
  }

  getState(agent: string): AgentState {
    return this.states.get(agent) ?? "off";
  }

  async health(): Promise<HealthResponse> {
    const h = await this.o.backend.health().catch(() => ({ ok: false, agents: 0 }));
    return { ok: true, mac: this.o.mac, hermes: h.ok, agents: this.agents.length || h.agents, version: this.o.version };
  }

  // ── device links ─────────────────────────────────────────────────────

  attach(link: DeviceLink): () => void {
    this.links.add(link);
    this.sendWelcome(link);
    return () => this.links.delete(link);
  }

  sendWelcome(link: DeviceLink): void {
    link.send({ type: "welcome", agents: [...this.agents], mac: this.o.mac, version: this.o.version });
    if (!this.agents.length) {
      link.send({ type: "error", code: "no_agents", message: ERROR_MESSAGES.no_agents });
      return;
    }
    // Restore what the device missed while disconnected.
    for (const a of this.agents) {
      const st = this.getState(a.id);
      if (st !== "off") link.send({ type: "status", agent: a.id, state: st });
    }
    // Requests still waiting for an answer (oldest first, so the newest ends on screen).
    const waiting = [...this.pending.values()].sort((a, b) => a.card.ts - b.card.ts);
    for (const p of waiting) link.send({ type: "card", card: p.card });
  }

  private broadcast(msg: ConnectorMessage): void {
    for (const l of this.links) {
      try {
        l.send(msg);
      } catch (err) {
        log.debug(`send to ${l.id} failed`, err);
      }
    }
  }

  private error(code: ErrorCode, message: string = ERROR_MESSAGES[code], to?: DeviceLink): void {
    const msg: ConnectorMessage = { type: "error", code, message };
    if (to) to.send(msg);
    else this.broadcast(msg);
    this.haptic("error", to);
  }

  private reportError(err: unknown, to?: DeviceLink, fallback: ErrorCode = "agent_failed"): void {
    const e = toDeckError(err, fallback);
    log.warn(`${e.code}: ${e.detail ?? e.message}`);
    this.error(e.code, e.message, to);
  }

  private haptic(pattern: HapticPattern, to?: DeviceLink): void {
    const msg: ConnectorMessage = { type: "haptic", pattern };
    if (to) to.send(msg);
    else this.broadcast(msg);
  }

  private agent(id: string): Agent | undefined {
    return this.agents.find((a) => a.id === id);
  }

  // ── agent state / cards ──────────────────────────────────────────────

  setStatus(agent: string, state: AgentState): void {
    const t = this.offTimers.get(agent);
    if (t) {
      clearTimeout(t);
      this.offTimers.delete(agent);
    }
    if (state === "done") {
      this.offTimers.set(
        agent,
        setTimeout(() => {
          this.offTimers.delete(agent);
          if (this.getState(agent) === "done") this.setStatus(agent, "off");
        }, this.doneHoldMs).unref(),
      );
    }
    if (this.states.get(agent) === state) return;
    this.states.set(agent, state);
    this.broadcast({ type: "status", agent, state });
  }

  /** Publish a card: remember it, broadcast it, set LED + haptic, notify push. */
  private publish(agentId: string, draft: CardDraft, pending?: Omit<Pending, "agent" | "options" | "card">): Card {
    const card = finalizeCard(draft, agentId);
    this.lastCard.set(agentId, card);
    if (card.kind === "request" && pending) {
      // Only the newest request of an agent stays answerable.
      for (const [id, p] of this.pending) if (p.agent === agentId) this.pending.delete(id);
      this.pending.set(card.id, { agent: agentId, options: card.options ?? [], card, ...pending });
    }
    this.broadcast({ type: "card", card });
    let state: AgentState;
    if (card.kind === "request") {
      state = "calling";
      this.haptic("request");
    } else {
      state = "done";
      if (card.kind === "done") this.haptic("done");
    }
    this.setStatus(agentId, state);
    const a = this.agent(agentId);
    if (a && this.o.push) {
      try {
        this.o.push.onCard(a, card, state);
      } catch (err) {
        log.debug("push failed", err);
      }
    }
    return card;
  }

  private onBackendEvent(e: BackendEvent): void {
    if (!this.agent(e.agent)) return;
    if (e.type === "card") {
      const pending = e.card.kind === "request" ? (e.ref ? { origin: "backend" as const, ref: e.ref } : { origin: "question" as const }) : undefined;
      this.publish(e.agent, e.card, pending);
    } else if (e.type === "say") {
      void this.speak(e.agent, e.text);
    }
  }

  // ── device messages ──────────────────────────────────────────────────

  keyTap(link: DeviceLink, agentId: string): void {
    if (!this.agent(agentId)) return this.error("bad_message", ERROR_VARIANTS.unknownAgent, link);
    const card = this.lastCard.get(agentId);
    if (card) link.send({ type: "card", card });
    else
      link.send({
        type: "card",
        card: finalizeCard({ kind: "reply", title: "Nessuna novità.", lines: ["Tieni premuto per parlare."] }, agentId),
      });
    if (this.getState(agentId) === "done") this.setStatus(agentId, "off");
  }

  async choice(link: DeviceLink, cardId: string, index: number, option: string): Promise<void> {
    const p = this.pending.get(cardId);
    if (!p) return this.error("bad_message", ERROR_VARIANTS.cardExpired, link);
    const label = p.options[index] ?? option;
    if (!label) return this.error("bad_message", ERROR_VARIANTS.cardExpired, link);
    this.pending.delete(cardId);
    this.setStatus(p.agent, "working");
    if (p.origin === "backend" && p.ref) {
      try {
        await this.o.backend.resolve(p.agent, p.ref, index, label);
      } catch (err) {
        this.setStatus(p.agent, "off");
        this.reportError(err, link);
      }
      return;
    }
    // A question the agent asked in its text: answer with the option text.
    await this.runTurn(p.agent, label);
  }

  /** A finished recording from a device. */
  async utterance(link: DeviceLink, agentId: string, recId: string, pcm: Buffer): Promise<void> {
    if (!this.agent(agentId)) return this.error("bad_message", ERROR_VARIANTS.unknownAgent, link);
    const ms = pcmDurationMs(pcm.length);
    let text = "";
    if (ms < this.minVoiceMs && !this.o.backend.fallbackTranscript) {
      return this.error("stt_failed", ERROR_VARIANTS.sttEmpty, link);
    }
    try {
      if (this.o.stt && ms >= this.minVoiceMs) {
        const t0 = Date.now();
        text = await this.o.stt.transcribe(pcm);
        log.info(`stt ${this.o.stt.name}: ${ms} ms audio → ${Date.now() - t0} ms`);
      } else if (this.o.backend.fallbackTranscript) {
        text = this.o.backend.fallbackTranscript(agentId, pcm.length);
      } else {
        throw new DeckError("stt_failed", ERROR_VARIANTS.sttNoKey);
      }
    } catch (err) {
      return this.reportError(err, link, "stt_failed");
    }
    if (!text.trim()) return this.error("stt_failed", ERROR_VARIANTS.sttEmpty, link);
    this.broadcast({ type: "transcript", agent: agentId, id: recId, text, final: true });
    await this.runTurn(agentId, text);
  }

  // ── conversations (sessions) ─────────────────────────────────────────

  /** `sessions.list` → `sessions` (the Deck's own conversation first, then Discord threads). */
  async sessions(link: DeviceLink, agentId: string): Promise<void> {
    if (!this.agent(agentId)) return this.error("bad_message", ERROR_VARIANTS.unknownAgent, link);
    const b = this.o.backend;
    let external: Awaited<ReturnType<NonNullable<AgentBackend["listSessions"]>>> = [];
    try {
      external = (await b.listSessions?.(agentId)) ?? [];
    } catch (err) {
      log.warn(`sessions of ${agentId} unavailable`, err);
    }
    const items = [
      { id: "deck", title: DECK_SESSION_TITLE, source: "deck", updated: b.deckUpdated?.(agentId) ?? 0 },
      ...external.filter((x) => x.id !== "deck").slice(0, MAX_SESSIONS - 1),
    ];
    link.send({ type: "sessions", agent: agentId, selected: b.getSelection?.(agentId) ?? "deck", items });
  }

  /** `session.select` → remember the choice for that key, answer with `sessions`. */
  async selectSession(link: DeviceLink, agentId: string, session: string): Promise<void> {
    if (!this.agent(agentId)) return this.error("bad_message", ERROR_VARIANTS.unknownAgent, link);
    const b = this.o.backend;
    if (!b.setSelection) return this.error("bad_message", ERROR_VARIANTS.sessionsUnsupported, link);
    if (session !== "deck" && session !== "latest") {
      let known = false;
      try {
        known = ((await b.listSessions?.(agentId)) ?? []).some((x) => x.id === session);
      } catch (err) {
        return this.reportError(err, link);
      }
      if (!known) return this.error("bad_message", ERROR_VARIANTS.sessionGone, link);
    }
    b.setSelection(agentId, session as SessionSelection);
    log.info(`${agentId}: conversazione → ${session}`);
    await this.sessions(link, agentId);
  }

  /** Show the "listening" card while the user holds the key. */
  listening(agentId: string, recId: string): void {
    if (!this.agent(agentId)) return;
    this.broadcast({
      type: "card",
      card: { id: `l_${recId}`, agent: agentId, kind: "listening", title: "Ti ascolto…", ts: Date.now() },
    });
  }

  // ── turns ────────────────────────────────────────────────────────────

  /** Serialize turns per agent (one conversation at a time). */
  runTurn(agentId: string, text: string): Promise<void> {
    const prev = this.queues.get(agentId) ?? Promise.resolve();
    const next = prev.then(() => this.doTurn(agentId, text)).catch((err) => this.reportError(err));
    this.queues.set(agentId, next);
    void next.finally(() => {
      if (this.queues.get(agentId) === next) this.queues.delete(agentId);
    });
    return next;
  }

  /** Group the devices that want audio by voice; null when nobody wants audio. */
  private newSpeech(agentId: string): MultiSpeech | null {
    const tts = this.o.tts;
    if (!tts) return null;
    const groups = new Map<string, DeviceLink[]>(); // "" = configured default voice
    for (const l of this.links) {
      if (l.prefs?.speak === false) continue;
      const v = l.prefs?.voice ?? "";
      groups.set(v, [...(groups.get(v) ?? []), l]);
    }
    if (!groups.size) return null;
    let errorReported = false;
    const pipes = [...groups].map(
      ([voice, links]) =>
        new SpeechPipeline(
          tts,
          (clip, final) => {
            const msg: ConnectorMessage = { type: "audio", agent: agentId, format: clip.format, data: clip.data.toString("base64"), final };
            for (const l of links) if (this.links.has(l)) l.send(msg);
          },
          (e) => {
            if (errorReported) return;
            errorReported = true;
            this.reportError(e, undefined, "tts_failed");
          },
          voice || undefined,
        ),
    );
    return new MultiSpeech(pipes);
  }

  private async speak(agentId: string, text: string): Promise<void> {
    const speech = this.newSpeech(agentId);
    if (!speech) return;
    const splitter = new SentenceSplitter(this.o.splitter);
    for (const s of [...splitter.push(text), ...splitter.flush()]) speech.push(s);
    await speech.finish();
  }

  private async doTurn(agentId: string, text: string): Promise<void> {
    const t0 = Date.now();
    this.setStatus(agentId, "working");
    const splitter = new SentenceSplitter(this.o.splitter);
    const speech = this.newSpeech(agentId);
    let firstAudioLogged = false;
    const abort = new AbortController();
    this.aborts.add(abort);

    const sink: TurnSink = {
      delta: (d) => {
        this.broadcast({ type: "reply", agent: agentId, text: d, final: false });
        if (speech) for (const s of splitter.push(d)) {
          if (!firstAudioLogged) {
            firstAudioLogged = true;
            log.info(`first sentence to TTS after ${Date.now() - t0} ms`);
          }
          speech.push(s);
        }
      },
      approval: (req) => {
        this.publish(agentId, req.card, { origin: "backend", ref: req.ref });
      },
      resumed: () => this.setStatus(agentId, "working"),
    };

    try {
      const result = await this.o.backend.send(agentId, text, sink, abort.signal);
      const shown = visibleText(result.text);
      this.broadcast({ type: "reply", agent: agentId, text: shown, final: true });
      if (speech) for (const s of splitter.flush()) speech.push(s);
      const draft = shapeText(result.text);
      this.publish(agentId, draft, draft.kind === "request" ? { origin: "question" } : undefined);
      await speech?.finish();
      log.info(`turn ${agentId} done in ${Date.now() - t0} ms`);
    } catch (err) {
      speech?.abort();
      this.setStatus(agentId, "off");
      throw err;
    } finally {
      this.aborts.delete(abort);
    }
  }
}
