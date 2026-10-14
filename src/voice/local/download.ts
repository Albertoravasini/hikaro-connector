/** Resumable model download (HTTP Range on a .part file) with progress in Italian. */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export interface DownloadOpts {
  url: string;
  dest: string;
  /** shown in the progress line ("Whisper large-v3-turbo") */
  label: string;
  /** progress sink (default: stdout, \r on a TTY) */
  onProgress?: (line: string, done: boolean) => void;
  /** test hook */
  fetchImpl?: typeof fetch;
}

export const mb = (n: number) => `${Math.round(n / 1_048_576)} MB`;

function defaultProgress(line: string, done: boolean): void {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K    ${line}${done ? "\n" : ""}`);
  else if (done) console.log(`    ${line}`);
}

/** Returns "present" if already complete, "downloaded" otherwise. Throws on failure (the .part stays for the next try). */
export async function downloadResumable(o: DownloadOpts): Promise<"present" | "downloaded"> {
  if (existsSync(o.dest) && statSync(o.dest).size > 0) return "present";
  mkdirSync(dirname(o.dest), { recursive: true });
  const part = `${o.dest}.part`;
  const progress = o.onProgress ?? defaultProgress;
  const f = o.fetchImpl ?? fetch;

  for (let attempt = 0; attempt < 4; attempt++) {
    const have = existsSync(part) ? statSync(part).size : 0;
    let res: Response;
    try {
      res = await f(o.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow" });
    } catch (err) {
      if (attempt === 3) throw new Error(`rete: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      continue;
    }
    if (res.status === 416 && have > 0) {
      // Range not satisfiable: the .part is already complete.
      renameSync(part, o.dest);
      progress(`${o.label}: ${mb(have)} ✓`, true);
      return "downloaded";
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} scaricando ${o.url}`);
    const resumed = res.status === 206;
    if (!resumed && have > 0) unlinkSync(part); // server ignored Range → start over
    const start = resumed ? have : 0;
    const len = Number(res.headers.get("content-length") ?? 0);
    const total = len ? start + len : 0;
    let got = start;
    let last = 0;
    const t0 = Date.now();
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        got += chunk.length;
        const now = Date.now();
        if (now - last > 500) {
          last = now;
          const rate = (got - start) / Math.max(0.001, (now - t0) / 1000);
          const pct = total ? ` (${Math.floor((got / total) * 100)}%)` : "";
          progress(`${o.label}: ${mb(got)}${total ? ` di ${mb(total)}` : ""}${pct} · ${mb(rate)}/s`, false);
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(part, { flags: resumed ? "a" : "w" }));
    } catch (err) {
      progress(`${o.label}: interrotto a ${mb(got)}, riprendo…`, true);
      if (attempt === 3) throw err;
      continue;
    }
    const size = statSync(part).size;
    if (total && size < total) {
      progress(`${o.label}: incompleto (${mb(size)} di ${mb(total)}), riprendo…`, true);
      continue;
    }
    renameSync(part, o.dest);
    progress(`${o.label}: ${mb(size)} ✓`, true);
    return "downloaded";
  }
  throw new Error(`download di ${o.label} non completato (riprova: riparte da dove si era fermato)`);
}
