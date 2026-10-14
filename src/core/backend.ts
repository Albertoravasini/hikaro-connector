import type { HapticPattern } from "../protocol.js";

/**
 * AgentBackend — what the hub needs from "an agent runtime".
 * Implemented by HermesBackend (real) and DemoBackend (no Hermes, no keys).
 * OpenClaw / Hikaro Cloud can be added later by implementing this interface.
 */

export interface BackendAgent {
  /** stable id (Hermes: profile name) */
  id: string;
  /** default display name */
  name: string;
}

/** Card fields a backend can propose; the hub fills id/agent/ts and enforces limits. */
export interface CardDraft {
  kind: "request" | "reply" | "done";
  title: string;
  lines?: string[];
  quote?: string;
  options?: string[];
  counter?: string;
}

/** A question the agent runtime itself is blocked on (e.g. Hermes approval). */
export interface ApprovalRequest {
  /** opaque reference the backend needs to resolve it (e.g. run id) */
  ref: string;
  card: CardDraft & { kind: "request"; options: string[] };
}

export interface TurnSink {
  /** streamed text chunk of the reply */
  delta(text: string): void;
  /** the runtime is waiting for a decision */
  approval(req: ApprovalRequest): void;
  /** the runtime received the decision and is working again */
  resumed?(): void;
}

export interface TurnResult {
  text: string;
}

/** Events a backend may raise on its own (not as a reply to a message). */
export type BackendEvent =
  | { type: "card"; agent: string; card: CardDraft; ref?: string; haptic?: HapticPattern }
  | { type: "say"; agent: string; text: string };

export interface BackendHealth {
  ok: boolean;
  agents: number;
  detail?: string;
}

/** A conversation of an agent other than the Deck's own (e.g. a Discord thread). */
export interface BackendSession {
  id: string;
  title: string;
  source: string;
  channel?: string;
  /** epoch ms */
  updated: number;
}

/** Which conversation a key talks to. */
export type SessionSelection = "deck" | "latest" | (string & {});

export interface AgentBackend {
  readonly kind: string;
  start?(emit: (e: BackendEvent) => void): Promise<void> | void;
  stop?(): Promise<void> | void;
  listAgents(): Promise<BackendAgent[]>;
  health(): Promise<BackendHealth>;
  /** Send a user message to an agent and stream the reply. Throws DeckError on failure. */
  send(agentId: string, text: string, sink: TurnSink, signal?: AbortSignal): Promise<TurnResult>;
  /** Resolve an approval/request the backend raised (index into its options). */
  resolve(agentId: string, ref: string, index: number, option: string): Promise<void>;
  /** Conversations of an agent besides the Deck's own, most recent first. */
  listSessions?(agentId: string): Promise<BackendSession[]>;
  getSelection?(agentId: string): SessionSelection;
  setSelection?(agentId: string, sel: SessionSelection): void;
  /** last activity of the Deck's own conversation (epoch ms, 0 = never) */
  deckUpdated?(agentId: string): number;
  /** Optional speech-to-text fallback (demo mode, no API keys). */
  fallbackTranscript?(agentId: string, pcmBytes: number): string;
}
