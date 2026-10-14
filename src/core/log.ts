/** Tiny logger: timestamps, levels, never prints secrets (callers must not pass them). */
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min: Level = (process.env.HIKARO_LOG as Level) in order ? (process.env.HIKARO_LOG as Level) : "info";

function out(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < order[min]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const tail = extra === undefined ? "" : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line + tail);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => out("debug", scope, m, e),
    info: (m: string, e?: unknown) => out("info", scope, m, e),
    warn: (m: string, e?: unknown) => out("warn", scope, m, e),
    error: (m: string, e?: unknown) => out("error", scope, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
