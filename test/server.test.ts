import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startApp, type App } from "../src/app.js";
import { DemoBackend } from "../src/demo/backend.js";
import type { SttProvider } from "../src/voice/stt.js";
import type { AudioClip, TtsProvider } from "../src/voice/tts.js";
import { MockHermes } from "./mock-hermes.js";
import { TestClient, sleep, testConfig, tmpHome, type Msg } from "./helpers.js";

const TOKEN = "test-token-1234567890";

async function health(port: number, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return { status: res.status, body: await res.json() };
}

describe("demo mode over WebSocket", () => {
  let app: App;
  let port: number;
  before(async () => {
    tmpHome();
    app = await startApp(testConfig({ token: TOKEN }), {
      backend: new DemoBackend({ intervalMs: 0, wordDelayMs: 1 }),
      stt: null,
      tts: null,
    });
    port = app.server.port;
  });
  after(async () => {
    await app.stop();
  });

  test("/health requires the token", async () => {
    assert.equal((await health(port)).status, 401);
    assert.equal((await health(port, "wrong")).status, 401);
    const ok = await health(port, TOKEN);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.hermes, true);
    assert.equal(ok.body.agents, 4);
    assert.equal(typeof ok.body.mac, "string");
    assert.equal(ok.body.version, "0.1.0");
  });

  test("unauthorized socket gets an Italian error and is closed", async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=nope`);
    const err = await c.waitFor((m) => m.type === "error");
    assert.equal(err.code, "unauthorized");
    assert.match(err.message, /abbinato/);
    await sleep(100);
    assert.equal(c.closeCode, 4401);
  });

  test("hello → welcome, ping → pong, unknown types ignored, bad JSON → bad_message", async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`, { Authorization: `Bearer ${TOKEN}` });
    const w = await c.waitFor((m) => m.type === "welcome");
    assert.deepEqual(
      w.agents.map((a: any) => [a.id, a.name, a.key, a.color]),
      [
        ["outreach", "Outreach", 0, "#2EE26B"],
        ["assistente", "Assistente", 1, "#2EE26B"],
        ["startup", "Startup", 2, "#2EE26B"],
        ["dev", "Dev", 3, "#2EE26B"],
      ],
    );
    c.send({ type: "hello", device: "iphone", version: "1", name: "Test" });
    c.send({ type: "something.new", foo: 1 });
    c.send({ type: "ping" });
    await c.waitFor((m) => m.type === "pong");
    assert.ok(!c.messages.some((m) => m.type === "error"));
    c.ws.send("{oops");
    const e = await c.waitFor((m) => m.type === "error");
    assert.equal(e.code, "bad_message");
    c.close();
  });

  test("key.tap with no history → placeholder card; voice round-trip with demo STT", async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await c.waitFor((m) => m.type === "welcome");
    c.send({ type: "key.tap", agent: "assistente" });
    const placeholder = await c.waitFor((m) => m.type === "card");
    assert.equal(placeholder.card.agent, "assistente");

    const from = c.mark();
    c.send({ type: "voice.start", agent: "assistente", id: "v_1" });
    for (let i = 0; i < 10; i++) c.sendBinary(Buffer.alloc(3200)); // 1 s of silence
    c.send({ type: "voice.end", agent: "assistente", id: "v_1" });

    const listening = await c.waitFor((m) => m.type === "card" && m.card.kind === "listening", 3000, from);
    assert.equal(listening.card.agent, "assistente");
    const tr = await c.waitFor((m) => m.type === "transcript", 3000, from);
    assert.deepEqual([tr.agent, tr.id, tr.final], ["assistente", "v_1", true]);
    assert.equal(tr.text, "Cosa ho in agenda domani?");
    await c.waitFor((m) => m.type === "status" && m.agent === "assistente" && m.state === "working", 3000, from);
    const final = await c.waitFor((m) => m.type === "reply" && m.final, 5000, from);
    const deltas = c.messages.slice(from).filter((m) => m.type === "reply" && !m.final);
    assert.ok(deltas.length > 3, "reply is streamed");
    assert.equal(deltas.map((m) => m.text).join(""), final.text);
    const card = await c.waitFor((m) => m.type === "card" && m.card.kind !== "listening" && m.card.agent === "assistente" && m.card.id !== placeholder.card.id, 3000, from);
    assert.ok(card.card.title.length <= 60);
    await c.waitFor((m) => m.type === "status" && m.agent === "assistente" && m.state === "done", 3000, from);
    // done → off after doneHoldMs (200 ms in tests)
    await c.waitFor((m) => m.type === "status" && m.agent === "assistente" && m.state === "off", 3000, from);

    // key.tap now resends the last card
    const before = c.mark();
    c.send({ type: "key.tap", agent: "assistente" });
    const again = await c.waitFor((m) => m.type === "card", 3000, before);
    assert.equal(again.card.id, card.card.id);
    c.close();
  });

  test("voice.cancel drops the recording", async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await c.waitFor((m) => m.type === "welcome");
    const from = c.mark();
    c.send({ type: "voice.start", agent: "dev", id: "v_2" });
    c.sendBinary(Buffer.alloc(3200));
    c.send({ type: "voice.cancel", agent: "dev", id: "v_2" });
    c.send({ type: "voice.end", agent: "dev", id: "v_2" });
    await sleep(300);
    assert.ok(!c.messages.slice(from).some((m) => m.type === "transcript"));
    c.close();
  });

  test("demo request card → choice → done card", async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await c.waitFor((m) => m.type === "welcome");
    const from = c.mark();
    (app.backend as DemoBackend).raiseRequest();
    const req = await c.waitFor((m) => m.type === "card" && m.card.kind === "request", 3000, from);
    assert.equal(req.card.title, "12 email pronte. Le invio?");
    assert.deepEqual(req.card.options, ["Invia tutte", "Leggi una per una", "Modifica a voce"]);
    await c.waitFor((m) => m.type === "status" && m.agent === "outreach" && m.state === "calling", 3000, from);
    await c.waitFor((m) => m.type === "haptic" && m.pattern === "request", 3000, from);

    // A second device connecting now gets the pending request again.
    const c2 = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await c2.waitFor((m) => m.type === "card" && m.card.id === req.card.id);
    c2.close();

    const after = c.mark();
    c.send({ type: "choice", card: req.card.id, index: 0, option: "Invia tutte" });
    const done = await c.waitFor((m) => m.type === "card" && m.card.kind === "done", 3000, after);
    assert.equal(done.card.title, "Inviate.");
    await c.waitFor((m) => m.type === "haptic" && m.pattern === "done", 3000, after);

    // The same card cannot be answered twice.
    const again = c.mark();
    c.send({ type: "choice", card: req.card.id, index: 0, option: "Invia tutte" });
    const e = await c.waitFor((m) => m.type === "error", 3000, again);
    assert.equal(e.code, "bad_message");
    c.close();
  });
});

class FakeStt implements SttProvider {
  readonly name = "fake";
  constructor(private readonly text: string) {}
  async transcribe(pcm: Buffer): Promise<string> {
    assert.ok(pcm.length > 0);
    return this.text;
  }
}
class FakeTts implements TtsProvider {
  readonly name = "fake";
  texts: string[] = [];
  voices: (string | undefined)[] = [];
  async synthesize(text: string, _signal?: AbortSignal, voice?: string): Promise<AudioClip> {
    this.texts.push(text);
    this.voices.push(voice);
    return { data: Buffer.from(`mp3:${voice ?? "default"}:${text}`), format: "mp3" };
  }
}

describe("Hermes backend through the hub (mock Hermes)", () => {
  const KEY = "0123456789abcdef0123456789abcdef";
  let mock: MockHermes;

  before(async () => {
    mock = await new MockHermes(KEY).start();
  });
  after(async () => {
    await mock.stop();
  });

  async function appWith(sttText: string, tts: FakeTts): Promise<App> {
    tmpHome();
    const hermesHome = mkdtempSync(join(tmpdir(), "hermes-"));
    writeFileSync(join(hermesHome, ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${KEY}\n`);
    return startApp(testConfig({ token: TOKEN, demo: false, hermesHome, hermesUrl: mock.url }), { stt: new FakeStt(sttText), tts });
  }

  test("voice → transcript → streamed reply → request card + audio segments", async () => {
    const tts = new FakeTts();
    const app = await appWith("controlla la posta", tts);
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${app.server.port}/ws?token=${TOKEN}`);
      const w = await c.waitFor((m) => m.type === "welcome");
      assert.deepEqual(w.agents.map((a: Msg) => [a.id, a.name, a.key]), [["default", "Hermes", 0]]);
      c.send({ type: "voice.start", agent: "default", id: "v_9" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "default", id: "v_9" });
      await c.waitFor((m) => m.type === "transcript" && m.text === "controlla la posta");
      const card = await c.waitFor((m) => m.type === "card" && m.card.kind === "request", 5000);
      assert.equal(card.card.title, "Vuoi che le riassuma?");
      assert.deepEqual(card.card.options, ["Sì, riassumi", "No, grazie"]);
      await c.waitFor((m) => m.type === "status" && m.state === "calling");
      const lastAudio = await c.waitFor((m) => m.type === "audio" && m.final, 5000);
      const audio = c.messages.filter((m) => m.type === "audio");
      assert.ok(audio.length >= 2, "audio is chunked by sentence");
      assert.equal(audio.filter((m) => m.final).length, 1);
      assert.equal(audio[audio.length - 1], lastAudio);
      assert.equal(Buffer.from(audio[0]!.data, "base64").toString(), "mp3:default:Ciao Alberto.");
      assert.ok(tts.texts.every((t) => !t.includes("-")), "list markers are not spoken");

      // Choosing an option of a text question sends the option back as a user message.
      const from = c.mark();
      c.send({ type: "choice", card: card.card.id, index: 1, option: "No, grazie" });
      await c.waitFor((m) => m.type === "reply" && m.final, 5000, from);
      assert.equal(mock.runs[mock.runs.length - 1]!.body.input, "No, grazie");
      c.close();
    } finally {
      await app.stop();
    }
  });

  test("prefs: speak=false gets no audio, voice override is per device, unknown voice ignored", async () => {
    const tts = new FakeTts();
    const app = await appWith("controlla la posta", tts);
    try {
      const url = `ws://127.0.0.1:${app.server.port}/ws?token=${TOKEN}`;
      const mute = await TestClient.connect(url);
      const nova = await TestClient.connect(url);
      const bogus = await TestClient.connect(url);
      for (const c of [mute, nova, bogus]) await c.waitFor((m) => m.type === "welcome");
      mute.send({ type: "prefs", speak: false, voice: "nova" });
      nova.send({ type: "prefs", voice: "nova", speak: true });
      bogus.send({ type: "prefs", voice: "not-a-voice" });
      nova.send({ type: "ping" });
      mute.send({ type: "ping" });
      bogus.send({ type: "ping" });
      for (const c of [mute, nova, bogus]) await c.waitFor((m) => m.type === "pong");
      nova.send({ type: "voice.start", agent: "default", id: "v_p" });
      nova.sendBinary(Buffer.alloc(16_000));
      nova.send({ type: "voice.end", agent: "default", id: "v_p" });
      await nova.waitFor((m) => m.type === "audio" && m.final, 5000);
      await bogus.waitFor((m) => m.type === "audio" && m.final, 5000);
      await mute.waitFor((m) => m.type === "card" && m.card.kind === "request", 5000);
      await sleep(100);
      assert.ok(!mute.messages.some((m) => m.type === "audio"), "speak=false → no audio");
      const decode = (m: Msg) => Buffer.from(m.data, "base64").toString();
      assert.ok(nova.messages.filter((m) => m.type === "audio").every((m) => decode(m).startsWith("mp3:nova:")));
      assert.ok(bogus.messages.filter((m) => m.type === "audio").every((m) => decode(m).startsWith("mp3:default:")));
      assert.deepEqual(new Set(tts.voices), new Set(["nova", undefined]));
      for (const c of [mute, nova, bogus]) c.close();
    } finally {
      await app.stop();
    }
  });

  test("Hermes approval → request card → choice → approval posted → reply", async () => {
    const app = await appWith("approva la pulizia della build", new FakeTts());
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${app.server.port}/ws?token=${TOKEN}`);
      await c.waitFor((m) => m.type === "welcome");
      c.send({ type: "voice.start", agent: "default", id: "v_10" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "default", id: "v_10" });
      const req = await c.waitFor((m) => m.type === "card" && m.card.kind === "request", 5000);
      assert.equal(req.card.title, "Posso eseguire questo comando?");
      assert.equal(req.card.quote, "rm -rf build");
      await c.waitFor((m) => m.type === "haptic" && m.pattern === "request");
      const from = c.mark();
      c.send({ type: "choice", card: req.card.id, index: 0, option: "Sì, solo ora" });
      const done = await c.waitFor((m) => m.type === "card" && m.card.kind === "done", 5000, from);
      assert.match(done.card.title, /^Fatto/);
      assert.equal(mock.approvals[mock.approvals.length - 1]!.choice, "once");
      c.close();
    } finally {
      await app.stop();
    }
  });

  test("Hermes down → Italian hermes_down error", async () => {
    tmpHome();
    const hermesHome = mkdtempSync(join(tmpdir(), "hermes-"));
    const app = await startApp(testConfig({ token: TOKEN, demo: false, hermesHome, hermesUrl: "http://127.0.0.1:1", hermesApiKey: KEY }), {
      stt: new FakeStt("ciao"),
      tts: null,
    });
    try {
      const h = await health(app.server.port, TOKEN);
      assert.equal(h.body.hermes, false);
      const c = await TestClient.connect(`ws://127.0.0.1:${app.server.port}/ws?token=${TOKEN}`);
      await c.waitFor((m) => m.type === "welcome");
      c.send({ type: "voice.start", agent: "default", id: "v_11" });
      c.sendBinary(Buffer.alloc(16_000));
      c.send({ type: "voice.end", agent: "default", id: "v_11" });
      const e = await c.waitFor((m) => m.type === "error", 5000);
      assert.equal(e.code, "hermes_down");
      assert.equal(e.message, "Hermes non risponde. Sul Mac scrivi hermes nel Terminale e premi Invio, poi riprova.");
      await c.waitFor((m) => m.type === "status" && m.state === "off");
      c.close();
    } finally {
      await app.stop();
    }
  });
});
