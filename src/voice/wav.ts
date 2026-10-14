import { SAMPLE_RATE } from "../protocol.js";

/** Wrap raw PCM16 little-endian mono samples into a WAV (RIFF) file. */
export function pcm16ToWav(pcm: Buffer, sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  // An odd byte count would be a broken sample: drop it.
  const data = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Duration in ms of PCM16 mono audio. */
export function pcmDurationMs(bytes: number, sampleRate = SAMPLE_RATE): number {
  return Math.round((bytes / 2 / sampleRate) * 1000);
}
