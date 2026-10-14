/** Wires config → backend → hub → device server. Used by `start` and by tests. */
import { StateStore, VERSION, macName, type Config } from "./config.js";
import type { AgentBackend } from "./core/backend.js";
import { Hub } from "./core/hub.js";
import { logger } from "./core/log.js";
import { DemoBackend } from "./demo/backend.js";
import { HermesBackend } from "./hermes/backend.js";
import { createPushService } from "./push/apns.js";
import { startDeviceServer, type DeviceServer } from "./server/http.js";
import { createVoice, describeStt, describeTts, type Voice } from "./voice/index.js";
import type { SttProvider } from "./voice/stt.js";
import type { TtsProvider } from "./voice/tts.js";

const log = logger("app");

export interface App {
  hub: Hub;
  server: DeviceServer;
  backend: AgentBackend;
  voice: Voice | null;
  stop(): Promise<void>;
}

export interface AppOverrides {
  backend?: AgentBackend;
  stt?: SttProvider | null;
  tts?: TtsProvider | null;
  /** wait for the local voice servers before resolving (tests/e2e) */
  waitVoice?: boolean;
}

export async function startApp(cfg: Config, ov: AppOverrides = {}): Promise<App> {
  const state = new StateStore(cfg.paths.stateFile);
  const backend: AgentBackend =
    ov.backend ??
    (cfg.demo
      ? new DemoBackend({ intervalMs: cfg.demoIntervalMs })
      : new HermesBackend({
          hermesHome: cfg.hermesHome,
          hermesUrl: cfg.hermesUrl,
          hermesApiKey: cfg.hermesApiKey,
          overrides: cfg.agentOverrides,
          state,
        }));
  const voice = ov.stt !== undefined && ov.tts !== undefined ? null : createVoice(cfg, { owner: !ov.stt && !ov.tts });
  const stt = ov.stt !== undefined ? ov.stt : voice!.stt;
  const tts = ov.tts !== undefined ? ov.tts : voice!.tts;
  const localTts = voice?.ttsChoice.kind === "local";
  const push = createPushService(state, cfg.apns);

  const hub = new Hub({
    backend,
    stt,
    tts,
    push,
    mac: macName(),
    version: VERSION,
    overrides: cfg.agentOverrides,
    doneHoldMs: cfg.doneHoldMs,
    // Local TTS answers in ~0.2 s per sentence: smaller chunks = earlier audio; Kokoro truncates very long input.
    splitter: localTts ? { firstMin: 6, nextMin: 30, maxChunk: 220 } : undefined,
  });
  await hub.start();

  const server = await startDeviceServer({
    hub,
    token: cfg.token,
    port: cfg.port,
    host: cfg.host,
    onPushRegister: (m) => push.register(m),
  });

  const agents = hub.getAgents();
  log.info(
    `${backend.kind} backend · ${agents.length} agenti (${agents.map((a) => `${a.id}${a.key !== null ? `#${a.key}` : ""}`).join(", ")}) · ` +
      `STT ${stt?.name ?? (backend.fallbackTranscript ? "demo" : "off")} · TTS ${tts?.name ?? "off"} · push ${push.enabled ? "on" : "off"}`,
  );
  if (voice) log.info(`voce → testo: ${describeStt(voice.sttChoice)} · testo → voce: ${describeTts(voice.ttsChoice, cfg)}`);
  // Load the local models now (first turn is fast); never blocks the device server.
  const warming = voice ? voice.warm() : Promise.resolve();
  if (ov.waitVoice) await warming;
  log.info(`in ascolto su http://${cfg.host}:${server.port} (ws: /ws, health: /health)`);

  // Re-discover Hermes profiles now and then (new agent created → appears on next connect).
  const refresh = setInterval(() => void hub.refreshAgents(), 60_000).unref();

  return {
    hub,
    server,
    backend,
    voice,
    stop: async () => {
      clearInterval(refresh);
      await hub.stop();
      await server.close();
      push.close();
      await voice?.stop();
    },
  };
}
