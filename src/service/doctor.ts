/** `hikaro-connector doctor` and `status` — read-only checks, plain Italian. */
import { existsSync, statSync } from "node:fs";
import { request } from "node:http";
import { LAUNCHD_LABEL, VERSION, loadConfig, macName, type Config } from "../config.js";
import { HermesClient } from "../hermes/client.js";
import { isMultiplexOn, listProfiles, resolveEndpoints } from "../hermes/profiles.js";
import { lanIPv4, tailscaleHost } from "../pairing/network.js";
import type { HealthResponse } from "../protocol.js";
import { isLoaded, plistPath } from "./launchd.js";
import { findHermes } from "./setup.js";
import { bad, info, ok, title, warn } from "./ui.js";
import { checkVoice } from "./voice.js";

/** GET /health on the local connector. */
export function localHealth(cfg: Config, timeoutMs = 2_000): Promise<HealthResponse | null> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: cfg.port, path: "/health", headers: { Authorization: `Bearer ${cfg.token}` }, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? (JSON.parse(body) as HealthResponse) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

export async function runStatus(): Promise<number> {
  const cfg = loadConfig();
  title("Hikaro · stato");
  const h = await localHealth(cfg);
  if (h) {
    ok(`Connettore acceso su ${macName()}:${cfg.port} (v${h.version})`);
    (h.hermes ? ok : bad)(h.hermes ? "Hermes risponde" : "Hermes non risponde");
    (h.agents > 0 ? ok : bad)(`${h.agents} agenti trovati`);
  } else {
    bad(`Il connettore non risponde sulla porta ${cfg.port}`);
    info("Avvialo con: hikaro-connector start   (oppure hikaro-connector setup)");
  }
  (await isLoaded()) ? ok(`Servizio ${LAUNCHD_LABEL} attivo`) : warn(`Servizio ${LAUNCHD_LABEL} non installato`);
  return h ? 0 : 1;
}

export async function runDoctor(): Promise<number> {
  const cfg = loadConfig();
  let problems = 0;
  const fail = (s: string, hint?: string) => {
    problems++;
    bad(s);
    if (hint) info(hint);
  };
  title(`Hikaro · controllo (connettore v${VERSION})`);

  const major = Number(process.versions.node.split(".")[0]);
  major >= 20 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node}: serve 20 o più`, "brew install node");

  const mode = existsSync(cfg.paths.configFile) ? statSync(cfg.paths.configFile).mode & 0o777 : 0;
  mode === 0o600
    ? ok(`Token di abbinamento in ${cfg.paths.configFile}`)
    : fail(`Permessi di ${cfg.paths.configFile} troppo aperti (${mode.toString(8)})`, `chmod 600 ${cfg.paths.configFile}`);

  const hermesBin = await findHermes();
  hermesBin ? ok(`Hermes installato (${hermesBin})`) : fail("Hermes non trovato", "Installa Hermes Agent, poi: hikaro-connector setup");

  if (existsSync(cfg.hermesHome)) {
    const profiles = listProfiles(cfg.hermesHome);
    ok(`Profili Hermes: ${profiles.map((p) => `${p.name}${p.api.enabled ? `(API:${p.api.port ?? 8642})` : "(API spenta)"}`).join(", ")}`);
    if (isMultiplexOn(cfg.hermesHome)) warn("multiplex_profiles attivo: raggiungibile solo il profilo default");
    const eps = resolveEndpoints({
      hermesHome: cfg.hermesHome,
      hermesUrl: cfg.hermesUrl,
      hermesApiKey: cfg.hermesApiKey,
      overrides: cfg.agentOverrides,
    });
    if (!eps.length) fail("Nessun agente raggiungibile", "Esegui: hikaro-connector setup");
    for (const e of eps) {
      const c = new HermesClient(e.url, e.key);
      if (!(await c.health())) {
        fail(`Agente ${e.name} (profilo ${e.profile}): Hermes non risponde su ${e.url}`, `Avvia il gateway: hermes ${e.profile === "default" ? "" : `-p ${e.profile} `}gateway start`);
      } else if (!e.key) {
        fail(`${e.name}: manca API_SERVER_KEY`, "Esegui: hikaro-connector setup");
      } else if (!(await c.checkAuth())) {
        fail(`${e.name}: Hermes rifiuta la chiave`, "Esegui: hikaro-connector setup");
      } else {
        ok(`Agente ${e.name} (profilo ${e.profile}): Hermes risponde su ${e.url}`);
      }
    }
  } else {
    fail(`Cartella Hermes non trovata (${cfg.hermesHome})`);
  }

  const v = await checkVoice(cfg);
  if (v.problems) fail("La voce non è a posto", "Esegui: hikaro-connector setup (scarica i modelli, riprende da dove si era fermato)");
  cfg.apns ? ok("Notifiche push configurate") : info("Notifiche push non configurate (facoltative)");

  const h = await localHealth(cfg);
  h ? ok(`Connettore acceso sulla porta ${cfg.port}`) : fail(`Connettore spento sulla porta ${cfg.port}`, "hikaro-connector start");
  (await isLoaded()) ? ok("Servizio launchd attivo") : warn(`Servizio launchd non installato (${plistPath()})`);

  const lan = lanIPv4();
  lan ? ok(`Rete di casa: ${lan}`) : fail("Nessuna rete Wi-Fi/Ethernet", "Collega il Mac alla stessa Wi-Fi dell'iPhone");
  const ts = await tailscaleHost();
  ts ? ok(`Tailscale: ${ts}`) : info("Tailscale non attivo (serve solo fuori casa)");

  console.log("");
  problems ? bad(`${problems} ${problems === 1 ? "cosa da sistemare" : "cose da sistemare"}`) : ok("Tutto a posto.");
  return problems ? 1 : 0;
}
