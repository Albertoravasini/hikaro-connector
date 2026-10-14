/**
 * HermesRouter — every Hermes profile is an agent; each agent is routed to the API backend
 * (Hermes API server reachable: today the default profile) or to the ACP backend (`hermes -p
 * <profile> acp`: every other profile, e.g. with `gateway.multiplex_profiles` on). The hub only
 * sees one AgentBackend.
 *
 *   override `agents.<id>.backend` in ~/.hikaro/connector.json ("api" | "acp") wins;
 *   otherwise API if the profile has an API endpoint that answers /health, else ACP.
 *   Once an agent is on the API it stays there (a gateway restart must not move its chat);
 *   an agent on ACP moves to the API when that comes up (e.g. connector started before Hermes).
 *
 * Names come from the profile's Discord bot (names.ts). Order: default first, then the other
 * profiles alphabetically (the hub assigns free keys in this order, after explicit `key`s).
 */
import type { AgentOverride, StateStore } from "../config.js";
import type {
  AgentBackend,
  BackendAgent,
  BackendEvent,
  BackendHealth,
  BackendSession,
  SessionSelection,
  TurnResult,
  TurnSink,
} from "../core/backend.js";
import { DeckError, ERROR_VARIANTS } from "../core/errors.js";
import { logger } from "../core/log.js";
import { HermesAcpBackend, type AcpAgentSpec } from "./acp.js";
import { HermesBackend } from "./backend.js";
import { HermesClient } from "./client.js";
import { NameResolver } from "./names.js";
import { listProfiles, type HermesEndpoint } from "./profiles.js";

const log = logger("router");

export type Via = "api" | "acp";

export interface AgentRoute {
  id: string;
  name: string;
  profile: string;
  home: string;
  via: Via;
  /** API url when via = api */
  url?: string;
}

export interface HermesRouterOpts {
  hermesHome: string;
  overrides: Record<string, AgentOverride>;
  state: StateStore;
  api: HermesBackend;
  acp: HermesAcpBackend;
  names: NameResolver;
  /** profiles that always use the API (e.g. default when HERMES_URL is set explicitly) */
  forceApi?: string[];
  /** API reachability probe (tests inject one) */
  apiHealthy?: (ep: HermesEndpoint) => Promise<boolean>;
}

export class HermesRouter implements AgentBackend {
  readonly kind = "hermes";
  private routes = new Map<string, AgentRoute>();
  private readonly sticky = new Map<string, Via>();

  constructor(private readonly o: HermesRouterOpts) {}

  /** Re-read profiles, probe API servers, resolve names. Does not start any process. */
  async discover(): Promise<AgentRoute[]> {
    await this.o.api.listAgents(); // refreshes its endpoints from disk
    const endpoints = new Map(this.o.api.getEndpoints().map((e) => [e.id, e]));
    const profiles = listProfiles(this.o.hermesHome).filter((p) => !this.o.overrides[p.name]?.hidden);
    const healthy = this.o.apiHealthy ?? ((ep: HermesEndpoint) => new HermesClient(ep.url, ep.key).health(2_000));

    const list: { profile: string; home: string; ep?: HermesEndpoint }[] = profiles.map((p) => {
      const ep = endpoints.get(p.name);
      return ep ? { profile: p.name, home: p.home, ep } : { profile: p.name, home: p.home };
    });
    // HERMES_URL without a local Hermes home (remote API): keep the old single-agent behaviour.
    for (const [id, ep] of endpoints) {
      if (!list.some((x) => x.profile === id) && !this.o.overrides[id]?.hidden) list.push({ profile: id, home: ep.home ?? this.o.hermesHome, ep });
    }

    const vias = await Promise.all(
      list.map(async (x): Promise<Via> => {
        const forced = this.o.overrides[x.profile]?.backend;
        if (forced === "acp") return "acp";
        if (x.ep && this.o.forceApi?.includes(x.profile)) return "api";
        if (forced === "api") {
          if (x.ep) return "api";
          log.warn(`${x.profile}: backend "api" richiesto ma il profilo non ha l'API di Hermes; uso ACP`);
          return "acp";
        }
        if (!x.ep) return "acp";
        if (this.sticky.get(x.profile) === "api") return "api";
        return (await healthy(x.ep).catch(() => false)) ? "api" : "acp";
      }),
    );
    const names = await this.o.names.resolveAll(list.map((x) => ({ profile: x.profile, home: x.home })));

    const routes: AgentRoute[] = list.map((x, i) => {
      const via = vias[i]!;
      const r: AgentRoute = { id: x.profile, name: names.get(x.profile) ?? x.profile, profile: x.profile, home: x.home, via };
      if (via === "api" && x.ep) r.url = x.ep.url;
      return r;
    });
    routes.sort((a, b) => (a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id)));
    return routes;
  }

  private apply(routes: AgentRoute[]): void {
    for (const r of routes) {
      const prev = this.routes.get(r.id)?.via;
      if (prev && prev !== r.via) log.info(`${r.id}: ora via ${r.via.toUpperCase()}`);
      if (r.via === "api") this.sticky.set(r.id, "api");
    }
    this.routes = new Map(routes.map((r) => [r.id, r]));
    const specs: AcpAgentSpec[] = routes.filter((r) => r.via === "acp").map((r) => ({ id: r.id, name: r.name, profile: r.profile, home: r.home }));
    this.o.acp.setAgents(specs);
  }

  getRoutes(): AgentRoute[] {
    return [...this.routes.values()];
  }

  async listAgents(): Promise<BackendAgent[]> {
    const routes = await this.discover();
    this.apply(routes);
    return routes.map((r) => ({ id: r.id, name: r.name }));
  }

  async start(_emit: (e: BackendEvent) => void): Promise<void> {
    this.o.acp.start();
  }

  async stop(): Promise<void> {
    await this.o.acp.stop();
  }

  async health(): Promise<BackendHealth> {
    const routes = this.getRoutes();
    const viaApi = routes.some((r) => r.via === "api");
    const [a, b] = await Promise.all([viaApi ? this.o.api.health() : null, this.o.acp.health()]);
    const parts = [a?.detail, b.detail].filter(Boolean).join(" ");
    return { ok: (a?.ok ?? false) || (b.ok && b.agents > 0), agents: routes.length, detail: parts };
  }

  private backend(agentId: string): AgentBackend {
    const r = this.routes.get(agentId);
    if (!r) throw new DeckError("bad_message", ERROR_VARIANTS.unknownAgent, `unknown agent ${agentId}`);
    return r.via === "api" ? this.o.api : this.o.acp;
  }

  async send(agentId: string, text: string, sink: TurnSink, signal?: AbortSignal): Promise<TurnResult> {
    return this.backend(agentId).send(agentId, text, sink, signal);
  }

  async resolve(agentId: string, ref: string, index: number, option: string): Promise<void> {
    return this.backend(agentId).resolve(agentId, ref, index, option);
  }

  async listSessions(agentId: string): Promise<BackendSession[]> {
    return (await this.backend(agentId).listSessions?.(agentId)) ?? [];
  }

  getSelection(agentId: string): SessionSelection {
    return this.backend(agentId).getSelection?.(agentId) ?? "deck";
  }

  setSelection(agentId: string, sel: SessionSelection): void {
    this.backend(agentId).setSelection?.(agentId, sel);
  }

  deckUpdated(agentId: string): number {
    return this.backend(agentId).deckUpdated?.(agentId) ?? 0;
  }
}
