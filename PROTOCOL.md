# Hikaro Deck Protocol · v1

Unico contratto tra **dispositivo** (oggi l'app iPhone, domani il Deck vero via Bluetooth)
e **connettore** (sul Mac Mini, parla con Hermes). Il connettore non manda mai immagini dello
schermo: manda dati, e ogni dispositivo li disegna.

Le implementazioni devono restare allineate a questo file:
- Swift: `ios/Shared/Protocol/DeckProtocol.swift`
- TypeScript: `connector/src/protocol.ts`
- Esempi validi: `protocol/examples/*.json`

## Trasporto

| | |
|---|---|
| WebSocket | `ws://<host>:<port>/ws` (porta predefinita **8787**) |
| Autenticazione | header `Authorization: Bearer <token>` (oppure `?token=` nella query) |
| Messaggi di controllo | frame **testo**, JSON UTF-8, un oggetto per frame, campo `type` sempre presente |
| Audio dal dispositivo | frame **binari**: PCM 16 bit little-endian, mono, 16 kHz, tra `voice.start` e `voice.end` |
| Audio dal connettore | messaggio `audio` (JSON, base64), formato `mp3`, `m4a` (AAC) o `wav` |
| Keep-alive | `ping` ogni 20 s, il connettore risponde `pong` |

### HTTP (per il primo avvio)

`GET /health` (con lo stesso token) →
```json
{ "ok": true, "mac": "Mac-mini-di-Alberto", "hermes": true, "agents": 4, "version": "0.1.0" }
```
L'app usa questa risposta per le tre spunte: «Mac trovato», «Hermes risponde», «N agenti trovati».

### Abbinamento (QR)

Il connettore mostra nel Terminale un QR che contiene:
```
hikaro://pair?v=1&host=192.168.1.20&port=8787&token=<token>&name=Mac-mini&ts=<tailscale-host>
```
`ts` (facoltativo) è il nome/IP Tailscale da usare fuori casa. Nessun indirizzo da scrivere a mano.

## Tipi comuni

```ts
AgentState = "off" | "working" | "calling" | "done"
// off = LED spento · working = fisso · done = lampeggio lento (ha finito) · calling = lampeggio veloce (ti cerca)
// (l'app mostra anche «risposta da ascoltare» col lampeggio lento finché non la apri)

CardKind = "request" | "reply" | "done" | "listening"

Agent = { id: string, name: string, color: string /* hex #RRGGBB */, key: 0|1|2|3|null }

Card = {
  id: string,            // univoco, serve per rispondere con `choice`
  agent: string,         // Agent.id
  kind: CardKind,
  title: string,         // max ~60 caratteri, già accorciato dal connettore
  lines?: string[],      // max 3 righe brevi ("A: …", "Oggetto: …")
  quote?: string,        // estratto tra virgolette, max ~140 caratteri
  options?: string[],    // max 3, solo per kind = "request"
  counter?: string,      // es. "1/12"
  ts: number             // epoch ms
}
```

## Dal dispositivo → connettore

| type | campi | quando |
|---|---|---|
| `hello` | `device: "iphone" \| "deck"`, `version`, `name?` | appena connesso |
| `voice.start` | `agent`, `id` (id della registrazione) | tasto tenuto premuto |
| *(binario)* | PCM 16 kHz | durante la registrazione |
| `voice.end` | `agent`, `id` | tasto rilasciato |
| `voice.cancel` | `agent`, `id` | registrazione annullata (troppo corta, trascinata via) |
| `choice` | `card`, `index`, `option` | rotella premuta su una scelta |
| `key.tap` | `agent` | tocco breve: chiedi l'ultima scheda |
| `prefs` | `voice?` (id voce TTS: OpenAI, es. `alloy`, oppure locale `if_sara`/`im_nicola`; con la voce sul Mac gli id OpenAI diventano la voce italiana più simile), `speak?` (bool, `false` = solo testo, niente audio) | dopo `hello` e a ogni cambio nelle Impostazioni |
| `sessions.list` | `agent` | Impostazioni → Tasti: elenco delle conversazioni di quell'agente |
| `session.select` | `agent`, `session`: `"deck"` \| `"latest"` \| id sessione Hermes | sceglie con quale conversazione parla quel tasto |
| `push.register` | `token`, `kind: "device" \| "liveactivity"`, `env: "sandbox" \| "production"` | facoltativo, per le notifiche push |
| `ping` | — | ogni 20 s |

## Dal connettore → dispositivo

| type | campi | effetto |
|---|---|---|
| `welcome` | `agents: Agent[]`, `mac`, `version` | elenco agenti (profili Hermes) |
| `status` | `agent`, `state: AgentState` | LED del tasto |
| `card` | `card: Card` | lo schermo mostra la scheda |
| `transcript` | `agent`, `id`, `text`, `final` | parole che compaiono mentre parli (scheda «ascolto») |
| `reply` | `agent`, `text`, `final` | testo della risposta (anche a pezzi, `final` all'ultimo) |
| `audio` | `agent`, `format: "mp3" \| "m4a" \| "wav"`, `data` (base64), `final` | voce della risposta |
| `haptic` | `pattern: "request" \| "done" \| "error"` | vibrazione |
| `error` | `code`, `message` | `message` è già una frase semplice in italiano, mai un codice |
| `sessions` | `agent`, `selected`, `items: [{ id, title, source, channel?, updated }]` (più recenti prima, max 30) | risposta a `sessions.list` e dopo `session.select` |
| `pong` | — | risposta a `ping` |

### Codici errore (`error.code`)
`unauthorized` · `hermes_down` · `no_agents` · `stt_failed` · `tts_failed` · `agent_failed` · `bad_message`

## Convenzioni (fissate dall'implementazione del connettore)

- All'apertura del WebSocket il connettore manda subito `welcome` (non aspetta `hello`), poi lo `status`
  degli agenti **non** `off` (uno stato mancante = `off`) e le schede `request` ancora in attesa, dalla più
  vecchia. Senza agenti, dopo `welcome` arriva `error` `no_agents`. Il dispositivo manda comunque `hello` e `prefs`.
- Token sbagliato: `error` con codice `unauthorized`, poi chiusura con codice **4401** → il dispositivo
  non riprova da solo, chiede di rifare l'abbinamento.
- Su `voice.start` il connettore manda una scheda `listening`.
- `reply`: con `final: false` il testo è un pezzo da **aggiungere**; con `final: true` è il testo
  **completo**, che sostituisce quanto accumulato.
- `audio`: ogni messaggio è un file audio autonomo (`mp3`, `m4a` o `wav`) (di solito una frase), da suonare in ordine; `final` sull'ultimo.
- `transcript` per ora arriva solo `final` (niente parole parziali).
- Live Activity via APNs: `content-state` = `{ agent, agentName, state, card }` (sempre presente), per ogni
  scheda tranne `listening`. La notifica di avviso (categoria `HIKARO_REQUEST`) solo per le `request`.

## Agenti Hermes (v0.18.2, verificato sul codice)

- Un agente = un **profilo** Hermes, e **ogni** profilo diventa un agente (anche con `gateway.multiplex_profiles`
  attivo, quando un solo gateway fa girare tutti i bot Discord). Il connettore sceglie per ogni profilo come parlarci:
  - **API** (`/v1/runs` + `/events` SSE) se il profilo ha l'API server di Hermes e risponde: di solito `default`
    (porta 8642; senza multiplex anche gli altri profili con la loro porta 8643, 8644…). Il server API non ha un
    prefisso `/p/<profilo>`: con multiplex solo `default` può averlo.
  - **ACP** (Agent Client Protocol) per tutti gli altri: un processo `hermes -p <profilo> acp` per profilo, sempre
    acceso, JSON-RPC su stdio. È lo stesso agente (configurazione, memoria, skill, modello, server MCP del profilo) ma
    non avvia Discord, quindi non litiga col gateway. Gli strumenti sono quelli «da editor» di Hermes (terminale, file,
    web, browser, memoria, skill, delegate…), senza invio di messaggi né cron.
  - In `~/.hikaro/connector.json` → `agents.<profilo>.backend: "api" | "acp"` forza la scelta. Un agente passato
    all'API ci resta (un riavvio del gateway non sposta la sua chat).
- **Nomi veri**: ogni agente si chiama come il suo bot Discord (`global_name` o `username` di `GET /users/@me` con il
  `DISCORD_BOT_TOKEN` del `.env` del profilo; il token va solo a discord.com, nome in cache in `state.json`). Se non c'è
  un bot: la descrizione breve del profilo (`profile.yaml`), altrimenti il nome del profilo con la maiuscola
  («creads» → «Creads»); «Hermes» solo per `default` quando non si sa altro. `agents.<profilo>.name` vince sempre.
- **Tasti**: prima quelli scelti in `agents.<profilo>.key`, poi i liberi in ordine: `default` per primo (tasto 0),
  poi gli altri profili in ordine alfabetico.
- Approvazioni native → scheda `request` (+ `status: calling` + vibrazione), al massimo 3 opzioni:
  «Sì, solo ora» · «Sì, per la sessione» (oppure «Sì, sempre») · «No». API: `/v1/runs/{id}/approval`
  (`once`/`session`/`always`/`deny`). ACP: `session/request_permission` (opzioni `allow_once`, `allow_session`,
  `allow_always`, `deny`); la `choice` del dispositivo risponde alla richiesta. Hermes aspetta 60 s, poi rifiuta da sé:
  dopo, la scheda non è più valida.
- Istruzioni Hikaro (risposte brevi, blocco ```` ```hikaro ````): via API vanno in `instructions` a ogni messaggio;
  via ACP (che non ha un campo apposta) all'inizio del primo messaggio di ogni conversazione e ogni 8 messaggi.
- Una conversazione fissa del Deck per agente; via API la cronologia arriva da `/api/sessions/{id}/messages`,
  via ACP la tiene Hermes nella sessione ACP (salvata nello `state.db` del profilo, sopravvive ai riavvii).

## Conversazioni (sottochat Discord)

Ogni agente (bot = profilo Hermes) può avere molte conversazioni: le sottochat aperte su Discord e quella del Deck.
Per ogni agente il connettore ricorda quale usare (`session.select`), salvato in `~/.hikaro/state.json`:
- `"deck"` (predefinito): una conversazione propria del Deck, con la stessa memoria a lungo termine dell'agente;
- `"latest"`: segue la sottochat Discord più recente di quell'agente;
- un id: quella conversazione precisa.

Agenti via **API**: l'elenco viene da `/api/sessions?source=discord` (con multiplex, tolte quelle degli altri profili)
e i messaggi mandati dal Deck entrano proprio in quella conversazione di Hermes (l'agente se li ricorda), ma non
compaiono come messaggi nel canale Discord.

Agenti via **ACP**: l'elenco viene letto in sola lettura dallo `state.db` di Hermes (quello del profilo, e con multiplex
quello di `default`, righe `agent:<profilo>:discord:…`). ACP non può riaprire una conversazione Discord, quindi
**i messaggi del Deck restano in una sottochat collegata**: la prima volta il connettore crea una sessione ACP legata a
quella sottochat (salvata in `state.json`) e le passa, ben delimitati, gli ultimi ~20 messaggi della sottochat Discord;
ai messaggi successivi aggiunge solo quelli nuovi arrivati su Discord. Su Discord non cambia niente, e quello che si dice
dal Deck non torna nella sottochat Discord.

Dettagli dell'implementazione: in `sessions.items` la prima voce è sempre `{ id: "deck", title: "Chat del Deck",
source: "deck", updated }` (`updated` = 0 se mai usata); poi le sottochat con `title` = nome del thread (o titolo/anteprima
di Hermes), `channel` = nome del canale senza `#`, `updated` in epoch ms. `session.select` con un id che non esiste più →
`error` `bad_message`. Con `"latest"` e nessuna sottochat si usa la chat del Deck.

## Regole per gli agenti

- Risposte brevi. Le richieste di approvazione hanno **al massimo 3 opzioni**.
- Il connettore trasforma in scheda anche le risposte lunghe, accorciandole (titolo + righe + citazione).
- Un'approvazione nativa di Hermes (`/v1/runs/{id}/approval`) diventa una scheda `request`
  con opzioni; la `choice` del dispositivo viene rimandata a Hermes.

## Versioni

Campo `v` nel QR e `version` in `hello`/`welcome`. Le aggiunte compatibili non cambiano la versione;
i campi sconosciuti vanno ignorati, i `type` sconosciuti vanno ignorati senza errore.
