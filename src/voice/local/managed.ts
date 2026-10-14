/**
 * A long-lived local helper process (whisper-server, mlx-audio server) that the
 * connector owns: started lazily (or at boot), health-checked over HTTP,
 * restarted with backoff when it crashes, killed when the connector stops.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:net";
import { logger, type Logger } from "../../core/log.js";

export interface ManagedOpts {
  name: string;
  cmd: string;
  args: (port: number) => string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** fixed port; 0/undefined = pick a free one */
  port?: number;
  host?: string;
  /** GET this path → any HTTP answer (< 500) means "up" */
  healthPath?: string;
  /** how long to wait for the first health OK (model load) */
  startTimeoutMs?: number;
  /**
   * Remember the child's pid here: if the connector is SIGKILLed, the next start
   * kills the orphan (same command) instead of leaving a model in RAM forever.
   */
  pidFile?: string;
  /** called once after every (re)start, e.g. a warm-up request */
  onReady?: (baseUrl: string) => Promise<void>;
}

export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, host, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ManagedProcess {
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private stopped = false;
  private failures = 0;
  private port = 0;
  private readonly log: Logger;
  private tail: string[] = [];

  constructor(private readonly o: ManagedOpts) {
    this.log = logger(o.name);
  }

  get baseUrl(): string {
    return `http://${this.o.host ?? "127.0.0.1"}:${this.port}`;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** Last lines of the process output (for error messages). */
  lastOutput(): string {
    return this.tail.join("\n");
  }

  /** Ensure the process is up and healthy; returns its base URL. */
  ensure(): Promise<string> {
    if (this.stopped) return Promise.reject(new Error(`${this.o.name} fermato`));
    if (this.running && !this.starting) return Promise.resolve(this.baseUrl);
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async healthy(timeoutMs = 1_500): Promise<boolean> {
    if (!this.port) return false;
    try {
      const res = await fetch(this.baseUrl + (this.o.healthPath ?? "/"), { signal: AbortSignal.timeout(timeoutMs) });
      await res.arrayBuffer().catch(() => undefined);
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /** Kill a leftover child of a previous (crashed) connector, if the pid still runs our command. */
  private reapOrphan(): void {
    const f = this.o.pidFile;
    if (!f) return;
    try {
      const pid = Number(readFileSync(f, "utf8").trim());
      if (pid > 1 && pid !== process.pid) {
        const cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
        if (cmd.includes(this.o.cmd.split("/").pop()!)) {
          process.kill(pid, "SIGTERM");
          this.log.info(`fermato un processo rimasto da prima (pid ${pid})`);
        }
      }
    } catch {
      /* no file / not running */
    }
    try {
      unlinkSync(f);
    } catch {
      /* none */
    }
  }

  private async launch(): Promise<string> {
    if (this.failures > 0) await sleep(Math.min(30_000, 500 * 2 ** (this.failures - 1)));
    this.reapOrphan();
    this.port = this.o.port || (await freePort(this.o.host));
    const args = this.o.args(this.port);
    this.log.info(`avvio: ${this.o.cmd} ${args.join(" ")}`);
    this.tail = [];
    const child = spawn(this.o.cmd, args, {
      env: { ...process.env, ...this.o.env },
      cwd: this.o.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    if (this.o.pidFile && child.pid) {
      try {
        mkdirSync(dirname(this.o.pidFile), { recursive: true });
        writeFileSync(this.o.pidFile, String(child.pid));
      } catch {
        /* best effort */
      }
    }
    const keep = (b: Buffer) => {
      for (const line of b.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.tail.push(line);
        if (this.tail.length > 30) this.tail.shift();
        this.log.debug(line);
      }
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let exited = false;
    child.on("error", (err) => {
      exited = true;
      this.tail.push(String(err.message));
    });
    child.on("exit", (code, sig) => {
      exited = true;
      if (this.child === child) this.child = null;
      if (!this.stopped) {
        this.failures++;
        this.log.warn(`terminato (code ${code ?? "-"} ${sig ?? ""}); verrà riavviato alla prossima richiesta`);
      }
    });

    const deadline = Date.now() + (this.o.startTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if (exited) {
        this.failures++;
        throw new Error(`${this.o.name} non parte: ${this.tail.slice(-3).join(" | ") || "uscito subito"}`);
      }
      if (await this.healthy(1_000)) {
        try {
          await this.o.onReady?.(this.baseUrl);
        } catch (err) {
          this.log.warn("riscaldamento non riuscito", err);
        }
        this.failures = 0;
        this.log.info(`pronto su ${this.baseUrl}`);
        return this.baseUrl;
      }
      await sleep(250);
    }
    this.failures++;
    this.kill();
    throw new Error(`${this.o.name} non risponde dopo ${Math.round((this.o.startTimeoutMs ?? 60_000) / 1000)} s`);
  }

  /** Forget the current process (used after a request error: next ensure() checks again). */
  async recheck(): Promise<void> {
    if (this.running && !(await this.healthy(2_000))) this.kill();
  }

  private kill(): void {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) {
      c.kill("SIGTERM");
      setTimeout(() => {
        if (c.exitCode === null) c.kill("SIGKILL");
      }, 3_000).unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.o.pidFile) {
      try {
        unlinkSync(this.o.pidFile);
      } catch {
        /* none */
      }
    }
    const c = this.child;
    this.kill();
    if (c && c.exitCode === null) await new Promise<void>((r) => {
      c.once("exit", () => r());
      setTimeout(r, 3_500).unref();
    });
  }
}
