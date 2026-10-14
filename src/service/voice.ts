/**
 * Local voice install (idempotent, part of `setup`) and the latency check used by
 * `setup` and `doctor`. Everything goes to ~/.hikaro (models, venv); the only
 * system-wide thing is Homebrew's `whisper-cpp`, installed only if brew exists.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { createVoice, describeStt, describeTts } from "../voice/index.js";
import { downloadResumable } from "../voice/local/download.js";
import {
  KOKORO_FILES,
  KOKORO_MODEL,
  VAD_MODEL,
  VAD_REPO,
  VENV_OK_MARKER,
  VOICE_PIP_PACKAGES,
  WHISPER_REPO,
  findBin,
  hfCached,
  kokoroVoicePath,
  venvPython,
  voiceLayout,
  whisperServerBin,
  type VoiceLayout,
} from "../voice/local/layout.js";
import { listSayVoices, pickItalianVoice } from "../voice/local/say.js";
import { bad, info, ok, warn } from "./ui.js";

function run(cmd: string, args: string[], o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: o.timeoutMs ?? 60_000, env: { ...process.env, ...o.env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

/** Run with live output (pip, brew, HF download progress) indented under our lines. */
function runLive(cmd: string, args: string[], env?: NodeJS.ProcessEnv, filter?: (line: string) => boolean): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const show = (b: Buffer) => {
      for (const line of b.toString("utf8").split(/\r?\n|\r/)) {
        const l = line.trimEnd();
        if (l && (!filter || filter(l))) console.log(`      ${l.slice(0, 160)}`);
      }
    };
    p.stdout.on("data", show);
    p.stderr.on("data", show);
    p.on("error", () => resolve(127));
    p.on("close", (code) => resolve(code ?? 1));
  });
}

/** Python ≥ 3.10 on arm64 for the mlx venv: Homebrew, then the one Hermes' installer brought (uv). */
export async function findPython(): Promise<string | null> {
  const home = homedir();
  const candidates = [
    ...["3.13", "3.12", "3.11", "3.10"].flatMap((v) => [`/opt/homebrew/bin/python${v}`, join(home, ".local", "bin", `python${v}`)]),
    "/opt/homebrew/bin/python3",
    join(home, ".hermes", "hermes-agent", "venv", "bin", "python"),
    findBin("python3") ?? "",
  ].filter((p) => p && existsSync(p));
  for (const py of candidates) {
    const r = await run(py, ["-I", "-c", "import sys,platform;print(sys.version_info[0]*100+sys.version_info[1], platform.machine())"], { timeoutMs: 10_000 });
    const [ver, arch] = r.out.trim().split(/\s+/);
    if (r.code === 0 && Number(ver) >= 310 && Number(ver) <= 313 && arch === "arm64") return py;
  }
  return null;
}

export interface VoiceSetupOpts {
  dryRun?: boolean;
}

export interface VoiceSetupResult {
  whisper: boolean;
  kokoro: boolean;
}

async function ensureWhisperBin(dry: boolean): Promise<string | null> {
  const existing = whisperServerBin();
  if (existing) return existing;
  const brew = findBin("brew");
  if (!brew) {
    warn("whisper.cpp non c'è e Homebrew non è installato: per la voce → testo userò Parakeet (mlx).");
    return null;
  }
  if (dry) {
    info("Installerei whisper.cpp con «brew install whisper-cpp»");
    return null;
  }
  info("Installo whisper.cpp con Homebrew (un paio di minuti)…");
  const code = await runLive(brew, ["install", "whisper-cpp"], { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" }, (l) => /^(==>|Error|Warning)/.test(l));
  const bin = whisperServerBin();
  if (code !== 0 || !bin) {
    warn("Non sono riuscito a installare whisper.cpp: userò Parakeet (mlx) se disponibile.");
    return null;
  }
  return bin;
}

async function ensureVenv(l: VoiceLayout, dry: boolean): Promise<boolean> {
  const marker = join(l.venv, VENV_OK_MARKER);
  const want = VOICE_PIP_PACKAGES.join(" ");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === want) {
    ok(`Ambiente voce già pronto (${l.venv})`);
    return true;
  }
  let py = await findPython();
  if (!py && findBin("brew") && !dry) {
    info("Serve Python 3.12 per la voce neurale: lo installo con Homebrew…");
    await runLive(findBin("brew")!, ["install", "python@3.12"], { HOMEBREW_NO_AUTO_UPDATE: "1" }, (l) => /^(==>|Error)/.test(l));
    py = await findPython();
  }
  if (!py) {
    warn("Python 3.10–3.13 non trovato: la voce delle risposte userà quella di macOS (Alice).");
    return false;
  }
  if (dry) {
    info(`Creerei l'ambiente voce in ${l.venv} con ${py} e installerei: ${want}`);
    return false;
  }
  mkdirSync(l.venv, { recursive: true });
  if (!existsSync(venvPython(l))) {
    const r = await run(py, ["-m", "venv", l.venv], { timeoutMs: 120_000 });
    if (r.code !== 0) {
      bad(`Non riesco a creare l'ambiente Python: ${r.out.trim().slice(0, 200)}`);
      return false;
    }
  }
  const pip = [venvPython(l), "-m", "pip"] as const;
  info("Installo la voce neurale (mlx-audio, Kokoro): qualche minuto la prima volta…");
  await runLive(pip[0], [pip[1], pip[2], "install", "--quiet", "--disable-pip-version-check", "--upgrade", "pip"]);
  const code = await runLive(
    pip[0],
    [pip[1], pip[2], "install", "--disable-pip-version-check", "--progress-bar", "off", ...VOICE_PIP_PACKAGES],
    { PIP_NO_INPUT: "1" },
    (line) => (/^Collecting /.test(line) && !line.includes("(from")) || /^(ERROR|error)/.test(line),
  );
  if (code !== 0) {
    bad("L'installazione della voce neurale non è riuscita: userò la voce di macOS.");
    return false;
  }
  const test = await run(venvPython(l), ["-I", "-c", "import webrtcvad, mlx_audio.server, misaki, phonemizer, espeakng_loader, uvicorn; print('ok')"], { timeoutMs: 120_000 });
  if (test.code !== 0 || !test.out.includes("ok")) {
    bad(`La voce neurale non si avvia: ${test.out.trim().split("\n").slice(-2).join(" ")}`);
    return false;
  }
  writeFileSync(marker, want + "\n");
  ok("Voce neurale installata");
  return true;
}

async function ensureHfModel(l: VoiceLayout, repo: string, label: string, patterns?: string[]): Promise<boolean> {
  if (hfCached(l, repo)) {
    ok(`${label} già scaricato`);
    return true;
  }
  info(`Scarico ${label}…`);
  const code = await runLive(
    venvPython(l),
    ["-I", "-c", `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(repo)}${patterns ? `, allow_patterns=${JSON.stringify(patterns)}` : ""})`],
    { HF_HOME: l.hfHome, HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1" },
    (line) => /Fetching|Error|error/.test(line) && /100%|Error|error/.test(line),
  );
  if (code !== 0 || !hfCached(l, repo)) {
    bad(`Non sono riuscito a scaricare ${label} (riprova: hikaro-connector setup)`);
    return false;
  }
  ok(`${label} scaricato`);
  return true;
}

/** Install/prepare the local voice. Idempotent: rerunning only checks. */
export async function setupLocalVoice(cfg: Config, o: VoiceSetupOpts = {}): Promise<VoiceSetupResult> {
  const dry = !!o.dryRun;
  const l = voiceLayout(cfg.paths.home, process.env, cfg.whisperModel);
  if (process.arch !== "arm64") {
    warn("Questo Mac non è Apple Silicon: la voce locale veloce non è disponibile (servono le chiavi cloud).");
    return { whisper: false, kokoro: false };
  }
  if (!dry) mkdirSync(l.models, { recursive: true, mode: 0o700 });

  // 1. speech → text: whisper.cpp + large-v3-turbo (q8_0) + Silero VAD
  let whisper = false;
  const bin = await ensureWhisperBin(dry);
  if (bin) {
    ok(`whisper.cpp pronto (${bin})`);
    if (dry) {
      info(`Scaricherei ${l.whisperModel} (~870 MB) e ${VAD_MODEL} in ${l.models}`);
    } else {
      try {
        const name = l.whisperModel.split("/").pop()!;
        const r = await downloadResumable({ url: `${WHISPER_REPO}/${name}`, dest: l.whisperModel, label: "Whisper large-v3-turbo" });
        ok(r === "present" ? "Modello Whisper già scaricato" : "Modello Whisper scaricato");
        await downloadResumable({ url: `${VAD_REPO}/${VAD_MODEL}`, dest: l.vadModel, label: "Silero VAD" });
        whisper = true;
      } catch (err) {
        bad(`Download del modello Whisper non riuscito: ${(err as Error).message}`);
        info("Rilancia hikaro-connector setup: riprende da dove si era fermato.");
      }
    }
  }

  // 2. text → speech: mlx-audio venv + Kokoro-82M; fallback macOS say
  let kokoro = await ensureVenv(l, dry);
  if (kokoro && !dry) kokoro = (await ensureHfModel(l, KOKORO_MODEL, "Kokoro (voce italiana, ~330 MB)", KOKORO_FILES)) && !!kokoroVoicePath(l, "if_sara");
  if (!whisper && kokoro && !dry) {
    // No whisper.cpp → Parakeet is the local STT engine.
    await ensureHfModel(l, "mlx-community/parakeet-tdt-0.6b-v3", "Parakeet v3 (voce → testo, ~1,2 GB)");
  }
  const sayVoice = pickItalianVoice(await listSayVoices(), cfg.sayVoice);
  sayVoice ? ok(`Voce di riserva di macOS: ${sayVoice}`) : warn("Nessuna voce italiana di macOS (Impostazioni → Accessibilità → Contenuti letti)");
  return { whisper, kokoro };
}

/** A real Italian clip from `say` (16 kHz mono PCM16) for latency checks. */
export async function sampleClip(text = "Ciao, che ore sono a Venezia?"): Promise<Buffer | null> {
  const aiff = join(tmpdir(), `hikaro-sample-${process.pid}.aiff`);
  const wav = join(tmpdir(), `hikaro-sample-${process.pid}.wav`);
  const s = await run("/usr/bin/say", ["-v", "Alice", "-o", aiff, text]);
  if (s.code !== 0) return null;
  const c = await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  if (c.code !== 0) return null;
  const buf = readFileSync(wav);
  // strip the RIFF header: find "data" chunk
  const idx = buf.indexOf("data");
  return idx > 0 ? buf.subarray(idx + 8) : null;
}

/** Start the configured voice, measure warm latency, stop it. Prints Italian lines. */
export async function checkVoice(cfg: Config, opts: { quiet?: boolean } = {}): Promise<{ problems: number }> {
  let problems = 0;
  const voice = createVoice(cfg);
  const say = (fn: (s: string) => void, s: string) => !opts.quiet && fn(s);
  say(info, `Voce → testo: ${describeStt(voice.sttChoice)}`);
  say(info, `Testo → voce: ${describeTts(voice.ttsChoice, cfg)}`);
  try {
    const t0 = Date.now();
    await voice.warm();
    if (voice.stt?.start || voice.tts?.start) say(info, `Avvio dei modelli: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (voice.stt) {
      const pcm = await sampleClip();
      if (pcm) {
        await voice.stt.transcribe(pcm); // warm
        const t1 = Date.now();
        const text = await voice.stt.transcribe(pcm);
        const ms = Date.now() - t1;
        const good = /venezia/i.test(text);
        (good ? ok : warn)(`Voce → testo (${voice.stt.name}): «${text}» in ${ms} ms`);
        if (!good) problems++;
      }
    } else {
      problems++;
      bad("Voce → testo spenta: il Deck non può capire la voce");
    }
    if (voice.tts) {
      await voice.tts.synthesize("Ciao.");
      const t2 = Date.now();
      const clip = await voice.tts.synthesize("Ho preparato dodici email per i clienti di Milano.");
      ok(`Testo → voce (${voice.tts.name}): prima frase pronta in ${Date.now() - t2} ms (${clip.format}, ${Math.round(clip.data.length / 1024)} KB)`);
    } else {
      warn("Testo → voce spenta: le risposte arrivano solo come testo");
    }
  } catch (err) {
    problems++;
    bad(`La voce locale non funziona: ${(err as Error).message}`);
  } finally {
    await voice.stop();
  }
  return { problems };
}
