import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEnvChanges, planSetup, upsertEnv } from "../src/hermes/envfile.js";
import { listProfiles, readProfileKey, resolveEndpoints, isMultiplexOn } from "../src/hermes/profiles.js";

test("upsertEnv replaces existing keys and appends missing ones, keeping everything else", () => {
  const before = "# my keys\nOPENROUTER_API_KEY=sk-x\nexport API_SERVER_PORT=9000\n\nFOO=bar # comment\n";
  const after = upsertEnv(before, { API_SERVER_PORT: "8643", API_SERVER_ENABLED: "true" });
  assert.match(after, /^# my keys\nOPENROUTER_API_KEY=sk-x\nAPI_SERVER_PORT=8643\n\nFOO=bar # comment\n/);
  assert.match(after, /# Hikaro connector.*\nAPI_SERVER_ENABLED=true\n$/);
  // idempotent
  assert.equal(upsertEnv(after, { API_SERVER_PORT: "8643", API_SERVER_ENABLED: "true" }), after);
  assert.equal(upsertEnv("", { A: "1" }).trim().split("\n").pop(), "A=1");
});

function fakeHermes(): string {
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  writeFileSync(join(home, "config.yaml"), "model: x\n");
  writeFileSync(join(home, ".env"), "OPENROUTER_API_KEY=sk-secret\n", { mode: 0o600 });
  for (const [name, env] of [
    ["outreach", "API_SERVER_ENABLED=true\nAPI_SERVER_KEY=0123456789abcdef0123\nAPI_SERVER_PORT=8643\n"],
    ["dev", ""],
    ["Bad Name", ""],
  ] as const) {
    mkdirSync(join(home, "profiles", name), { recursive: true });
    writeFileSync(join(home, "profiles", name, ".env"), env);
  }
  return home;
}

test("profile discovery + setup plan", () => {
  const home = fakeHermes();
  const profiles = listProfiles(home);
  assert.deepEqual(profiles.map((p) => p.name), ["default", "dev", "outreach"]);
  assert.equal(isMultiplexOn(home, {}), false);

  const plan = planSetup(profiles, false, readProfileKey, "k".repeat(64));
  const by = Object.fromEntries(plan.profiles.map((p) => [p.profile, p]));
  assert.deepEqual(by.default!.changes, { API_SERVER_ENABLED: "true", API_SERVER_KEY: "k".repeat(64) });
  assert.equal(by.default!.port, 8642);
  assert.equal(by.dev!.port, 8644, "8643 is taken by outreach");
  assert.equal(by.dev!.changes.API_SERVER_PORT, "8644");
  assert.deepEqual(by.outreach!.changes, {}, "already configured profiles are left alone");

  // apply → backup + 0600 + other keys preserved
  const backup = applyEnvChanges(join(home, ".env"), by.default!.changes);
  assert.ok(backup && readFileSync(backup, "utf8") === "OPENROUTER_API_KEY=sk-secret\n");
  const env = readFileSync(join(home, ".env"), "utf8");
  assert.match(env, /^OPENROUTER_API_KEY=sk-secret\n/);
  assert.match(env, /API_SERVER_KEY=k{64}/);
  assert.equal(statSync(join(home, ".env")).mode & 0o777, 0o600);
  applyEnvChanges(join(home, "profiles", "dev", ".env"), by.dev!.changes);
  assert.equal(readdirSync(home).filter((f) => f.includes("hikaro-backup")).length, 1);

  const eps = resolveEndpoints({ hermesHome: home });
  assert.deepEqual(eps.map((e) => [e.id, e.url, e.name]), [
    ["dev", "http://127.0.0.1:8644", "Dev"],
    ["outreach", "http://127.0.0.1:8643", "Outreach"],
    ["default", "http://127.0.0.1:8642", "Hermes"],
  ]);
  assert.equal(eps[2]!.key, "k".repeat(64));
  // hidden override + explicit HERMES_URL
  const eps2 = resolveEndpoints({ hermesHome: home, hermesUrl: "http://10.0.0.5:9999", overrides: { dev: { hidden: true } } });
  assert.deepEqual(eps2.map((e) => e.url), ["http://127.0.0.1:8643", "http://10.0.0.5:9999"]);
});

test("multiplex mode: only the default profile", () => {
  const home = fakeHermes();
  writeFileSync(join(home, "config.yaml"), "gateway:\n  multiplex_profiles: true\n");
  assert.equal(isMultiplexOn(home, {}), true);
  const plan = planSetup(listProfiles(home), true, readProfileKey);
  assert.deepEqual(plan.profiles.map((p) => p.profile), ["default"]);
  assert.equal(plan.skipped.length, 2);
  assert.deepEqual(resolveEndpoints({ hermesHome: home }).map((e) => e.id), ["default"]);
});
