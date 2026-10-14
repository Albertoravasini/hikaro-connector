import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** 100.64.0.0/10 — Tailscale's CGNAT range. */
export function isTailscaleIp(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export function isPrivateLan(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

type Ifaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Best LAN IPv4: private ranges first, Wi-Fi/Ethernet (en*) first, no Tailscale/link-local. */
export function lanIPv4(ifaces: Ifaces = networkInterfaces()): string | null {
  const cands: { ip: string; score: number }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (i.address.startsWith("169.254.") || isTailscaleIp(i.address)) continue;
      let score = 0;
      if (isPrivateLan(i.address)) score += 10;
      if (/^en\d/.test(name)) score += 5 - Math.min(4, Number(name.slice(2)) || 0);
      if (/^(utun|bridge|vmnet|vboxnet|docker|llw|awdl)/.test(name)) score -= 20;
      cands.push({ ip: i.address, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0]?.ip ?? null;
}

const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

function run(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (bin.startsWith("/") && !existsSync(bin)) return resolve(null);
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Tailscale MagicDNS name (preferred) or 100.x IP, if Tailscale is running. */
export async function tailscaleHost(ifaces: Ifaces = networkInterfaces()): Promise<string | null> {
  for (const bin of TAILSCALE_BINS) {
    const out = await run(bin, ["status", "--json"], 2_500);
    if (!out) continue;
    try {
      const j = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
      if (j.BackendState && j.BackendState !== "Running") return null;
      const dns = j.Self?.DNSName?.replace(/\.$/, "");
      if (dns) return dns;
      const ip = j.Self?.TailscaleIPs?.find((x) => x.includes("."));
      if (ip) return ip;
    } catch {
      /* try next */
    }
  }
  // Fallback: an interface with a Tailscale address.
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) if (i.family === "IPv4" && isTailscaleIp(i.address)) return i.address;
  }
  return null;
}
