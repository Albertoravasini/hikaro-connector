import { macName } from "../config.js";
import { lanIPv4, tailscaleHost } from "./network.js";
import { buildPairUrl, renderQr } from "./qr.js";

export interface PairingInfo {
  url: string;
  host: string;
  ts: string | null;
}

export async function pairingInfo(port: number, token: string): Promise<PairingInfo> {
  const host = lanIPv4() ?? "127.0.0.1";
  const ts = await tailscaleHost();
  return { url: buildPairUrl({ host, port, token, name: macName(), ts }), host, ts };
}

/** Print the pairing QR + URL in the Terminal (Italian). */
export async function printPairing(port: number, token: string): Promise<PairingInfo> {
  const info = await pairingInfo(port, token);
  const qr = await renderQr(info.url);
  const out = [
    "",
    "  Inquadra questo codice con l'app Hikaro sull'iPhone:",
    "",
    qr.replace(/^/gm, "  "),
    `  Mac: ${macName()}  ·  in casa: ${info.host}:${port}${info.ts ? `  ·  fuori casa (Tailscale): ${info.ts}` : ""}`,
    "",
    "  Se il QR non si legge, copia questo indirizzo nell'app:",
    `  ${info.url}`,
    "",
  ];
  console.log(out.join("\n"));
  return info;
}
