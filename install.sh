#!/usr/bin/env bash
# Hikaro — installa il connettore sul Mac dove gira Hermes (di solito il Mac Mini).
#
#   curl -fsSL https://raw.githubusercontent.com/Albertoravasini/hikaro-connector/main/install.sh | bash
#
# Cosa fa (si può rilanciare quante volte vuoi, riprende da dove si era fermato):
#   1. controlla macOS e trova Node 20+ (quello nel PATH, quello di Hermes in ~/.hermes/node,
#      altrimenti ne scarica uno da nodejs.org in ~/.hikaro/node — senza sudo)
#   2. scarica il connettore in ~/.hikaro/connector, npm ci + build
#   3. crea il comando hikaro-connector (in ~/.local/bin)
#   4. lancia «hikaro-connector setup»: accende l'API di Hermes (copia di sicurezza del .env,
#      riavvia il gateway senza perdere Discord), installa la voce sul Mac (Whisper + Kokoro,
#      nessuna chiave), installa il servizio che resta acceso dopo il riavvio, mostra il QR.
#
# Variabili utili:
#   HIKARO_CONNECTOR_SRC   da dove prendere il codice: URL di un tarball (.tar.gz),
#                          URL git (….git / git@…) oppure una cartella locale.
#   HIKARO_SETUP_ARGS      opzioni per «hikaro-connector setup» (es. "--no-voice --dry-run").
#   HIKARO_NODE_DIST       mirror di nodejs.org/dist (per i test).
#   HIKARO_NODE_DOWNLOAD=1 ignora i Node già presenti e scarica il suo (per i test).

set -euo pipefail

DEFAULT_SRC="https://github.com/Albertoravasini/hikaro-connector/archive/refs/heads/main.tar.gz"
NODE_DIST="${HIKARO_NODE_DIST:-https://nodejs.org/dist}"
NODE_LINE="latest-v22.x"

main() {
  export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
  local src="${HIKARO_CONNECTOR_SRC:-$DEFAULT_SRC}"
  local hikaro_dir="${HIKARO_HOME:-$HOME/.hikaro}"
  local dest="$hikaro_dir/connector"
  local bin_dir="$HOME/.local/bin"

  bold() { printf '\n\033[1m%s\033[0m\n\n' "$1"; }
  ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
  info() { printf '    %s\n' "$1"; }
  warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
  die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '    %s\n' "$2" >&2; exit 1; }

  bold "Hikaro · installo il connettore"

  # 1. macOS + Node ≥ 20 -----------------------------------------------------
  [ "$(uname -s)" = "Darwin" ] || die "Questo installer è per macOS (il Mac dove gira Hermes)."
  ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
  mkdir -p "$hikaro_dir"
  chmod 700 "$hikaro_dir"

  node_ok() { # $1 = path to a node binary
    [ -x "$1" ] || return 1
    local major
    major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "${major:-0}" -ge 20 ] 2>/dev/null
  }

  local node_bin=""
  local cand
  [ "${HIKARO_NODE_DOWNLOAD:-0}" = "1" ] || for cand in "$(command -v node 2>/dev/null || true)" "$HOME/.hermes/node/bin/node" "$HOME/.local/bin/node" \
              /opt/homebrew/bin/node /usr/local/bin/node "$hikaro_dir/node/bin/node"; do
    if [ -n "$cand" ] && node_ok "$cand"; then node_bin="$cand"; break; fi
  done

  if [ -z "$node_bin" ]; then
    local arch
    case "$(uname -m)" in
      arm64) arch="darwin-arm64" ;;
      x86_64) arch="darwin-x64" ;;
      *) die "Processore non riconosciuto ($(uname -m))." ;;
    esac
    info "Node 20+ non c'è: ne scarico uno solo per Hikaro (in $hikaro_dir/node, niente sudo)…"
    local tmpn sums file
    tmpn="$(mktemp -d "${TMPDIR:-/tmp}/hikaro-node.XXXXXX")"
    sums="$(curl -fsSL "$NODE_DIST/$NODE_LINE/SHASUMS256.txt")" || die "Non riesco a contattare nodejs.org." "Controlla la connessione a Internet e riprova."
    file="$(printf '%s\n' "$sums" | awk -v a="$arch" '$2 ~ ("^node-v[0-9.]+-" a "\\.tar\\.gz$") {print $2; exit}')"
    [ -n "$file" ] || die "Non trovo Node per $arch su nodejs.org."
    curl -fL --progress-bar -o "$tmpn/$file" "$NODE_DIST/$NODE_LINE/$file" || die "Download di Node non riuscito." "Riprova."
    local want got
    want="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')"
    got="$(shasum -a 256 "$tmpn/$file" | awk '{print $1}')"
    [ "$want" = "$got" ] || die "Il file di Node scaricato è rovinato (checksum diverso)." "Riprova."
    rm -rf "$hikaro_dir/node.new"
    mkdir -p "$hikaro_dir/node.new"
    tar -xzf "$tmpn/$file" -C "$hikaro_dir/node.new" --strip-components 1
    rm -rf "$hikaro_dir/node" "$tmpn"
    mv "$hikaro_dir/node.new" "$hikaro_dir/node"
    node_bin="$hikaro_dir/node/bin/node"
    node_ok "$node_bin" || die "Node scaricato ma non parte."
  fi
  local node_dir
  node_dir="$(cd "$(dirname "$node_bin")" && pwd -P)"
  node_bin="$node_dir/$(basename "$node_bin")"
  export PATH="$node_dir:$PATH"
  local npm_bin="$node_dir/npm"
  [ -x "$npm_bin" ] || npm_bin="$(command -v npm 2>/dev/null || true)"
  [ -n "$npm_bin" ] || die "npm non trovato accanto a $node_bin."
  ok "Node $("$node_bin" -v) ($node_bin)"

  # 2. Download into a temp dir, then swap atomically -------------------------
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/hikaro-install.XXXXXX")"
  # Expanded now: the EXIT trap runs after main() returns, when the local is gone (set -u).
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  local root="$tmp/src"
  mkdir -p "$root"
  if [ -d "$src" ]; then
    (cd "$src" && tar --exclude node_modules --exclude dist --exclude build-test -cf - .) | (cd "$root" && tar -xf -)
    ok "Codice preso da $src"
  elif [[ "$src" == *.git || "$src" == git@* ]]; then
    command -v git >/dev/null 2>&1 || die "Serve git per scaricare da $src." "Installa gli strumenti con «xcode-select --install»."
    rmdir "$root"
    git clone --quiet --depth 1 "$src" "$root" || die "Non riesco a scaricare il connettore da $src."
    ok "Scaricato (git)"
  elif [ -f "$src" ]; then
    tar -xzf "$src" -C "$root" || die "Non riesco ad aprire $src."
    ok "Codice preso da $src"
  else
    curl -fsSL "$src" | tar -xz -C "$root" || die "Non riesco a scaricare il connettore." "Controlla la connessione a Internet e riprova."
    ok "Scaricato"
  fi

  # GitHub tarballs have one top folder (hikaro-connector-main/); the Hikaro monorepo has …/connector.
  local pkg
  pkg="$(find "$root" -maxdepth 3 -name package.json -not -path '*/node_modules/*' -exec grep -l '"name": "hikaro-connector"' {} + 2>/dev/null | head -n 1 || true)"
  [ -n "$pkg" ] || die "Nel pacchetto scaricato non trovo il connettore." "Controlla HIKARO_CONNECTOR_SRC ($src)."
  local pkg_dir
  pkg_dir="$(dirname "$pkg")"

  rm -rf "$dest.new" "$dest.old"
  mkdir -p "$dest.new"
  (cd "$pkg_dir" && tar --exclude node_modules --exclude dist --exclude build-test -cf - .) | (cd "$dest.new" && tar -xf -)

  # 3. Build in the new dir; only swap if it worked (the running service keeps the old copy meanwhile).
  info "Installo le dipendenze (può volerci un minuto)…"
  (cd "$dest.new" && "$npm_bin" ci --no-audit --no-fund --loglevel=error >/dev/null) || die "npm ci non è riuscito." "Riprova; se succede ancora scrivi a Hikaro con l'errore qui sopra."
  (cd "$dest.new" && "$npm_bin" run --silent build >/dev/null) || die "La compilazione non è riuscita."
  if [ -d "$dest" ]; then mv "$dest" "$dest.old"; fi
  mv "$dest.new" "$dest"
  rm -rf "$dest.old"
  ok "Connettore installato in $dest"

  # 4. Command (absolute node path: launchd and new Terminals find it without PATH tricks)
  mkdir -p "$hikaro_dir/bin" "$bin_dir"
  local home_line=""
  [ -n "${HIKARO_HOME:-}" ] && home_line="export HIKARO_HOME=\"$HIKARO_HOME\""
  cat > "$hikaro_dir/bin/hikaro-connector" <<EOF
#!/bin/sh
$home_line
exec "$node_bin" "$dest/dist/index.js" "\$@"
EOF
  chmod 755 "$hikaro_dir/bin/hikaro-connector"
  ln -sf "$hikaro_dir/bin/hikaro-connector" "$bin_dir/hikaro-connector"
  ok "Comando hikaro-connector pronto"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "Aggiungi $bin_dir al PATH per usare hikaro-connector da ogni Terminale:"
       # shellcheck disable=SC2016  # printed literally, for the user to paste
       printf '      echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.zshrc\n' ;;
  esac

  # 5. Setup (Hermes API, local voice, service, QR)
  # shellcheck disable=SC2086
  "$hikaro_dir/bin/hikaro-connector" setup ${HIKARO_SETUP_ARGS:-} </dev/null
}

main "$@"
