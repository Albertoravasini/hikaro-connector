/**
 * Minimal JSON-RPC 2.0 peer over a byte stream pair, framed as newline-delimited JSON
 * (one message per line) — the framing of the Python `acp` SDK used by `hermes acp`
 * (acp/connection.py: `await reader.readline()` + `json.loads(line)`; writes `json.dumps(msg) + "\n"`).
 *
 * Both sides can send requests: we call the agent (initialize, session/new, session/prompt…),
 * the agent calls us (session/request_permission) and notifies us (session/update).
 */
import type { Readable, Writable } from "node:stream";

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
  toObject(): RpcErrorObject {
    const o: RpcErrorObject = { code: this.code, message: this.message };
    if (this.data !== undefined) o.data = this.data;
    return o;
  }
}

/** The connection is gone (child exited, stream closed). */
export class RpcClosedError extends Error {
  constructor(message = "connection closed") {
    super(message);
    this.name = "RpcClosedError";
  }
}

export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: unknown) => void;

interface Outgoing {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: NodeJS.Timeout;
}

type Id = number | string;

/** Split a growing text buffer into complete lines; returns [lines, rest]. */
export function splitLines(buf: string): [string[], string] {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  return [parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== ""), rest];
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<Id, Outgoing>();
  private buf = "";
  private closed = false;
  private onRequest: RequestHandler = (m) => {
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${m}`);
  };
  private onNotification: NotificationHandler = () => {};
  /** non-JSON lines on the stream (should not happen; logged by the owner) */
  onGarbage: (line: string) => void = () => {};

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.feed(chunk));
    input.on("end", () => this.close(new RpcClosedError("stream ended")));
    input.on("error", (e) => this.close(new RpcClosedError(`stream error: ${e.message}`)));
    output.on("error", (e) => this.close(new RpcClosedError(`write error: ${e.message}`)));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  handleRequests(h: RequestHandler): void {
    this.onRequest = h;
  }

  handleNotifications(h: NotificationHandler): void {
    this.onNotification = h;
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed) throw new RpcClosedError();
    this.output.write(JSON.stringify(msg) + "\n");
  }

  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Outgoing = { method, resolve: resolve as (v: unknown) => void, reject };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(INTERNAL_ERROR, `${method}: timeout after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        if (opts.signal.aborted) return reject(opts.signal.reason ?? new Error("aborted"));
        opts.signal.addEventListener(
          "abort",
          () => {
            if (!this.pending.delete(id)) return;
            if (entry.timer) clearTimeout(entry.timer);
            reject(opts.signal!.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      }
      this.pending.set(id, entry);
      try {
        this.write({ jsonrpc: "2.0", id, method, params: params ?? null });
      } catch (e) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(e);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params: params ?? null });
    } catch {
      /* closed: notifications are best-effort */
    }
  }

  /** Feed raw text from the stream (exposed for tests). */
  feed(chunk: string): void {
    this.buf += chunk;
    const [lines, rest] = splitLines(this.buf);
    this.buf = rest;
    for (const line of lines) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.onGarbage(line);
        continue;
      }
      if (msg && typeof msg === "object" && !Array.isArray(msg)) this.dispatch(msg as Record<string, unknown>);
      else this.onGarbage(line);
    }
  }

  private dispatch(m: Record<string, unknown>): void {
    const hasId = "id" in m && (typeof m.id === "number" || typeof m.id === "string");
    const method = typeof m.method === "string" ? m.method : undefined;
    if (method && hasId) {
      void this.answer(m.id as Id, method, m.params);
    } else if (method) {
      try {
        this.onNotification(method, m.params);
      } catch {
        /* a broken listener must not kill the stream */
      }
    } else if (hasId) {
      const p = this.pending.get(m.id as Id);
      if (!p) return; // late answer to a request that timed out
      this.pending.delete(m.id as Id);
      if (p.timer) clearTimeout(p.timer);
      if ("error" in m && m.error) {
        const e = m.error as Partial<RpcErrorObject>;
        p.reject(new RpcError(typeof e.code === "number" ? e.code : INTERNAL_ERROR, String(e.message ?? "error"), e.data));
      } else {
        p.resolve(m.result ?? null);
      }
    }
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequest(method, params);
      if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      if (!this.closed) {
        try {
          this.write({ jsonrpc: "2.0", id, error: e.toObject() });
        } catch {
          /* closed meanwhile */
        }
      }
    }
  }

  /** Reject everything in flight; further calls fail fast. */
  close(reason: Error = new RpcClosedError()): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
  }
}
