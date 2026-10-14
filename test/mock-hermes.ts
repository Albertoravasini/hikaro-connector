/** Minimal fake of the Hermes API server (only what the connector uses). */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRun {
  id: string;
  body: Record<string, any>;
  events: string[];
  closed: boolean;
  res?: ServerResponse;
  approval?: (choice: string) => void;
}

export class MockHermes {
  server!: Server;
  url = "";
  runs: MockRun[] = [];
  approvals: { runId: string; choice: string }[] = [];
  sessions = new Map<string, { role: string; content: string }[]>();
  /** rows for GET /api/sessions (newest first, like state.db ordering) */
  sessionRows: { id: string; source: string; title?: string | null; preview?: string; started_at: number; last_active?: number }[] = [];
  constructor(readonly key: string) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  private async body(req: IncomingMessage): Promise<any> {
    let s = "";
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : {};
  }

  private json(res: ServerResponse, status: number, o: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  }

  private send(run: MockRun, ev: Record<string, unknown>) {
    run.res?.write(`data: ${JSON.stringify({ run_id: run.id, timestamp: Date.now() / 1000, ...ev })}\n\n`);
  }

  private async script(run: MockRun) {
    const input: string = run.body.input;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    run.res!.write(": keepalive\n\n");
    if (input.includes("approva")) {
      this.send(run, { event: "tool.started", tool: "terminal", preview: "rm -rf build" });
      this.send(run, {
        event: "approval.request",
        command: "rm -rf build",
        description: "Cancella la cartella build",
        choices: ["once", "session", "always", "deny"],
      });
      const choice = await new Promise<string>((r) => (run.approval = r));
      this.send(run, { event: "approval.responded", choice, resolved: 1 });
      const out = choice === "deny" ? "Va bene, non la cancello." : "Fatto, cartella cancellata.";
      this.send(run, { event: "message.delta", delta: out });
      this.send(run, { event: "run.completed", output: out });
    } else if (input.includes("fallisci")) {
      this.send(run, { event: "run.failed", error: "provider exploded" });
    } else {
      const parts = ["Ciao Alberto. ", "Ho controllato la casella: ", "tre email nuove, nessuna urgente. ", "Vuoi che le riassuma?\n- Sì, riassumi\n- No, grazie"];
      for (const p of parts) {
        this.send(run, { event: "message.delta", delta: p });
        await sleep(5);
      }
      this.send(run, { event: "run.completed", output: parts.join("") });
    }
    const hist = this.sessions.get(run.body.session_id) ?? [];
    hist.push({ role: "user", content: input }, { role: "assistant", content: "ok" });
    this.sessions.set(run.body.session_id, hist);
    run.res!.end(": stream closed\n\n");
    run.closed = true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") return this.json(res, 200, { status: "ok", platform: "hermes-agent" });
    if (req.headers.authorization !== `Bearer ${this.key}`) {
      return this.json(res, 401, { error: { message: "Invalid API key", code: "invalid_api_key" } });
    }
    let m: RegExpExecArray | null;
    if (req.method === "GET" && url.pathname === "/v1/models") return this.json(res, 200, { object: "list", data: [{ id: "hermes-agent" }] });
    if (req.method === "GET" && (m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname))) {
      const s = this.sessions.get(decodeURIComponent(m[1]!));
      if (!s) return this.json(res, 404, { error: { message: "Session not found", code: "session_not_found" } });
      return this.json(res, 200, { object: "list", data: s });
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const source = url.searchParams.get("source");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const rows = this.sessionRows.filter((r) => !source || r.source === source).slice(0, limit);
      return this.json(res, 200, { object: "list", data: rows, limit, offset: 0, has_more: false });
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = await this.body(req);
      const run: MockRun = { id: `run_${this.runs.length + 1}`, body, events: [], closed: false };
      this.runs.push(run);
      return this.json(res, 202, { run_id: run.id, status: "started" });
    }
    if (req.method === "GET" && (m = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname))) {
      const run = this.runs.find((r) => r.id === m![1]);
      if (!run) return this.json(res, 404, {});
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      run.res = res;
      void this.script(run);
      return;
    }
    if (req.method === "POST" && (m = /^\/v1\/runs\/([^/]+)\/approval$/.exec(url.pathname))) {
      const run = this.runs.find((r) => r.id === m![1]);
      const body = await this.body(req);
      if (!run?.approval) return this.json(res, 409, { error: { code: "approval_not_pending" } });
      this.approvals.push({ runId: run.id, choice: body.choice });
      const a = run.approval;
      run.approval = undefined;
      a(body.choice);
      return this.json(res, 200, { object: "hermes.run.approval_response", run_id: run.id, choice: body.choice, resolved: 1 });
    }
    if (req.method === "GET" && (m = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname))) {
      return this.json(res, 200, { status: "completed", output: "" });
    }
    this.json(res, 404, {});
  }
}
