/**
 * Local neural voice on Apple Silicon via `mlx-audio` (Python venv in ~/.hikaro/venvs/voice):
 * one persistent `mlx_audio.server` (OpenAI-compatible) serves
 *   - Kokoro-82M text → speech (Italian voices if_sara, im_nicola), ~0.1–0.3 s per sentence warm;
 *   - optionally Parakeet TDT 0.6B v3 speech → text (/v1/audio/transcriptions).
 */
import { join } from "node:path";
import { DeckError, ERROR_MESSAGES, ERROR_VARIANTS } from "../../core/errors.js";
import type { SttProvider } from "../stt.js";
import type { AudioClip, TtsProvider } from "../tts.js";
import { LOCAL_VOICES, sniffAudioFormat } from "../tts.js";
import { pcm16ToWav } from "../wav.js";
import { KOKORO_MODEL, PARAKEET_MODEL, espeakEnv, hfCached, kokoroVoicePath, mlxServerBin, venvReady, type VoiceLayout } from "./layout.js";
import { ManagedProcess } from "./managed.js";

export const KOKORO_IT_VOICES = LOCAL_VOICES;

/** OpenAI voice ids the app may send → closest Italian Kokoro voice (by timbre). */
const OPENAI_TO_KOKORO: Record<string, string> = {
  ash: "im_nicola", ballad: "im_nicola", cedar: "im_nicola", echo: "im_nicola", onyx: "im_nicola", verse: "im_nicola",
  alloy: "if_sara", coral: "if_sara", fable: "if_sara", marin: "if_sara", nova: "if_sara", sage: "if_sara", shimmer: "if_sara",
};

/** Any voice id → an Italian Kokoro voice (unknown ids → the default, never an error). */
export function kokoroVoice(requested: string | undefined, fallback: string): string {
  const def = (KOKORO_IT_VOICES as readonly string[]).includes(fallback) ? fallback : "if_sara";
  if (!requested) return def;
  const v = requested.trim().toLowerCase();
  if ((KOKORO_IT_VOICES as readonly string[]).includes(v)) return v;
  return OPENAI_TO_KOKORO[v] ?? def;
}

export interface MlxServerOpts {
  layout: VoiceLayout;
  home: string;
  warmKokoro?: boolean;
  warmParakeet?: boolean;
  port?: number;
  pidFile?: string | undefined;
}

export function createMlxServer(o: MlxServerOpts): ManagedProcess {
  const l = o.layout;
  const offline = hfCached(l, KOKORO_MODEL) && (!o.warmParakeet || hfCached(l, PARAKEET_MODEL));
  return new ManagedProcess({
    name: "mlx-voice",
    cmd: mlxServerBin(l),
    args: (port) => ["--host", "127.0.0.1", "--port", String(port), "--log-dir", join(o.home, "logs")],
    env: {
      ...espeakEnv(l),
      HF_HOME: l.hfHome,
      ...(offline ? { HF_HUB_OFFLINE: "1" } : {}),
      HF_HUB_DISABLE_TELEMETRY: "1",
      TOKENIZERS_PARALLELISM: "false",
    },
    cwd: o.home,
    port: o.port ?? 0,
    ...(o.pidFile ? { pidFile: o.pidFile } : {}),
    healthPath: "/v1/models",
    startTimeoutMs: 120_000,
    onReady: async (url) => {
      if (o.warmKokoro !== false) await kokoroSpeech(url, "Pronto.", kokoroVoicePath(l, "if_sara") ?? "if_sara", 60_000);
      if (o.warmParakeet) await openAiTranscribe(url, PARAKEET_MODEL, pcm16ToWav(Buffer.alloc(32_000)), "it", 120_000).catch(() => "");
    },
  });
}

/** `voice` = a Kokoro voice id or the absolute path of its .safetensors (preferred: works offline). */
export async function kokoroSpeech(baseUrl: string, text: string, voice: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<AudioClip> {
  const id = voice.split("/").pop()!.replace(/\.safetensors$/, "");
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: KOKORO_MODEL,
      input: text,
      voice,
      lang_code: id.startsWith("i") ? "i" : "a",
      response_format: "mp3",
      speed: 1.0,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const data = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new DeckError("tts_failed", undefined, `kokoro HTTP ${res.status}: ${data.toString("utf8", 0, 200)}`);
  const format = sniffAudioFormat(data);
  if (!format || data.length < 200) throw new DeckError("tts_failed", undefined, `kokoro: audio non valido (${data.length} byte)`);
  return { data, format };
}

export async function openAiTranscribe(baseUrl: string, model: string, wav: Buffer, language: string, timeoutMs = 30_000): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  form.append("model", model);
  if (language && language !== "auto") form.append("language", language);
  form.append("response_format", "json");
  const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  if (!res.ok) throw new DeckError("stt_failed", ERROR_MESSAGES.stt_failed, `HTTP ${res.status}: ${body.slice(0, 200)}`);
  try {
    const j = JSON.parse(body) as { text?: unknown };
    return typeof j.text === "string" ? j.text.trim() : "";
  } catch {
    return body.trim();
  }
}

export class KokoroTts implements TtsProvider {
  readonly name = "kokoro";
  constructor(
    private readonly server: ManagedProcess,
    private readonly layout: VoiceLayout,
    private readonly defaultVoice: string,
  ) {}

  get available(): boolean {
    return venvReady(this.layout);
  }

  async start(): Promise<void> {
    if (this.available) await this.server.ensure();
  }

  async stop(): Promise<void> {
    await this.server.stop();
  }

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<AudioClip> {
    if (!this.available) throw new DeckError("tts_failed", undefined, "venv della voce non installato");
    const id = kokoroVoice(voice, this.defaultVoice);
    const v = kokoroVoicePath(this.layout, id) ?? id;
    for (let attempt = 0; ; attempt++) {
      let url: string;
      try {
        url = await this.server.ensure();
      } catch (err) {
        throw new DeckError("tts_failed", undefined, (err as Error).message);
      }
      try {
        return await kokoroSpeech(url, text, v, 20_000, signal);
      } catch (err) {
        if (signal?.aborted || err instanceof DeckError || attempt > 0) {
          throw err instanceof DeckError ? err : new DeckError("tts_failed", undefined, (err as Error).message);
        }
        await this.server.recheck();
      }
    }
  }
}

/** Parakeet v3 through the same mlx-audio server (alternative local STT engine). */
export class ParakeetStt implements SttProvider {
  readonly name = "parakeet-locale";
  constructor(
    private readonly server: ManagedProcess,
    private readonly layout: VoiceLayout,
    private readonly language: string,
  ) {}

  get available(): boolean {
    return venvReady(this.layout);
  }

  async start(): Promise<void> {
    if (this.available) await this.server.ensure();
  }

  async stop(): Promise<void> {
    await this.server.stop();
  }

  async transcribe(pcm: Buffer): Promise<string> {
    let url: string;
    try {
      url = await this.server.ensure();
    } catch (err) {
      throw new DeckError("stt_failed", ERROR_VARIANTS.sttLocalDown, (err as Error).message);
    }
    return openAiTranscribe(url, PARAKEET_MODEL, pcm16ToWav(pcm), this.language);
  }
}
