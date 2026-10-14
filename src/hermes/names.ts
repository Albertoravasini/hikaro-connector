/**
 * Real agent names: each Hermes profile is usually one Discord bot, so the agent is named
 * after the bot (`global_name || username` of GET /users/@me with the profile's
 * DISCORD_BOT_TOKEN — the key Hermes reads in gateway/config.py).
 *
 * The token is only sent to discord.com; it is never logged nor stored. The result is
 * cached in state.json (keyed by a short hash of the token, so a new token refreshes it).
 *
 * Fallbacks: a short profile description from <profile>/profile.yaml (`hermes profile
 * describe`), else the profile name capitalised ("creads" → "Creads"); "Hermes" only for
 * the default profile when nothing else is known.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile, type StateStore } from "../config.js";
import { logger } from "../core/log.js";

const log = logger("names");

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_TOKEN_ENV = "DISCORD_BOT_TOKEN";
/** refresh a cached bot name after this long (the cache is used meanwhile and on errors) */
export const NAME_TTL_MS = 12 * 60 * 60_000;

export interface CachedName {
  name: string;
  /** sha256(token) prefix: the cache follows the token */
  tokenHash: string;
  ts: number;
}

export function capitalise(profile: string): string {
  if (profile === "default") return "Hermes";
  return profile
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Short `description:` from profile.yaml (only if it reads like a name: ≤ 24 chars, one line, no full stop). */
export function profileDescriptionName(home: string): string | undefined {
  try {
    const yaml = readFileSync(join(home, "profile.yaml"), "utf8");
    const m = /^description\s*:\s*(.+)$/m.exec(yaml);
    if (!m) return undefined;
    const v = m[1]!.trim().replace(/^["']|["']$/g, "").trim();
    if (!v || v.length > 24 || /[.!?:]/.test(v) || v === "|" || v === ">") return undefined;
    return v;
  } catch {
    return undefined;
  }
}

/** GET /users/@me with a bot token. Never throws; never logs the token. */
export async function fetchBotName(token: string, base = DISCORD_API, timeoutMs = 3_000): Promise<string | undefined> {
  try {
    const res = await fetch(`${base}/users/@me`, {
      headers: { Authorization: `Bot ${token}`, "User-Agent": "HikaroConnector (https://hikaro.app, 0.1)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn(`Discord: nome del bot non disponibile (HTTP ${res.status})`);
      return undefined;
    }
    const j = (await res.json()) as { global_name?: unknown; username?: unknown };
    const name = (typeof j.global_name === "string" && j.global_name.trim()) || (typeof j.username === "string" && j.username.trim()) || "";
    return name || undefined;
  } catch (err) {
    log.debug(`Discord: nome del bot non disponibile (${(err as Error).name})`);
    return undefined;
  }
}

export interface NameSource {
  profile: string;
  home: string;
}

export interface NameResolverOpts {
  state: StateStore;
  discordApi?: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

export class NameResolver {
  constructor(private readonly o: NameResolverOpts) {}

  async resolve(p: NameSource): Promise<string> {
    const token = readEnvFile(join(p.home, ".env"))[DISCORD_TOKEN_ENV]?.trim();
    const now = (this.o.now ?? Date.now)();
    if (token) {
      const hash = tokenHash(token);
      const cached = this.o.state.get().names?.[p.profile];
      const fresh = cached && cached.tokenHash === hash && now - cached.ts < (this.o.ttlMs ?? NAME_TTL_MS);
      if (fresh) return cached.name;
      const name = await fetchBotName(token, this.o.discordApi ?? DISCORD_API, this.o.timeoutMs ?? 3_000);
      if (name) {
        if (!cached || cached.name !== name || cached.tokenHash !== hash || !fresh) {
          this.o.state.update((s) => {
            s.names = s.names ?? {};
            s.names[p.profile] = { name, tokenHash: hash, ts: now };
          });
        }
        return name;
      }
      if (cached && cached.tokenHash === hash) return cached.name; // stale but right bot
    }
    return profileDescriptionName(p.home) ?? capitalise(p.profile);
  }

  async resolveAll(list: NameSource[]): Promise<Map<string, string>> {
    const names = await Promise.all(list.map((p) => this.resolve(p)));
    return new Map(list.map((p, i) => [p.profile, names[i]!]));
  }
}
