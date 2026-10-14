/** Terminal output helpers (Italian, no colors when not a TTY). */
const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const title = (s: string) => console.log(`\n${c("1", s)}\n`);
export const ok = (s: string) => console.log(`  ${c("32", "✓")} ${s}`);
export const bad = (s: string) => console.log(`  ${c("31", "✗")} ${s}`);
export const warn = (s: string) => console.log(`  ${c("33", "!")} ${s}`);
export const info = (s: string) => console.log(`    ${c("2", s)}`);
