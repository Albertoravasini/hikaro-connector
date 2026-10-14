/**
 * Minimal Hermes API server client (hermes-agent v0.18.2, gateway/platforms/api_server.py).
 *
 *   GET  /health                          → {status:"ok", platform:"hermes-agent", version}  (no auth)
 *   GET  /v1/models                       → model id = profile name (or "hermes-agent")
 *   POST /v1/runs                         → 202 {run_id, status:"started"}
 *        body {input, session_id?, instructions?, conversation_history?, model?}
 *        NB: /v1/runs does NOT load history from session_id by itself; it only tags
 *        the run's transcript with it. History is passed in conversation_history.
 *   GET  /v1/runs/{id}/events             → SSE "data: {json}\n\n", events:
 *        message.delta{delta} · tool.started/completed · reasoning.available ·
 *        approval.request{command,description,choices[]} · approval.responded ·
 *        run.completed{output} · run.failed{error} · run.cancelled
 *   POST /v1/runs/{id}/approval           → body {choice: once|session|always|deny}
 *   POST /v1/runs/{id}/stop
 *   GET  /api/sessions/{id}/messages      → {data:[{role,content,…}]} (404 if unknown)
 *   GET  /api/sessions?source=discord&limit=N → {data:[{id,source,title,started_at,last_active,preview,…}]}
 *        ordered by last activity (state.db), timestamps in epoch SECONDS.
 *        A /v1/runs call with an existing (Discord) session_id appends its turns to that same
 *        session in state.db (create_session only enriches NULL metadata on conflict), and the
 *        Discord gateway reloads the transcript from state.db at its next message.
 * Auth: `Authorization: Bearer <API_SERVER_KEY>`.
 */
import { DeckError, ERROR_MESSAGES, ERROR_VARIANTS } from "../core/errors.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface HermesEvent {
  event: string;
  run_id?: string;
  delta?: string;
  output?: string;
  error?: string;
  command?: string;
  description?: string;
  choices?: string[];
  [k: string]: unknown;
}

export interface HermesSessionInfo {
  id: string;
  source?: string;
  title?: string | null;
  preview?: string | null;
  started_at?: number;
  last_active?: number | null;
}

export interface StartRunInput {
  input: string;
  sessionId: string;
  instructions?: string;
  history?: HistoryMessage[];
}

const NET_ERR = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|fetch failed|socket|timed? ?out|aborted due to timeout/i;

export class HermesClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async req(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    const signals = [AbortSignal.timeout(timeoutMs ?? 15_000)];
    if (rest.signal) signals.push(rest.signal);
    try {
      return await fetch(this.baseUrl + path, { ...rest, signal: AbortSignal.any(signals) });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      if (rest.signal?.aborted) throw err;
      const text = `${e.message} ${e.cause?.code ?? ""} ${e.cause?.message ?? ""}`;
      if (NET_ERR.test(text)) throw new DeckError("hermes_down", ERROR_MESSAGES.hermes_down, text.trim());
      throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, text.trim());
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new DeckError("agent_failed", ERROR_VARIANTS.hermesKey, `${what}: HTTP ${res.status}`);
    }
    if (res.status === 429) {
      throw new DeckError("agent_failed", ERROR_VARIANTS.agentBusy, `${what}: HTTP 429 ${body.slice(0, 200)}`);
    }
    throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, `${what}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  /** True when the API server answers /health. Never throws. */
  async health(timeoutMs = 2_000): Promise<boolean> {
    try {
      const res = await this.req("/health", { timeoutMs });
      if (!res.ok) return false;
      const j = (await res.json().catch(() => ({}))) as { status?: string };
      return j.status === "ok";
    } catch {
      return false;
    }
  }

  /** Authenticated probe: is our key accepted? */
  async checkAuth(timeoutMs = 3_000): Promise<boolean> {
    try {
      const res = await this.req("/v1/models", { headers: this.headers(), timeoutMs });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Transcript of a session, or null if Hermes does not know it (yet). */
  async sessionHistory(sessionId: string, limit = 30): Promise<HistoryMessage[] | null> {
    const res = await this.req(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      headers: this.headers(),
      timeoutMs: 5_000,
    });
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res, "session messages");
    const j = (await res.json()) as { data?: Array<{ role?: string; content?: unknown }> };
    const msgs: HistoryMessage[] = [];
    for (const m of j.data ?? []) {
      if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    return msgs.slice(-limit);
  }

  /** Persisted sessions, most recently active first. */
  async listSessions(source?: string, limit = 30): Promise<HermesSessionInfo[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (source) q.set("source", source);
    const res = await this.req(`/api/sessions?${q}`, { headers: this.headers(), timeoutMs: 5_000 });
    if (!res.ok) return this.fail(res, "list sessions");
    const j = (await res.json()) as { data?: HermesSessionInfo[] };
    return (j.data ?? []).filter((x) => x && typeof x.id === "string");
  }

  async startRun(i: StartRunInput, signal?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = { input: i.input, session_id: i.sessionId };
    if (i.instructions) body.instructions = i.instructions;
    if (i.history?.length) body.conversation_history = i.history;
    const init: RequestInit & { timeoutMs?: number } = {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    const res = await this.req("/v1/runs", init);
    if (!res.ok) return this.fail(res, "start run");
    const j = (await res.json()) as { run_id?: string };
    if (!j.run_id) throw new DeckError("agent_failed", ERROR_MESSAGES.agent_failed, "no run_id");
    return j.run_id;
  }

  /** Stream run events (SSE). Ends when Hermes closes the stream. */
  async *events(runId: string, signal?: AbortSignal): AsyncGenerator<HermesEvent> {
    const init: RequestInit & { timeoutMs?: number } = {
      headers: { ...this.headers(), Accept: "text/event-stream" },
      timeoutMs: 30 * 60_000, // agent runs can be long; keepalives arrive every 30 s
    };
    if (signal) init.signal = signal;
    const res = await this.req(`/v1/runs/${encodeURIComponent(runId)}/events`, init);
    if (!res.ok || !res.body) {
      await this.fail(res, "run events");
      return;
    }
    yield* parseSse(res.body);
  }

  async runStatus(runId: string): Promise<{ status?: string; output?: string; error?: string } | null> {
    const res = await this.req(`/v1/runs/${encodeURIComponent(runId)}`, { headers: this.headers(), timeoutMs: 5_000 });
    if (!res.ok) return null;
    return (await res.json()) as { status?: string; output?: string; error?: string };
  }

  async approve(runId: string, choice: "once" | "session" | "always" | "deny"): Promise<void> {
    const res = await this.req(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ choice }),
    });
    if (!res.ok) await this.fail(res, "approval");
  }

  async stop(runId: string): Promise<void> {
    await this.req(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      headers: this.headers(),
      timeoutMs: 3_000,
    }).catch(() => undefined);
  }
}

/** Parse a text/event-stream body into JSON `data:` payloads. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<HermesEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const ev = parseSseBlock(raw);
      if (ev) yield ev;
    }
  }
  const tail = parseSseBlock(buf);
  if (tail) yield tail;
}

export function parseSseBlock(raw: string): HermesEvent | null {
  const data: string[] = [];
  let name: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) name = line.slice(6).trim();
  }
  if (!data.length) return null;
  try {
    const obj = JSON.parse(data.join("\n")) as HermesEvent;
    if (!obj.event && name) obj.event = name;
    return obj;
  } catch {
    return null;
  }
}
