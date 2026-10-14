/**
 * Card shaper — turns an agent's free-text reply into a Deck card.
 * Pure functions, no I/O (unit-tested in test/shaper.test.ts).
 *
 * Priority:
 *   1. A fenced ```hikaro block with JSON matching the Card fields (see AGENT_INSTRUCTIONS).
 *   2. Heuristic: title = question or first sentence, ≤3 short lines, quote from «…»/“…”,
 *      options from a list that follows (or precedes) a final question.
 */
import { randomBytes } from "node:crypto";
import { CARD_LIMITS, type Card } from "../protocol.js";
import type { CardDraft } from "../core/backend.js";

const ELLIPSIS = "…";

/** Shorten at a word boundary, adding "…" when cut. */
export function truncate(input: string, max: number): string {
  const s = input.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space >= max * 0.6) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.\-–—]+$/u, "") + ELLIPSIS;
}

export function newCardId(): string {
  return `c_${randomBytes(5).toString("hex")}`;
}

// ── ```hikaro block ───────────────────────────────────────────────────

const BLOCK_RE = /```hikaro[ \t]*\r?\n([\s\S]*?)```/i;
/** Any fenced block (also unterminated ones at the end of a stream). */
const ANY_FENCE_RE = /```[\s\S]*?(?:```|$)/g;

export interface ExtractedBlock {
  draft: Partial<CardDraft> | null;
  /** text with the hikaro block removed */
  rest: string;
}

export function extractHikaroBlock(text: string): ExtractedBlock {
  const m = BLOCK_RE.exec(text);
  if (!m) return { draft: null, rest: text };
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let obj: unknown;
  try {
    obj = JSON.parse(m[1] ?? "");
  } catch {
    return { draft: null, rest };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { draft: null, rest };
  const o = obj as Record<string, unknown>;
  const strs = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined;
  const draft: Partial<CardDraft> = {};
  if (o.kind === "request" || o.kind === "reply" || o.kind === "done") draft.kind = o.kind;
  if (typeof o.title === "string" && o.title.trim()) draft.title = o.title;
  const lines = strs(o.lines);
  if (lines?.length) draft.lines = lines;
  if (typeof o.quote === "string" && o.quote.trim()) draft.quote = o.quote;
  const options = strs(o.options);
  if (options?.length) draft.options = options;
  if (typeof o.counter === "string" && o.counter.trim()) draft.counter = o.counter;
  return { draft, rest };
}

// ── Text cleanup ──────────────────────────────────────────────────────

/** Remove markdown decoration, keep the words. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .replace(/\|/g, " ");
}

/** Text without code blocks / hikaro block, for display and speech. */
export function visibleText(text: string): string {
  const { rest } = extractHikaroBlock(text);
  return rest.replace(ANY_FENCE_RE, " ").replace(/[ \t]+\n/g, "\n").trim();
}

const LIST_RE = /^\s*(?:[-*•–]|\d{1,2}[.)]|[a-cA-C][.)])\s+(.+)$/;

/** Split prose into sentences (Italian-friendly, no abbreviations magic). */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}\d«"“(¿¡])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Make a list item into a short wheel option ("Invia tutte: manda subito…" → "Invia tutte"). */
export function shortOption(item: string): string {
  let s = stripMarkdown(item).trim();
  const sep = /\s(?:—|–|-)\s|:\s/.exec(s);
  if (sep && sep.index >= 2) s = s.slice(0, sep.index);
  s = s.replace(/^[«"“]|[»"”]$/g, "").replace(/[.;,!]+$/u, "").trim();
  return truncate(s, CARD_LIMITS.option);
}

const DONE_RE =
  /^(fatto|fatta|fatti|ok[,.!]|okay[,.!]|perfetto[,.!]|inviat[aeio]|spedit[aeio]|completat[aeio]|terminat[aeio]|pubblicat[aeio]|salvat[aeio]|aggiornat[aeio]|ho finito|tutto pronto|done\b)/i;
const QUOTE_RE = /[«“"]([^«»“”"\n]{12,})[»”"]/u;

interface Parsed {
  prose: string[]; // sentences, in order
  items: string[]; // list items (cleaned), in order
  question?: string;
  options: string[];
}

function parse(text: string): Parsed {
  const lines = stripMarkdown(visibleText(text))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  type Row = { kind: "item" | "text"; text: string };
  const rows: Row[] = lines.map((l) => {
    const m = LIST_RE.exec(l);
    return m ? { kind: "item", text: (m[1] ?? "").trim() } : { kind: "text", text: l };
  });

  // Find the last question among text rows.
  let qRow = -1;
  let question: string | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind !== "text") continue;
    const qs = splitSentences(r.text).filter((s) => /\?\s*$/.test(s));
    if (qs.length) {
      qRow = i;
      question = qs[qs.length - 1];
      break;
    }
  }

  // Options = consecutive list items right after the question (to the end),
  // or right before it when the question is the last row.
  let options: string[] = [];
  const optionRows = new Set<number>();
  if (qRow >= 0) {
    const after: number[] = [];
    for (let i = qRow + 1; i < rows.length && rows[i]!.kind === "item"; i++) after.push(i);
    let picked = after.length >= 2 && qRow + 1 + after.length === rows.length ? after : [];
    if (!picked.length && qRow === rows.length - 1) {
      const before: number[] = [];
      for (let i = qRow - 1; i >= 0 && rows[i]!.kind === "item"; i--) before.unshift(i);
      if (before.length >= 2) picked = before;
    }
    if (picked.length >= 2 && picked.length <= 6) {
      options = picked.map((i) => shortOption(rows[i]!.text)).filter(Boolean);
      picked.forEach((i) => optionRows.add(i));
    }
  }

  const prose: string[] = [];
  const items: string[] = [];
  rows.forEach((r, i) => {
    if (optionRows.has(i)) return;
    if (r.kind === "item") items.push(r.text);
    else prose.push(...splitSentences(r.text));
  });
  return { prose, items, question, options };
}

/** Shape any reply text into a card draft (no id/agent/ts yet). */
export function shapeText(text: string): CardDraft {
  const { draft: block, rest } = extractHikaroBlock(text);
  const fallback = parse(rest || text);

  if (block && (block.title || block.lines?.length || block.options?.length)) {
    const kind = block.kind ?? (block.options?.length ? "request" : "reply");
    const d: CardDraft = {
      kind,
      title: block.title ?? fallback.question ?? fallback.prose[0] ?? "Risposta",
    };
    if (block.lines) d.lines = block.lines;
    if (block.quote) d.quote = block.quote;
    if (block.options) d.options = block.options;
    if (block.counter) d.counter = block.counter;
    return d;
  }

  const p = fallback;
  const quoteMatch = QUOTE_RE.exec(stripMarkdown(visibleText(text)));
  const quote = quoteMatch?.[1]?.trim();

  if (p.question && p.options.length >= 2) {
    const context = p.prose.filter((s) => s !== p.question);
    const d: CardDraft = {
      kind: "request",
      title: p.question,
      lines: [...context, ...p.items].slice(0, CARD_LIMITS.lines),
      options: p.options,
    };
    if (quote) d.quote = quote;
    return d;
  }

  const all = [...p.prose, ...p.items];
  if (!all.length) return { kind: "reply", title: "Nessuna risposta." };
  const title = all[0]!;
  const lines = all.slice(1, 1 + CARD_LIMITS.lines);
  const shortReply = visibleText(text).length <= 220;
  const d: CardDraft = { kind: shortReply && DONE_RE.test(title) ? "done" : "reply", title };
  if (lines.length) d.lines = lines;
  if (quote && !title.includes(quote)) d.quote = quote;
  return d;
}

/** Enforce protocol limits and add id/agent/ts. */
export function finalizeCard(draft: CardDraft, agent: string, opts: { id?: string; ts?: number } = {}): Card {
  const card: Card = {
    id: opts.id ?? newCardId(),
    agent,
    kind: draft.kind,
    title: truncate(stripMarkdown(draft.title || "Risposta"), CARD_LIMITS.title) || "Risposta",
    ts: opts.ts ?? Date.now(),
  };
  const lines = (draft.lines ?? [])
    .map((l) => truncate(stripMarkdown(l), CARD_LIMITS.line))
    .filter(Boolean)
    .slice(0, CARD_LIMITS.lines);
  if (lines.length) card.lines = lines;
  if (draft.quote?.trim()) card.quote = truncate(draft.quote, CARD_LIMITS.quote);
  if (draft.counter?.trim()) card.counter = truncate(draft.counter, 12);
  if (draft.kind === "request") {
    const options = (draft.options ?? [])
      .map((o) => truncate(stripMarkdown(o), CARD_LIMITS.option))
      .filter(Boolean)
      .slice(0, CARD_LIMITS.options);
    card.options = options.length ? options : ["Sì", "No"];
  }
  return card;
}

/** Convenience: text → final card. */
export function shapeCard(text: string, agent: string, opts: { id?: string; ts?: number } = {}): Card {
  return finalizeCard(shapeText(text), agent, opts);
}
