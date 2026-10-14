/**
 * Streaming speech: cut the reply into sentences while it streams, synthesize each
 * one as soon as it is complete (in parallel), emit the audio segments in order.
 * The first sentence goes to TTS long before the agent has finished → low latency.
 */
import { stripMarkdown } from "../cards/shaper.js";
import { toDeckError, type DeckError } from "../core/errors.js";
import type { AudioClip, TtsProvider } from "./tts.js";

/** Clean a piece of text for speaking (no markdown, no URLs, no list markers). */
export function speakable(text: string): string {
  return stripMarkdown(text)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+/gm, "")
    .replace(/[#*_`~<>{}\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SplitterOpts {
  /** minimum chars for the first sentence (low → earlier audio) */
  firstMin?: number;
  /** minimum chars for later chunks (fewer TTS requests) */
  nextMin?: number;
  /** stop speaking after this many chars (the card carries the rest) */
  maxChars?: number;
  /** split chunks longer than this at a comma/space (local TTS models truncate long input) */
  maxChunk?: number;
}

/** Cut `s` into pieces ≤ max chars, preferring , ; : then spaces. */
export function splitLong(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Incremental sentence splitter for streamed text. Stops at the first ``` fence. */
export class SentenceSplitter {
  private buf = "";
  private stopped = false;
  private spoken = 0;
  private count = 0;
  private readonly firstMin: number;
  private readonly nextMin: number;
  private readonly maxChars: number;
  private readonly maxChunk: number;

  constructor(o: SplitterOpts = {}) {
    this.firstMin = o.firstMin ?? 6;
    this.nextMin = o.nextMin ?? 60;
    this.maxChars = o.maxChars ?? 700;
    this.maxChunk = o.maxChunk ?? 0;
  }

  push(delta: string): string[] {
    if (this.stopped) return [];
    this.buf += delta;
    const fence = this.buf.indexOf("```");
    if (fence >= 0) {
      this.buf = this.buf.slice(0, fence);
      this.stopped = true;
      return this.take(true);
    }
    return this.take(false);
  }

  flush(): string[] {
    if (this.stopped && !this.buf) return [];
    const out = this.take(true);
    this.stopped = true;
    return out;
  }

  private take(all: boolean): string[] {
    const out: string[] = [];
    const boundary = /[.!?…]+(?=\s)|\n+/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = boundary.exec(this.buf))) {
      const end = m.index + m[0].length;
      const piece = this.buf.slice(start, end);
      const min = this.count === 0 ? this.firstMin : this.nextMin;
      if (speakable(piece).length < min) continue; // merge with the next sentence
      this.emit(piece, out);
      start = end;
    }
    this.buf = this.buf.slice(start);
    if (all && this.buf.trim()) {
      this.emit(this.buf, out);
      this.buf = "";
    }
    return out;
  }

  private emit(piece: string, out: string[]): void {
    const s = speakable(piece);
    if (!/[\p{L}\d]/u.test(s)) return;
    if (this.spoken >= this.maxChars) return;
    this.spoken += s.length;
    this.count++;
    if (this.maxChunk > 0 && s.length > this.maxChunk) out.push(...splitLong(s, this.maxChunk));
    else out.push(s);
  }
}

/**
 * Ordered TTS pipeline. Segment i is emitted once it is synthesized AND we know
 * whether it is the last one (next segment pushed, or finish() called), so the
 * last emitted segment carries `final: true`.
 */
export class SpeechPipeline {
  private segs: Promise<AudioClip>[] = [];
  private finished = false;
  private aborted = false;
  private wake: (() => void) | null = null;
  private readonly ctrl = new AbortController();
  private readonly loop: Promise<void>;
  emitted = 0;

  constructor(
    private readonly tts: TtsProvider,
    private readonly emit: (clip: AudioClip, final: boolean) => void,
    private readonly onError: (e: DeckError) => void,
    private readonly voice?: string,
  ) {
    this.loop = this.run();
  }

  push(sentence: string): void {
    if (this.finished || this.aborted) return;
    const p = this.tts.synthesize(sentence, this.ctrl.signal, this.voice);
    p.catch(() => undefined); // handled in run()
    this.segs.push(p);
    this.notify();
  }

  /** No more sentences; resolves when everything has been emitted. */
  async finish(): Promise<void> {
    this.finished = true;
    this.notify();
    await this.loop;
  }

  abort(): void {
    this.aborted = true;
    this.ctrl.abort();
    this.notify();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private changed(): Promise<void> {
    return new Promise((r) => (this.wake = r));
  }

  private async run(): Promise<void> {
    for (let i = 0; ; i++) {
      while (i >= this.segs.length) {
        if (this.finished || this.aborted) return;
        await this.changed();
      }
      let buf: AudioClip;
      try {
        buf = await this.segs[i]!;
      } catch (err) {
        if (!this.aborted) {
          this.abort();
          this.onError(toDeckError(err, "tts_failed"));
        }
        return;
      }
      while (i === this.segs.length - 1 && !this.finished && !this.aborted) await this.changed();
      if (this.aborted) return;
      const final = this.finished && i === this.segs.length - 1;
      this.emitted++;
      this.emit(buf, final);
    }
  }
}
