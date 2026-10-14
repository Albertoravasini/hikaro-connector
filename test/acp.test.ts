import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { StateStore } from "../src/config.js";
import type { ApprovalRequest } from "../src/core/backend.js";
import { DeckError } from "../src/core/errors.js";
import { buildAgents } from "../src/core/hub.js";
import {
  HermesAcpBackend,
  acpHandshake,
  buildPrompt,
  discordContextBlock,
  hasModelProvider,
  permissionCard,
  permissionChoices,
  type AcpCommand,
} from "../src/hermes/acp.js";
import { HermesBackend } from "../src/hermes/backend.js";
import { JsonRpcPeer, RpcClosedError, RpcError, splitLines } from "../src/hermes/jsonrpc.js";
import { NameResolver, capitalise, fetchBotName } from "../src/hermes/names.js";
import { HermesRouter } from "../src/hermes/router.js";
import { foreignDiscordIds, listDiscordSessions, newestPerKey, profileOfKey, readTranscript } from "../src/hermes/statedb.js";
import { sleep, tmpHome } from "./helpers.js";

const FAKE = fileURLToPath(new URL("./fake-acp.js", import.meta.url));

// ── JSON-RPC framing ─────────────────────────────────────────────────

function pair(): [JsonRpcPeer, JsonRpcPeer] {
  const ab = new PassThrough();
  const ba = new PassThrough();
  return [new JsonRpcPeer(ba, ab), new JsonRpcPeer(ab, ba)];
}

describe("JSON-RPC over newline-delimited JSON", () => {
  test("lines are split on \\n, partial lines wait, blank and \\r are dropped", () => {
    assert.deepEqual(splitLines('{"a":1}\n{"b"'), [['{"a":1}'], '{"b"']);
    assert.deepEqual(splitLines('{"a":1}\r\n\n{"b":2}\n'), [['{"a":1}', '{"b":2}'], ""]);
  });

  test("requests, results, errors, notifications both ways", async () => {
    const [client, agent] = pair();
    agent.handleRequests(async (method, params) => {
      if (method === "echo") return params;
      if (method === "boom") throw new RpcError(42, "nope", { why: "test" });
      throw new RpcError(-32601, `Method not found: ${method}`);
    });
    const notes: unknown[] = [];
    client.handleNotifications((m, p) => notes.push([m, p]));
    assert.deepEqual(await client.request("echo", { x: "è ✓" }), { x: "è ✓" });
    await assert.rejects(client.request("boom"), (e: RpcError) => e.code === 42 && e.message === "nope");
    await assert.rejects(client.request("nada"), (e: RpcError) => e.code === -32601);
    agent.notify("session/update", { n: 1 });
    // agent → client request (like session/request_permission)
    client.handleRequests((m) => (m === "ask" ? { ok: true } : null));
    assert.deepEqual(await agent.request("ask", {}), { ok: true });
    await sleep(5);
    assert.deepEqual(notes, [["session/update", { n: 1 }]]);
  });

  test("a message split across chunks is reassembled; garbage lines are reported, not fatal", async () => {
    const out = new PassThrough();
    const inp = new PassThrough();
    const peer = new JsonRpcPeer(inp, out);
    const garbage: string[] = [];
    peer.onGarbage = (l) => garbage.push(l);
    const written: string[] = [];
    out.on("data", (d: Buffer) => written.push(d.toString()));
    const p = peer.request("initialize", { protocolVersion: 1 });
    await sleep(5);
    assert.equal(written.join(""), '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n');
    inp.write("Loaded env from x\n");
    inp.write('{"jsonrpc":"2.0","id":1,"res');
    inp.write('ult":{"protocolVersion":1}}\n');
    assert.deepEqual(await p, { protocolVersion: 1 });
    assert.deepEqual(garbage, ["Loaded env from x"]);
  });

  test("closing rejects pending requests; timeouts reject", async () => {
    const client = new JsonRpcPeer(new PassThrough(), new PassThrough());
    await assert.rejects(client.request("slow", {}, { timeoutMs: 20 }), /timeout/);
    const p = client.request("never");
    client.close(new RpcClosedError("child exited"));
    await assert.rejects(p, (e: Error) => e instanceof RpcClosedError && /child exited/.test(e.message));
    await assert.rejects(client.request("x"), RpcClosedError);
  });
});

// ── permission mapping / prompt text ─────────────────────────────────

test("ACP permission options → ≤3 wheel options with Italian labels", () => {
  const full = [
    { optionId: "allow_once", kind: "allow_once" },
    { optionId: "allow_session", kind: "allow_always" },
    { optionId: "allow_always", kind: "allow_always" },
    { optionId: "deny", kind: "reject_once" },
    { optionId: "deny_always", kind: "reject_always" },
  ];
  assert.deepEqual(permissionChoices(full), [
    { optionId: "allow_once", label: "Sì, solo ora" },
    { optionId: "allow_session", label: "Sì, per la sessione" },
    { optionId: "deny", label: "No" },
  ]);
  assert.deepEqual(
    permissionChoices([{ optionId: "allow_once", kind: "allow_once" }, { optionId: "allow_always", kind: "allow_always" }, { optionId: "deny", kind: "reject_once" }]).map((c) => c.label),
    ["Sì, solo ora", "Sì, sempre", "No"],
  );
  // edit approval: allow once + deny only
  const edit = permissionChoices([{ optionId: "allow_once", kind: "allow_once", name: "Allow edit" }, { optionId: "deny", kind: "reject_once" }]);
  assert.deepEqual(edit.map((c) => c.label), ["Sì, solo ora", "No"]);
  const card = permissionCard({ sessionId: "s", toolCall: { title: "Edit notes.md", kind: "edit" } }, edit);
  assert.equal(card.title, "Posso modificare questo file?");
  assert.deepEqual(card.lines, ["Edit notes.md"]);
  const cmd = permissionCard({ sessionId: "s", toolCall: { kind: "execute", rawInput: { command: "rm -rf build", description: "pulizia" } } }, edit);
  assert.equal(cmd.title, "Posso eseguire questo comando?");
  assert.equal(cmd.quote, "rm -rf build");
  assert.deepEqual(cmd.lines, ["pulizia"]);
});

test("prompt text: instructions and Discord context are delimited, the user's words come last", () => {
  assert.equal(buildPrompt("ciao", {}), "ciao");
  const p = buildPrompt("e adesso?", { instructions: "Rispondi breve.", context: discordContextBlock("#outreach / Ferri", [{ role: "user", content: "manda la mail", ts: 1 }, { role: "assistant", content: "fatto", ts: 2 }], false) });
  assert.match(p, /^\[Istruzioni Hikaro[^\n]*\]\nRispondi breve\.\n\[Fine istruzioni\]\n\n\[Contesto: ultimi messaggi della sottochat Discord «#outreach \/ Ferri»/);
  assert.match(p, /\nUtente: manda la mail\nTu: fatto\n\[Fine contesto\]\n\nMessaggio dell'utente: e adesso\?$/);
  const long = Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `${i} ${"x".repeat(400)}`, ts: i }));
  const block = discordContextBlock("t", long, true);
  assert.ok(block.length < 7_000);
  assert.match(block, /^\[Nuovi messaggi/);
  assert.match(block, /Utente: 39 /, "the newest messages are kept");
});

// ── ACP backend against the fake server ──────────────────────────────

function fakeCommand(dir: string, extraEnv: Record<string, string> = {}) {
  return (profile: string): AcpCommand => ({
    command: process.execPath,
    args: [FAKE, "-p", profile, "acp"],
    env: { ...process.env, FAKE_ACP_DIR: dir, ...extraEnv },
  });
}

function readLog(dir: string): any[] {
  try {
    return readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const prompts = (dir: string, profile?: string): string[] =>
  readLog(dir)
    .filter((e) => e.in?.method === "session/prompt" && (!profile || e.profile === profile))
    .map((e) => e.in.params.prompt[0].text as string);

const noSink = { delta: () => {}, approval: () => assert.fail("no approval expected") };

function acpSetup(over: Partial<ConstructorParameters<typeof HermesAcpBackend>[0]> = {}) {
  const home = tmpHome();
  const dir = mkdtempSync(join(tmpdir(), "fakeacp-"));
  const root = mkdtempSync(join(tmpdir(), "hermes-"));
  const state = new StateStore(join(home, "state.json"));
  const backend = new HermesAcpBackend({ hermesRoot: root, state, command: fakeCommand(dir), cwd: "/tmp", instructionsEvery: 3, ...over });
  backend.setAgents([
    { id: "creads", name: "Creads", profile: "creads", home: join(root, "profiles", "creads") },
    { id: "ifh", name: "Ifh", profile: "ifh", home: join(root, "profiles", "ifh") },
  ]);
  return { backend, state, dir, root };
}

describe("HermesAcpBackend (fake hermes acp)", () => {
  test("handshake helper: initialize works, provider detection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakeacp-"));
    const ok = await acpHandshake(fakeCommand(dir)("creads"), 10_000);
    assert.equal(ok.ok, true);
    assert.equal(ok.init?.agentInfo?.version, "0.18.2-fake");
    assert.equal(hasModelProvider(ok.init), true);
    const init = readLog(dir).find((e) => e.in?.method === "initialize").in.params;
    assert.equal(init.protocolVersion, 1);
    assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    const noProv = await acpHandshake(fakeCommand(dir, { FAKE_ACP_NO_PROVIDER: "1" })("creads"), 10_000);
    assert.equal(hasModelProvider(noProv.init), false);
    const bad = await acpHandshake({ command: "/nonexistent/hermes", args: ["-p", "x", "acp"] }, 5_000);
    assert.equal(bad.ok, false);
  });

  test("streams chunks as deltas, one session per agent, instructions on the 1st prompt and every N", async () => {
    const { backend, state, dir } = acpSetup();
    try {
      backend.start();
      assert.deepEqual((await backend.listAgents()).map((a) => a.id), ["creads", "ifh"]);
      const deltas: string[] = [];
      const r = await backend.send("creads", "come va?", { delta: (d) => deltas.push(d), approval: () => assert.fail() });
      assert.equal(r.text, "Ciao dal profilo creads. Turno 1.");
      assert.deepEqual(deltas, ["Ciao ", "dal profilo creads.", " Turno 1."], "thoughts/tool calls are not shown");
      const link = state.get().acp.creads!.deck!;
      assert.match(link.id, /^creads-s1-/);
      assert.equal(link.turns, 1);
      assert.ok(state.get().deckUpdated.creads! > 0);
      const newSess = readLog(dir).find((e) => e.in?.method === "session/new").in.params;
      assert.deepEqual(newSess, { cwd: "/tmp", mcpServers: [] });
      await backend.send("creads", "e poi?", noSink);
      const r3 = await backend.send("creads", "ultima", noSink);
      assert.equal(r3.text, "Ciao dal profilo creads. Turno 3.", "same ACP session kept");
      await backend.send("creads", "quarta", noSink);
      const ps = prompts(dir, "creads");
      assert.match(ps[0]!, /^\[Istruzioni Hikaro/);
      assert.match(ps[0]!, /Messaggio dell'utente: come va\?$/);
      assert.equal(ps[1], "e poi?");
      assert.equal(ps[2], "ultima");
      assert.match(ps[3]!, /^\[Istruzioni Hikaro/, "repeated every 3 turns");
      // the other agent has its own process and session
      assert.equal((await backend.send("ifh", "ciao", noSink)).text, "Ciao dal profilo ifh. Turno 1.");
    } finally {
      await backend.stop();
    }
  });

  test("request_permission → request card → choice answers the JSON-RPC request", async () => {
    const { backend, dir } = acpSetup();
    try {
      let resumed = false;
      let card = null as ApprovalRequest | null;
      const r = await backend.send("creads", "approva la pulizia", {
        delta: () => {},
        approval: (req) => {
          card = req;
          assert.deepEqual(req.card.options, ["Sì, solo ora", "Sì, per la sessione", "No"]);
          assert.equal(req.card.quote, "rm -rf build");
          assert.deepEqual(req.card.lines, ["pulizia della build"]);
          void backend.resolve("creads", req.ref, 1, "Sì, per la sessione");
        },
        resumed: () => (resumed = true),
      });
      assert.ok(card);
      assert.equal(r.text, "Fatto (allow_session).");
      assert.ok(resumed);
      assert.deepEqual(readLog(dir).find((e) => e.permission).permission, { outcome: { outcome: "selected", optionId: "allow_session" } });
      // the card is gone once answered
      await assert.rejects(backend.resolve("creads", card!.ref, 0, "x"), (e: DeckError) => e.code === "bad_message");
    } finally {
      await backend.stop();
    }
  });

  test("an unanswered permission expires as cancelled (Hermes then denies)", async () => {
    const { backend, dir } = acpSetup({ permissionTimeoutMs: 100 });
    try {
      const r = await backend.send("creads", "approva", { delta: () => {}, approval: () => {} });
      assert.equal(r.text, "Va bene, non lo faccio.");
      assert.deepEqual(readLog(dir).find((e) => e.permission).permission, { outcome: { outcome: "cancelled" } });
    } finally {
      await backend.stop();
    }
  });

  test("errors: 'Error: …' reply → agent_failed (not spoken); unknown session → new session; crash → hermes_down then respawn", async () => {
    const { backend, state } = acpSetup();
    try {
      const deltas: string[] = [];
      await assert.rejects(
        backend.send("creads", "fai un errore", { delta: (d) => deltas.push(d), approval: () => {} }),
        (e: DeckError) => e.code === "agent_failed" && /provider authentication/.test(e.detail ?? ""),
      );
      assert.deepEqual(deltas, []);
      // a session Hermes no longer knows
      state.update((s) => {
        s.acp.creads = { deck: { id: "gone-session", turns: 5 } };
      });
      const r = await backend.send("creads", "ci sei?", noSink);
      assert.equal(r.text, "Ciao dal profilo creads. Turno 1.");
      assert.notEqual(state.get().acp.creads!.deck!.id, "gone-session");
      // crash mid-prompt
      await assert.rejects(backend.send("creads", "crash", noSink), (e: DeckError) => e.code === "hermes_down");
      await sleep(1_300); // backoff 1 s, then automatic respawn
      const again = await backend.send("creads", "di nuovo", noSink);
      assert.match(again.text, /^Ciao dal profilo creads\. Turno \d+\.$/, "the persisted session is reused after the restart");
    } finally {
      await backend.stop();
    }
  });

  test("abort sends session/cancel", async () => {
    const { backend, dir } = acpSetup();
    try {
      const ac = new AbortController();
      const p = backend.send("creads", "lento", noSink, ac.signal);
      await sleep(600);
      ac.abort();
      await assert.rejects(p);
      await sleep(100);
      assert.ok(readLog(dir).some((e) => e.cancelled));
    } finally {
      await backend.stop();
    }
  });
});

// ── state.db (read-only) and linked Discord sub-chats ────────────────

const SCHEMA = `CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, session_key TEXT, title TEXT, display_name TEXT, origin_json TEXT, model_config TEXT, parent_session_id TEXT, started_at REAL NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);`;

function sql(db: string, s: string): void {
  execFileSync("/usr/bin/sqlite3", [db, s]);
}

/** Multiplexed layout: every profile's Discord sessions in the root state.db. */
function fixtureHermes(): string {
  const root = mkdtempSync(join(tmpdir(), "hermes-db-"));
  mkdirSync(join(root, "profiles", "creads"), { recursive: true });
  const db = join(root, "state.db");
  sql(db, SCHEMA);
  const origin = (c: string) => JSON.stringify({ platform: "discord", chat_name: c }).replace(/'/g, "''");
  sql(
    db,
    `INSERT INTO sessions VALUES ('d-main', 'discord', 'agent:main:discord:thread:1', NULL, NULL, '${origin("HQ / #generale / idee")}', NULL, NULL, 1000);
INSERT INTO sessions VALUES ('c-old', 'discord', 'agent:creads:discord:thread:9', NULL, NULL, NULL, NULL, NULL, 1100);
INSERT INTO sessions VALUES ('c-new', 'discord', 'agent:creads:discord:thread:9', 'Campagna Q4', NULL, '${origin("Creads / #ads / Campagna Q4")}', NULL, NULL, 1200);
INSERT INTO sessions VALUES ('c-other', 'discord', 'agent:creads:discord:channel:5', NULL, NULL, NULL, NULL, NULL, 1300);
INSERT INTO sessions VALUES ('c-sub', 'discord', NULL, NULL, NULL, NULL, '{"_delegate_from":"c-new"}', 'c-new', 1250);
INSERT INTO sessions VALUES ('i-1', 'discord', 'agent:ifh:discord:thread:2', NULL, NULL, NULL, NULL, NULL, 1050);
INSERT INTO sessions VALUES ('acp-1', 'acp', NULL, NULL, NULL, NULL, NULL, NULL, 1400);
INSERT INTO messages (session_id, role, content, timestamp) VALUES ('c-new', 'user', 'prepara la campagna', 1201), ('c-new', 'assistant', 'ecco la bozza', 1202), ('c-new', 'tool', 'x', 1203), ('c-new', 'user', 'ok, ma più corta', 1204);
INSERT INTO messages (session_id, role, content, timestamp, active) VALUES ('c-new', 'assistant', 'versione compattata', 1205, 0);
INSERT INTO messages (session_id, role, content, timestamp) VALUES ('c-other', 'user', 'canale', 1150), ('d-main', 'user', 'ciao default', 1001);`,
  );
  return root;
}

describe("state.db (read-only) and Discord sub-chats of ACP agents", () => {
  test("helpers: session key → profile, newest row per conversation", () => {
    assert.equal(profileOfKey("agent:main:discord:thread:1"), "default");
    assert.equal(profileOfKey("agent:creads:discord:dm:2"), "creads");
    assert.equal(profileOfKey(null), undefined);
    const rows = newestPerKey([
      { id: "a", db: "x", sessionKey: "k", last_active: 1 },
      { id: "b", db: "x", sessionKey: "k", last_active: 5 },
      { id: "c", db: "x", last_active: 3 },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ["b", "c"]);
  });

  test("lists a profile's Discord sub-chats from the multiplexed root db, without touching it", async () => {
    const root = fixtureHermes();
    const before = readFileSync(join(root, "state.db"));
    const creads = await listDiscordSessions({ profile: "creads", home: join(root, "profiles", "creads"), root });
    assert.deepEqual(creads.map((r) => r.id), ["c-new", "c-other"], "newest row per thread, no delegate sub-agent, no other profile");
    assert.equal(creads[0]!.chatName, "Creads / #ads / Campagna Q4");
    assert.equal(creads[0]!.last_active, 1205);
    const def = await listDiscordSessions({ profile: "default", home: root, root });
    assert.deepEqual(def.map((r) => r.id), ["d-main"]);
    assert.deepEqual([...(await foreignDiscordIds(root, "default"))].sort(), ["c-new", "c-old", "c-other", "i-1"]);
    const t = await readTranscript(join(root, "state.db"), "c-new", 20);
    assert.deepEqual(t.map((m) => `${m.role}:${m.content}`), ["user:prepara la campagna", "assistant:ecco la bozza", "user:ok, ma più corta"]);
    assert.deepEqual((await readTranscript(join(root, "state.db"), "c-new", 20, 1202)).map((m) => m.content), ["ok, ma più corta"]);
    assert.deepEqual(await listDiscordSessions({ profile: "x", home: "/nonexistent", root: "/nonexistent" }), []);
    assert.ok(before.equals(readFileSync(join(root, "state.db"))), "state.db unchanged");
  });

  test("a Discord sub-chat on an ACP agent → linked ACP session seeded with its transcript, then only news", async () => {
    const root = fixtureHermes();
    const home = tmpHome();
    const dir = mkdtempSync(join(tmpdir(), "fakeacp-"));
    const state = new StateStore(join(home, "state.json"));
    const backend = new HermesAcpBackend({ hermesRoot: root, state, command: fakeCommand(dir) });
    backend.setAgents([{ id: "creads", name: "Creads", profile: "creads", home: join(root, "profiles", "creads") }]);
    try {
      const items = await backend.listSessions("creads");
      assert.deepEqual(items.map((i) => [i.id, i.title, i.channel ?? null]), [
        ["c-new", "Campagna Q4", "ads"],
        ["c-other", "canale", null],
      ]);
      backend.setSelection("creads", "c-new");
      await backend.send("creads", "com'è andata?", noSink);
      let ps = prompts(dir);
      assert.match(ps[0]!, /^\[Istruzioni Hikaro/);
      assert.match(ps[0]!, /\[Contesto: ultimi messaggi della sottochat Discord «Campagna Q4»[^\n]*\]\nUtente: prepara la campagna\nTu: ecco la bozza\nUtente: ok, ma più corta\n\[Fine contesto\]\n\nMessaggio dell'utente: com'è andata\?$/);
      const link = state.get().acp.creads!["c-new"]!;
      assert.equal(link.seededTs, 1204);
      // nothing new on Discord → plain prompt
      await backend.send("creads", "e poi?", noSink);
      // a new Discord message arrives → only that one is passed
      sql(join(root, "state.db"), "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('c-new', 'user', 'aggiunto da Discord', 1300)");
      await backend.send("creads", "novità?", noSink);
      ps = prompts(dir);
      assert.equal(ps[1], "e poi?");
      assert.match(ps[2]!, /^\[Nuovi messaggi nella sottochat Discord «Campagna Q4»[^\n]*\]\nUtente: aggiunto da Discord\n\[Fine contesto\]\n\nMessaggio dell'utente: novità\?$/);
      assert.equal(state.get().acp.creads!["c-new"]!.id, link.id, "same linked ACP session");
      // the Deck chat is a different ACP session
      backend.setSelection("creads", "deck");
      await backend.send("creads", "chat del deck", noSink);
      assert.notEqual(state.get().acp.creads!.deck!.id, link.id);
      // "latest" follows the most recent Discord sub-chat
      backend.setSelection("creads", "latest");
      await backend.send("creads", "ultima sottochat", noSink);
      assert.equal(state.get().acp.creads!["c-new"]!.turns, 4);
      // a sub-chat that no longer exists
      backend.setSelection("creads", "sparita");
      await assert.rejects(backend.send("creads", "x", noSink), (e: DeckError) => e.code === "bad_message");
    } finally {
      await backend.stop();
    }
  });
});

// ── names ────────────────────────────────────────────────────────────

async function fakeDiscord(): Promise<{ url: string; calls: string[]; fail: { on: boolean }; close: () => Promise<void> }> {
  const calls: string[] = [];
  const fail = { on: false };
  const server: Server = createServer((req, res) => {
    calls.push(String(req.headers.authorization));
    if (fail.on) return res.writeHead(500).end();
    const users: Record<string, unknown> = {
      "Bot tok-default": { id: "1", username: "albertobot", global_name: null },
      "Bot tok-creads": { id: "2", username: "creads_bot", global_name: "Creads Studio" },
    };
    const u = req.url === "/api/v10/users/@me" ? users[String(req.headers.authorization)] : undefined;
    if (!u) return res.writeHead(401, { "Content-Type": "application/json" }).end('{"message":"401: Unauthorized"}');
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(u));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/api/v10`, calls, fail, close: () => new Promise((r) => server.close(() => r())) };
}

describe("agent names from the Discord bots", () => {
  test("bot name, cache in state.json (never the token), fallbacks", async () => {
    const d = await fakeDiscord();
    try {
      const home = tmpHome();
      const root = mkdtempSync(join(tmpdir(), "hermes-"));
      for (const p of ["creads", "ifh", "personale", "broken"]) mkdirSync(join(root, "profiles", p), { recursive: true });
      writeFileSync(join(root, ".env"), "DISCORD_BOT_TOKEN=tok-default\n");
      writeFileSync(join(root, "profiles", "creads", ".env"), "DISCORD_BOT_TOKEN='tok-creads'\n");
      writeFileSync(join(root, "profiles", "broken", ".env"), "DISCORD_BOT_TOKEN=tok-revoked\n");
      writeFileSync(join(root, "profiles", "personale", "profile.yaml"), "description: Assistente\n");
      writeFileSync(join(root, "profiles", "ifh", "profile.yaml"), "description: Gestisce l'outreach per IFH e scrive le email.\n");
      const state = new StateStore(join(home, "state.json"));
      let now = 1_000_000;
      const names = new NameResolver({ state, discordApi: d.url, now: () => now });
      const list = ["default", "creads", "ifh", "personale", "broken"].map((p) => ({ profile: p, home: p === "default" ? root : join(root, "profiles", p) }));
      const m = await names.resolveAll(list);
      assert.deepEqual(Object.fromEntries(m), { default: "albertobot", creads: "Creads Studio", ifh: "Ifh", personale: "Assistente", broken: "Broken" });
      const raw = readFileSync(join(home, "state.json"), "utf8");
      assert.ok(!raw.includes("tok-"), "the token is never stored");
      assert.equal(JSON.parse(raw).names.creads.name, "Creads Studio");
      const calls = d.calls.length;
      await names.resolveAll(list.slice(0, 2));
      assert.equal(d.calls.length, calls, "cached");
      // after the TTL Discord is asked again; when it fails the stale name is kept
      now += 13 * 3600_000;
      d.fail.on = true;
      assert.equal(await names.resolve(list[1]!), "Creads Studio");
      // a new token for that profile invalidates the cache
      writeFileSync(join(root, "profiles", "creads", ".env"), "DISCORD_BOT_TOKEN=tok-other\n");
      assert.equal(await names.resolve(list[1]!), "Creads");
      assert.equal(capitalise("my-agent_x"), "My Agent X");
      assert.equal(await fetchBotName("tok-creads", "http://127.0.0.1:1/api", 300), undefined);
    } finally {
      await d.close();
    }
  });
});

// ── router ───────────────────────────────────────────────────────────

const KEY = "0123456789abcdef0123456789abcdef";

function routerFixture(over: { overrides?: Record<string, any>; healthy?: () => boolean } = {}) {
  const home = tmpHome();
  const root = mkdtempSync(join(tmpdir(), "hermes-"));
  writeFileSync(join(root, "config.yaml"), "gateway:\n  multiplex_profiles: true\n");
  writeFileSync(join(root, ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${KEY}\n`);
  for (const p of ["personale", "creads", "ifh"]) mkdirSync(join(root, "profiles", p), { recursive: true });
  const state = new StateStore(join(home, "state.json"));
  const overrides = over.overrides ?? {};
  const api = new HermesBackend({ hermesHome: root, overrides, state });
  const dir = mkdtempSync(join(tmpdir(), "fakeacp-"));
  const acp = new HermesAcpBackend({ hermesRoot: root, state, command: fakeCommand(dir) });
  const healthy = over.healthy ?? (() => true);
  const router = new HermesRouter({ hermesHome: root, overrides, state, api, acp, names: new NameResolver({ state, discordApi: "http://127.0.0.1:1" }), apiHealthy: async () => healthy() });
  return { router, acp, api };
}

describe("router: every profile is an agent (API where reachable, else ACP)", () => {
  test("multiplex: default via API (key 0), the others via ACP, alphabetical", async () => {
    const { router } = routerFixture();
    const agents = await router.listAgents();
    assert.deepEqual(agents, [
      { id: "default", name: "Hermes" },
      { id: "creads", name: "Creads" },
      { id: "ifh", name: "Ifh" },
      { id: "personale", name: "Personale" },
    ]);
    assert.deepEqual(router.getRoutes().map((r) => `${r.id}:${r.via}`), ["default:api", "creads:acp", "ifh:acp", "personale:acp"]);
    assert.deepEqual(buildAgents(agents).map((a) => `${a.id}#${a.key}`), ["default#0", "creads#1", "ifh#2", "personale#3"]);
    // explicit keys are kept, the others fill the free ones in order
    assert.deepEqual(buildAgents(agents, { personale: { key: 0 } }).map((a) => `${a.id}#${a.key}`), ["default#1", "creads#2", "ifh#3", "personale#0"]);
  });

  test("routing: sends go to the right backend; overrides backend/hidden", async () => {
    const { router, acp } = routerFixture({ overrides: { ifh: { hidden: true }, default: { backend: "acp" } } });
    try {
      await router.listAgents();
      assert.deepEqual(router.getRoutes().map((r) => `${r.id}:${r.via}`), ["default:acp", "creads:acp", "personale:acp"]);
      assert.deepEqual(acp.getSpecs().map((s) => s.id), ["default", "creads", "personale"]);
      const r = await router.send("creads", "ciao", noSink);
      assert.equal(r.text, "Ciao dal profilo creads. Turno 1.");
      assert.equal(router.getSelection("creads"), "deck");
      await assert.rejects(router.send("ifh", "x", noSink), (e: DeckError) => e.code === "bad_message");
    } finally {
      await router.stop();
    }
  });

  test("API down at startup → ACP; when it comes up → API, and it stays there", async () => {
    let up = false;
    const { router } = routerFixture({ healthy: () => up });
    await router.listAgents();
    assert.equal(router.getRoutes()[0]!.via, "acp");
    up = true;
    await router.listAgents();
    assert.equal(router.getRoutes()[0]!.via, "api");
    up = false;
    await router.listAgents();
    assert.equal(router.getRoutes()[0]!.via, "api", "sticky: a gateway restart does not move the chat");
    await router.stop();
  });
});

// ── end to end through the hub (WebSocket, like the iPhone) ──────────

describe("ACP agent over WebSocket", () => {
  test("voice → streamed reply; permission → request card + calling + haptic → choice → reply; sub-chats", async () => {
    const { startApp } = await import("../src/app.js");
    const { TestClient, testConfig } = await import("./helpers.js");
    const root = fixtureHermes();
    const home = tmpHome();
    const dir = mkdtempSync(join(tmpdir(), "fakeacp-"));
    const state = new StateStore(join(home, "state.json"));
    const backend = new HermesAcpBackend({ hermesRoot: root, state, command: fakeCommand(dir) });
    backend.setAgents([{ id: "creads", name: "Creads Studio", profile: "creads", home: join(root, "profiles", "creads") }]);
    let said = "approva la pulizia";
    const stt = { name: "fake", transcribe: async () => said };
    const TOKEN = "test-token-1234567890";
    const app = await startApp(testConfig({ token: TOKEN, demo: false, hermesHome: root }), { backend, stt, tts: null });
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${app.server.port}/ws?token=${TOKEN}`);
      const w = await c.waitFor((m) => m.type === "welcome");
      assert.deepEqual(w.agents.map((a: any) => [a.id, a.name, a.key]), [["creads", "Creads Studio", 0]]);
      c.send({ type: "voice.start", agent: "creads", id: "v1" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "creads", id: "v1" });
      const req = await c.waitFor((m) => m.type === "card" && m.card.kind === "request", 10_000);
      assert.deepEqual(req.card.options, ["Sì, solo ora", "Sì, per la sessione", "No"]);
      await c.waitFor((m) => m.type === "status" && m.state === "calling");
      await c.waitFor((m) => m.type === "haptic" && m.pattern === "request");
      const from = c.mark();
      c.send({ type: "choice", card: req.card.id, index: 2, option: "No" });
      const fin = await c.waitFor((m) => m.type === "reply" && m.final, 10_000, from);
      assert.equal(fin.text, "Va bene, non lo faccio.");
      assert.deepEqual(readLog(dir).find((e) => e.permission).permission, { outcome: { outcome: "selected", optionId: "deny" } });
      // sub-chats of the ACP agent
      c.send({ type: "sessions.list", agent: "creads" });
      const s = await c.waitFor((m) => m.type === "sessions");
      assert.deepEqual(s.items.map((i: any) => i.id), ["deck", "c-new", "c-other"]);
      c.send({ type: "session.select", agent: "creads", session: "c-new" });
      await c.waitFor((m) => m.type === "sessions" && m.selected === "c-new");
      said = "riassumi";
      const from2 = c.mark();
      c.send({ type: "voice.start", agent: "creads", id: "v2" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "creads", id: "v2" });
      const fin2 = await c.waitFor((m) => m.type === "reply" && m.final, 10_000, from2);
      assert.equal(fin2.text, "Ciao dal profilo creads. Turno 1.");
      assert.match(prompts(dir).at(-1)!, /Utente: prepara la campagna/);
      c.close();
    } finally {
      await app.stop();
    }
  });
});
