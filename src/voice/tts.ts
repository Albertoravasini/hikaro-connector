import { DeckError } from "../core/errors.js";
import { logger } from "../core/log.js";
import type { AudioFormat } from "../protocol.js";

const log = logger("tts");

/** Voices accepted by OpenAI /v1/audio/speech (gpt-4o-mini-tts). */
export const OPENAI_VOICES = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse",
] as const;

export function isOpenAiVoice(v: string): boolean {
  return (OPENAI_VOICES as readonly string[]).includes(v);
}

/** Italian Kokoro voices (local TTS). */
export const LOCAL_VOICES = ["if_sara", "im_nicola"] as const;

/** Voice ids a device may pick: OpenAI ids (mapped to a local voice when TTS is local) + local ids. */
export function isKnownVoice(v: string): boolean {
  return isOpenAiVoice(v) || (LOCAL_VOICES as readonly string[]).includes(v);
}

/** A self-contained piece of audio (usually one sentence). */
export interface AudioClip {
  data: Buffer;
  format: AudioFormat;
}

export interface TtsProvider {
  readonly name: string;
  /**
   * `voice` is the device preference (may be an id this provider does not know:
   * then the provider uses its own default voice — never an error).
   */
  synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<AudioClip>;
  /** Warm up (start local servers, load models). */
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/** Detect the container of an audio buffer from its magic bytes. */
export function sniffAudioFormat(b: Buffer): AudioFormat | null {
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (b.length >= 8 && b.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (b.length >= 3 && b.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return "mp3";
  return null;
}

export interface OpenAiTtsOpts {
  apiKey: string;
  model: string;
  voice: string;
  instructions?: string;
  url?: string;
}

export class OpenAiTts implements TtsProvider {
  readonly name = "openai";
  constructor(private readonly o: OpenAiTtsOpts) {}

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<AudioClip> {
    const body: Record<string, unknown> = {
      model: this.o.model,
      voice: voice && isOpenAiVoice(voice) ? voice : this.o.voice,
      input: text,
      response_format: "mp3",
    };
    // `instructions` is supported by gpt-4o-mini-tts, not by tts-1.
    if (this.o.instructions && !this.o.model.startsWith("tts-1")) body.instructions = this.o.instructions;
    const timeout = AbortSignal.timeout(20_000);
    let res: Response;
    try {
      res = await fetch(this.o.url ?? "https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new DeckError("tts_failed", undefined, (err as Error).message);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new DeckError("tts_failed", undefined, `HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    return { data: Buffer.from(await res.arrayBuffer()), format: "mp3" };
  }
}

/**
 * Try providers in order. A provider that fails is skipped for `cooldownMs`
 * (so one broken engine does not add latency to every sentence).
 */
export class FallbackTts implements TtsProvider {
  readonly name: string;
  private readonly downUntil = new Map<TtsProvider, number>();

  constructor(
    private readonly chain: TtsProvider[],
    private readonly cooldownMs = 60_000,
  ) {
    this.name = chain.map((p) => p.name).join("→");
  }

  /** Name of the provider that would be used now. */
  get active(): string {
    const now = Date.now();
    return (this.chain.find((p) => (this.downUntil.get(p) ?? 0) <= now) ?? this.chain[this.chain.length - 1]!).name;
  }

  async start(): Promise<void> {
    await Promise.all(this.chain.map((p) => p.start?.().catch((err) => log.warn(`${p.name}: avvio non riuscito`, err))));
  }

  async stop(): Promise<void> {
    await Promise.all(this.chain.map((p) => p.stop?.().catch(() => undefined)));
  }

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<AudioClip> {
    let lastErr: unknown;
    const now = Date.now();
    const candidates = this.chain.filter((p) => (this.downUntil.get(p) ?? 0) <= now);
    for (const p of candidates.length ? candidates : this.chain) {
      if (signal?.aborted) break;
      try {
        return await p.synthesize(text, signal, voice);
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = err;
        this.downUntil.set(p, Date.now() + this.cooldownMs);
        log.warn(`${p.name} non ha funzionato, provo il prossimo`, err);
      }
    }
    throw lastErr instanceof DeckError ? lastErr : new DeckError("tts_failed", undefined, String((lastErr as Error)?.message ?? lastErr));
  }
}
