/**
 * Read-only access to a Hermes profile's `state.db` (SQLite, hermes_state.py).
 *
 * Used for profiles that are reached through ACP (no API server): their Discord
 * sub-chats and the transcript we seed into a linked ACP session.
 *
 * Never writes: the macOS `/usr/bin/sqlite3 -readonly` CLI (always present, JSON output
 * since 3.33) in a child process; `node:sqlite` (Node ≥ 22.13, opened readOnly) only if
 * the CLI is missing.
 *
 * Where Discord sessions live (hermes-agent v0.18.2, gateway/session.py):
 *  - one gateway per profile: in that profile's own state.db, session_key "agent:main:discord:…";
 *  - `gateway.multiplex_profiles` on: ONE gateway (HERMES_HOME = the default profile) writes every
 *    profile's sessions into the default state.db, with session_key "agent:<profile>:discord:…"
 *    (the default profile keeps "agent:main:…").
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../core/log.js";

const log = logger("statedb");

export const SQLITE_BIN = "/usr/bin/sqlite3";

export type Row = Record<string, unknown>;

/** SQL string literal (values we pass are ids/profile names; quotes are escaped anyway). */
export function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function viaCli(bin: string, db: string, sql: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["-readonly", "-json", db, sql], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`sqlite3: ${(stderr || err.message).trim().slice(0, 200)}`));
      const out = stdout.trim();
      if (!out) return resolve([]);
      try {
        resolve(JSON.parse(out) as Row[]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function viaNode(db: string, sql: string): Promise<Row[]> {
  const mod = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (p: string, o: { readOnly: boolean }) => { prepare(s: string): { all(): Row[] }; close(): void };
  };
  const conn = new mod.DatabaseSync(db, { readOnly: true });
  try {
    return conn.prepare(sql).all();
  } finally {
    conn.close();
  }
}

/** Run a read-only query. Missing db → []. */
export async function queryReadOnly(db: string, sql: string, bin = SQLITE_BIN): Promise<Row[]> {
  if (!existsSync(db)) return [];
  if (existsSync(bin)) return viaCli(bin, db, sql);
  return viaNode(db, sql);
}

export interface DiscordSessionRow {
  id: string;
  /** which state.db holds it (for the transcript) */
  db: string;
  sessionKey?: string;
  title?: string | null;
  preview?: string | null;
  displayName?: string | null;
  chatName?: string | null;
  started_at?: number;
  last_active?: number | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Profile encoded in a gateway session key ("agent:main:…" → default). */
export function profileOfKey(key: string | undefined | null): string | undefined {
  if (!key) return undefined;
  const parts = key.split(":");
  if (parts.length < 2 || parts[0] !== "agent") return undefined;
  return !parts[1] || parts[1] === "main" ? "default" : parts[1];
}

function discordSql(where: string, limit: number): string {
  // Delegate sub-agent runs carry `_delegate_from` in model_config; they are not sub-chats.
  return `SELECT s.id, s.session_key, s.title, s.display_name, s.origin_json, s.started_at,
  (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_active,
  (SELECT substr(m.content, 1, 120) FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL ORDER BY m.id LIMIT 1) AS preview
FROM sessions s
WHERE s.source = 'discord' AND (s.model_config IS NULL OR s.model_config NOT LIKE '%_delegate_from%') AND (${where})
ORDER BY COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), s.started_at) DESC
LIMIT ${Math.max(1, Math.floor(limit))}`;
}

function toRow(r: Row, db: string): DiscordSessionRow {
  let chatName: string | undefined;
  const origin = str(r.origin_json);
  if (origin) {
    try {
      chatName = str((JSON.parse(origin) as { chat_name?: unknown }).chat_name);
    } catch {
      /* ignore */
    }
  }
  const out: DiscordSessionRow = { id: String(r.id), db };
  const key = str(r.session_key);
  if (key) out.sessionKey = key;
  out.title = str(r.title) ?? null;
  out.preview = str(r.preview) ?? null;
  out.displayName = str(r.display_name) ?? null;
  out.chatName = chatName ?? null;
  const st = num(r.started_at);
  if (st !== undefined) out.started_at = st;
  out.last_active = num(r.last_active) ?? null;
  return out;
}

/** One entry per conversation: a thread whose session was reset/compressed keeps only its newest row. */
export function newestPerKey(rows: DiscordSessionRow[]): DiscordSessionRow[] {
  const seen = new Set<string>();
  const out: DiscordSessionRow[] = [];
  const t = (r: DiscordSessionRow) => r.last_active ?? r.started_at ?? 0;
  for (const r of [...rows].sort((a, b) => t(b) - t(a))) {
    const k = r.sessionKey ?? `id:${r.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export interface ProfileDbs {
  profile: string;
  /** the profile's own HERMES_HOME */
  home: string;
  /** the Hermes root (default profile home), where a multiplexed gateway writes */
  root: string;
}

/**
 * Discord sub-chats of a profile, newest first, read-only from state.db:
 * its own db (own gateway) + the root db rows namespaced "agent:<profile>:" (multiplexed gateway).
 */
export async function listDiscordSessions(p: ProfileDbs, limit = 30, bin = SQLITE_BIN): Promise<DiscordSessionRow[]> {
  const own = join(p.home, "state.db");
  const rootDb = join(p.root, "state.db");
  const rows: DiscordSessionRow[] = [];
  const isDefault = p.profile === "default";
  if (isDefault) {
    // Only the default profile's own conversations (multiplexed gateways keep the others in the same db).
    const where = "s.session_key IS NULL OR s.session_key NOT LIKE 'agent:%' OR s.session_key LIKE 'agent:main:%'";
    rows.push(...(await safeQuery(rootDb, discordSql(where, limit * 2), bin)).map((r) => toRow(r, rootDb)));
  } else {
    rows.push(...(await safeQuery(own, discordSql("1 = 1", limit * 2), bin)).map((r) => toRow(r, own)));
    if (rootDb !== own) {
      const where = `s.session_key LIKE ${sqlStr(`agent:${p.profile}:%`)}`;
      rows.push(...(await safeQuery(rootDb, discordSql(where, limit * 2), bin)).map((r) => toRow(r, rootDb)));
    }
  }
  return newestPerKey(rows).slice(0, limit);
}

/** Ids of Discord sessions in the root db that belong to OTHER profiles (multiplexed gateway). */
export async function foreignDiscordIds(root: string, profile: string, bin = SQLITE_BIN): Promise<Set<string>> {
  const ns = profile === "default" ? "main" : profile;
  const sql = `SELECT id FROM sessions WHERE source = 'discord' AND session_key LIKE 'agent:%' AND session_key NOT LIKE ${sqlStr(`agent:${ns}:%`)}`;
  const rows = await safeQuery(join(root, "state.db"), sql, bin);
  return new Set(rows.map((r) => String(r.id)));
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  /** epoch seconds */
  ts: number;
}

/** Last `limit` user/assistant messages of a session (oldest first), optionally only newer than `afterTs`. */
export async function readTranscript(db: string, sessionId: string, limit = 20, afterTs = 0, bin = SQLITE_BIN): Promise<TranscriptMessage[]> {
  const sql = `SELECT role, content, timestamp FROM messages
WHERE session_id = ${sqlStr(sessionId)} AND role IN ('user', 'assistant') AND content IS NOT NULL AND trim(content) != ''
  AND COALESCE(active, 1) = 1 AND timestamp > ${Number(afterTs) || 0}
ORDER BY id DESC LIMIT ${Math.max(1, Math.floor(limit))}`;
  const rows = await safeQuery(db, sql, bin);
  return rows
    .map((r) => ({ role: r.role as "user" | "assistant", content: String(r.content), ts: num(r.timestamp) ?? 0 }))
    .reverse();
}

async function safeQuery(db: string, sql: string, bin: string): Promise<Row[]> {
  try {
    return await queryReadOnly(db, sql, bin);
  } catch (err) {
    log.debug(`query on ${db} failed`, err);
    return [];
  }
}
