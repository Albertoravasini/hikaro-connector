/**
 * `start --hermes-temp` (dev/test): run a TEMPORARY Hermes gateway for the default
 * profile with the API server switched on ONLY through the process environment.
 *
 * Verified in hermes-agent v0.18.2:
 *  - gateway/config.py `_apply_env_overrides`: API_SERVER_ENABLED / API_SERVER_KEY /
 *    API_SERVER_PORT / API_SERVER_HOST read with os.environ → enable the api_server
 *    platform without touching config.yaml.
 *  - hermes_cli/env_loader.py loads ~/.hermes/.env with override=True: a value there
 *    beats ours. So we refuse if that .env already sets API_SERVER_* (it would not be temporary).
 *  - `hermes gateway run` = foreground gateway (refuses if a launchd service already
 *    supervises the profile, unless --force; we never pass --force/--replace).
 *  - Messaging adapters start when their tokens/config are present: we refuse if
 *    ~/.hermes/.env or config.yaml configure any (a second Discord/Telegram bot
 *    instance would answer users twice).
 * Nothing under ~/.hermes is written by us (Hermes itself still writes its own runtime
 * state: logs, gateway pid/lock, state.db rows for the sessions you create).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readEnvFile } from "../config.js";
import { logger } from "../core/log.js";
import { freePort } from "../voice/local/managed.js";
import { HermesClient } from "./client.js";

const log = logger("hermes-temp");

/** Env-var prefixes that switch on a messaging platform in gateway/config.py + plugins/platforms. */
const PLATFORM_PREFIXES = [
  "TELEGRAM_", "DISCORD_", "SLACK_", "MATTERMOST_", "MATRIX_", "WEIXIN_", "WHATSAPP_", "SIGNAL_", "EMAIL_",
  "TWILIO_", "SMS_", "HASS_", "HOMEASSISTANT_", "DINGTALK_", "FEISHU_", "WECOM_", "BLUEBUBBLES_", "QQ_", "QQBOT_",
  "YUANBAO_", "MSGRAPH_", "WEBHOOK_ENABLED", "GOOGLE_CHAT_", "IRC_", "LINE_", "NTFY_", "PHOTON_", "RAFT_",
  "SIMPLEX_", "TEAMS_",
];
/** keys that look like a platform prefix but do not start one */
const HARMLESS = /_(HOME_CHANNEL|HOME_CHANNEL_NAME|ALLOWED_USERS|REQUIRE_MENTION|FREE_RESPONSE_CHANNELS)$/;

export interface PlatformCheck {
  /** env keys (names only) that would start a messaging adapter */
  envKeys: string[];
  /** config.yaml has a `platforms:` section with something enabled */
  configPlatforms: boolean;
  /** API_SERVER_* already set in the profile .env (would override ours) */
  apiInEnvFile: string[];
}

function pluginPrefixes(hermesHome: string): string[] {
  for (const root of [hermesHome, join(homedir(), ".hermes")]) {
    try {
      return readdirSync(join(root, "hermes-agent", "plugins", "platforms")).map((d) => `${d.toUpperCase()}_`);
    } catch {
      /* try next */
    }
  }
  return [];
}

/** Read KEY NAMES only (never values) from the profile .env + process env, and sniff config.yaml. */
export function checkPlatforms(hermesHome: string, procEnv: NodeJS.ProcessEnv = process.env): PlatformCheck {
  const fileEnv = readEnvFile(join(hermesHome, ".env"));
  const prefixes = [...new Set([...PLATFORM_PREFIXES, ...pluginPrefixes(hermesHome)])];
  const hits = new Set<string>();
  const scan = (k: string, v: string | undefined) => {
    if (!v || !v.trim() || HARMLESS.test(k)) return;
    if (prefixes.some((p) => (p.endsWith("_") ? k.startsWith(p) : k === p))) hits.add(k);
  };
  for (const [k, v] of Object.entries(fileEnv)) scan(k, v);
  for (const [k, v] of Object.entries(procEnv)) scan(k, v);
  let configPlatforms = false;
  try {
    const yaml = readFileSync(join(hermesHome, "config.yaml"), "utf8");
    const m = /^platforms:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml);
    configPlatforms = !!m && /enabled:\s*(true|yes|on)/i.test(m[1] ?? "");
  } catch {
    /* no config */
  }
  const apiInEnvFile = Object.keys(fileEnv).filter((k) => /^API_SERVER_(ENABLED|KEY|PORT|HOST)$/.test(k) && fileEnv[k]);
  return { envKeys: [...hits].sort(), configPlatforms, apiInEnvFile };
}

export interface TempHermes {
  url: string;
  key: string;
  pid: number | undefined;
  logFile: string;
  stop(): Promise<void>;
}

export interface TempHermesOpts {
  hermesBin: string;
  hermesHome: string;
  logFile: string;
  port?: number;
  startTimeoutMs?: number;
}

async function pickPort(preferred: number): Promise<number> {
  const probe = await new HermesClient(`http://127.0.0.1:${preferred}`, undefined).health(500);
  if (!probe) {
    try {
      const { createServer } = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const s = createServer();
        s.once("error", reject);
        s.listen(preferred, "127.0.0.1", () => s.close(() => resolve()));
      });
      return preferred;
    } catch {
      /* taken */
    }
  }
  return freePort();
}

export async function startTempHermes(o: TempHermesOpts): Promise<TempHermes> {
  if (!existsSync(o.hermesHome)) throw new Error(`Cartella Hermes non trovata: ${o.hermesHome}`);
  const chk = checkPlatforms(o.hermesHome);
  if (chk.envKeys.length || chk.configPlatforms) {
    throw new Error(
      `Questo Hermes ha piattaforme di messaggi configurate (${[...chk.envKeys, ...(chk.configPlatforms ? ["config.yaml: platforms"] : [])].join(", ")}): ` +
        "un gateway temporaneo risponderebbe due volte. --hermes-temp è solo per un Mac di prova.",
    );
  }
  if (chk.apiInEnvFile.length) {
    throw new Error(`${join(o.hermesHome, ".env")} imposta già ${chk.apiInEnvFile.join(", ")}: usa «hikaro-connector start» normale.`);
  }

  const key = `hk_tmp_${randomBytes(24).toString("hex")}`;
  const port = o.port || (await pickPort(8652));
  const url = `http://127.0.0.1:${port}`;
  const out = createWriteStream(o.logFile, { flags: "a", mode: 0o600 });
  out.write(`\n--- hermes gateway run (temporaneo) ${new Date().toISOString()} porta ${port}\n`);

  // Belt and braces: never hand messaging tokens down through our own env.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!PLATFORM_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  Object.assign(env, {
    API_SERVER_ENABLED: "true",
    API_SERVER_KEY: key,
    API_SERVER_PORT: String(port),
    API_SERVER_HOST: "127.0.0.1",
  });
  // A non-default home (HIKARO_HERMES_HOME, e.g. a scratch copy for tests) must reach Hermes too.
  if (resolve(o.hermesHome) !== resolve(join(homedir(), ".hermes"))) env.HERMES_HOME = o.hermesHome;

  const child: ChildProcess = spawn(o.hermesBin, ["gateway", "run"], {
    env,
    cwd: o.hermesHome,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group → we can stop the gateway and everything it spawned
  });
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  let exitInfo: string | null = null;
  child.on("exit", (code, sig) => {
    exitInfo = `code ${code ?? "-"} ${sig ?? ""}`.trim();
    log.warn(`gateway temporaneo terminato (${exitInfo})`);
  });

  const killGroup = (sig: NodeJS.Signals) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    }
  };
  // Even on a crash of the connector, do not leave a gateway behind.
  const onExit = () => killGroup("SIGTERM");
  process.on("exit", onExit);

  const stop = async () => {
    process.off("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup("SIGINT");
    const done = new Promise<void>((r) => child.once("exit", () => r()));
    const t1 = setTimeout(() => killGroup("SIGTERM"), 8_000);
    const t2 = setTimeout(() => killGroup("SIGKILL"), 15_000);
    await Promise.race([done, new Promise((r) => setTimeout(r, 16_000))]);
    clearTimeout(t1);
    clearTimeout(t2);
    out.end();
  };

  const client = new HermesClient(url, key);
  const deadline = Date.now() + (o.startTimeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (exitInfo) {
      const tail = readFileSync(o.logFile, "utf8").split("\n").slice(-8).join("\n");
      throw new Error(`Il gateway temporaneo di Hermes si è chiuso (${exitInfo}). Ultime righe:\n${tail}`);
    }
    if ((await client.health(1_000)) && (await client.checkAuth(2_000))) {
      log.info(`Hermes temporaneo pronto su ${url} (pid ${child.pid}, log ${o.logFile})`);
      return { url, key, pid: child.pid, logFile: o.logFile, stop };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`Il gateway temporaneo di Hermes non risponde su ${url} (log: ${o.logFile})`);
}
