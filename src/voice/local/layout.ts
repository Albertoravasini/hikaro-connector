/**
 * Where the local voice lives (all under ~/.hikaro, nothing system-wide except
 * Homebrew's whisper-cpp):
 *   ~/.hikaro/models/ggml-large-v3-turbo-q8_0.bin   Whisper (whisper.cpp, Metal)
 *   ~/.hikaro/models/ggml-silero-v5.1.2.bin         Silero VAD (no "Grazie." on silence)
 *   ~/.hikaro/models/hf/                            HF cache for Kokoro / Parakeet (MLX)
 *   ~/.hikaro/venvs/voice/                          Python venv with mlx-audio (Kokoro TTS)
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const WHISPER_REPO = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
export const VAD_REPO = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";
/** large-v3-turbo q8_0: measured on M3 Pro ~0.65 s for a 3 s Italian clip, same text as q5_0 and ~8% faster. */
export const DEFAULT_WHISPER_MODEL = "ggml-large-v3-turbo-q8_0.bin";
export const VAD_MODEL = "ggml-silero-v5.1.2.bin";
export const KOKORO_MODEL = "mlx-community/Kokoro-82M-bf16";
export const PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
/** Pinned so a reinstall gives the same thing that was measured. */
export const VOICE_PIP_PACKAGES = [
  "mlx-audio==0.5.9",
  "misaki==0.7.4",
  "phonemizer-fork==3.3.2",
  "espeakng-loader==0.2.4",
  "num2words==0.5.14",
  "uvicorn==0.54.0",
  "fastapi==0.143.1",
  "python-multipart==0.0.32",
  // mlx_audio.server imports webrtcvad; the -wheels fork ships prebuilt arm64 wheels (no compiler needed)
  "webrtcvad-wheels==2.0.14",
  "setuptools<81",
];
/** Written by setup after the venv passed an import test. */
export const VENV_OK_MARKER = ".hikaro-ok";

export interface VoiceLayout {
  models: string;
  hfHome: string;
  venv: string;
  whisperModel: string;
  vadModel: string;
}

export function voiceLayout(home: string, env: NodeJS.ProcessEnv = process.env, whisperModel = DEFAULT_WHISPER_MODEL): VoiceLayout {
  const models = env.HIKARO_MODELS_DIR || join(home, "models");
  return {
    models,
    hfHome: join(models, "hf"),
    venv: env.HIKARO_VENV_DIR || join(home, "venvs", "voice"),
    whisperModel: whisperModel.includes("/") ? whisperModel : join(models, whisperModel),
    vadModel: join(models, VAD_MODEL),
  };
}

const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** First executable called `name` in $PATH or the Homebrew prefixes. */
export function findBin(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...BIN_DIRS];
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function whisperServerBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HIKARO_WHISPER_SERVER && existsSync(env.HIKARO_WHISPER_SERVER)) return env.HIKARO_WHISPER_SERVER;
  return findBin("whisper-server", env);
}

export function venvPython(l: VoiceLayout): string {
  return join(l.venv, "bin", "python");
}

export function mlxServerBin(l: VoiceLayout): string {
  return join(l.venv, "bin", "mlx_audio.server");
}

/** The venv exists and passed setup's import test. */
export function venvReady(l: VoiceLayout): boolean {
  return existsSync(join(l.venv, VENV_OK_MARKER)) && existsSync(mlxServerBin(l));
}

/** espeak-ng shipped inside the venv by `espeakng-loader` (Kokoro's Italian phonemizer; no Homebrew needed). */
export function espeakEnv(l: VoiceLayout): Record<string, string> {
  const lib = join(l.venv, "lib");
  try {
    for (const py of readdirSync(lib)) {
      const dir = join(lib, py, "site-packages", "espeakng_loader");
      const dylib = join(dir, "libespeak-ng.dylib");
      if (existsSync(dylib)) return { PHONEMIZER_ESPEAK_LIBRARY: dylib, ESPEAK_DATA_PATH: join(dir, "espeak-ng-data") };
    }
  } catch {
    /* no venv */
  }
  return {};
}

/** Files of the Kokoro repo we need (weights + Italian voices, ~330 MB instead of 740). */
export const KOKORO_FILES = ["config.json", "kokoro-v1_0.safetensors", "voices/if_*.safetensors", "voices/im_*.safetensors"];

/**
 * Absolute path of a Kokoro voice file in the HF cache. mlx-audio loads a voice
 * given as a path ending in .safetensors directly (otherwise it looks it up in a
 * different repo, prince-canuma/Kokoro-82M, which needs the network).
 */
export function kokoroVoicePath(l: VoiceLayout, voice: string): string | null {
  const snaps = join(l.hfHome, "hub", `models--${KOKORO_MODEL.replace("/", "--")}`, "snapshots");
  try {
    for (const rev of readdirSync(snaps)) {
      const f = join(snaps, rev, "voices", `${voice}.safetensors`);
      if (existsSync(f)) return f;
    }
  } catch {
    /* not downloaded */
  }
  return null;
}

/** Is an HF repo already in the cache (so the server can run offline)? */
export function hfCached(l: VoiceLayout, repo: string): boolean {
  const dir = join(l.hfHome, "hub", `models--${repo.replace("/", "--")}`, "snapshots");
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
