/**
 * Hermes profile discovery (read-only).
 *
 * Facts from hermes-agent v0.18.2 source:
 *  - Profiles: default = ~/.hermes, named = ~/.hermes/profiles/<name>
 *    (name matches ^[a-z0-9][a-z0-9_-]{0,63}$), each with its own config.yaml and .env.
 *  - The API server (gateway/platforms/api_server.py) has NO per-profile routing:
 *    one gateway process = one profile = one API server port. Each profile that
 *    should be reachable needs its own API_SERVER_PORT (8642, 8643, …).
 *    The `/p/<profile>/` URL prefix exists only for webhooks in multiplex mode, and
 *    with gateway.multiplex_profiles on, secondary profiles may NOT enable api_server
 *    (MultiplexConfigError) → only the default profile is reachable then.
 *  - API server env: API_SERVER_ENABLED, API_SERVER_KEY (≥16 chars, required),
 *    API_SERVER_PORT (default 8642), API_SERVER_HOST (default 127.0.0.1).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile, type AgentOverride } from "../config.js";

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const HERMES_DEFAULT_PORT = 8642;

export interface HermesProfile {
  name: string;
  home: string;
  isDefault: boolean;
  envFile: string;
  api: {
    enabled: boolean;
    port?: number;
    host?: string;
    hasKey: boolean;
  };
}

function isTruthy(v: string | undefined): boolean {
  return !!v && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export function readProfile(name: string, home: string, isDefault: boolean): HermesProfile {
  const envFile = join(home, ".env");
  const env = readEnvFile(envFile);
  const port = Number(env.API_SERVER_PORT);
  const api: HermesProfile["api"] = {
    enabled: isTruthy(env.API_SERVER_ENABLED) || !!env.API_SERVER_KEY,
    hasKey: !!env.API_SERVER_KEY && env.API_SERVER_KEY.length >= 16,
  };
  if (Number.isInteger(port) && port > 0) api.port = port;
  if (env.API_SERVER_HOST) api.host = env.API_SERVER_HOST;
  return { name, home, isDefault, envFile, api };
}

/** Default profile + every valid named profile, sorted by name. */
export function listProfiles(hermesHome: string): HermesProfile[] {
  const out: HermesProfile[] = [];
  if (existsSync(hermesHome)) out.push(readProfile("default", hermesHome, true));
  const root = join(hermesHome, "profiles");
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      if (name === "default" || !PROFILE_ID_RE.test(name)) continue;
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push(readProfile(name, dir, false));
    }
  }
  return out;
}

/** Is gateway.multiplex_profiles (or top-level multiplex_profiles) on? Cheap YAML sniff. */
export function isMultiplexOn(hermesHome: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.GATEWAY_MULTIPLEX_PROFILES?.trim().toLowerCase();
  if (override && ["1", "true", "yes", "on"].includes(override)) return true;
  if (override && ["0", "false", "no", "off"].includes(override)) return false;
  try {
    const yaml = readFileSync(join(hermesHome, "config.yaml"), "utf8");
    return /^\s*multiplex_profiles\s*:\s*(true|yes|on|1)\s*$/im.test(yaml);
  } catch {
    return false;
  }
}

/** Read the API key of a profile (kept out of HermesProfile so it is never logged by accident). */
export function readProfileKey(p: HermesProfile): string | undefined {
  const k = readEnvFile(p.envFile).API_SERVER_KEY;
  return k && k.length > 0 ? k : undefined;
}

export interface HermesEndpoint {
  /** agent id = profile name */
  id: string;
  name: string;
  profile: string;
  url: string;
  key: string | undefined;
  /** profile directory (for the read-only sessions.json lookup) */
  home?: string;
}

export function displayName(profile: string): string {
  if (profile === "default") return "Hermes";
  return profile
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function connectHost(host: string | undefined): string {
  if (!host || host === "0.0.0.0" || host === "::" || host === "localhost") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Discord channel/thread names of a profile's gateway sessions, from the read-only
 * legacy mirror <profile>/sessions/sessions.json (origin.chat_name =
 * "Guild / #channel / thread" for threads, "Guild / #channel" for channels).
 */
export function readSessionOrigins(profileHome: string): Map<string, { chatName?: string; displayName?: string }> {
  const out = new Map<string, { chatName?: string; displayName?: string }>();
  try {
    const raw = JSON.parse(readFileSync(join(profileHome, "sessions", "sessions.json"), "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_") || !v || typeof v !== "object") continue;
      const e = v as { session_id?: unknown; display_name?: unknown; origin?: { chat_name?: unknown } };
      if (typeof e.session_id !== "string") continue;
      const info: { chatName?: string; displayName?: string } = {};
      if (typeof e.origin?.chat_name === "string") info.chatName = e.origin.chat_name;
      if (typeof e.display_name === "string") info.displayName = e.display_name;
      out.set(e.session_id, info);
    }
  } catch {
    /* no gateway sessions yet */
  }
  return out;
}

/** "Guild / #outreach / Studio Ferri" → { channel: "outreach", thread: "Studio Ferri" } */
export function splitChatName(chatName: string | undefined): { channel?: string; thread?: string } {
  if (!chatName) return {};
  const parts = chatName.split(" / ").map((x) => x.trim()).filter(Boolean);
  const idx = parts.findIndex((x) => x.startsWith("#"));
  if (idx >= 0) {
    const r: { channel?: string; thread?: string } = { channel: parts[idx]!.slice(1) };
    const thread = parts.slice(idx + 1).join(" / ");
    if (thread) r.thread = thread;
    return r;
  }
  if (parts.length >= 3) return { channel: parts[1]!, thread: parts.slice(2).join(" / ") };
  if (parts.length === 2) return { channel: parts[0]!, thread: parts[1]! };
  return { thread: parts[0]! };
}

export interface ResolveOpts {
  hermesHome: string;
  hermesUrl?: string | undefined;
  hermesApiKey?: string | undefined;
  overrides?: Record<string, AgentOverride>;
}

/**
 * Which Hermes API servers to talk to, one per agent.
 * Named profiles first (they are usually the purpose-built agents), default last.
 */
export function resolveEndpoints(o: ResolveOpts): HermesEndpoint[] {
  const profiles = listProfiles(o.hermesHome);
  const multiplex = isMultiplexOn(o.hermesHome);
  const out: HermesEndpoint[] = [];
  let def: HermesEndpoint | undefined;

  for (const p of profiles) {
    if (o.overrides?.[p.name]?.hidden) continue;
    if (p.isDefault) {
      def = {
        id: p.name,
        name: displayName(p.name),
        profile: p.name,
        url: o.hermesUrl ?? `http://${connectHost(p.api.host)}:${p.api.port ?? HERMES_DEFAULT_PORT}`,
        key: o.hermesApiKey ?? readProfileKey(p),
        home: p.home,
      };
      continue;
    }
    if (multiplex) continue; // secondary profiles cannot expose an API server
    if (!p.api.enabled || !p.api.port) continue; // would collide with the default port
    out.push({
      id: p.name,
      name: displayName(p.name),
      profile: p.name,
      url: `http://${connectHost(p.api.host)}:${p.api.port}`,
      key: readProfileKey(p),
      home: p.home,
    });
  }
  if (!def && o.hermesUrl) {
    def = { id: "default", name: "Hermes", profile: "default", url: o.hermesUrl, key: o.hermesApiKey };
  }
  if (def) out.push(def);
  return out;
}
