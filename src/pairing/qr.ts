import qrcode from "qrcode-terminal";

export interface PairParams {
  host: string;
  port: number;
  token: string;
  name: string;
  ts?: string | null | undefined;
}

/** hikaro://pair?v=1&host=…&port=…&token=…&name=…[&ts=…] (protocol/README.md). */
export function buildPairUrl(p: PairParams): string {
  const q = new URLSearchParams();
  q.set("v", "1");
  q.set("host", p.host);
  q.set("port", String(p.port));
  q.set("token", p.token);
  q.set("name", p.name);
  if (p.ts) q.set("ts", p.ts);
  return `hikaro://pair?${q.toString()}`;
}

export function parsePairUrl(url: string): PairParams | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "hikaro:" || u.hostname !== "pair") return null;
    const g = (k: string) => u.searchParams.get(k);
    const host = g("host");
    const token = g("token");
    if (!host || !token) return null;
    return { host, token, port: Number(g("port") ?? 8787), name: g("name") ?? "Mac", ts: g("ts") };
  } catch {
    return null;
  }
}

export function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.setErrorLevel("L");
    qrcode.generate(text, { small: true }, (qr) => resolve(qr));
  });
}
