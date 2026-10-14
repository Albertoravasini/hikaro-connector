/**
 * Builds the speech-to-text and text-to-speech providers from the config.
 * Without any API key everything runs on the Mac:
 *   STT  whisper.cpp large-v3-turbo (whisper-server, Metal)  ·  alt: Parakeet v3 (mlx-audio)
 *   TTS  Kokoro-82M via mlx-audio (if_sara)  →  fallback macOS `say` (Alice), m4a
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { logger } from "../core/log.js";
import { voiceLayout, venvReady, whisperServerBin, type VoiceLayout } from "./local/layout.js";
import type { ManagedProcess } from "./local/managed.js";
import { KokoroTts, ParakeetStt, createMlxServer } from "./local/mlx.js";
import { SayTts } from "./local/say.js";
import { WhisperLocalStt } from "./local/whisper.js";
import { cloudStt, selectStt, type SttChoice, type SttProvider } from "./stt.js";
import { FallbackTts, OpenAiTts, type TtsProvider } from "./tts.js";

const log = logger("voice");

export type TtsChoice = { kind: "openai" } | { kind: "local"; kokoro: boolean } | { kind: "none"; reason: string };

export function selectTts(i: { mode: Config["ttsMode"]; openaiApiKey?: string | undefined; kokoroReady: boolean }): TtsChoice {
  switch (i.mode) {
    case "off":
      return { kind: "none", reason: "HIKARO_TTS=off" };
    case "openai":
      return i.openaiApiKey ? { kind: "openai" } : { kind: "none", reason: "manca OPENAI_API_KEY" };
    case "local":
      return { kind: "local", kokoro: i.kokoroReady };
    default:
      return i.openaiApiKey ? { kind: "openai" } : { kind: "local", kokoro: i.kokoroReady };
  }
}

export interface Voice {
  stt: SttProvider | null;
  tts: TtsProvider | null;
  sttChoice: SttChoice;
  ttsChoice: TtsChoice;
  layout: VoiceLayout;
  /** start local servers (models into RAM) without blocking the connector */
  warm(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * `owner: true` only for the long-running connector: it records the children's pids so a
 * restart after a crash can reap orphans. Checks (doctor/setup) must not, or they would
 * kill the running service's servers.
 */
export function createVoice(cfg: Config, opts: { owner?: boolean; env?: NodeJS.ProcessEnv } = {}): Voice {
  const env = opts.env ?? process.env;
  const run = (name: string) => (opts.owner ? join(cfg.paths.home, "run", `${name}.pid`) : undefined);
  const layout = voiceLayout(cfg.paths.home, env, cfg.whisperModel);
  const wbin = whisperServerBin(env);
  const whisperReady = !!wbin && existsSync(layout.whisperModel);
  const mlxReady = venvReady(layout);

  const sttChoice = selectStt({
    mode: cfg.sttMode,
    engine: cfg.sttEngine,
    groqApiKey: cfg.groqApiKey,
    openaiApiKey: cfg.openaiApiKey,
    sttUrl: cfg.sttUrl,
    whisperReady,
    parakeetReady: mlxReady,
  });
  const ttsChoice = selectTts({ mode: cfg.ttsEnabled ? cfg.ttsMode : "off", openaiApiKey: cfg.openaiApiKey, kokoroReady: mlxReady });

  let mlx: ManagedProcess | null = null;
  const mlxServer = (warmParakeet: boolean) =>
    (mlx ??= createMlxServer({
      layout,
      home: cfg.paths.home,
      warmKokoro: ttsChoice.kind === "local" && ttsChoice.kokoro,
      warmParakeet,
      port: cfg.voicePort,
      pidFile: run("mlx-voice"),
    }));

  let stt: SttProvider | null;
  switch (sttChoice.kind) {
    case "whisper":
      stt = new WhisperLocalStt({
        bin: wbin!,
        model: layout.whisperModel,
        vadModel: cfg.sttVad ? layout.vadModel : undefined,
        language: cfg.sttLanguage,
        port: cfg.whisperPort,
        pidFile: run("whisper"),
      });
      break;
    case "parakeet":
      stt = new ParakeetStt(mlxServer(true), layout, cfg.sttLanguage);
      break;
    case "none":
      stt = null;
      break;
    default:
      stt = cloudStt(sttChoice, { ...cfg, language: cfg.sttLanguage });
  }

  let tts: TtsProvider | null = null;
  if (ttsChoice.kind === "openai") {
    tts = new OpenAiTts({
      apiKey: cfg.openaiApiKey!,
      model: cfg.ttsModel,
      voice: cfg.ttsVoice,
      instructions: "Parla in italiano con tono naturale, caldo e sintetico, come un assistente personale.",
    });
  } else if (ttsChoice.kind === "local") {
    const say = new SayTts(cfg.sayVoice ?? "Alice");
    tts = ttsChoice.kokoro ? new FallbackTts([new KokoroTts(mlxServer(sttChoice.kind === "parakeet"), layout, cfg.localVoice), say]) : say;
  }

  return {
    stt,
    tts,
    sttChoice,
    ttsChoice,
    layout,
    warm: async () => {
      const t0 = Date.now();
      await Promise.all([
        stt?.start?.().catch((err) => log.warn(`STT ${stt?.name}: non parte`, err)),
        tts?.start?.().catch((err) => log.warn(`TTS ${tts?.name}: non parte`, err)),
      ]);
      if (stt?.start || tts?.start) log.info(`voce locale pronta in ${Date.now() - t0} ms`);
    },
    stop: async () => {
      await Promise.all([stt?.stop?.(), tts?.stop?.()].map((p) => p?.catch(() => undefined)));
    },
  };
}

export function describeStt(c: SttChoice): string {
  switch (c.kind) {
    case "groq": return "Groq Whisper (cloud)";
    case "openai": return "OpenAI (cloud)";
    case "url": return `servizio compatibile OpenAI (${c.url})`;
    case "whisper": return "Whisper large-v3-turbo sul Mac (whisper.cpp)";
    case "parakeet": return "Parakeet v3 sul Mac (mlx-audio)";
    default: return `spenta: ${c.reason}`;
  }
}

export function describeTts(c: TtsChoice, cfg: Pick<Config, "localVoice" | "sayVoice" | "ttsVoice" | "ttsModel">): string {
  switch (c.kind) {
    case "openai": return `OpenAI ${cfg.ttsModel} (voce ${cfg.ttsVoice})`;
    case "local": return c.kokoro ? `Kokoro sul Mac (voce ${cfg.localVoice}), riserva: voce di macOS ${cfg.sayVoice ?? "Alice"}` : `voce di macOS ${cfg.sayVoice ?? "Alice"} (Kokoro non installato)`;
    default: return `spenta: ${c.reason}`;
  }
}
