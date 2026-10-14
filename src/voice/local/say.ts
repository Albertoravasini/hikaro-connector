/**
 * macOS built-in `say` → m4a (AAC). Always available, no download: the last
 * link of the local TTS chain. ~0.5 s per sentence with the Italian voice Alice.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeckError } from "../../core/errors.js";
import type { AudioClip, TtsProvider } from "../tts.js";

export const SAY_BIN = "/usr/bin/say";

export interface SayVoice {
  name: string;
  locale: string;
}

/** Parse `say -v '?'` output ("Alice               it_IT    # Ciao! …"). */
export function parseSayVoices(out: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of out.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line);
    if (m) voices.push({ name: m[1]!.trim(), locale: m[2]! });
  }
  return voices;
}

export function listSayVoices(): Promise<SayVoice[]> {
  return new Promise((resolve) => {
    execFile(SAY_BIN, ["-v", "?"], { timeout: 10_000 }, (err, stdout) => resolve(err ? [] : parseSayVoices(stdout)));
  });
}

/** Best Italian voice: Premium/Enhanced first (if the user downloaded one), then Alice. */
export function pickItalianVoice(voices: SayVoice[], preferred?: string): string | null {
  const it = voices.filter((v) => v.locale.startsWith("it_"));
  if (preferred && voices.some((v) => v.name.toLowerCase() === preferred.toLowerCase())) return preferred;
  const rank = (n: string) => (/premium/i.test(n) ? 0 : /enhanced|migliorat/i.test(n) ? 1 : /^(alice|federica|luca|paola)/i.test(n) ? 2 : 3);
  const best = it.sort((a, b) => rank(a.name) - rank(b.name))[0];
  return best ? best.name : null;
}

export class SayTts implements TtsProvider {
  readonly name = "say";
  constructor(
    private readonly voice: string,
    private readonly rate?: number,
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<AudioClip> {
    const file = join(tmpdir(), `hikaro-say-${process.pid}-${randomBytes(4).toString("hex")}.m4a`);
    const args = ["-v", this.voice, "-o", file, "--file-format=m4af", "--data-format=aac", "-f", "-"];
    if (this.rate) args.push("-r", String(this.rate));
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(SAY_BIN, args, { stdio: ["pipe", "ignore", "pipe"] });
        let err = "";
        p.stderr.on("data", (b: Buffer) => (err += b.toString()));
        const onAbort = () => p.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });
        const t = setTimeout(() => p.kill("SIGKILL"), 20_000);
        p.on("error", reject);
        p.on("close", (code) => {
          clearTimeout(t);
          signal?.removeEventListener("abort", onAbort);
          code === 0 ? resolve() : reject(new Error(`say exit ${code}: ${err.trim().slice(0, 200)}`));
        });
        p.stdin.end(text);
      });
      const data = await readFile(file);
      if (data.length < 100) throw new Error("say: file vuoto");
      return { data, format: "m4a" };
    } catch (err) {
      throw new DeckError("tts_failed", undefined, (err as Error).message);
    } finally {
      await unlink(file).catch(() => undefined);
    }
  }
}
