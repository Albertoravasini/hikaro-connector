/**
 * APNs (token-based, .p8) — optional. Off unless APNS_KEY_PATH, APNS_KEY_ID and
 * APNS_TEAM_ID are configured. Uses node:http2 + an ES256 JWT signed with node:crypto.
 *
 *  - Alert notifications (topic = bundle id, push-type "alert") for request cards,
 *    category "HIKARO_REQUEST" so the app can attach approve/deny actions.
 *  - Live Activity updates (topic = "<bundle>.push-type.liveactivity",
 *    push-type "liveactivity"), content-state = { agent, agentName, state, card }.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { ApnsConfig, PushToken, StateStore } from "../config.js";
import type { PushNotifier } from "../core/hub.js";
import { logger } from "../core/log.js";
import type { Agent, AgentState, Card, PushRegisterMsg } from "../protocol.js";

const log = logger("apns");

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** ES256 JWT for APNs provider authentication. */
export function createApnsJwt(key: KeyObject, keyId: string, teamId: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: nowSec }));
  const input = `${header}.${claims}`;
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

export interface ApnsSendOpts {
  token: string;
  env: "sandbox" | "production";
  topic: string;
  pushType: "alert" | "liveactivity" | "background";
  payload: unknown;
  priority?: 5 | 10;
  expirationSec?: number;
}

export interface ApnsResult {
  status: number;
  reason?: string;
}

export class ApnsClient {
  private readonly key: KeyObject;
  private jwt: { value: string; at: number } | null = null;
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly cfg: ApnsConfig) {
    this.key = createPrivateKey(readFileSync(cfg.keyPath));
  }

  get bundleId(): string {
    return this.cfg.bundleId;
  }

  private token(): string {
    const now = Math.floor(Date.now() / 1000);
    // Apple: refresh no more than once every 20 min, no less than once an hour.
    if (!this.jwt || now - this.jwt.at > 50 * 60) {
      this.jwt = { value: createApnsJwt(this.key, this.cfg.keyId, this.cfg.teamId, now), at: now };
    }
    return this.jwt.value;
  }

  private session(env: "sandbox" | "production"): ClientHttp2Session {
    const origin = env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(origin);
    s.on("error", (err) => log.debug(`http2 ${origin} error`, err));
    s.on("close", () => this.sessions.delete(origin));
    s.unref();
    this.sessions.set(origin, s);
    return s;
  }

  send(o: ApnsSendOpts): Promise<ApnsResult> {
    return new Promise((resolve) => {
      const headers: Record<string, string | number> = {
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${o.token}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": o.topic,
        "apns-push-type": o.pushType,
        "apns-priority": o.priority ?? 10,
        "apns-expiration": o.expirationSec ?? 0,
        "content-type": "application/json",
      };
      let req;
      try {
        req = this.session(o.env).request(headers);
      } catch (err) {
        return resolve({ status: 0, reason: (err as Error).message });
      }
      let status = 0;
      let body = "";
      req.setEncoding("utf8");
      req.setTimeout(10_000, () => req.close());
      req.on("response", (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS]) || 0));
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
        } catch {
          /* ignore */
        }
        resolve(reason ? { status, reason } : { status });
      });
      req.on("error", (err) => resolve({ status: 0, reason: err.message }));
      req.end(JSON.stringify(o.payload));
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

/** Remembers device tokens (state.json) and pushes request cards / Live Activity updates. */
export class PushService implements PushNotifier {
  constructor(
    private readonly state: StateStore,
    private readonly apns: ApnsClient | null,
  ) {}

  get enabled(): boolean {
    return !!this.apns;
  }

  register(m: PushRegisterMsg): void {
    this.state.update((s) => {
      s.push = s.push.filter((t) => !(t.token === m.token && t.kind === m.kind));
      // Keep only the newest Live Activity token per env (old activities end).
      if (m.kind === "liveactivity") s.push = s.push.filter((t) => !(t.kind === "liveactivity" && t.env === m.env));
      s.push.push({ token: m.token, kind: m.kind, env: m.env, ts: Date.now() });
      s.push = s.push.slice(-20);
    });
    log.info(`registered ${m.kind} push token (${m.env})${this.apns ? "" : " — APNs not configured, stored only"}`);
  }

  private drop(t: PushToken): void {
    this.state.update((s) => {
      s.push = s.push.filter((x) => x.token !== t.token);
    });
  }

  onCard(agent: Agent, card: Card, state: AgentState): void {
    const apns = this.apns;
    if (!apns) return;
    const tokens = this.state.get().push;
    const jobs: Promise<void>[] = [];
    for (const t of tokens) {
      if (t.kind === "device" && card.kind === "request") {
        jobs.push(
          this.deliver(apns, t, {
            topic: apns.bundleId,
            pushType: "alert",
            payload: {
              aps: {
                alert: { title: agent.name, body: card.title },
                sound: "default",
                category: "HIKARO_REQUEST",
                "thread-id": agent.id,
                "interruption-level": "time-sensitive",
              },
              card,
            },
          }),
        );
      } else if (t.kind === "liveactivity" && card.kind !== "listening") {
        const aps: Record<string, unknown> = {
          timestamp: Math.floor(Date.now() / 1000),
          event: "update",
          "content-state": { agent: agent.id, agentName: agent.name, state, card },
        };
        if (card.kind === "request") aps.alert = { title: agent.name, body: card.title };
        jobs.push(
          this.deliver(apns, t, {
            topic: `${apns.bundleId}.push-type.liveactivity`,
            pushType: "liveactivity",
            payload: { aps },
            priority: card.kind === "request" ? 10 : 5,
          }),
        );
      }
    }
    void Promise.all(jobs);
  }

  private async deliver(apns: ApnsClient, t: PushToken, o: Omit<ApnsSendOpts, "token" | "env">): Promise<void> {
    const r = await apns.send({ ...o, token: t.token, env: t.env });
    if (r.status === 200) return;
    log.warn(`APNs ${o.pushType} → ${r.status} ${r.reason ?? ""}`);
    if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") this.drop(t);
  }

  close(): void {
    this.apns?.close();
  }
}

export function createPushService(state: StateStore, cfg: ApnsConfig | undefined): PushService {
  if (!cfg) return new PushService(state, null);
  try {
    return new PushService(state, new ApnsClient(cfg));
  } catch (err) {
    log.warn(`APNs disabled: cannot read key ${cfg.keyPath}`, err);
    return new PushService(state, null);
  }
}
