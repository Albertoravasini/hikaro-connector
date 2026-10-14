import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { Config } from "../src/config.js";
import { paths } from "../src/config.js";

/** Isolated ~/.hikaro for a test (never touches the real one). */
export function tmpHome(prefix = "hikaro-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HIKARO_HOME = dir;
  return dir;
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    paths: paths(),
    port: 0,
    host: "127.0.0.1",
    token: "test-token-1234567890",
    agentOverrides: {},
    demo: true,
    hermesHome: join(tmpdir(), "nonexistent-hermes"),
    hermesUrl: undefined,
    hermesApiKey: undefined,
    groqApiKey: undefined,
    openaiApiKey: undefined,
    sttLanguage: "it",
    sttMode: "off",
    sttEngine: "auto",
    sttUrl: undefined,
    sttModel: undefined,
    sttApiKey: undefined,
    whisperModel: "ggml-large-v3-turbo-q8_0.bin",
    sttVad: true,
    whisperPort: 0,
    voicePort: 0,
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "coral",
    ttsEnabled: false,
    ttsMode: "off",
    localVoice: "if_sara",
    sayVoice: undefined,
    doneHoldMs: 200,
    demoIntervalMs: 0,
    apns: undefined,
    ...over,
  };
}

export type Msg = { type: string; [k: string]: any };

/** WebSocket test client that records every JSON message. */
export class TestClient {
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void; from: number }[] = [];
  closeCode: number | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString()) as Msg;
      this.messages.push(m);
      const idx = this.messages.length - 1;
      this.waiters = this.waiters.filter((w) => {
        if (idx >= w.from && w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    ws.on("close", (code) => (this.closeCode = code));
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const c = new TestClient(ws);
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  sendBinary(b: Buffer): void {
    this.ws.send(b, { binary: true });
  }

  /** Wait for a message matching pred (also searches already-received ones from index `from`). */
  waitFor(pred: (m: Msg) => boolean, timeoutMs = 3_000, from = 0): Promise<Msg> {
    const found = this.messages.slice(from).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for message; got ${JSON.stringify(this.messages.slice(from).map((m) => m.type))}`)), timeoutMs);
      this.waiters.push({ pred, from, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  mark(): number {
    return this.messages.length;
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
