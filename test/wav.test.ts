import assert from "node:assert/strict";
import { test } from "node:test";
import { pcm16ToWav, pcmDurationMs } from "../src/voice/wav.js";

test("WAV header for PCM16 mono 16 kHz", () => {
  const pcm = Buffer.alloc(32_000); // 1 s
  const wav = pcm16ToWav(pcm);
  assert.equal(wav.length, 44 + 32_000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 32_000);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(28), 32_000); // byte rate
  assert.equal(wav.readUInt16LE(32), 2); // block align
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 32_000);
  assert.equal(pcmDurationMs(32_000), 1000);
});

test("odd byte counts are trimmed", () => {
  const wav = pcm16ToWav(Buffer.alloc(5));
  assert.equal(wav.readUInt32LE(40), 4);
});
