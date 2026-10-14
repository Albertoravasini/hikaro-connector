import { DeckError, ERROR_MESSAGES } from "../core/errors.js";
import { pcm16ToWav } from "./wav.js";

export interface SttProvider {
  readonly name: string;
  transcribe(pcm: Buffer): Promise<string>;
  /** start local servers / load models */
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

interface OpenAiCompatOpts {
  name: string;
  url: string;
  apiKey?: string | undefined;
  model: string;
  language: string;
  timeoutMs?: number;
}

/** OpenAI-compatible /audio/transcriptions (Groq, OpenAI, or any self-hosted server). */
export class OpenAiCompatStt implements SttProvider {
  readonly name: string;
  constructor(private readonly o: OpenAiCompatOpts) {
    this.name = o.name;
  }

  async transcribe(pcm: Buffer): Promise<string> {
    const wav = pcm16ToWav(pcm);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
    if (this.o.model) form.append("model", this.o.model);
    if (this.o.language && this.o.language !== "auto") form.append("language", this.o.language);
    form.append("response_format", "json");
    form.append("temperature", "0");
    let res: Response;
    try {
      res = await fetch(this.o.url, {
        method: "POST",
        headers: this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new DeckError("stt_failed", ERROR_MESSAGES.stt_failed, `${this.name}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DeckError("stt_failed", ERROR_MESSAGES.stt_failed, `${this.name} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { text?: unknown };
    return typeof json.text === "string" ? json.text.trim() : "";
  }
}

export type SttChoice =
  | { kind: "groq" }
  | { kind: "openai" }
  | { kind: "url"; url: string }
  | { kind: "whisper" }
  | { kind: "parakeet" }
  | { kind: "none"; reason: string };

export interface SttSelectInput {
  mode: "auto" | "local" | "groq" | "openai" | "url" | "off";
  engine: "auto" | "whisper" | "parakeet";
  groqApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  sttUrl?: string | undefined;
  /** whisper-server binary + model present */
  whisperReady: boolean;
  /** mlx-audio venv present (Parakeet) */
  parakeetReady: boolean;
}

function pickLocal(i: SttSelectInput): SttChoice {
  if (i.engine === "parakeet") {
    return i.parakeetReady ? { kind: "parakeet" } : { kind: "none", reason: "Parakeet non installato (hikaro-connector setup)" };
  }
  if (i.whisperReady) return { kind: "whisper" };
  if (i.engine === "auto" && i.parakeetReady) return { kind: "parakeet" };
  return { kind: "none", reason: "Whisper locale non installato (hikaro-connector setup)" };
}

/**
 * Which speech-to-text to use (pure, unit-tested).
 * auto = Groq if key, else OpenAI if key, else HIKARO_STT_URL, else local.
 */
export function selectStt(i: SttSelectInput): SttChoice {
  switch (i.mode) {
    case "off":
      return { kind: "none", reason: "HIKARO_STT=off" };
    case "groq":
      return i.groqApiKey ? { kind: "groq" } : { kind: "none", reason: "manca GROQ_API_KEY" };
    case "openai":
      return i.openaiApiKey ? { kind: "openai" } : { kind: "none", reason: "manca OPENAI_API_KEY" };
    case "url":
      return i.sttUrl ? { kind: "url", url: i.sttUrl } : { kind: "none", reason: "manca HIKARO_STT_URL" };
    case "local":
      return pickLocal(i);
    default:
      if (i.groqApiKey) return { kind: "groq" };
      if (i.openaiApiKey) return { kind: "openai" };
      if (i.sttUrl) return { kind: "url", url: i.sttUrl };
      return pickLocal(i);
  }
}

export function cloudStt(choice: SttChoice, k: { groqApiKey?: string | undefined; openaiApiKey?: string | undefined; sttApiKey?: string | undefined; sttModel?: string | undefined; language: string }): SttProvider | null {
  if (choice.kind === "groq") {
    return new OpenAiCompatStt({
      name: "groq",
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      apiKey: k.groqApiKey,
      model: "whisper-large-v3-turbo",
      language: k.language,
    });
  }
  if (choice.kind === "openai") {
    return new OpenAiCompatStt({
      name: "openai",
      url: "https://api.openai.com/v1/audio/transcriptions",
      apiKey: k.openaiApiKey,
      model: "gpt-4o-mini-transcribe",
      language: k.language,
    });
  }
  if (choice.kind === "url") {
    return new OpenAiCompatStt({
      name: "url",
      url: choice.url,
      apiKey: k.sttApiKey,
      model: k.sttModel ?? "whisper-1",
      language: k.language,
      timeoutMs: 30_000,
    });
  }
  return null;
}
