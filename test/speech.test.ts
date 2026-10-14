import assert from "node:assert/strict";
import { test } from "node:test";
import { DeckError } from "../src/core/errors.js";
import { SentenceSplitter, SpeechPipeline, speakable } from "../src/voice/speech.js";
import type { AudioClip, TtsProvider } from "../src/voice/tts.js";
import { sleep } from "./helpers.js";

test("splitter emits the first sentence early and stops at the hikaro fence", () => {
  const s = new SentenceSplitter({ firstMin: 4, nextMin: 40 });
  const out: string[] = [];
  for (const d of ["Ciao", " Alberto.", " Ho preparato", " le email per oggi. Sono", " dodici in tutto. ```hik", 'aro\n{"title":"x"}\n```']) {
    out.push(...s.push(d));
  }
  out.push(...s.flush());
  assert.deepEqual(out, ["Ciao Alberto.", "Ho preparato le email per oggi. Sono dodici in tutto."]);
});

test("splitter caps spoken length and cleans markdown", () => {
  const s = new SentenceSplitter({ maxChars: 30, nextMin: 1 });
  const out = [...s.push("**Uno** due tre quattro cinque. Sei sette otto nove dieci. Undici. "), ...s.flush()];
  assert.equal(out[0], "Uno due tre quattro cinque.");
  assert.ok(out.length <= 2);
  assert.equal(speakable("- vedi https://x.y/z e `codice`"), "vedi e codice");
});

class FakeTts implements TtsProvider {
  readonly name = "fake";
  calls: string[] = [];
  constructor(private readonly delays: Record<string, number> = {}, private readonly failOn?: string) {}
  async synthesize(text: string): Promise<AudioClip> {
    this.calls.push(text);
    await sleep(this.delays[text] ?? 5);
    if (text === this.failOn) throw new DeckError("tts_failed");
    return { data: Buffer.from(`mp3:${text}`), format: "mp3" };
  }
}

test("pipeline emits in order, final only on the last segment", async () => {
  const tts = new FakeTts({ A: 40, B: 5, C: 5 });
  const got: [string, boolean][] = [];
  const p = new SpeechPipeline(tts, (b, f) => got.push([b.data.toString(), f]), () => assert.fail("no error expected"));
  p.push("A");
  p.push("B");
  await sleep(10);
  p.push("C");
  await p.finish();
  assert.deepEqual(got, [
    ["mp3:A", false],
    ["mp3:B", false],
    ["mp3:C", true],
  ]);
});

test("pipeline reports a TTS failure once and stops", async () => {
  const errors: DeckError[] = [];
  const got: string[] = [];
  const p = new SpeechPipeline(new FakeTts({}, "B"), (b) => got.push(b.data.toString()), (e) => errors.push(e));
  p.push("A");
  p.push("B");
  p.push("C");
  await p.finish();
  assert.deepEqual(got, ["mp3:A"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "tts_failed");
});

test("pipeline with nothing pushed finishes immediately", async () => {
  const p = new SpeechPipeline(new FakeTts(), () => assert.fail(), () => assert.fail());
  await p.finish();
  assert.equal(p.emitted, 0);
});
