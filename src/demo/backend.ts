/**
 * Demo backend — no Hermes, no API keys. Used by the iOS app in the simulator.
 * Four fake agents answer canned text (streamed word by word), Outreach periodically
 * raises the "12 email pronte. Le invio?" request card, and transcripts are echoed.
 */
import type {
  AgentBackend,
  BackendAgent,
  BackendEvent,
  BackendHealth,
  BackendSession,
  CardDraft,
  SessionSelection,
  TurnResult,
  TurnSink,
} from "../core/backend.js";
import { DeckError, ERROR_VARIANTS } from "../core/errors.js";

export const DEMO_AGENTS: BackendAgent[] = [
  { id: "outreach", name: "Outreach" },
  { id: "assistente", name: "Assistente" },
  { id: "startup", name: "Startup" },
  { id: "dev", name: "Dev" },
];

export const DEMO_EMAIL_REQUEST: CardDraft = {
  kind: "request",
  title: "12 email pronte. Le invio?",
  lines: ["A: Studio Ferri + altri 11", "Oggetto: Collaborazione ads Q4"],
  quote: "Ciao Marco, ho visto il vostro lavoro per Lago...",
  options: ["Invia tutte", "Leggi una per una", "Modifica a voce"],
  counter: "1/12",
};

/** Fake Discord threads ("sottochat") per agent, minutes ago. */
const DEMO_SESSIONS: Record<string, { id: string; channel: string; title: string; ago: number }[]> = {
  outreach: [
    { id: "demo_outreach_ferri", channel: "outreach", title: "Studio Ferri", ago: 12 },
    { id: "demo_outreach_listino", channel: "outreach", title: "Listino Q4", ago: 190 },
    { id: "demo_outreach_lago", channel: "clienti", title: "Lago · follow-up", ago: 1500 },
  ],
  assistente: [{ id: "demo_assistente_agenda", channel: "agenda", title: "Settimana prossima", ago: 45 }],
  startup: [{ id: "demo_startup_metriche", channel: "metriche", title: "Preordini ottobre", ago: 300 }],
  dev: [
    { id: "demo_dev_login", channel: "dev", title: "bug login", ago: 30 },
    { id: "demo_dev_deploy", channel: "dev", title: "deploy venerdì", ago: 720 },
  ],
};

const DEMO_TRANSCRIPTS: Record<string, string> = {
  outreach: "Come vanno le email di oggi?",
  assistente: "Cosa ho in agenda domani?",
  startup: "Riassumimi le metriche della settimana.",
  dev: "La build è passata?",
};

function cannedReply(agent: string, text: string): string {
  const said = text.trim().replace(/[.?!]+$/, "");
  switch (agent) {
    case "outreach":
      return `Hai detto: «${said}». Ho 12 email pronte per Studio Ferri e altri 11 studi. Ti avviso appena qualcuno risponde.`;
    case "assistente":
      return `Hai detto: «${said}». Domani alle 10 hai la call con Marco, alle 15 il dentista. Nient'altro in agenda.`;
    case "startup":
      return `Hai detto: «${said}». Questa settimana 214 preordini, più 18 per cento. Il deposito medio è stabile.`;
    case "dev":
      return `Hai detto: «${said}». La build è passata, 142 test verdi. Vuoi che faccia il deploy?\n- Fai il deploy\n- Aspetta\n- Mostrami i log`;
    default:
      return `Hai detto: «${said}». Fatto.`;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DeckError("agent_failed", undefined, "aborted"));
      },
      { once: true },
    );
  });

export interface DemoOpts {
  /** how often Outreach raises the email request (ms); 0 = never */
  intervalMs: number;
  /** delay before the first request (ms) */
  firstDelayMs?: number;
  /** delay between streamed words (ms) */
  wordDelayMs?: number;
}

export class DemoBackend implements AgentBackend {
  readonly kind = "demo";
  private emit: ((e: BackendEvent) => void) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private requestOpen = false;
  private seq = 0;
  private readonly selection = new Map<string, SessionSelection>();
  private readonly deckTs = new Map<string, number>();
  private readonly t0 = Date.now();

  constructor(private readonly o: DemoOpts) {}

  start(emit: (e: BackendEvent) => void): void {
    this.emit = emit;
    if (this.o.intervalMs > 0) {
      this.timers.push(setTimeout(() => this.raiseRequest(), this.o.firstDelayMs ?? 8_000));
      this.timers.push(setInterval(() => this.raiseRequest(), this.o.intervalMs));
    }
  }

  stop(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  /** Raise the Outreach email request (unless one is already waiting). */
  raiseRequest(): void {
    if (this.requestOpen || !this.emit) return;
    this.requestOpen = true;
    this.emit({ type: "card", agent: "outreach", card: DEMO_EMAIL_REQUEST, ref: `demo_email_${++this.seq}`, haptic: "request" });
  }

  async listAgents(): Promise<BackendAgent[]> {
    return DEMO_AGENTS;
  }

  async health(): Promise<BackendHealth> {
    return { ok: true, agents: DEMO_AGENTS.length, detail: "demo" };
  }

  async listSessions(agentId: string): Promise<BackendSession[]> {
    return (DEMO_SESSIONS[agentId] ?? []).map((x) => ({
      id: x.id,
      title: x.title,
      source: "discord",
      channel: x.channel,
      updated: this.t0 - x.ago * 60_000,
    }));
  }

  getSelection(agentId: string): SessionSelection {
    return this.selection.get(agentId) ?? "deck";
  }

  setSelection(agentId: string, sel: SessionSelection): void {
    this.selection.set(agentId, sel);
  }

  deckUpdated(agentId: string): number {
    return this.deckTs.get(agentId) ?? 0;
  }

  fallbackTranscript(agentId: string): string {
    return DEMO_TRANSCRIPTS[agentId] ?? "Ciao!";
  }

  async send(agentId: string, text: string, sink: TurnSink, signal?: AbortSignal): Promise<TurnResult> {
    if (!DEMO_AGENTS.some((a) => a.id === agentId)) {
      throw new DeckError("bad_message", ERROR_VARIANTS.unknownAgent, `unknown agent ${agentId}`);
    }
    const sel = this.getSelection(agentId);
    const thread = sel === "deck" ? undefined : sel === "latest" ? DEMO_SESSIONS[agentId]?.[0] : DEMO_SESSIONS[agentId]?.find((x) => x.id === sel);
    if (!thread) this.deckTs.set(agentId, Date.now());
    const reply = (thread ? `Nella sottochat «${thread.title}». ` : "") + cannedReply(agentId, text);
    await sleep(250, signal); // "thinking"
    const words = reply.split(/(?<=\s)/);
    for (const w of words) {
      sink.delta(w);
      await sleep(this.o.wordDelayMs ?? 35, signal);
    }
    return { text: reply };
  }

  async resolve(agentId: string, ref: string, index: number): Promise<void> {
    if (!ref.startsWith("demo_email_")) {
      throw new DeckError("bad_message", ERROR_VARIANTS.cardExpired, `unknown ref ${ref}`);
    }
    const emit = this.emit;
    if (!emit) return;
    setTimeout(() => {
      this.requestOpen = false;
      if (index === 0) {
        emit({
          type: "card",
          agent: agentId,
          card: { kind: "done", title: "Inviate.", lines: ["12 email · 0 errori", "Ti avviso quando rispondono."] },
          haptic: "done",
        });
        emit({ type: "say", agent: agentId, text: "Inviate. Ti avviso quando rispondono." });
      } else if (index === 1) {
        emit({
          type: "card",
          agent: agentId,
          card: {
            kind: "reply",
            title: "Email 1 di 12 · Studio Ferri",
            lines: ["A: marco@studioferri.it", "Oggetto: Collaborazione ads Q4"],
            quote: "Ciao Marco, ho visto il vostro lavoro per Lago e mi è piaciuto molto...",
            counter: "1/12",
          },
        });
      } else {
        emit({
          type: "card",
          agent: agentId,
          card: { kind: "reply", title: "Dimmi cosa cambiare.", lines: ["Tieni premuto e parla."] },
        });
        emit({ type: "say", agent: agentId, text: "Dimmi cosa cambiare." });
      }
    }, 600);
  }
}
