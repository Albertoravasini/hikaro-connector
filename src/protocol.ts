/**
 * Hikaro Deck Protocol · v1 — TypeScript mirror of `protocol/README.md`.
 *
 * KEEP IN SYNC with:
 *   - protocol/README.md            (the contract)
 *   - ios/Shared/Protocol/DeckProtocol.swift
 *   - protocol/examples/*.json      (must all parse with these types)
 *
 * Rules: unknown fields are ignored, unknown `type`s are ignored without error.
 *
 * Streaming conventions used by this connector (compatible with v1):
 *   - `reply` with `final: false` carries a DELTA (append it);
 *     `reply` with `final: true` carries the COMPLETE text (replace).
 *   - every `audio` message is a self-contained audio segment (usually one
 *     sentence) in `format` mp3 | m4a | wav; play them in order. `final: true`
 *     marks the last segment.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8787;
export const SAMPLE_RATE = 16_000;

export type AgentState = "off" | "working" | "calling" | "done";
export type CardKind = "request" | "reply" | "done" | "listening";
export type HapticPattern = "request" | "done" | "error";
export type KeyIndex = 0 | 1 | 2 | 3;
export type AudioFormat = "mp3" | "m4a" | "wav";
export const AUDIO_FORMATS: readonly AudioFormat[] = ["mp3", "m4a", "wav"];

export interface Agent {
  id: string;
  name: string;
  /** hex #RRGGBB */
  color: string;
  key: KeyIndex | null;
}

export interface Card {
  id: string;
  agent: string;
  kind: CardKind;
  /** max ~60 chars */
  title: string;
  /** max 3 short lines */
  lines?: string[];
  /** max ~140 chars */
  quote?: string;
  /** max 3, only for kind = "request" */
  options?: string[];
  counter?: string;
  /** epoch ms */
  ts: number;
}

export const CARD_LIMITS = {
  title: 60,
  line: 60,
  lines: 3,
  quote: 140,
  options: 3,
  option: 32,
} as const;

export type ErrorCode =
  | "unauthorized"
  | "hermes_down"
  | "no_agents"
  | "stt_failed"
  | "tts_failed"
  | "agent_failed"
  | "bad_message";

// ── Device → connector ────────────────────────────────────────────────

export interface HelloMsg { type: "hello"; device: "iphone" | "deck"; version: string; name?: string }
export interface VoiceStartMsg { type: "voice.start"; agent: string; id: string }
export interface VoiceEndMsg { type: "voice.end"; agent: string; id: string }
export interface VoiceCancelMsg { type: "voice.cancel"; agent: string; id: string }
export interface ChoiceMsg { type: "choice"; card: string; index: number; option: string }
export interface KeyTapMsg { type: "key.tap"; agent: string }
export interface PushRegisterMsg {
  type: "push.register";
  token: string;
  kind: "device" | "liveactivity";
  env: "sandbox" | "production";
}
export interface PingMsg { type: "ping" }
/** Per-device preferences: TTS voice override, `speak: false` = text only (no `audio`). */
export interface PrefsMsg { type: "prefs"; voice?: string; speak?: boolean }
/** Ask for the conversations of an agent (Discord threads + the Deck's own). */
export interface SessionsListMsg { type: "sessions.list"; agent: string }
/** Pick which conversation a key talks to: "deck" | "latest" | a Hermes session id. */
export interface SessionSelectMsg { type: "session.select"; agent: string; session: string }

export type DeviceMessage =
  | HelloMsg
  | VoiceStartMsg
  | VoiceEndMsg
  | VoiceCancelMsg
  | ChoiceMsg
  | KeyTapMsg
  | PushRegisterMsg
  | PrefsMsg
  | SessionsListMsg
  | SessionSelectMsg
  | PingMsg;

// ── Connector → device ────────────────────────────────────────────────

export interface WelcomeMsg { type: "welcome"; agents: Agent[]; mac: string; version: string }
export interface StatusMsg { type: "status"; agent: string; state: AgentState }
export interface CardMsg { type: "card"; card: Card }
export interface TranscriptMsg { type: "transcript"; agent: string; id: string; text: string; final: boolean }
export interface ReplyMsg { type: "reply"; agent: string; text: string; final: boolean }
export interface AudioMsg { type: "audio"; agent: string; format: AudioFormat; data: string; final: boolean }
export interface SessionItem {
  id: string;
  title: string;
  /** "deck" | "discord" | other Hermes source */
  source: string;
  /** channel name without "#" (Discord) */
  channel?: string;
  /** epoch ms of the last activity */
  updated: number;
}
export interface SessionsMsg { type: "sessions"; agent: string; selected: string; items: SessionItem[] }
export interface HapticMsg { type: "haptic"; pattern: HapticPattern }
export interface ErrorMsg { type: "error"; code: ErrorCode; message: string }
export interface PongMsg { type: "pong" }

export type ConnectorMessage =
  | WelcomeMsg
  | StatusMsg
  | CardMsg
  | TranscriptMsg
  | ReplyMsg
  | AudioMsg
  | HapticMsg
  | ErrorMsg
  | SessionsMsg
  | PongMsg;

export interface HealthResponse {
  ok: boolean;
  mac: string;
  hermes: boolean;
  agents: number;
  version: string;
}

// ── Parsing ───────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; message: DeviceMessage }
  | { ok: false; ignored: true; type: string }   // unknown type → ignore silently
  | { ok: false; ignored: false; reason: string }; // malformed → bad_message

const isStr = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;

/** Parse one text frame from the device. Never throws. */
export function parseDeviceMessage(raw: string): ParseResult {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ok: false, ignored: false, reason: "invalid JSON" };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    return { ok: false, ignored: false, reason: "not an object" };
  }
  const m = o as Record<string, unknown>;
  const type = m.type;
  if (!isStr(type)) return { ok: false, ignored: false, reason: "missing type" };
  const bad = (reason: string): ParseResult => ({ ok: false, ignored: false, reason: `${type}: ${reason}` });

  switch (type) {
    case "hello": {
      const device = m.device === "deck" ? "deck" : "iphone";
      const msg: HelloMsg = { type, device, version: isStr(m.version) ? m.version : String(m.version ?? "") };
      if (isStr(m.name)) msg.name = m.name;
      return { ok: true, message: msg };
    }
    case "voice.start":
    case "voice.end":
    case "voice.cancel":
      if (!nonEmpty(m.agent)) return bad("agent required");
      if (!nonEmpty(m.id)) return bad("id required");
      return { ok: true, message: { type, agent: m.agent, id: m.id } };
    case "choice": {
      if (!nonEmpty(m.card)) return bad("card required");
      const index = typeof m.index === "number" && Number.isInteger(m.index) ? m.index : -1;
      if (index < 0) return bad("index must be a non-negative integer");
      return { ok: true, message: { type, card: m.card, index, option: isStr(m.option) ? m.option : "" } };
    }
    case "key.tap":
      if (!nonEmpty(m.agent)) return bad("agent required");
      return { ok: true, message: { type, agent: m.agent } };
    case "push.register": {
      if (!nonEmpty(m.token)) return bad("token required");
      const kind = m.kind === "liveactivity" ? "liveactivity" : "device";
      const env = m.env === "production" ? "production" : "sandbox";
      return { ok: true, message: { type, token: m.token, kind, env } };
    }
    case "prefs": {
      const msg: PrefsMsg = { type };
      if (isStr(m.voice) && m.voice.trim()) msg.voice = m.voice.trim();
      if (typeof m.speak === "boolean") msg.speak = m.speak;
      return { ok: true, message: msg };
    }
    case "sessions.list":
      if (!nonEmpty(m.agent)) return bad("agent required");
      return { ok: true, message: { type, agent: m.agent } };
    case "session.select":
      if (!nonEmpty(m.agent)) return bad("agent required");
      if (!nonEmpty(m.session)) return bad("session required");
      return { ok: true, message: { type, agent: m.agent, session: m.session } };
    case "ping":
      return { ok: true, message: { type } };
    default:
      return { ok: false, ignored: true, type };
  }
}

export function encode(msg: ConnectorMessage): string {
  return JSON.stringify(msg);
}
