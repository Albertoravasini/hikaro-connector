/**
 * `hikaro-connector setup` — non-interactive, idempotent, run by the USER on the Mac:
 *   1. checks Node + Hermes;
 *   2. creates ~/.hikaro (token, connector.env);
 *   3. enables Hermes' API server per profile (backs up every .env it touches,
 *      only adds/updates API_SERVER_* lines, never touches anything else);
 *   4. (re)starts each profile's Hermes gateway so the API comes up — without breaking
 *      Discord/Telegram: a launchd service (ai.hermes.gateway[-profile]) is restarted with
 *      `hermes gateway restart` (drains in-flight runs, then launchctl kickstart -k);
 *      a gateway started by hand is never killed (we print what to do instead);
 *      no gateway at all → installed as a service;
 *   5. installs the local voice (whisper.cpp + Whisper turbo, Kokoro via mlx-audio);
 *   6. installs the launchd agent app.hikaro.connector;
 *   7. prints the pairing QR.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEnvFile, hermesHome, loadConfig, loadConnectorFile, paths, readEnvFile } from "../config.js";
import { acpHandshake, hasModelProvider, hermesAcpCommand } from "../hermes/acp.js";
import { HermesClient } from "../hermes/client.js";
import { applyEnvChanges, planSetup } from "../hermes/envfile.js";
import { isMultiplexOn, listProfiles, readProfileKey } from "../hermes/profiles.js";
import { printPairing } from "../pairing/show.js";
import { installAgent, servicePath } from "./launchd.js";
import { checkVoice, setupLocalVoice } from "./voice.js";
import { bad, info, ok, title, warn } from "./ui.js";

export interface SetupOpts {
  dryRun?: boolean;
  noService?: boolean;
  noHermes?: boolean;
  noGateway?: boolean;
  noVoice?: boolean;
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, PATH: servicePath() + ":" + (process.env.PATH ?? "") } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

export async function findHermes(): Promise<string | null> {
  const forced = process.env.HIKARO_HERMES_BIN;
  if (forced && existsSync(forced)) return forced;
  const local = join(homedir(), ".local", "bin", "hermes");
  if (existsSync(local)) return local;
  const r = await run("/bin/sh", ["-lc", "command -v hermes"], 5_000);
  const p = r.out.trim().split("\n")[0];
  return r.code === 0 && p ? p : null;
}

function hermesLaunchdPlist(profile: string): string {
  const name = profile === "default" ? "ai.hermes.gateway" : `ai.hermes.gateway-${profile}`;
  return join(homedir(), "Library", "LaunchAgents", `${name}.plist`);
}

const profileArgs = (profile: string) => (profile === "default" ? [] : ["-p", profile]);

/** Is a gateway process running for this profile (service or by hand)? */
async function gatewayRunning(hermesBin: string, profile: string): Promise<boolean> {
  const r = await run(hermesBin, [...profileArgs(profile), "gateway", "status"], 30_000);
  if (/not running|non è in esecuzione|stopped/i.test(r.out)) return false;
  return /running|PID/i.test(r.out);
}

/** Absolute path of the compiled CLI entry (dist/index.js). */
export function cliScriptPath(): string {
  return realpathSync(fileURLToPath(new URL("../index.js", import.meta.url)));
}

async function waitHealthy(url: string, key: string | undefined, timeoutMs: number): Promise<boolean> {
  const c = new HermesClient(url, key);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await c.health(1_500)) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

export async function runSetup(o: SetupOpts = {}): Promise<number> {
  const dry = !!o.dryRun;
  title(`Hikaro · configurazione del Mac${dry ? " (prova: non cambio niente)" : ""}`);

  // 1. Node
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    bad(`Node ${process.versions.node} è troppo vecchio: serve Node 20 o più recente (brew install node).`);
    return 1;
  }
  ok(`Node ${process.versions.node}`);

  // 2. ~/.hikaro
  const p = paths();
  if (!dry) {
    loadConnectorFile(p);
    if (ensureEnvFile(p)) info(`Creato ${p.envFile} (qui vanno le chiavi per la voce)`);
  }
  ok(`Cartella ${p.home} pronta`);

  // 3. Hermes
  let hermesOk = true;
  const hermesBin = await findHermes();
  const hHome = hermesHome({ ...readEnvFile(p.envFile), ...process.env });
  if (!hermesBin || !existsSync(hHome)) {
    hermesOk = false;
    bad("Hermes non è installato su questo Mac.");
    info("Installa Hermes Agent (https://hermes-agent.nousresearch.com), poi rilancia: hikaro-connector setup");
    info("Per provare l'app senza Hermes: hikaro-connector start --demo");
  } else {
    ok(`Hermes trovato (${hermesBin})`);
  }

  const touched: string[] = [];
  if (hermesOk && !o.noHermes) {
    const profiles = listProfiles(hHome);
    const multiplex = isMultiplexOn(hHome);
    const plan = planSetup(profiles, multiplex, readProfileKey);
    ok(`${profiles.length} ${profiles.length === 1 ? "profilo" : "profili"} Hermes: ${profiles.map((x) => x.name).join(", ")}`);
    if (multiplex && plan.skipped.length) {
      // Secondary profiles cannot have an API server here: the connector talks to them via ACP.
      const others = plan.skipped.map((x) => x.profile).join(", ");
      if (dry || !hermesBin) {
        info(`Hermes usa un solo gateway per tutti i profili (multiplex): default via API, ${others} via ACP (hermes -p <profilo> acp).`);
      } else {
        const first = plan.skipped[0]!.profile;
        const hs = await acpHandshake(hermesAcpCommand(hermesBin, hHome, first), 90_000);
        if (hs.ok) {
          ok(`Hermes usa un solo gateway per tutti i profili (multiplex): default via API, ${others} via ACP (${first} risponde in ${(hs.ms / 1000).toFixed(1)} s)`);
          if (!hasModelProvider(hs.init)) warn(`${first}: Hermes non ha un modello configurato per questo profilo. Nel Terminale: hermes -p ${first} model`);
        } else {
          warn(`Hermes usa un solo gateway per tutti i profili (multiplex) e ACP non risponde: per ora raggiungo solo il profilo default.`);
          info(`Prova nel Terminale: hermes -p ${first} acp --check   (dettaglio: ${(hs.error ?? "").slice(0, 160)})`);
        }
      }
    } else {
      for (const s of plan.skipped) warn(`${s.profile}: ${s.reason}`);
    }

    for (const pp of plan.profiles) {
      const changed = Object.keys(pp.changes).length > 0;
      if (!changed) {
        ok(`${pp.profile}: API già attiva sulla porta ${pp.port}`);
      } else if (dry) {
        info(`${pp.profile}: ${pp.reason} (porta ${pp.port}) in ${pp.envFile}`);
      } else {
        const backup = applyEnvChanges(pp.envFile, pp.changes);
        touched.push(pp.profile);
        ok(`${pp.profile}: API di Hermes accesa sulla porta ${pp.port}${backup ? ` (copia di sicurezza: ${backup})` : ""}`);
      }

      if (o.noGateway || !hermesBin) continue;
      const plist = hermesLaunchdPlist(pp.profile);
      const installed = existsSync(plist);
      const hermesCmd = (args: string[]) => `hermes ${[...profileArgs(pp.profile), ...args].join(" ")}`;
      if (!installed && (await gatewayRunning(hermesBin, pp.profile))) {
        // Started by hand (terminal/tmux): killing it would drop Discord until the user notices.
        if (changed) {
          warn(`${pp.profile}: il gateway di Hermes è acceso a mano: fermalo (Ctrl+C nel suo Terminale) e riaccendilo con «${hermesCmd(["gateway", "run"])}» per attivare l'API (Discord resta com'è).`);
          continue;
        }
      } else if (installed) {
        if (dry) {
          if (changed) info(`${pp.profile}: riavvierei il servizio del gateway con «${hermesCmd(["gateway", "restart"])}» (Discord torna su da solo)`);
          continue;
        }
        if (changed) {
          info(`${pp.profile}: riavvio il gateway di Hermes (finisce prima i lavori in corso, fino a 3 minuti)…`);
          const r = await run(hermesBin, [...profileArgs(pp.profile), "gateway", "restart"], 240_000);
          if (r.code !== 0) {
            warn(`${pp.profile}: il riavvio non è riuscito. Nel Terminale scrivi «${hermesCmd(["gateway", "restart"])}».`);
            continue;
          }
        }
      } else {
        const args = [...profileArgs(pp.profile), "gateway", "install", "--start-now", "--start-on-login"];
        if (dry) {
          info(`${pp.profile}: eseguirei «hermes ${args.join(" ")}»`);
          continue;
        }
        const r = await run(hermesBin, args, 120_000);
        if (r.code !== 0) {
          warn(`${pp.profile}: «hermes ${args.join(" ")}» non è riuscito. Prova a lanciarlo a mano.`);
          continue;
        }
      }
      const url = `http://127.0.0.1:${pp.port}`;
      const key = readProfileKey(profiles.find((x) => x.name === pp.profile)!);
      if (await waitHealthy(url, key, 45_000)) ok(`${pp.profile}: Hermes risponde su ${url}`);
      else warn(`${pp.profile}: Hermes non risponde ancora su ${url}. Controlla con: hermes ${[...profileArgs(pp.profile), "gateway", "status"].join(" ")}`);
    }
  }

  // 4. Local voice (no API keys needed)
  if (!o.noVoice) {
    title(`Voce sul Mac (senza chiavi)${dry ? " — prova" : ""}`);
    const cfgv = loadConfig();
    const res = await setupLocalVoice(cfgv, { dryRun: dry });
    if (!dry && (res.whisper || res.kokoro)) {
      info("Provo la voce…");
      await checkVoice(cfgv);
    }
  }

  // 5. launchd agent for the connector
  if (!o.noService) {
    if (dry) {
      info(`Installerei il servizio app.hikaro.connector (si riavvia da solo col Mac)`);
    } else {
      try {
        const cfg = loadConfig();
        const file = await installAgent({
          nodePath: process.execPath,
          scriptPath: cliScriptPath(),
          args: ["start"],
          logFile: cfg.paths.logFile,
          workingDir: cfg.paths.home,
          env: { PATH: `${dirname(process.execPath)}:${servicePath()}`, HOME: homedir(), ...(process.env.HIKARO_HOME ? { HIKARO_HOME: process.env.HIKARO_HOME } : {}) },
        });
        ok(`Connettore installato come servizio (${file})`);
      } catch (err) {
        bad(`Non riesco a installare il servizio: ${(err as Error).message}`);
        info("Puoi sempre avviarlo a mano: hikaro-connector start");
      }
    }
  }

  // 5. Pairing QR
  if (!dry) {
    const cfg = loadConfig();
    await printPairing(cfg.port, cfg.token);
    if (touched.length) info(`Profili Hermes modificati: ${touched.join(", ")} — le copie di sicurezza sono accanto ai file .env`);
  }
  return hermesOk ? 0 : 1;
}
