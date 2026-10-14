#!/usr/bin/env node
/**
 * hikaro-connector — CLI entry.
 *   start [--demo] [--hermes-temp] [--port N]   avvia il connettore (predefinito)
 *   setup [--dry-run] [--no-service] [--no-hermes] [--no-gateway]
 *   pair [--rotate]             mostra il QR (con --rotate cambia il token)
 *   status · doctor · restart · uninstall [--purge] · version · help
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "./app.js";
import { startTempHermes, type TempHermes } from "./hermes/temp.js";
import { VERSION, loadConfig, loadConnectorFile, newToken, paths, saveConnectorFile } from "./config.js";
import { logger } from "./core/log.js";
import { printPairing } from "./pairing/show.js";
import { runDoctor, runStatus } from "./service/doctor.js";
import { isLoaded, restartAgent, uninstallAgent } from "./service/launchd.js";
import { findHermes, runSetup } from "./service/setup.js";
import { info, ok, title, warn } from "./service/ui.js";

const log = logger("cli");

const HELP = `hikaro-connector ${VERSION} — collega il Deck Hikaro agli agenti Hermes sul Mac

Uso: hikaro-connector <comando> [opzioni]

  start            avvia il connettore (predefinito)
    --demo         4 agenti finti, niente Hermes né chiavi (per provare l'app)
    --port N       porta (predefinita 8787)
    --hermes-temp  (prova) avvia un gateway Hermes TEMPORANEO con l'API accesa solo
                   per questa sessione, senza toccare la configurazione di Hermes
  setup            configura tutto: Hermes, voce locale, servizio, QR
    --dry-run      mostra cosa farebbe senza cambiare niente
    --no-service   non installare il servizio launchd
    --no-hermes    non toccare la configurazione di Hermes
    --no-gateway   non (ri)avviare i gateway di Hermes
    --no-voice     non installare la voce locale (Whisper + Kokoro)
  pair             mostra il QR per abbinare l'iPhone
    --rotate       crea un nuovo token (i telefoni vanno riabbinati)
  status           il connettore è acceso? Hermes risponde?
  doctor           controllo completo, con cosa fare se qualcosa non va
  restart          riavvia il servizio
  uninstall        rimuove il servizio (--purge cancella anche ~/.hikaro)
  version          versione
`;

interface Args {
  cmd: string;
  flags: Set<string>;
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  let cmd: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") {
      port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice(7));
    } else if (a.startsWith("-")) {
      flags.add(a.replace(/^-+/, ""));
    } else if (!cmd) {
      cmd = a;
    }
  }
  if (flags.has("help") || flags.has("h")) cmd = "help";
  if (flags.has("version") || flags.has("v")) cmd = "version";
  const out: Args = { cmd: cmd ?? "start", flags };
  if (port !== undefined && Number.isInteger(port) && port > 0) out.port = port;
  return out;
}

async function cmdStart(a: Args): Promise<void> {
  const opts: { demo?: boolean; port?: number } = {};
  if (a.flags.has("demo")) opts.demo = true;
  if (a.port) opts.port = a.port;
  const cfg = loadConfig(opts);
  let temp: TempHermes | null = null;
  if (a.flags.has("hermes-temp") && !cfg.demo) {
    const bin = await findHermes();
    if (!bin) {
      console.error("Hermes non è installato su questo Mac.");
      process.exit(1);
    }
    try {
      log.info("avvio un gateway Hermes temporaneo (API solo per questa sessione)…");
      temp = await startTempHermes({ hermesBin: bin, hermesHome: cfg.hermesHome, logFile: join(cfg.paths.home, "hermes-temp.log") });
      cfg.hermesUrl = temp.url;
      cfg.hermesApiKey = temp.key;
    } catch (err) {
      console.error(`Non riesco ad avviare Hermes temporaneo: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  let app;
  try {
    app = await startApp(cfg);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(`La porta ${cfg.port} è già in uso: forse il connettore è già acceso. Controlla con: hikaro-connector status`);
    } else {
      console.error(`Non riesco ad avviare il connettore: ${e.message}`);
    }
    await temp?.stop();
    process.exit(1);
  }
  if (process.stdout.isTTY) {
    if (cfg.demo) console.log("\n  Modalità demo: 4 agenti finti (Outreach, Assistente, Startup, Dev).");
    await printPairing(app.server.port, cfg.token);
  } else {
    log.info("per il QR di abbinamento: hikaro-connector pair");
  }
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: chiudo`);
    const force = setTimeout(() => process.exit(0), temp ? 20_000 : 5_000).unref();
    await app.stop().catch(() => undefined);
    await temp?.stop().catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function cmdPair(a: Args): Promise<number> {
  if (a.flags.has("rotate")) {
    const p = paths();
    const f = loadConnectorFile(p);
    f.token = newToken();
    saveConnectorFile(f, p);
    ok("Nuovo token creato: i telefoni abbinati prima vanno riabbinati.");
    if (await isLoaded()) {
      (await restartAgent()) ? ok("Servizio riavviato") : warn("Riavvia il connettore per usare il nuovo token");
    } else {
      info("Se il connettore è acceso, riavvialo per usare il nuovo token.");
    }
  }
  const cfg = loadConfig(a.port ? { port: a.port } : {});
  await printPairing(cfg.port, cfg.token);
  return 0;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  switch (a.cmd) {
    case "start":
      await cmdStart(a);
      return -1; // keep running
    case "setup":
      return runSetup({
        dryRun: a.flags.has("dry-run"),
        noService: a.flags.has("no-service"),
        noHermes: a.flags.has("no-hermes"),
        noGateway: a.flags.has("no-gateway"),
        noVoice: a.flags.has("no-voice"),
      });
    case "pair":
      return cmdPair(a);
    case "status":
      return runStatus();
    case "doctor":
      return runDoctor();
    case "restart":
      if (await restartAgent()) {
        ok("Connettore riavviato");
        return 0;
      }
      warn("Il servizio non è installato. Esegui: hikaro-connector setup");
      return 1;
    case "uninstall": {
      title("Hikaro · disinstallazione");
      (await uninstallAgent()) ? ok("Servizio rimosso") : info("Il servizio non era installato");
      if (a.flags.has("purge")) {
        rmSync(paths().home, { recursive: true, force: true });
        ok(`Cancellata ${paths().home}`);
      } else {
        info(`Token e impostazioni restano in ${paths().home} (usa --purge per cancellarli)`);
      }
      info("La configurazione di Hermes non è stata toccata: le copie di sicurezza sono accanto ai file .env (*.hikaro-backup-*)");
      return 0;
    }
    case "version":
      console.log(VERSION);
      return 0;
    case "help":
      console.log(HELP);
      return 0;
    default:
      console.error(`Comando sconosciuto: ${a.cmd}\n`);
      console.log(HELP);
      return 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
