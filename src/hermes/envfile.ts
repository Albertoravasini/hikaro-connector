/**
 * Safe edits of a Hermes profile `.env` + the pure plan used by `hikaro-connector setup`.
 *
 * Why .env and not `hermes config set`: in v0.18.2 `config set` only routes keys ending in
 * _API_KEY/_TOKEN to .env, so `API_SERVER_KEY` would land in config.yaml as a bogus key.
 * The gateway reads API_SERVER_ENABLED / API_SERVER_KEY / API_SERVER_PORT from the
 * profile's environment (gateway/config.py), which Hermes loads from <profile>/.env.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { HermesProfile } from "./profiles.js";
import { HERMES_DEFAULT_PORT } from "./profiles.js";

const MARK = "# Hikaro connector — API server di Hermes (aggiunto da hikaro-connector setup)";

/** Replace or append KEY=value lines; every other line (comments, other keys) is kept verbatim. */
export function upsertEnv(text: string, updates: Record<string, string>): string {
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && key in updates && !done.has(key)) {
      done.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  const missing = Object.keys(updates).filter((k) => !done.has(k));
  if (missing.length) {
    if (out.length && out[out.length - 1]!.trim() !== "") out.push("");
    if (!out.includes(MARK)) out.push(MARK);
    for (const k of missing) out.push(`${k}=${updates[k]}`);
  }
  return out.join("\n") + "\n";
}

export interface ProfilePlan {
  profile: string;
  envFile: string;
  port: number;
  /** keys to write; empty = already configured */
  changes: Record<string, string>;
  keyIsNew: boolean;
  reason: string;
}

export interface SetupPlan {
  multiplex: boolean;
  profiles: ProfilePlan[];
  skipped: { profile: string; reason: string }[];
}

export function newApiKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Decide, per profile, which API server settings to write.
 * - keeps existing ports and strong keys (≥16 chars);
 * - assigns free ports: default → 8642, named → 8643, 8644, … (skipping used ones);
 * - with multiplex on, only the default profile can expose an API server.
 * `readKey` returns a profile's current API_SERVER_KEY (or undefined).
 */
export function planSetup(
  profiles: HermesProfile[],
  multiplex: boolean,
  readKey: (p: HermesProfile) => string | undefined,
  sharedKey: string = newApiKey(),
): SetupPlan {
  const plan: SetupPlan = { multiplex, profiles: [], skipped: [] };
  const used = new Set<number>();
  for (const p of profiles) if (p.api.port) used.add(p.api.port);

  const nextPort = (preferred: number): number => {
    let port = preferred;
    while (used.has(port)) port++;
    used.add(port);
    return port;
  };

  const ordered = [...profiles].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  for (const p of ordered) {
    if (multiplex && !p.isDefault) {
      plan.skipped.push({
        profile: p.name,
        reason: "gateway.multiplex_profiles è attivo: solo il profilo default può avere l'API server",
      });
      continue;
    }
    const changes: Record<string, string> = {};
    if (!p.api.enabled || !readEnvFlag(p)) changes.API_SERVER_ENABLED = "true";
    const existingKey = readKey(p);
    let keyIsNew = false;
    if (!existingKey || existingKey.length < 16) {
      changes.API_SERVER_KEY = sharedKey;
      keyIsNew = true;
    }
    let port = p.api.port;
    if (!port) {
      port = nextPort(p.isDefault ? HERMES_DEFAULT_PORT : HERMES_DEFAULT_PORT + 1);
      // The default profile listens on 8642 without an explicit port; only write it for named ones.
      if (!p.isDefault || port !== HERMES_DEFAULT_PORT) changes.API_SERVER_PORT = String(port);
    }
    plan.profiles.push({
      profile: p.name,
      envFile: p.envFile,
      port,
      changes,
      keyIsNew,
      reason: Object.keys(changes).length ? `imposta ${Object.keys(changes).join(", ")}` : "già pronto",
    });
  }
  return plan;
}

function readEnvFlag(p: HermesProfile): boolean {
  // `enabled` is true also when only a key is present; make the flag explicit anyway.
  try {
    return /^\s*(?:export\s+)?API_SERVER_ENABLED\s*=\s*["']?(1|true|yes|on)["']?\s*$/im.test(readFileSync(p.envFile, "utf8"));
  } catch {
    return false;
  }
}

function stamp(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

/** Back up then apply `changes` to an env file. Returns the backup path (or null if the file was new). */
export function applyEnvChanges(envFile: string, changes: Record<string, string>): string | null {
  let backup: string | null = null;
  let text = "";
  if (existsSync(envFile)) {
    backup = `${envFile}.hikaro-backup-${stamp()}`;
    copyFileSync(envFile, backup);
    chmodSync(backup, 0o600);
    text = readFileSync(envFile, "utf8");
  }
  // .env holds secrets: always owner-only.
  writeFileSync(envFile, upsertEnv(text, changes), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  return backup;
}
