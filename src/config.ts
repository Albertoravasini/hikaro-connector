import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, type KeyIndex } from "./protocol.js";

export const VERSION = "0.1.0";
export const DEFAULT_COLOR = "#2EE26B";
export const LAUNCHD_LABEL = "app.hikaro.connector";

// ── Paths ─────────────────────────────────────────────────────────────

export interface Paths {
  home: string;          // ~/.hikaro
  configFile: string;    // ~/.hikaro/connector.json   (token, agent overrides) 0600
  envFile: string;       // ~/.hikaro/connector.env    (API keys, options)      0600
  stateFile: string;     // ~/.hikaro/state.json       (sessions, push tokens)  0600
  logFile: string;       // ~/.hikaro/connector.log
  installDir: string;    // ~/.hikaro/connector        (where install.sh puts the code)
}

export function paths(): Paths {
  const home = process.env.HIKARO_HOME || join(homedir(), ".hikaro");
  return {
    home,
    configFile: join(home, "connector.json"),
    envFile: join(home, "connector.env"),
    stateFile: join(home, "state.json"),
    logFile: join(home, "connector.log"),
    installDir: join(home, "connector"),
  };
}

export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HIKARO_HERMES_HOME || join(homedir(), ".hermes");
}

/** Mac name shown on the device ("Mac-mini-di-Alberto"). */
export function macName(): string {
  return hostname().replace(/\.local$/i, "") || "Mac";
}

// ── Small JSON / env helpers ──────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Atomic write with 0600 permissions. */
export function writePrivate(file: string, content: string): void {
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (dir) ensureDir(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Parse a dotenv-style file (KEY=value, # comments, optional quotes, `export`). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

export function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ── connector.json ────────────────────────────────────────────────────

export interface AgentOverride {
  name?: string;
  color?: string;
  key?: KeyIndex | null;
  /** hide this profile from the device */
  hidden?: boolean;
}

export interface ConnectorFile {
  token: string;
  createdAt: number;
  /** per-agent display overrides, keyed by agent id (= Hermes profile name) */
  agents?: Record<string, AgentOverride>;
}

/** Load connector.json, creating it (with a fresh token) on first run. */
export function loadConnectorFile(p: Paths = paths()): ConnectorFile {
  const existing = readJson<Partial<ConnectorFile> | null>(p.configFile, null);
  if (existing && typeof existing.token === "string" && existing.token.length >= 16) {
    // Re-assert permissions in case they were loosened.
    try { chmodSync(p.configFile, 0o600); } catch { /* ignore */ }
    return { createdAt: Date.now(), ...existing } as ConnectorFile;
  }
  const fresh: ConnectorFile = { ...(existing ?? {}), token: newToken(), createdAt: Date.now() };
  writePrivate(p.configFile, JSON.stringify(fresh, null, 2) + "\n");
  return fresh;
}

export function saveConnectorFile(file: ConnectorFile, p: Paths = paths()): void {
  writePrivate(p.configFile, JSON.stringify(file, null, 2) + "\n");
}

// ── state.json ────────────────────────────────────────────────────────

export interface PushToken {
  token: string;
  kind: "device" | "liveactivity";
  env: "sandbox" | "production";
  ts: number;
}

export interface StateFile {
  /** agent id → Hermes session id (persistent conversation per agent) */
  sessions: Record<string, string>;
  push: PushToken[];
  /** agent id → which conversation the key talks to: "deck" | "latest" | Hermes session id */
  selected: Record<string, string>;
  /** agent id → last activity of the Deck conversation (epoch ms) */
  deckUpdated: Record<string, number>;
}

export class StateStore {
  private data: StateFile;
  constructor(private readonly file: string) {
    const raw = readJson<Partial<StateFile>>(file, {});
    this.data = { sessions: raw.sessions ?? {}, push: raw.push ?? [], selected: raw.selected ?? {}, deckUpdated: raw.deckUpdated ?? {} };
  }
  get(): Readonly<StateFile> {
    return this.data;
  }
  update(fn: (s: StateFile) => void): void {
    fn(this.data);
    try {
      writePrivate(this.file, JSON.stringify(this.data, null, 2) + "\n");
    } catch {
      /* state is best-effort */
    }
  }
}

// ── Runtime config ────────────────────────────────────────────────────

export type SttMode = "auto" | "local" | "groq" | "openai" | "url" | "off";
export type TtsMode = "auto" | "local" | "openai" | "off";

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], d: T): T {
  const x = v?.trim().toLowerCase();
  return x && (allowed as readonly string[]).includes(x) ? (x as T) : d;
}

export interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

export interface Config {
  paths: Paths;
  port: number;
  host: string;
  token: string;
  agentOverrides: Record<string, AgentOverride>;
  demo: boolean;
  hermesHome: string;
  /** explicit Hermes URL/key (applies to the default profile); undefined = discover */
  hermesUrl: string | undefined;
  hermesApiKey: string | undefined;
  groqApiKey: string | undefined;
  openaiApiKey: string | undefined;
  sttLanguage: string;
  /** HIKARO_STT: auto (Groq → OpenAI → URL → local) | local | groq | openai | url | off */
  sttMode: SttMode;
  /** HIKARO_STT_ENGINE for local STT: auto (whisper.cpp if installed, else Parakeet) | whisper | parakeet */
  sttEngine: "auto" | "whisper" | "parakeet";
  /** any OpenAI-compatible /audio/transcriptions endpoint (HIKARO_STT_URL, _MODEL, _KEY) */
  sttUrl: string | undefined;
  sttModel: string | undefined;
  sttApiKey: string | undefined;
  /** whisper.cpp model file name (in ~/.hikaro/models) or absolute path */
  whisperModel: string;
  /** Silero VAD in whisper.cpp (HIKARO_STT_VAD=off to disable) */
  sttVad: boolean;
  /** fixed ports for the local servers (0 = free port) */
  whisperPort: number;
  voicePort: number;
  ttsModel: string;
  ttsVoice: string;
  ttsEnabled: boolean;
  /** HIKARO_TTS: auto (OpenAI if key, else local) | local | openai | off */
  ttsMode: TtsMode;
  /** local Kokoro voice: if_sara | im_nicola */
  localVoice: string;
  /** macOS `say` voice for the fallback (Alice, or a Premium/Enhanced Italian voice) */
  sayVoice: string | undefined;
  doneHoldMs: number;
  demoIntervalMs: number;
  apns: ApnsConfig | undefined;
}

/**
 * Build the runtime config: process.env wins over ~/.hikaro/connector.env.
 * Also creates the token on first run.
 */
export function loadConfig(opts: { demo?: boolean; port?: number } = {}): Config {
  const p = paths();
  const fileEnv = readEnvFile(p.envFile);
  const env = (k: string): string | undefined => {
    const v = process.env[k] ?? fileEnv[k];
    return v === undefined || v === "" ? undefined : v;
  };
  const num = (k: string, d: number): number => {
    const v = Number(env(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const cf = loadConnectorFile(p);
  const keyPath = env("APNS_KEY_PATH");
  const keyId = env("APNS_KEY_ID");
  const teamId = env("APNS_TEAM_ID");
  return {
    paths: p,
    port: opts.port ?? num("HIKARO_PORT", DEFAULT_PORT),
    host: env("HIKARO_BIND") ?? "0.0.0.0",
    token: cf.token,
    agentOverrides: cf.agents ?? {},
    demo: opts.demo ?? env("HIKARO_DEMO") === "1",
    hermesHome: hermesHome({ ...fileEnv, ...process.env }),
    hermesUrl: env("HERMES_URL")?.replace(/\/+$/, ""),
    hermesApiKey: env("HERMES_API_KEY"),
    groqApiKey: env("GROQ_API_KEY"),
    openaiApiKey: env("OPENAI_API_KEY"),
    sttLanguage: env("HIKARO_STT_LANGUAGE") ?? "it",
    sttMode: oneOf<SttMode>(env("HIKARO_STT"), ["auto", "local", "groq", "openai", "url", "off"], "auto"),
    sttEngine: oneOf(env("HIKARO_STT_ENGINE"), ["auto", "whisper", "parakeet"] as const, "auto"),
    sttUrl: env("HIKARO_STT_URL"),
    sttModel: env("HIKARO_STT_MODEL"),
    sttApiKey: env("HIKARO_STT_KEY"),
    whisperModel: env("HIKARO_WHISPER_MODEL") ?? "ggml-large-v3-turbo-q8_0.bin",
    sttVad: env("HIKARO_STT_VAD") !== "off",
    whisperPort: num("HIKARO_WHISPER_PORT", 0),
    voicePort: num("HIKARO_VOICE_PORT", 0),
    ttsModel: env("HIKARO_TTS_MODEL") ?? "gpt-4o-mini-tts",
    ttsVoice: env("HIKARO_TTS_VOICE") ?? "coral",
    ttsEnabled: env("HIKARO_TTS") !== "off",
    ttsMode: oneOf<TtsMode>(env("HIKARO_TTS"), ["auto", "local", "openai", "off"], "auto"),
    localVoice: env("HIKARO_LOCAL_VOICE") ?? "if_sara",
    sayVoice: env("HIKARO_SAY_VOICE"),
    doneHoldMs: num("HIKARO_DONE_HOLD_MS", 30_000),
    demoIntervalMs: num("HIKARO_DEMO_INTERVAL_MS", 45_000),
    apns:
      keyPath && keyId && teamId
        ? { keyPath, keyId, teamId, bundleId: env("APNS_BUNDLE_ID") ?? "app.hikaro.deck" }
        : undefined,
  };
}

export const ENV_TEMPLATE = `# Hikaro connector — impostazioni (questo file resta solo sul tuo Mac)
# Dopo una modifica: hikaro-connector restart  (oppure riavvia il Mac)

# La voce funziona tutta sul Mac, senza chiavi: Whisper (voce → testo) e Kokoro (testo → voce).
# Le chiavi qui sotto sono facoltative: se le metti, il connettore usa i servizi cloud.
GROQ_API_KEY=
OPENAI_API_KEY=

# Voce → testo: auto (cloud se c'è una chiave, altrimenti locale) | local | groq | openai | url | off
# HIKARO_STT=auto
# HIKARO_STT_LANGUAGE=it            (oppure auto)
# HIKARO_STT_ENGINE=auto            (whisper | parakeet)
# Un servizio compatibile OpenAI qualsiasi:
# HIKARO_STT_URL=http://127.0.0.1:9000/v1/audio/transcriptions
# HIKARO_STT_MODEL=
# HIKARO_STT_KEY=

# Testo → voce: auto (OpenAI se c'è la chiave, altrimenti locale) | local | openai | off
# HIKARO_TTS=auto
# Voce locale: if_sara (donna) | im_nicola (uomo); riserva: voce di macOS (Alice)
# HIKARO_LOCAL_VOICE=if_sara
# HIKARO_SAY_VOICE=Alice
# Voce OpenAI: alloy, ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer, verse
# HIKARO_TTS_VOICE=coral

# Hermes (di solito non serve toccarli: il setup li trova da solo)
# HERMES_URL=http://127.0.0.1:8642
# HERMES_API_KEY=

# Porta del connettore
# HIKARO_PORT=8787

# Notifiche push (facoltative)
# APNS_KEY_PATH=/Users/tu/AuthKey_XXXXXXXXXX.p8
# APNS_KEY_ID=
# APNS_TEAM_ID=
`;

/** Create connector.env from the template if missing. Returns true if created. */
export function ensureEnvFile(p: Paths = paths()): boolean {
  if (existsSync(p.envFile)) return false;
  writePrivate(p.envFile, ENV_TEMPLATE);
  return true;
}
