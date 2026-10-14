import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractHikaroBlock,
  finalizeCard,
  shapeCard,
  shapeText,
  shortOption,
  splitSentences,
  stripMarkdown,
  truncate,
  visibleText,
} from "../src/cards/shaper.js";
import { CARD_LIMITS } from "../src/protocol.js";

test("truncate keeps short strings and cuts at a word boundary with an ellipsis", () => {
  assert.equal(truncate("Ciao", 60), "Ciao");
  const t = truncate("Questa è una frase decisamente troppo lunga per stare nel titolo della scheda", 40);
  assert.ok(t.length <= 40, t);
  assert.ok(t.endsWith("…"));
  assert.ok(!t.includes("  "));
});

test("hikaro block wins and is removed from the text", () => {
  const text = `Ho preparato le email.
\`\`\`hikaro
{"kind":"request","title":"12 email pronte. Le invio?","lines":["A: Studio Ferri + altri 11"],"options":["Invia tutte","Leggi una per una","Modifica a voce","Annulla"],"counter":"1/12"}
\`\`\``;
  const { draft, rest } = extractHikaroBlock(text);
  assert.equal(rest, "Ho preparato le email.");
  assert.equal(draft?.title, "12 email pronte. Le invio?");
  const card = shapeCard(text, "outreach", { id: "c_1", ts: 1 });
  assert.equal(card.kind, "request");
  assert.equal(card.title, "12 email pronte. Le invio?");
  assert.deepEqual(card.options, ["Invia tutte", "Leggi una per una", "Modifica a voce"]); // max 3
  assert.equal(card.counter, "1/12");
  assert.equal(card.agent, "outreach");
  assert.equal(visibleText(text), "Ho preparato le email.");
});

test("invalid hikaro JSON falls back to the heuristic", () => {
  const card = shapeCard("Fatto, ho salvato il file.\n```hikaro\n{not json\n```", "dev");
  assert.equal(card.kind, "done");
  assert.match(card.title, /^Fatto/);
});

test("heuristic: question + list of options → request card", () => {
  const text = `Ho trovato 3 fornitori per le cover MagSafe.
Il più economico è Shenzhen Lite.

Quale preferisci?
1. **Shenzhen Lite** — 2,10 € a pezzo
2. Ningbo Pro: qualità migliore
3. Aspetta altre offerte
4. Annulla tutto`;
  const card = shapeCard(text, "startup");
  assert.equal(card.kind, "request");
  assert.equal(card.title, "Quale preferisci?");
  assert.deepEqual(card.options, ["Shenzhen Lite", "Ningbo Pro", "Aspetta altre offerte"]);
  assert.deepEqual(card.lines, ["Ho trovato 3 fornitori per le cover MagSafe.", "Il più economico è Shenzhen Lite."]);
});

test("heuristic: options listed before the final question", () => {
  const card = shapeCard("- Invia ora\n- Domani mattina\nQuando le mando?", "outreach");
  assert.equal(card.kind, "request");
  assert.deepEqual(card.options, ["Invia ora", "Domani mattina"]);
});

test("a question without options stays a reply", () => {
  const card = shapeCard("Ecco il riassunto della call. Vuoi altro?", "assistente");
  assert.equal(card.kind, "reply");
  assert.equal(shapeCard("Ho finito il riassunto. Vuoi altro?", "assistente").kind, "done");
  assert.equal(card.options, undefined);
});

test("long reply → title ≤60, ≤3 lines ≤60, quote ≤140", () => {
  const long =
    "## Riepilogo della settimana\n\n**Preordini**: questa settimana abbiamo ricevuto 214 preordini, con un aumento del 18 per cento rispetto alla settimana precedente grazie alla campagna su Instagram. " +
    "Il deposito medio è rimasto stabile. Marco ha scritto: «Siamo pronti a partire con la produzione appena arriviamo a mille preordini, ma serve confermare il fornitore delle batterie entro venerdì prossimo, altrimenti slittiamo di un mese intero». " +
    "Le spese pubblicitarie sono state 1.200 euro. Il costo per preordine è sceso a 5,60 euro. Domani ti mando il dettaglio.";
  const card = shapeCard(long, "startup");
  assert.equal(card.kind, "reply");
  assert.ok(card.title.length <= CARD_LIMITS.title, card.title);
  assert.ok(!card.title.includes("#") && !card.title.includes("*"));
  assert.ok((card.lines?.length ?? 0) <= 3);
  for (const l of card.lines ?? []) assert.ok(l.length <= CARD_LIMITS.line, l);
  assert.ok(card.quote && card.quote.length <= CARD_LIMITS.quote, card.quote);
  assert.match(card.quote!, /^Siamo pronti/);
});

test("done detection for short completion replies", () => {
  assert.equal(shapeText("Inviate. 12 email, nessun errore.").kind, "done");
  assert.equal(shapeText("Fatto!").kind, "done");
  assert.equal(shapeText("Ecco il meteo di domani: sole.").kind, "reply");
});

test("empty reply still produces a valid card", () => {
  const c = shapeCard("", "dev");
  assert.equal(c.kind, "reply");
  assert.ok(c.title.length > 0);
});

test("code blocks are not shown on the card", () => {
  const c = shapeCard("Ecco lo script.\n```bash\nrm -rf build\n```\nL'ho salvato in scripts/.", "dev");
  assert.equal(c.title, "Ecco lo script.");
  assert.ok(!(c.lines ?? []).some((l) => l.includes("rm -rf")));
});

test("finalizeCard enforces limits and defaults request options", () => {
  const c = finalizeCard({ kind: "request", title: "Procedo?" }, "dev");
  assert.deepEqual(c.options, ["Sì", "No"]);
  const r = finalizeCard({ kind: "reply", title: "x", options: ["a", "b"] }, "dev");
  assert.equal(r.options, undefined, "options only on request cards");
  assert.match(c.id, /^c_[0-9a-f]{10}$/);
});

test("helpers", () => {
  assert.equal(stripMarkdown("**ciao** [link](http://x) `code`"), "ciao link code");
  assert.deepEqual(splitSentences("Primo. Secondo! Terzo? quarto"), ["Primo.", "Secondo!", "Terzo? quarto"]);
  assert.equal(shortOption("Invia tutte: manda subito le 12 email."), "Invia tutte");
  assert.ok(shortOption("Un'opzione davvero molto molto lunga che non entra").length <= CARD_LIMITS.option);
});
