/** launchd LaunchAgent `app.hikaro.connector` — keeps the connector running across reboots. */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LAUNCHD_LABEL } from "../config.js";

export function plistPath(label = LAUNCHD_LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface PlistOpts {
  label?: string;
  nodePath: string;
  scriptPath: string;
  args?: string[];
  logFile: string;
  workingDir: string;
  env?: Record<string, string>;
}

export function buildPlist(o: PlistOpts): string {
  const args = [o.nodePath, o.scriptPath, ...(o.args ?? ["start"])];
  const env = o.env ?? {};
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(o.label ?? LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(o.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logFile)}</string>
</dict>
</plist>
`;
}

export function launchctl(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("launchctl", args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export async function isLoaded(label = LAUNCHD_LABEL): Promise<boolean> {
  return (await launchctl(["print", `${domain()}/${label}`])).code === 0;
}

export async function installAgent(o: PlistOpts): Promise<string> {
  const label = o.label ?? LAUNCHD_LABEL;
  const file = plistPath(label);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(o.logFile), { recursive: true });
  await launchctl(["bootout", `${domain()}/${label}`]); // ignore "not loaded"
  writeFileSync(file, buildPlist(o), { mode: 0o644 });
  const r = await launchctl(["bootstrap", domain(), file]);
  if (r.code !== 0 && !(await isLoaded(label))) throw new Error(`launchctl bootstrap: ${r.out.trim()}`);
  await launchctl(["enable", `${domain()}/${label}`]);
  return file;
}

export async function restartAgent(label = LAUNCHD_LABEL): Promise<boolean> {
  return (await launchctl(["kickstart", "-k", `${domain()}/${label}`])).code === 0;
}

export async function uninstallAgent(label = LAUNCHD_LABEL): Promise<boolean> {
  await launchctl(["bootout", `${domain()}/${label}`]);
  const file = plistPath(label);
  if (existsSync(file)) {
    unlinkSync(file);
    return true;
  }
  return false;
}

/** PATH for the service: launchd starts with a minimal PATH. */
export function servicePath(): string {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/Applications/Tailscale.app/Contents/MacOS",
  ].join(":");
}
