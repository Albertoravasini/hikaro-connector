import type { ErrorCode } from "../protocol.js";

/**
 * Messages shown on the device. Always plain Italian sentences that say what to do —
 * never a code (the code travels separately in `error.code`).
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  unauthorized:
    "Questo telefono non è abbinato al Mac. Sul Mac scrivi hikaro-connector pair nel Terminale e inquadra di nuovo il QR.",
  hermes_down: "Hermes non risponde. Sul Mac scrivi hermes nel Terminale e premi Invio, poi riprova.",
  no_agents: "Nessun agente trovato. Crea un agente (profilo) in Hermes, poi riprova.",
  stt_failed: "Non ho capito. Tieni premuto il tasto e riprova.",
  tts_failed: "Non riesco a parlare adesso. Leggi la risposta sullo schermo.",
  agent_failed: "L'agente non è riuscito a rispondere. Riprova tra poco.",
  bad_message: "Qualcosa non torna nella richiesta. Aggiorna l'app e riprova.",
};

/** Variants for specific situations (same codes). */
export const ERROR_VARIANTS = {
  sttNoKey:
    "La voce non è ancora pronta sul Mac. Scrivi hikaro-connector setup nel Terminale del Mac, poi riprova.",
  sttLocalDown: "Il riconoscimento vocale sul Mac si sta avviando. Riprova tra qualche secondo.",
  sttEmpty: "Non ho sentito niente. Tieni premuto il tasto mentre parli.",
  hermesKey: "Hermes rifiuta la chiave. Sul Mac scrivi hikaro-connector setup nel Terminale, poi riprova.",
  unknownAgent: "Questo tasto non ha un agente. Assegnalo nelle impostazioni.",
  cardExpired: "Questa scelta non è più valida. Tocca il tasto per vedere l'ultima scheda.",
  agentBusy: "L'agente sta ancora lavorando. Aspetta che finisca, poi riprova.",
  sessionGone: "Questa conversazione non c'è più. Scegline un'altra.",
  sessionsUnsupported: "Questo agente ha solo la chat del Deck.",
} as const;

/** Error carrying a protocol code and a ready-to-show Italian message. */
export class DeckError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = ERROR_MESSAGES[code],
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DeckError";
  }
}

export function toDeckError(err: unknown, fallback: ErrorCode = "agent_failed"): DeckError {
  if (err instanceof DeckError) return err;
  return new DeckError(fallback, ERROR_MESSAGES[fallback], err instanceof Error ? err.message : String(err));
}
