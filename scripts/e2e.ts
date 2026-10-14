/**
 * End-to-end check that behaves like the iPhone app against a RUNNING connector:
 *   hello → prefs → sessions.list → voice.start → real Italian PCM (from `say`) → voice.end
 * and checks transcript ≈ sentence, streamed reply, card, valid audio (ffprobe), timings.
 *
 *   npm run e2e -- --port 8799 [--agent default] [--text "…"] [--approval] [--approval-demo]
 *
 * Token: --token, or HIKARO_HOME/connector.json. Exit code 0 = all checks passed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

type Msg = { type: string; [k: string]: any };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

const port = Number(arg("port") ?? 8787);
const host = arg("host") ?? "127.0.0.1";
const home = process.env.HIKARO_HOME || join(homedir(), ".hikaro");
const token = arg("token") || (JSON.parse(readFileSync(join(home, "connector.json"), "utf8")) as { token: string }).token;
const sentence = arg("text") || "Ciao, che ore sono a Venezia?";
const turnTimeout = Number(arg("timeout") ?? 240_000);
const work = mkdtempSync(join(tmpdir(), "hikaro-e2e-"));

let failures = 0;
const check = (okay: boolean, what: string) => {
  console.log(`  ${okay ? "✓" : "✗"} ${what}`);
  if (!okay) failures++;
};

/** `say` → 16 kHz mono s16le PCM (exactly what the app streams). */
function speechPcm(text: string, voice = "Alice"): Buffer {
  const aiff = join(work, `clip-${Date.now()}.aiff`);
  const raw = join(work, `clip-${Date.now()}.pcm`);
  execFileSync("/usr/bin/say", ["-v", voice, "-o", aiff, text]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-f", "s16le", "-acodec", "pcm_s16le", raw]);
  return readFileSync(raw);
}

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

/** Share of expected words found in the transcript. */
function wordRecall(expected: string, got: string): number {
  const e = norm(expected);
  const g = new Set(norm(got));
  return e.length ? e.filter((w) => g.has(w)).length / e.length : 0;
}

function ffprobe(file: string): { format: string; duration: number } | null {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", file], { encoding: "utf8" });
    const j = JSON.parse(out) as { format?: { format_name?: string; duration?: string } };
    return { format: j.format?.format_name ?? "", duration: Number(j.format?.duration ?? 0) };
  } catch {
    return null;
  }
}

class Client {
  readonly messages: { at: number; m: Msg }[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void; from: number }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data, bin) => {
      if (bin) return;
      const m = JSON.parse(data.toString()) as Msg;
      this.messages.push({ at: Date.now(), m });
      const idx = this.messages.length - 1;
      this.waiters = this.waiters.filter((w) => (idx >= w.from && w.pred(m) ? (w.resolve(m), false) : true));
    });
  }
  static open(url: string): Promise<Client> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const c = new Client(ws);
      ws.once("open", () => res(c));
      ws.once("error", rej);
    });
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  mark() {
    return this.messages.length;
  }
  waitFor(pred: (m: Msg) => boolean, timeoutMs: number, from = 0): Promise<Msg> {
    const found = this.messages.slice(from).find((x) => pred(x.m));
    if (found) return Promise.resolve(found.m);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; ricevuti: ${this.messages.slice(from).map((x) => x.m.type).join(",")}`)), timeoutMs);
      this.waiters.push({ pred, from, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }
  firstAt(pred: (m: Msg) => boolean, from: number): number | null {
    return this.messages.slice(from).find((x) => pred(x.m))?.at ?? null;
  }
}

async function voiceTurn(c: Client, agent: string, text: string, label: string): Promise<{ from: number; release: number; transcript: Msg }> {
  const pcm = speechPcm(text);
  const from = c.mark();
  const id = `e2e_${Date.now()}`;
  c.send({ type: "voice.start", agent, id });
  for (let i = 0; i < pcm.length; i += 3200) c.ws.send(pcm.subarray(i, i + 3200), { binary: true });
  const release = Date.now();
  c.send({ type: "voice.end", agent, id });
  console.log(`\n${label}: «${text}» (${(pcm.length / 32000).toFixed(1)} s di audio)`);
  const transcript = await c.waitFor((m) => (m.type === "transcript" && m.id === id) || m.type === "error", 60_000, from);
  if (transcript.type === "error") throw new Error(`errore dal connettore: ${transcript.message}`);
  return { from, release, transcript };
}

/** Wait until the turn is over: final reply + card + (if audio) final audio. */
async function finishTurn(c: Client, agent: string, from: number, release: number, wantAudio: boolean) {
  const finalReply = await c.waitFor((m) => (m.type === "reply" && m.agent === agent && m.final) || m.type === "error", turnTimeout, from);
  if (finalReply.type === "error") throw new Error(`errore: ${finalReply.message}`);
  const card = await c.waitFor((m) => m.type === "card" && m.card.agent === agent && m.card.kind !== "listening", 10_000, from);
  if (wantAudio) await c.waitFor((m) => (m.type === "audio" && m.agent === agent && m.final) || (m.type === "error" && m.code === "tts_failed"), 60_000, from);
  const t = (pred: (m: Msg) => boolean) => {
    const at = c.firstAt(pred, from);
    return at === null ? "—" : `${at - release} ms`;
  };
  console.log(
    `  tempi dal rilascio del tasto → trascrizione ${t((m) => m.type === "transcript")} · primo pezzo di risposta ${t((m) => m.type === "reply" && !m.final)} · ` +
      `primo audio ${t((m) => m.type === "audio")} · risposta completa ${t((m) => m.type === "reply" && m.final)} · scheda ${t((m) => m.type === "card" && m.card.kind !== "listening")}`,
  );
  console.log(`  risposta: «${String(finalReply.text).slice(0, 200)}»`);
  console.log(`  scheda: ${card.card.kind} «${card.card.title}»${card.card.options ? ` [${card.card.options.join(" | ")}]` : ""}`);
  const audios = c.messages.slice(from).map((x) => x.m).filter((m) => m.type === "audio" && m.agent === agent);
  if (wantAudio) {
    check(audios.length > 0, `${audios.length} messaggi audio`);
    let total = 0;
    audios.forEach((a, i) => {
      const f = join(work, `audio-${from}-${i}.${a.format}`);
      writeFileSync(f, Buffer.from(a.data, "base64"));
      const p = ffprobe(f);
      if (!p || !(p.duration > 0)) check(false, `audio ${i} (${a.format}) non valido`);
      else total += p.duration;
    });
    const formats = [...new Set(audios.map((a) => a.format))].join("+");
    check(audios.length > 0 && audios.every((a) => ["mp3", "m4a", "wav"].includes(a.format)), `audio valido per ffprobe (${formats}, ${total.toFixed(1)} s in tutto, final sull'ultimo: ${audios.at(-1)?.final === true})`);
  }
  return { finalReply, card };
}

async function main() {
  const url = `ws://${host}:${port}/ws`;
  console.log(`Hikaro e2e → ${url}  (file audio in ${work})`);
  const c = await Client.open(url);
  const welcome = await c.waitFor((m) => m.type === "welcome", 5_000);
  c.send({ type: "hello", device: "iphone", version: "e2e", name: "e2e" });
  c.send({ type: "prefs", voice: arg("voice") || "coral", speak: true });
  const agent = arg("agent") || welcome.agents.find((a: { key: number | null }) => a.key === 0)?.id || welcome.agents[0]?.id;
  check(!!agent, `welcome con ${welcome.agents.length} agenti (${welcome.agents.map((a: { id: string }) => a.id).join(", ")}), uso «${agent}»`);

  // Conversations
  let mark = c.mark();
  c.send({ type: "sessions.list", agent });
  const sessions = await c.waitFor((m) => m.type === "sessions" && m.agent === agent, 10_000, mark);
  check(sessions.items[0]?.id === "deck", `sessions: ${sessions.items.length} conversazioni, selezionata «${sessions.selected}» (${sessions.items.slice(0, 4).map((x: { title: string }) => x.title).join(" · ")})`);
  if (arg("select")) {
    mark = c.mark();
    c.send({ type: "session.select", agent, session: arg("select") });
    const s2 = await c.waitFor((m) => (m.type === "sessions" && m.agent === agent) || m.type === "error", 10_000, mark);
    check(s2.type === "sessions" && s2.selected === arg("select"), `session.select → ${s2.selected ?? s2.message}`);
  }

  // Main voice turn
  const turn = await voiceTurn(c, agent, sentence, "Turno vocale");
  const recall = wordRecall(sentence, turn.transcript.text);
  check(recall >= 0.75, `trascrizione «${turn.transcript.text}» (${Math.round(recall * 100)}% delle parole) in ${Date.now() - turn.release} ms dal rilascio`);
  await finishTurn(c, agent, turn.from, turn.release, true);

  // Approval through a real Hermes run
  if (arg("approval") !== undefined) {
    const prompt = arg("approval") || "Usa il terminale per cancellare ricorsivamente la cartella temporanea barra tmp barra hikaro prova.";
    const t2 = await voiceTurn(c, agent, prompt, "Turno con approvazione");
    console.log(`  trascrizione: «${t2.transcript.text}»`);
    const req = await c.waitFor((m) => (m.type === "card" && m.card.agent === agent && m.card.kind === "request") || (m.type === "reply" && m.final) || m.type === "error", turnTimeout, t2.from);
    if (req.type === "card") {
      check(true, `scheda di approvazione «${req.card.title}» ${req.card.quote ? `(${req.card.quote}) ` : ""}[${req.card.options.join(" | ")}] dopo ${Date.now() - t2.release} ms`);
      const m2 = c.mark();
      // --choice N (default: the last option = «No», the safe answer)
      const idx = arg("choice") ? Number(arg("choice")) : req.card.options.length - 1;
      const t3 = Date.now();
      c.send({ type: "choice", card: req.card.id, index: idx, option: req.card.options[idx] });
      const fin = await c.waitFor((m) => (m.type === "reply" && m.final) || m.type === "error", turnTimeout, m2);
      check(fin.type === "reply", `dopo «${req.card.options[idx]}» (${Date.now() - t3} ms): «${String(fin.text ?? fin.message).slice(0, 160)}»`);
    } else {
      check(false, `nessuna approvazione: ${req.type === "error" ? req.message : `l'agente ha risposto «${String(req.text).slice(0, 160)}»`}`);
    }
  }

  // Approval in demo mode (Outreach raises «12 email pronte. Le invio?» every HIKARO_DEMO_INTERVAL_MS)
  if (arg("approval-demo") !== undefined) {
    const from = c.mark();
    const req = await c.waitFor((m) => m.type === "card" && m.card.kind === "request" && m.card.agent === "outreach", 60_000, 0);
    check(true, `richiesta demo «${req.card.title}» [${req.card.options.join(" | ")}]`);
    const t0 = Date.now();
    c.send({ type: "choice", card: req.card.id, index: 0, option: req.card.options[0] });
    const done = await c.waitFor((m) => m.type === "card" && m.card.agent === "outreach" && m.card.kind === "done", 10_000, from);
    const audio = await c.waitFor((m) => m.type === "audio" && m.agent === "outreach" && m.final, 20_000, from);
    check(!!done && !!audio, `scelta → scheda «${done.card.title}» + voce (${audio.format}) in ${Date.now() - t0} ms`);
  }

  c.ws.close();
  console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli passati.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
