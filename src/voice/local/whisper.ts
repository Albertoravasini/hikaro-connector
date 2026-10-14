/**
 * Local speech-to-text with whisper.cpp's `whisper-server` (Homebrew `whisper-cpp`):
 * one persistent process keeps large-v3-turbo in RAM on the Metal GPU, we POST a
 * WAV to its /inference endpoint. With the Silero VAD model, silence/noise gives ""
 * instead of Whisper's classic hallucinations ("Grazie.", "Sottotitoli a cura di…").
 */
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { DeckError, ERROR_MESSAGES, ERROR_VARIANTS } from "../../core/errors.js";
import type { SttProvider } from "../stt.js";
import { pcm16ToWav } from "../wav.js";
import { ManagedProcess } from "./managed.js";

export interface WhisperRequestOpts {
  language: string;
  timeoutMs?: number;
  /** extra form fields (e.g. temperature) */
  fields?: Record<string, string>;
}

/** POST a WAV to a whisper.cpp server; returns the trimmed text. */
export async function whisperInference(baseUrl: string, wav: Buffer, o: WhisperRequestOpts): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", o.language || "auto");
  for (const [k, v] of Object.entries(o.fields ?? {})) form.append(k, v);
  const res = await fetch(`${baseUrl}/inference`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new DeckError("stt_failed", ERROR_MESSAGES.stt_failed, `whisper HTTP ${res.status}: ${body.slice(0, 200)}`);
  let json: { text?: unknown; error?: unknown };
  try {
    json = JSON.parse(body) as { text?: unknown; error?: unknown };
  } catch {
    throw new DeckError("stt_failed", ERROR_MESSAGES.stt_failed, `whisper: risposta non JSON: ${body.slice(0, 120)}`);
  }
  if (typeof json.error === "string") throw new DeckError("stt_failed", ERROR_MESSAGES.stt_failed, `whisper: ${json.error}`);
  return cleanTranscript(typeof json.text === "string" ? json.text : "");
}

/** Whisper markers that mean "nothing was said". */
const NON_SPEECH = /^\s*[[(](?:musica|music|silenzio|silence|blank_audio|applausi|risate|rumore|noise)[^\])]*[\])]\s*$/i;

export function cleanTranscript(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  return NON_SPEECH.test(s) ? "" : s;
}

export interface WhisperLocalOpts {
  bin: string;
  model: string;
  vadModel?: string | undefined;
  language: string;
  /** fixed port (0 = free port) */
  port?: number;
  threads?: number;
  pidFile?: string | undefined;
}

export class WhisperLocalStt implements SttProvider {
  readonly name = "whisper-locale";
  readonly proc: ManagedProcess;

  constructor(private readonly o: WhisperLocalOpts) {
    const threads = String(o.threads ?? Math.max(4, Math.min(8, cpus().length - 2)));
    const vad = o.vadModel && existsSync(o.vadModel) ? ["--vad", "-vm", o.vadModel] : [];
    this.proc = new ManagedProcess({
      name: "whisper",
      cmd: o.bin,
      args: (port) => [
        "-m", o.model,
        "--host", "127.0.0.1",
        "--port", String(port),
        "-l", o.language || "auto",
        "-t", threads,
        "-nt",
        ...vad,
      ],
      port: o.port ?? 0,
      ...(o.pidFile ? { pidFile: o.pidFile } : {}),
      healthPath: "/",
      startTimeoutMs: 90_000,
      onReady: async (url) => {
        // Warm-up: the first inference compiles Metal kernels (~1 s).
        await whisperInference(url, pcm16ToWav(Buffer.alloc(16_000)), { language: o.language }).catch(() => "");
      },
    });
  }

  /** Model on disk? (setup downloads it) */
  get available(): boolean {
    return existsSync(this.o.model) && existsSync(this.o.bin);
  }

  async start(): Promise<void> {
    await this.proc.ensure();
  }

  async stop(): Promise<void> {
    await this.proc.stop();
  }

  async transcribe(pcm: Buffer): Promise<string> {
    if (!this.available) throw new DeckError("stt_failed", ERROR_VARIANTS.sttNoKey, `modello mancante: ${this.o.model}`);
    const wav = pcm16ToWav(pcm);
    for (let attempt = 0; ; attempt++) {
      let url: string;
      try {
        url = await this.proc.ensure();
      } catch (err) {
        throw new DeckError("stt_failed", ERROR_VARIANTS.sttLocalDown, (err as Error).message);
      }
      try {
        return await whisperInference(url, wav, { language: this.o.language });
      } catch (err) {
        if (err instanceof DeckError || attempt > 0) {
          throw err instanceof DeckError ? err : new DeckError("stt_failed", ERROR_MESSAGES.stt_failed, (err as Error).message);
        }
        await this.proc.recheck(); // crashed? the next ensure() restarts it
      }
    }
  }
}
