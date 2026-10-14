import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startApp, type App } from "../src/app.js";
import { DemoBackend } from "../src/demo/backend.js";
import { toDeckSession } from "../src/hermes/backend.js";
import { readSessionOrigins, splitChatName } from "../src/hermes/profiles.js";
import { checkPlatforms } from "../src/hermes/temp.js";
import { parseDeviceMessage } from "../src/protocol.js";
import type { SttProvider } from "../src/voice/stt.js";
import { TestClient, testConfig, tmpHome } from "./helpers.js";
import { MockHermes } from "./mock-hermes.js";

const TOKEN = "test-token-1234567890";
const KEY = "0123456789abcdef0123456789abcdef";

test("protocol: sessions.list / session.select parse, malformed ones are bad_message", () => {
  assert.deepEqual(parseDeviceMessage('{"type":"sessions.list","agent":"dev"}'), { ok: true, message: { type: "sessions.list", agent: "dev" } });
  assert.deepEqual(parseDeviceMessage('{"type":"session.select","agent":"dev","session":"latest"}'), {
    ok: true,
    message: { type: "session.select", agent: "dev", session: "latest" },
  });
  for (const raw of ['{"type":"sessions.list"}', '{"type":"session.select","agent":"dev"}']) {
    const r = parseDeviceMessage(raw);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.ignored, false);
  }
});

test("Discord chat names → channel + thread title", () => {
  assert.deepEqual(splitChatName("Hikaro HQ / #outreach / Studio Ferri"), { channel: "outreach", thread: "Studio Ferri" });
  assert.deepEqual(splitChatName("Hikaro HQ / #dev"), { channel: "dev" });
  assert.deepEqual(splitChatName("Hikaro HQ / idee / Nuovo logo"), { channel: "idee", thread: "Nuovo logo" });
  assert.deepEqual(splitChatName("alberto"), { thread: "alberto" });
  const s = toDeckSession({ id: "s1", source: "discord", title: null, preview: "ciao", started_at: 1_792_000_000.5, last_active: 1_792_000_100 }, { chatName: "G / #outreach / Studio Ferri" });
  assert.deepEqual(s, { id: "s1", title: "Studio Ferri", source: "discord", channel: "outreach", updated: 1_792_000_100_000 });
  assert.equal(toDeckSession({ id: "s2", title: "Listino Q4", started_at: 1_792_000_000 }).title, "Listino Q4");
  assert.equal(toDeckSession({ id: "s3", preview: "  una   anteprima " }).title, "una anteprima");
});

test("sessions.json origins are read without touching the file", () => {
  const home = mkdtempSync(join(tmpdir(), "prof-"));
  mkdirSync(join(home, "sessions"));
  writeFileSync(
    join(home, "sessions", "sessions.json"),
    JSON.stringify({
      _README: "legacy mirror",
      "agent:main:discord:thread:1": { session_id: "s1", display_name: "x", origin: { platform: "discord", chat_name: "G / #dev / bug login" } },
      broken: 3,
    }),
  );
  const m = readSessionOrigins(home);
  assert.equal(m.size, 1);
  assert.equal(m.get("s1")?.chatName, "G / #dev / bug login");
  assert.equal(readSessionOrigins(join(home, "nope")).size, 0);
});

test("--hermes-temp refuses a Hermes with messaging platforms (names only, values never read out)", () => {
  const clean = mkdtempSync(join(tmpdir(), "hh-"));
  writeFileSync(join(clean, ".env"), "TERMINAL_TIMEOUT=60\nDISCORD_HOME_CHANNEL=\n");
  writeFileSync(join(clean, "config.yaml"), "model:\n  default: x\n");
  assert.deepEqual(checkPlatforms(clean, {}), { envKeys: [], configPlatforms: false, apiInEnvFile: [] });
  const busy = mkdtempSync(join(tmpdir(), "hh-"));
  writeFileSync(join(busy, ".env"), "DISCORD_BOT_TOKEN=abc\nAPI_SERVER_KEY=k\n");
  writeFileSync(join(busy, "config.yaml"), "platforms:\n  telegram:\n    enabled: true\n");
  const r = checkPlatforms(busy, { SLACK_BOT_TOKEN: "x" });
  assert.deepEqual(r.envKeys, ["DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN"]);
  assert.equal(r.configPlatforms, true);
  assert.deepEqual(r.apiInEnvFile, ["API_SERVER_KEY"]);
});

class FakeStt implements SttProvider {
  readonly name = "fake";
  constructor(private readonly text: string) {}
  async transcribe(): Promise<string> {
    return this.text;
  }
}

describe("conversations over WebSocket", () => {
  let mock: MockHermes;
  before(async () => {
    mock = await new MockHermes(KEY).start();
    const now = Date.now() / 1000;
    mock.sessionRows = [
      { id: "d_new", source: "discord", title: "Studio Ferri", started_at: now - 600, last_active: now - 60 },
      { id: "d_old", source: "discord", title: null, preview: "listino", started_at: now - 9000, last_active: now - 8000 },
      { id: "api_x", source: "api_server", title: "altro", started_at: now },
    ];
    mock.sessions.set("d_new", [
      { role: "user", content: "Scrivi a Studio Ferri" },
      { role: "assistant", content: "Bozza pronta." },
    ]);
  });
  after(async () => {
    await mock.stop();
  });

  async function hermesApp(): Promise<App> {
    tmpHome();
    const hermesHome = mkdtempSync(join(tmpdir(), "hermes-"));
    writeFileSync(join(hermesHome, ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${KEY}\n`);
    return startApp(testConfig({ token: TOKEN, demo: false, hermesHome, hermesUrl: mock.url }), { stt: new FakeStt("e allora?"), tts: null });
  }

  test("list → deck first + Discord threads; select persists and routes the next message", async () => {
    const app = await hermesApp();
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${app.server.port}/ws?token=${TOKEN}`);
      await c.waitFor((m) => m.type === "welcome");
      c.send({ type: "sessions.list", agent: "default" });
      const s = await c.waitFor((m) => m.type === "sessions");
      assert.equal(s.selected, "deck");
      assert.deepEqual(s.items.map((x: { id: string }) => x.id), ["deck", "d_new", "d_old"]);
      assert.equal(s.items[0].title, "Chat del Deck");
      assert.equal(s.items[2].title, "listino");

      let mark = c.mark();
      c.send({ type: "session.select", agent: "default", session: "nope" });
      const err = await c.waitFor((m) => m.type === "error", 3_000, mark);
      assert.equal(err.code, "bad_message");

      mark = c.mark();
      c.send({ type: "session.select", agent: "default", session: "d_new" });
      assert.equal((await c.waitFor((m) => m.type === "sessions", 3_000, mark)).selected, "d_new");

      mark = c.mark();
      c.send({ type: "voice.start", agent: "default", id: "v1" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "default", id: "v1" });
      await c.waitFor((m) => m.type === "reply" && m.final, 5_000, mark);
      const run = mock.runs.at(-1)!;
      assert.equal(run.body.session_id, "d_new", "the run goes into the Discord thread's session");
      assert.equal(run.body.conversation_history[0].content, "Scrivi a Studio Ferri");

      mark = c.mark();
      c.send({ type: "session.select", agent: "default", session: "latest" });
      await c.waitFor((m) => m.type === "sessions" && m.selected === "latest", 3_000, mark);
      mark = c.mark();
      c.send({ type: "voice.start", agent: "default", id: "v2" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "default", id: "v2" });
      await c.waitFor((m) => m.type === "reply" && m.final, 5_000, mark);
      assert.equal(mock.runs.at(-1)!.body.session_id, "d_new", "latest = most recent Discord session");

      mark = c.mark();
      c.send({ type: "session.select", agent: "default", session: "deck" });
      await c.waitFor((m) => m.type === "sessions" && m.selected === "deck", 3_000, mark);
      mark = c.mark();
      c.send({ type: "voice.start", agent: "default", id: "v3" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "default", id: "v3" });
      await c.waitFor((m) => m.type === "reply" && m.final, 5_000, mark);
      assert.match(mock.runs.at(-1)!.body.session_id, /^hikaro_default_/);
      c.close();
    } finally {
      await app.stop();
    }
  });

  test("demo backend has fake Discord threads", async () => {
    tmpHome();
    const app = await startApp(testConfig({ token: TOKEN }), { backend: new DemoBackend({ intervalMs: 0, wordDelayMs: 1 }), stt: null, tts: null });
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${app.server.port}/ws?token=${TOKEN}`);
      await c.waitFor((m) => m.type === "welcome");
      c.send({ type: "sessions.list", agent: "dev" });
      const s = await c.waitFor((m) => m.type === "sessions");
      assert.deepEqual(s.items.map((x: { title: string }) => x.title), ["Chat del Deck", "bug login", "deploy venerdì"]);
      assert.equal(s.items[1].channel, "dev");
      const mark = c.mark();
      c.send({ type: "session.select", agent: "dev", session: "demo_dev_login" });
      assert.equal((await c.waitFor((m) => m.type === "sessions", 3_000, mark)).selected, "demo_dev_login");
      c.close();
    } finally {
      await app.stop();
    }
  });
});
