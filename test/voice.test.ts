import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DeckError } from "../src/core/errors.js";
import { selectTts } from "../src/voice/index.js";
import { downloadResumable } from "../src/voice/local/download.js";
import { ManagedProcess } from "../src/voice/local/managed.js";
import { kokoroVoice } from "../src/voice/local/mlx.js";
import { parseSayVoices, pickItalianVoice } from "../src/voice/local/say.js";
import { WhisperLocalStt, cleanTranscript, whisperInference } from "../src/voice/local/whisper.js";
import { SentenceSplitter, splitLong } from "../src/voice/speech.js";
import { selectStt, type SttSelectInput } from "../src/voice/stt.js";
import { FallbackTts, sniffAudioFormat, type AudioClip, type TtsProvider } from "../src/voice/tts.js";
import { pcm16ToWav } from "../src/voice/wav.js";
import { startApp } from "../src/app.js";
import { DemoBackend } from "../src/demo/backend.js";
import { TestClient, testConfig, tmpHome } from "./helpers.js";

// ── provider selection ────────────────────────────────────────────────

describe("STT/TTS selection", () => {
  const base: SttSelectInput = { mode: "auto", engine: "auto", whisperReady: true, parakeetReady: true };

  test("auto: Groq key → groq, then OpenAI, then custom URL, then local whisper", () => {
    assert.equal(selectStt({ ...base, groqApiKey: "g", openaiApiKey: "o" }).kind, "groq");
    assert.equal(selectStt({ ...base, openaiApiKey: "o" }).kind, "openai");
    assert.deepEqual(selectStt({ ...base, sttUrl: "http://x/v1/audio/transcriptions" }), { kind: "url", url: "http://x/v1/audio/transcriptions" });
    assert.equal(selectStt(base).kind, "whisper");
  });

  test("local engines: whisper preferred, Parakeet when whisper.cpp is missing or asked for", () => {
    assert.equal(selectStt({ ...base, whisperReady: false }).kind, "parakeet");
    assert.equal(selectStt({ ...base, engine: "parakeet" }).kind, "parakeet");
    assert.equal(selectStt({ ...base, whisperReady: false, parakeetReady: false }).kind, "none");
    assert.equal(selectStt({ ...base, engine: "whisper", whisperReady: false }).kind, "none");
  });

  test("forced modes ignore other keys and explain what is missing", () => {
    assert.equal(selectStt({ ...base, mode: "local", groqApiKey: "g" }).kind, "whisper");
    const none = selectStt({ ...base, mode: "groq" });
    assert.equal(none.kind, "none");
    assert.match(none.kind === "none" ? none.reason : "", /GROQ_API_KEY/);
    assert.equal(selectStt({ ...base, mode: "off", groqApiKey: "g" }).kind, "none");
  });

  test("TTS: OpenAI only with a key, otherwise local (Kokoro if installed, else say)", () => {
    assert.equal(selectTts({ mode: "auto", openaiApiKey: "o", kokoroReady: true }).kind, "openai");
    assert.deepEqual(selectTts({ mode: "auto", kokoroReady: true }), { kind: "local", kokoro: true });
    assert.deepEqual(selectTts({ mode: "auto", kokoroReady: false }), { kind: "local", kokoro: false });
    assert.deepEqual(selectTts({ mode: "local", openaiApiKey: "o", kokoroReady: true }), { kind: "local", kokoro: true });
    assert.equal(selectTts({ mode: "openai", kokoroReady: true }).kind, "none");
    assert.equal(selectTts({ mode: "off", openaiApiKey: "o", kokoroReady: true }).kind, "none");
  });

  test("voices: OpenAI ids map to the Italian Kokoro voice of similar timbre, unknown → default", () => {
    assert.equal(kokoroVoice("coral", "if_sara"), "if_sara");
    assert.equal(kokoroVoice("onyx", "if_sara"), "im_nicola");
    assert.equal(kokoroVoice("im_nicola", "if_sara"), "im_nicola");
    assert.equal(kokoroVoice("klingon", "im_nicola"), "im_nicola");
    assert.equal(kokoroVoice(undefined, "nonsense"), "if_sara");
  });

  test("say voices: parse `say -v ?`, prefer Premium/Enhanced Italian, then Alice", () => {
    const out = [
      "Alice               it_IT    # Ciao! Mi chiamo Alice.",
      "Eddy (Italian (Italy)) it_IT    # Ciao! Mi chiamo Eddy.",
      "Federica (Premium)  it_IT    # Ciao! Mi chiamo Federica.",
      "Samantha            en_US    # Hello! My name is Samantha.",
    ].join("\n");
    const v = parseSayVoices(out);
    assert.equal(v.length, 4);
    assert.equal(v[1]!.name, "Eddy (Italian (Italy))");
    assert.equal(pickItalianVoice(v), "Federica (Premium)");
    assert.equal(pickItalianVoice(v.filter((x) => !x.name.includes("Premium"))), "Alice");
    assert.equal(pickItalianVoice(v, "Samantha"), "Samantha");
  });
});

// ── chunking & audio format ───────────────────────────────────────────

describe("sentence chunking for local TTS", () => {
  test("splitLong cuts at commas first, then spaces, never above max", () => {
    const s = "Ho controllato la casella di lavoro, ci sono tre email nuove da Marco, Giulia e Studio Ferri, nessuna urgente ma una chiede il listino aggiornato entro venerdì.";
    const parts = splitLong(s, 60);
    assert.ok(parts.length >= 3);
    for (const p of parts) assert.ok(p.length <= 61, p);
    assert.equal(parts.join(" ").replace(/\s+/g, " "), s);
    assert.ok(parts[0]!.endsWith(","));
    assert.deepEqual(splitLong("breve.", 60), ["breve."]);
  });

  test("splitter with maxChunk splits a long first sentence; short replies stay whole", () => {
    const sp = new SentenceSplitter({ firstMin: 6, nextMin: 30, maxChunk: 50 });
    const out = [...sp.push("Ciao Alberto. Questa è una frase lunghissima, piena di dettagli inutili, che il modello locale troncherebbe se arrivasse intera. "), ...sp.flush()];
    assert.equal(out[0], "Ciao Alberto.");
    assert.ok(out.length >= 3);
    for (const p of out) assert.ok(p.length <= 51, p);
  });

  test("sniffAudioFormat recognises mp3, m4a and wav", () => {
    assert.equal(sniffAudioFormat(pcm16ToWav(Buffer.alloc(100))), "wav");
    assert.equal(sniffAudioFormat(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")])), "m4a");
    assert.equal(sniffAudioFormat(Buffer.from("ID3\x04\x00")), "mp3");
    assert.equal(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "mp3");
    assert.equal(sniffAudioFormat(Buffer.from("{\"error\":1}")), null);
  });

  test("FallbackTts uses the next engine when one fails and keeps the formats", async () => {
    let kokoroCalls = 0;
    const kokoro: TtsProvider = {
      name: "kokoro",
      async synthesize(): Promise<AudioClip> {
        kokoroCalls++;
        throw new DeckError("tts_failed", undefined, "boom");
      },
    };
    const say: TtsProvider = { name: "say", synthesize: async (t) => ({ data: Buffer.from(t), format: "m4a" }) };
    const tts = new FallbackTts([kokoro, say], 60_000);
    assert.equal(tts.name, "kokoro→say");
    assert.deepEqual(await tts.synthesize("uno"), { data: Buffer.from("uno"), format: "m4a" });
    await tts.synthesize("due");
    assert.equal(kokoroCalls, 1, "a broken engine is skipped during the cooldown");
    assert.equal(tts.active, "say");
  });
});

// ── whisper-server client ─────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += (c as Buffer).toString("latin1");
  return s;
}

describe("whisper-server client", () => {
  test("posts a WAV + language to /inference and cleans the text", async () => {
    const seen: string[] = [];
    const srv = createServer(async (req, res) => {
      const body = await readBody(req);
      seen.push(`${req.method} ${req.url} ${/name="language"\r\n\r\nit/.test(body)} ${body.includes("RIFF")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "  Ciao, che ore sono   a Venezia?\n" }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const t = await whisperInference(url, pcm16ToWav(Buffer.alloc(3200)), { language: "it" });
      assert.equal(t, "Ciao, che ore sono a Venezia?");
      assert.deepEqual(seen, ["POST /inference true true"]);
    } finally {
      srv.close();
    }
  });

  test("errors become stt_failed; non-speech markers become empty", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(500);
      res.end("model exploded");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      await assert.rejects(whisperInference(url, pcm16ToWav(Buffer.alloc(10)), { language: "it" }), (e: DeckError) => e.code === "stt_failed");
    } finally {
      srv.close();
    }
    assert.equal(cleanTranscript(" [Musica] "), "");
    assert.equal(cleanTranscript("(silenzio)"), "");
    assert.equal(cleanTranscript("Musica a palla"), "Musica a palla");
  });

  test("WhisperLocalStt starts the server lazily, restarts it after a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-whisper-"));
    const bin = join(dir, "whisper-server");
    const model = join(dir, "model.bin");
    const counter = join(dir, "starts");
    writeFileSync(model, "x");
    writeFileSync(counter, "");
    // A fake whisper-server: answers /inference, then dies after its 2nd request (warm-up + 1).
    writeFileSync(
      bin,
      `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(counter)}, "start\\n");
const a = process.argv; const port = Number(a[a.indexOf("--port") + 1]); const lang = a[a.indexOf("-l") + 1];
let n = 0;
http.createServer((req, res) => {
  if (req.url === "/") { res.end("ok"); return; }
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    n++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "ciao " + lang + " " + (a.includes("--vad") ? "vad" : "novad") }));
    if (n >= 2) setTimeout(() => process.exit(1), 20);
  });
}).listen(port, "127.0.0.1");
`,
    );
    chmodSync(bin, 0o755);
    const stt = new WhisperLocalStt({ bin, model, vadModel: join(dir, "missing-vad.bin"), language: "it" });
    try {
      assert.equal(await stt.transcribe(Buffer.alloc(32_000)), "ciao it novad");
      await new Promise((r) => setTimeout(r, 200)); // the fake dies
      assert.equal(await stt.transcribe(Buffer.alloc(32_000)), "ciao it novad");
      assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2, "restarted once");
    } finally {
      await stt.stop();
    }
  });

  test("ManagedProcess reports a binary that exits immediately", async () => {
    const p = new ManagedProcess({ name: "bad", cmd: "/usr/bin/false", args: () => [], startTimeoutMs: 3_000 });
    await assert.rejects(p.ensure(), /non parte/);
    await p.stop();
  });
});

// ── resumable download ────────────────────────────────────────────────

describe("model download", () => {
  test("resumes a .part file with an HTTP Range request", async () => {
    const payload = Buffer.alloc(200_000, 7);
    const ranges: string[] = [];
    const srv = createServer((req, res) => {
      const range = req.headers.range;
      ranges.push(range ?? "none");
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)![1]);
        res.writeHead(206, { "Content-Length": String(payload.length - start), "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}` });
        res.end(payload.subarray(start));
      } else {
        res.writeHead(200, { "Content-Length": String(payload.length) });
        res.end(payload);
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/model.bin`;
    const dir = mkdtempSync(join(tmpdir(), "dl-"));
    const dest = join(dir, "model.bin");
    writeFileSync(`${dest}.part`, payload.subarray(0, 50_000));
    const lines: string[] = [];
    try {
      assert.equal(await downloadResumable({ url, dest, label: "Modello", onProgress: (l) => lines.push(l) }), "downloaded");
      assert.deepEqual(readFileSync(dest), payload);
      assert.deepEqual(ranges, ["bytes=50000-"]);
      assert.match(lines.at(-1)!, /Modello: 0 MB ✓/);
      assert.equal(await downloadResumable({ url, dest, label: "Modello", onProgress: () => undefined }), "present");
    } finally {
      srv.close();
    }
  });
});

// ── audio messages carry the provider's format ───────────────────────


test("audio messages use the clip format (m4a from say, mp3 from Kokoro)", async () => {
  tmpHome();
  const tts: TtsProvider = { name: "say", synthesize: async (t) => ({ data: Buffer.from(`m4a:${t}`), format: "m4a" }) };
  const stt = { name: "fake", transcribe: async () => "ciao" };
  const app = await startApp(testConfig({ token: "test-token-1234567890" }), { backend: new DemoBackend({ intervalMs: 0, wordDelayMs: 1 }), stt, tts });
  try {
    const c = await TestClient.connect(`ws://127.0.0.1:${app.server.port}/ws?token=test-token-1234567890`);
    await c.waitFor((m) => m.type === "welcome");
    c.send({ type: "voice.start", agent: "assistente", id: "a1" });
    c.sendBinary(Buffer.alloc(16_000));
    c.send({ type: "voice.end", agent: "assistente", id: "a1" });
    const last = await c.waitFor((m) => m.type === "audio" && m.final, 5_000);
    const audios = c.messages.filter((m) => m.type === "audio");
    assert.ok(audios.length >= 2);
    assert.ok(audios.every((m) => m.format === "m4a"));
    assert.match(Buffer.from(last.data, "base64").toString(), /^m4a:/);
    c.close();
  } finally {
    await app.stop();
  }
});
