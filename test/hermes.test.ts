import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/config.js";
import { DeckError } from "../src/core/errors.js";
import { approvalOptions, HermesBackend } from "../src/hermes/backend.js";
import { HermesClient, parseSseBlock } from "../src/hermes/client.js";
import { MockHermes } from "./mock-hermes.js";
import { tmpHome } from "./helpers.js";

const KEY = "0123456789abcdef0123456789abcdef";

function backendFor(mock: MockHermes): { backend: HermesBackend; state: StateStore } {
  const home = tmpHome();
  const hermesHome = mkdtempSync(join(tmpdir(), "hermes-"));
  writeFileSync(join(hermesHome, ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${KEY}\n`);
  const state = new StateStore(join(home, "state.json"));
  const backend = new HermesBackend({ hermesHome, hermesUrl: mock.url, overrides: {}, state });
  return { backend, state };
}

test("SSE block parsing", () => {
  assert.deepEqual(parseSseBlock('data: {"event":"message.delta","delta":"ciao"}'), { event: "message.delta", delta: "ciao" });
  assert.equal(parseSseBlock(": keepalive"), null);
  assert.deepEqual(parseSseBlock('event: assistant.delta\ndata: {"delta":"x"}'), { event: "assistant.delta", delta: "x" });
});

test("approval choices map to ≤3 options", () => {
  assert.deepEqual(approvalOptions(["once", "session", "always", "deny"]), ["once", "session", "deny"]);
  assert.deepEqual(approvalOptions(["once", "deny"]), ["once", "deny"]);
  assert.deepEqual(approvalOptions(undefined), ["once", "deny"]);
});

test("client: health, auth, hermes_down", async () => {
  const mock = await new MockHermes(KEY).start();
  try {
    assert.equal(await new HermesClient(mock.url, KEY).health(), true);
    assert.equal(await new HermesClient(mock.url, KEY).checkAuth(), true);
    assert.equal(await new HermesClient(mock.url, "wrong").checkAuth(), false);
    await assert.rejects(new HermesClient(mock.url, "wrong").startRun({ input: "x", sessionId: "s" }), (e: DeckError) => e.code === "agent_failed" && /chiave/.test(e.message));
  } finally {
    await mock.stop();
  }
  const down = new HermesClient("http://127.0.0.1:1", KEY);
  assert.equal(await down.health(500), false);
  await assert.rejects(down.startRun({ input: "x", sessionId: "s" }), (e: DeckError) => e.code === "hermes_down" && /Hermes non risponde/.test(e.message));
});

test("backend: streams a run with session id + instructions, keeps the session", async () => {
  const mock = await new MockHermes(KEY).start();
  try {
    const { backend, state } = backendFor(mock);
    assert.deepEqual((await backend.listAgents()).map((a) => a.id), ["default"]);
    assert.equal((await backend.health()).ok, true);
    const deltas: string[] = [];
    const r = await backend.send("default", "che email ho?", { delta: (d) => deltas.push(d), approval: () => assert.fail() });
    assert.match(r.text, /^Ciao Alberto\./);
    assert.equal(deltas.join(""), r.text);
    const run = mock.runs[0]!;
    const sid = state.get().sessions.default!;
    assert.match(sid, /^hikaro_default_[0-9a-f]{8}$/);
    assert.equal(run.body.session_id, sid);
    assert.match(run.body.instructions, /Hikaro/);
    assert.equal(run.body.conversation_history, undefined, "no history on the first turn");
    // second turn: history comes back from Hermes' session store
    await backend.send("default", "e ieri?", { delta: () => {}, approval: () => {} });
    assert.equal(mock.runs[1]!.body.session_id, sid);
    assert.equal(mock.runs[1]!.body.conversation_history.length, 2);
  } finally {
    await mock.stop();
  }
});

test("backend: native approval → request card → choice posted back", async () => {
  const mock = await new MockHermes(KEY).start();
  try {
    const { backend } = backendFor(mock);
    let resumed = false;
    const p = backend.send("default", "approva la pulizia", {
      delta: () => {},
      approval: (req) => {
        assert.equal(req.card.kind, "request");
        assert.deepEqual(req.card.options, ["Sì, solo ora", "Sì, per la sessione", "No"]);
        assert.equal(req.card.quote, "rm -rf build");
        void backend.resolve("default", req.ref, 2, "No");
      },
      resumed: () => (resumed = true),
    });
    const r = await p;
    assert.equal(r.text, "Va bene, non la cancello.");
    assert.deepEqual(mock.approvals, [{ runId: "run_1", choice: "deny" }]);
    assert.ok(resumed);
  } finally {
    await mock.stop();
  }
});

test("backend: run.failed → agent_failed", async () => {
  const mock = await new MockHermes(KEY).start();
  try {
    const { backend } = backendFor(mock);
    await assert.rejects(backend.send("default", "fallisci", { delta: () => {}, approval: () => {} }), (e: DeckError) => e.code === "agent_failed");
  } finally {
    await mock.stop();
  }
});
