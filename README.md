# Hikaro connector

Il servizio che gira sul Mac Mini e collega il **Deck** (oggi l'app iPhone, domani il dispositivo) agli agenti **Hermes**. Parla il protocollo di [`protocol/README.md`](PROTOCOL.md): WebSocket sulla porta 8787, schede, voce, LED.

```
iPhone/Deck ──WebSocket──▶ connettore ──HTTP──▶ Hermes API (un profilo = un agente = un tasto)
   voce PCM 16 kHz          STT · schede · TTS · push (APNs)
```

**Nessuna chiave cloud necessaria**: la voce gira sul Mac (Apple Silicon). Voce → testo con Whisper large-v3-turbo
(whisper.cpp, Metal, ~0,65 s per una frase), testo → voce con Kokoro-82M (mlx-audio, voce `if_sara`, ~0,3 s per frase),
riserva automatica sulla voce di macOS (Alice). Con `GROQ_API_KEY`/`OPENAI_API_KEY` usa invece il cloud.

## Installazione (utente)

```bash
curl -fsSL https://raw.githubusercontent.com/Albertoravasini/hikaro-connector/main/install.sh | bash
```
(`https://hikaro.app/install.sh` rimanda allo stesso script.)

L'installer trova un Node 20+ (quello nel PATH, quello che porta Hermes in `~/.hermes/node`, altrimenti ne scarica
uno da nodejs.org in `~/.hikaro/node`, senza sudo), installa in `~/.hikaro/connector`, poi `hikaro-connector setup`:
- accende l'API di Hermes per ogni profilo (copia di sicurezza del `.env`) e **riavvia il gateway senza perdere Discord**:
  se è il servizio launchd di Hermes usa `hermes gateway restart` (finisce i lavori in corso, poi `launchctl kickstart`);
  se il gateway è acceso a mano non lo tocca e dice cosa fare; se non c'è lo installa come servizio;
- installa la voce locale: `brew install whisper-cpp` se manca, modelli in `~/.hikaro/models` (download che riprende
  da dove si era fermato), Python venv con mlx-audio in `~/.hikaro/venvs/voice`, poi prova la voce e mostra i tempi;
- installa il servizio launchd `app.hikaro.connector` (che avvia anche i server della voce) e mostra il QR.

## Sviluppo

```bash
npm install
npm run build
npm test
node dist/index.js start --demo   # 4 agenti finti, niente Hermes né chiavi (per il simulatore)
node dist/index.js start --hermes-temp --port 8798   # Hermes vero, gateway TEMPORANEO (vedi sotto)
npm run e2e -- --port 8798 [--agent default] [--approval] [--approval-demo] [--select latest]
```

Comandi: `start [--demo] [--hermes-temp] [--port N]` · `setup [--dry-run] [--no-service] [--no-hermes] [--no-gateway] [--no-voice]` · `pair [--rotate]` · `status` · `doctor` · `restart` · `uninstall [--purge]`.

`start --hermes-temp` (solo per un Mac di prova): avvia `hermes gateway run` in primo piano con l'API accesa **solo
tramite variabili d'ambiente** (`API_SERVER_ENABLED/KEY/PORT/HOST`, chiave casuale, porta 8652 o libera), lo usa come
backend e lo chiude all'uscita. Non scrive niente in `~/.hermes` (Hermes scrive solo il suo stato: log, sessioni) e si
rifiuta se quel Hermes ha piattaforme di messaggi configurate (risponderebbe due volte) o `API_SERVER_*` nel `.env`.
`HIKARO_HERMES_HOME=<cartella>` per usare una copia di prova della configurazione.

`scripts/e2e.ts` si comporta come l'iPhone: `hello`, `prefs`, `sessions.list`, poi una frase italiana vera (generata
con `say -v Alice`, convertita in PCM 16 kHz) e controlla trascrizione, risposta a pezzi, scheda, audio valido (ffprobe)
e i tempi dal rilascio del tasto.

In modalità demo: Outreach, Assistente, Startup, Dev rispondono con testo di prova (con la voce locale installata la trascrizione è vera, altrimenti finta), ogni agente ha sottochat finte (`sessions.list`), e ogni 45 s Outreach chiede «12 email pronte. Le invio?» (`HIKARO_DEMO_INTERVAL_MS`).

## Impostazioni — `~/.hikaro/connector.env`

| Variabile | A cosa serve |
|---|---|
| `HIKARO_STT` | `auto` (Groq → OpenAI → `HIKARO_STT_URL` → locale) · `local` · `groq` · `openai` · `url` · `off` |
| `HIKARO_STT_ENGINE` | voce → testo locale: `auto` (whisper.cpp se c'è, altrimenti Parakeet v3) · `whisper` · `parakeet` |
| `HIKARO_STT_LANGUAGE` | `it` (predefinita) oppure `auto` |
| `HIKARO_STT_URL`, `HIKARO_STT_MODEL`, `HIKARO_STT_KEY` | qualsiasi servizio `/audio/transcriptions` compatibile OpenAI |
| `HIKARO_WHISPER_MODEL`, `HIKARO_STT_VAD=off` | modello whisper.cpp (predefinito `ggml-large-v3-turbo-q8_0.bin`), VAD Silero |
| `HIKARO_TTS` | `auto` (OpenAI se c'è la chiave, altrimenti locale) · `local` · `openai` · `off` (solo testo) |
| `HIKARO_LOCAL_VOICE`, `HIKARO_SAY_VOICE` | voce Kokoro `if_sara`/`im_nicola`; voce macOS di riserva (`Alice`) |
| `GROQ_API_KEY` | facoltativa: voce → testo nel cloud (`whisper-large-v3-turbo`) |
| `OPENAI_API_KEY` | facoltativa: voce → testo (`gpt-4o-mini-transcribe`) se manca Groq, e testo → voce (`gpt-4o-mini-tts`) |
| `HIKARO_TTS_VOICE` | voce OpenAI (predefinita `coral`) |
| `HERMES_URL`, `HERMES_API_KEY` | forzano l'indirizzo/chiave del profilo default (di solito li trova il setup) |
| `HIKARO_PORT` | porta del connettore (8787) |
| `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID` | notifiche push e Live Activity (facoltative, bundle `app.hikaro.deck`) |

Altri file in `~/.hikaro` (tutti `0600`): `connector.json` (token di abbinamento, nomi/colori/tasti degli agenti in `agents`), `state.json` (sessione Hermes per agente, conversazione scelta per tasto, token push), `connector.log`. Voce locale: `models/` (Whisper, VAD, cache HF di Kokoro), `venvs/voice/`, `run/*.pid` (per fermare server rimasti dopo un crash).

## Voce locale (misurata su M3 Pro, frasi italiane vere)

| | scelta | tempi a caldo | note |
|---|---|---|---|
| voce → testo | **Whisper large-v3-turbo q8_0** (whisper.cpp 1.9.5, Metal) + Silero VAD | ~0,65 s per 2–4 s di audio | q5_0 stesso testo ma ~8% più lento; il VAD evita il «Grazie.» inventato sul silenzio |
| alternativa | Parakeet TDT 0.6B v3 (mlx) | ~0,06–0,2 s | italiano supportato, 4× più veloce, ma attraverso mlx-audio più errori («emaila», «letteo»): opzione `HIKARO_STT_ENGINE=parakeet` |
| testo → voce | **Kokoro-82M** (mlx-audio 0.5.9, `if_sara`) | 0,1–0,3 s per frase (mp3) | modelli caricati per percorso, funziona offline |
| riserva | `say` di macOS (Alice) → m4a AAC | ~0,5 s per frase | sempre presente; usata se Kokoro non va (pausa di 60 s) |
| scartata | Qwen3-TTS 0.6B (mlx, 8 bit) | ~3,4 s per frase | troppo lento per la prima frase |

Le risposte vengono tagliate in frasi (≤220 caratteri per Kokoro) e la prima va in sintesi appena è completa.

## Come parla con Hermes (v0.18.2)

- **Un profilo = un agente.** L'API server di Hermes non ha instradamento per profilo: ogni profilo ha il suo gateway e la sua porta (`API_SERVER_PORT`: default 8642, gli altri 8643, 8644…). Il setup scrive `API_SERVER_ENABLED`, `API_SERVER_KEY`, `API_SERVER_PORT` nel `.env` di ogni profilo e (ri)avvia `hermes [-p profilo] gateway`. Con `gateway.multiplex_profiles` attivo è raggiungibile solo il profilo default.
- Ogni messaggio va a `POST /v1/runs` con il `session_id` della conversazione scelta per quel tasto (predefinita: una
  fissa del Deck; la cronologia viene da `/api/sessions/{id}/messages`) e `instructions` = [istruzioni Hikaro](src/cards/instructions.ts) (risposte brevi, ≤3 opzioni).
- **Conversazioni (sottochat Discord)**: `sessions.list` legge `GET /api/sessions?source=discord` (più recenti prima) e
  arricchisce i titoli con i nomi canale/thread da `<profilo>/sessions/sessions.json` (sola lettura). Verificato nel
  codice di Hermes: un run con il `session_id` di una sottochat aggiunge i turni a quella stessa sessione in `state.db`
  (`create_session` non sovrascrive la riga), e il gateway Discord ricarica la trascrizione da `state.db` al messaggio
  successivo: l'agente se li ricorda, ma nel canale Discord non compaiono.
- Gli eventi arrivano da `GET /v1/runs/{id}/events`: `message.delta` → `reply` a pezzi + voce frase per frase; `approval.request` → scheda `request` («Sì, solo ora» / «Sì, per la sessione» / «No»), la scelta va a `POST /v1/runs/{id}/approval`.

## Schede: il blocco ```hikaro

Un agente può dettare la scheda aggiungendo in fondo alla risposta (non viene letto ad alta voce):

````
```hikaro
{"kind":"request","title":"12 email pronte. Le invio?","lines":["A: Studio Ferri + altri 11"],
 "quote":"Ciao Marco, ho visto…","options":["Invia tutte","Leggi una per una","Modifica a voce"],"counter":"1/12"}
```
````

Senza blocco, il connettore accorcia da solo: titolo ≤60 caratteri, ≤3 righe, citazione ≤140 da «…», opzioni da un elenco dopo una domanda finale. Se l'utente sceglie un'opzione di una domanda scritta dall'agente, il testo dell'opzione torna all'agente come messaggio.

## Convenzioni di streaming (compatibili con il protocollo v1)

- `reply` con `final: false` = pezzo da aggiungere; con `final: true` = testo completo (sostituisce).
- Ogni `audio` è un file autonomo (di solito una frase) in `format` `mp3` (Kokoro, OpenAI) o `m4a` (voce di macOS), da suonare in ordine; `final: true` sull'ultimo.
- `prefs` (per dispositivo): `voice` sceglie la voce (id OpenAI o `if_sara`/`im_nicola`; con la voce locale gli id OpenAI diventano la voce italiana più simile), `speak: false` = solo testo, nessun `audio` e nessuna sintesi se nessun dispositivo vuole la voce.

## Struttura

```
src/index.ts        CLI            src/app.ts        collega tutto
src/protocol.ts     tipi del protocollo (allineati a protocol/README.md)
src/core/           hub (stati LED, schede, turni), interfaccia AgentBackend, errori in italiano
src/server/         HTTP /health + WebSocket /ws, sessione per dispositivo
src/hermes/         client API, scoperta profili, backend, modifica sicura del .env
src/demo/           backend demo         src/cards/   shaper + istruzioni agenti
src/voice/          wav, stt, tts, frasi in streaming; local/ = whisper.cpp, mlx-audio (Kokoro/Parakeet), say, download
src/push/           APNs (http2 + JWT ES256)   src/pairing/  QR, IP di casa, Tailscale
src/service/        setup, launchd, doctor/status, voice (installazione + prova della voce)
src/hermes/temp.ts  gateway Hermes temporaneo per i test   scripts/e2e.ts  prova completa come l'iPhone
install.sh          l'installer (fonte unica; il repo pubblico hikaro-connector = questa cartella)
```

Per aggiungere OpenClaw o Hikaro Cloud basta implementare `AgentBackend` (`src/core/backend.ts`).
