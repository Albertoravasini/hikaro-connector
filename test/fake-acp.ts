/**
 * Fake `hermes -p <profile> acp`: speaks the same newline-delimited JSON-RPC as Hermes'
 * acp_adapter (initialize, session/new, session/prompt with streamed session/update,
 * session/request_permission round-trip, session/cancel). Used by test/acp.test.ts.
 *
 *   node fake-acp.js -p <profile> acp
 *   FAKE_ACP_DIR=<dir>   sessions survive restarts in <dir>/sessions.json; every request is
 *                        appended to <dir>/log.jsonl (so the test can inspect prompts)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const profile = process.argv[process.argv.indexOf("-p") + 1] ?? "default";
const dir = process.env.FAKE_ACP_DIR ?? ".";
const sessFile = join(dir, `sessions-${profile}.json`);
const sessions: Record<string, { cwd: string; turns: number }> = existsSync(sessFile) ? JSON.parse(readFileSync(sessFile, "utf8")) : {};
let nextOut = 1000;
const waiting = new Map<number, (v: any) => void>();

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const log = (m: unknown) => appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ profile, ...(m as object) }) + "\n");
const update = (sessionId: string, u: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const chunk = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const ask = (method: string, params: unknown): Promise<any> => {
  const id = nextOut++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((r) => waiting.set(id, r));
};

process.stderr.write(`fake hermes acp for ${profile} starting\n`);
// Hermes prints nothing but JSON on stdout; a stray line must be tolerated anyway.
process.stdout.write("not json, ignore me\n");

async function handle(m: any): Promise<unknown> {
  switch (m.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentInfo: { name: "hermes-agent", version: "0.18.2-fake" },
        agentCapabilities: { loadSession: true },
        authMethods: process.env.FAKE_ACP_NO_PROVIDER ? [{ id: "hermes-setup", type: "terminal" }] : [{ id: "openrouter", name: "openrouter" }, { id: "hermes-setup", type: "terminal" }],
      };
    case "session/new": {
      const id = `${profile}-s${Object.keys(sessions).length + 1}-${Date.now() % 100000}`;
      sessions[id] = { cwd: m.params.cwd, turns: 0 };
      writeFileSync(sessFile, JSON.stringify(sessions));
      return { sessionId: id };
    }
    case "session/prompt": {
      const sid = m.params.sessionId as string;
      if (!sessions[sid]) return { stopReason: "refusal" };
      const text: string = m.params.prompt?.[0]?.text ?? "";
      sessions[sid]!.turns++;
      writeFileSync(sessFile, JSON.stringify(sessions));
      const last = text.split("\n").pop() ?? "";
      update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "penso…" } });
      update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "terminal", kind: "execute", status: "pending" });
      if (/crash/.test(last)) process.exit(3);
      if (/errore/.test(last)) {
        chunk(sid, "Error: provider authentication failed");
        return { stopReason: "end_turn" };
      }
      if (/lento/.test(last)) {
        await new Promise((r) => setTimeout(r, 5_000));
        return { stopReason: "end_turn" };
      }
      if (/approva/.test(last)) {
        const res = await ask("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "perm-check-1", title: "pulizia: rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build", description: "pulizia della build" } },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
            { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
            { optionId: "deny_always", kind: "reject_always", name: "Deny always" },
          ],
        });
        log({ permission: res });
        const chosen = res?.outcome?.outcome === "selected" ? res.outcome.optionId : "cancelled";
        chunk(sid, chosen.startsWith("allow") ? `Fatto (${chosen}).` : "Va bene, non lo faccio.");
        return { stopReason: "end_turn" };
      }
      chunk(sid, "Ciao ");
      chunk(sid, `dal profilo ${profile}.`);
      chunk(sid, ` Turno ${sessions[sid]!.turns}.`);
      return { stopReason: "end_turn" };
    }
    default: {
      const err: any = new Error(`Method not found: ${m.method}`);
      err.code = -32601;
      throw err;
    }
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => {
  buf += c;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log({ in: m });
    if (m.method && m.id !== undefined) {
      handle(m).then(
        (result) => send({ jsonrpc: "2.0", id: m.id, result }),
        (e) => send({ jsonrpc: "2.0", id: m.id, error: { code: e.code ?? -32603, message: e.message } }),
      );
    } else if (m.method === "session/cancel") {
      log({ cancelled: m.params.sessionId });
    } else if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)!(m.result);
      waiting.delete(m.id);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
