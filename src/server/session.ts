import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { SAMPLE_RATE, encode, parseDeviceMessage, type ConnectorMessage, type PushRegisterMsg } from "../protocol.js";
import { ERROR_MESSAGES } from "../core/errors.js";
import type { DeviceLink, DevicePrefs, Hub } from "../core/hub.js";
import { isKnownVoice } from "../voice/tts.js";
import { logger } from "../core/log.js";

const log = logger("device");

/** 60 s of PCM16 mono 16 kHz. Longer recordings are truncated. */
export const MAX_RECORDING_BYTES = SAMPLE_RATE * 2 * 300; // 5 min, the app's longest key-hold recording

interface Recording {
  agent: string;
  id: string;
  chunks: Buffer[];
  bytes: number;
}

/** One connected device (one WebSocket). */
export class DeviceSession implements DeviceLink {
  readonly id = `d_${randomBytes(3).toString("hex")}`;
  device = "unknown";
  name: string | undefined;
  prefs: DevicePrefs = {};
  private rec: Recording | null = null;
  private detach: (() => void) | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly hub: Hub,
    private readonly onPushRegister?: (m: PushRegisterMsg) => void,
  ) {}

  open(): void {
    this.detach = this.hub.attach(this);
    this.ws.on("message", (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) this.onAudio(buf);
      else void this.onText(buf.toString("utf8"));
    });
    this.ws.on("close", () => {
      this.detach?.();
      this.rec = null;
      log.info(`${this.id} disconnected`);
    });
    this.ws.on("error", (err) => log.debug(`${this.id} socket error`, err));
  }

  send(msg: ConnectorMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encode(msg));
  }

  private onAudio(buf: Buffer): void {
    const r = this.rec;
    if (!r) return; // audio outside voice.start/voice.end → ignore
    const room = MAX_RECORDING_BYTES - r.bytes;
    if (room <= 0) return;
    const chunk = buf.length > room ? buf.subarray(0, room) : buf;
    r.chunks.push(chunk);
    r.bytes += chunk.length;
  }

  private async onText(raw: string): Promise<void> {
    const parsed = parseDeviceMessage(raw);
    if (!parsed.ok) {
      if (parsed.ignored) return log.debug(`${this.id} ignored unknown type ${parsed.type}`);
      log.warn(`${this.id} bad message: ${parsed.reason}`);
      return this.send({ type: "error", code: "bad_message", message: ERROR_MESSAGES.bad_message });
    }
    const m = parsed.message;
    switch (m.type) {
      case "ping":
        return this.send({ type: "pong" });
      case "hello":
        this.device = m.device;
        this.name = m.name;
        log.info(`${this.id} hello from ${m.device}${m.name ? ` "${m.name}"` : ""} v${m.version}`);
        return;
      case "voice.start":
        this.rec = { agent: m.agent, id: m.id, chunks: [], bytes: 0 };
        this.hub.listening(m.agent, m.id);
        return;
      case "voice.cancel":
        if (this.rec?.id === m.id) this.rec = null;
        return;
      case "voice.end": {
        const r = this.rec;
        this.rec = null;
        if (!r || r.id !== m.id) return log.debug(`${this.id} voice.end without matching voice.start (${m.id})`);
        return this.hub.utterance(this, r.agent, r.id, Buffer.concat(r.chunks, r.bytes));
      }
      case "choice":
        return this.hub.choice(this, m.card, m.index, m.option);
      case "key.tap":
        return this.hub.keyTap(this, m.agent);
      case "prefs":
        if (m.voice !== undefined) {
          if (isKnownVoice(m.voice)) this.prefs.voice = m.voice;
          else log.warn(`${this.id} ignored unknown voice "${m.voice}"`);
        }
        if (m.speak !== undefined) this.prefs.speak = m.speak;
        log.info(`${this.id} prefs: voice=${this.prefs.voice ?? "default"} speak=${this.prefs.speak ?? true}`);
        return;
      case "sessions.list":
        return this.hub.sessions(this, m.agent);
      case "session.select":
        return this.hub.selectSession(this, m.agent, m.session);
      case "push.register":
        this.onPushRegister?.(m);
        return;
    }
  }
}
