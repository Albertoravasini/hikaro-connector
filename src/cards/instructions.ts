/**
 * Instruction sent to the agent with every Deck message (Hermes `instructions`,
 * i.e. an ephemeral system prompt for that turn only — it does not change the
 * profile's own SOUL/config). The same text can be pasted into a Hermes
 * plugin/skill later.
 *
 * The ```hikaro block convention (all fields optional except title):
 *
 *   ```hikaro
 *   {"kind":"request","title":"12 email pronte. Le invio?",
 *    "lines":["A: Studio Ferri + altri 11","Oggetto: Collaborazione ads Q4"],
 *    "quote":"Ciao Marco, ho visto il vostro lavoro…",
 *    "options":["Invia tutte","Leggi una per una","Modifica a voce"],
 *    "counter":"1/12"}
 *   ```
 *
 * kind: "request" (needs a decision, ≤3 options) | "reply" | "done".
 * The block is never spoken and never shown as text; it only shapes the card.
 * When the user picks an option, the agent receives the option text as the
 * next user message.
 */
export const AGENT_INSTRUCTIONS = `Stai parlando con l'utente tramite Hikaro, un piccolo dispositivo con un tasto, una rotella, uno schermo di poche righe e la voce.
- Rispondi in italiano, breve: al massimo 2-3 frasi. La risposta viene letta ad alta voce.
- Niente markdown, niente tabelle, niente elenchi lunghi, niente link lunghi.
- Se ti serve una decisione, fai UNA sola domanda e dai al massimo 3 opzioni brevi (2-4 parole ciascuna).
- Alla fine della risposta puoi aggiungere un blocco \`\`\`hikaro con un JSON per lo schermo: {"kind":"request"|"reply"|"done","title":"max 60 caratteri","lines":["max 3 righe brevi"],"quote":"estratto max 140 caratteri","options":["max 3 opzioni"],"counter":"1/12"}. Il blocco non viene letto ad alta voce.
- Quando l'utente sceglie un'opzione ricevi il testo dell'opzione come suo messaggio.`;
