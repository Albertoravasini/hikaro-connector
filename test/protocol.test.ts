import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CARD_LIMITS, parseDeviceMessage, type Card } from "../src/protocol.js";

const EXAMPLES = resolve(process.cwd(), "..", "protocol", "examples");

test("device messages parse", () => {
  const ok = (raw: unknown) => {
    const r = parseDeviceMessage(JSON.stringify(raw));
    assert.ok(r.ok, JSON.stringify(r));
    return r.ok ? r.message : null;
  };
  assert.deepEqual(ok({ type: "hello", device: "iphone", version: "1", name: "iPhone di Alberto" }), {
    type: "hello",
    device: "iphone",
    version: "1",
    name: "iPhone di Alberto",
  });
  assert.deepEqual(ok({ type: "voice.start", agent: "dev", id: "v1", extra: 1 }), { type: "voice.start", agent: "dev", id: "v1" });
  assert.deepEqual(ok({ type: "choice", card: "c_1", index: 2, option: "Modifica a voce" }), {
    type: "choice",
    card: "c_1",
    index: 2,
    option: "Modifica a voce",
  });
  assert.deepEqual(ok({ type: "push.register", token: "abc", kind: "liveactivity", env: "production" }), {
    type: "push.register",
    token: "abc",
    kind: "liveactivity",
    env: "production",
  });
  assert.deepEqual(ok({ type: "ping" }), { type: "ping" });
  assert.deepEqual(ok({ type: "prefs", voice: "nova", speak: false }), { type: "prefs", voice: "nova", speak: false });
  assert.deepEqual(ok({ type: "prefs", speak: "yes", voice: 3 }), { type: "prefs" }, "wrong field types are dropped");
  assert.deepEqual(ok({ type: "key.tap", agent: "outreach" }), { type: "key.tap", agent: "outreach" });
});

test("unknown types are ignored, malformed ones are bad_message", () => {
  const unknown = parseDeviceMessage(JSON.stringify({ type: "future.thing", x: 1 }));
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.ignored, true);
  for (const raw of ["not json", "[]", "{}", JSON.stringify({ type: "voice.start" }), JSON.stringify({ type: "choice", card: "c", index: -1 })]) {
    const r = parseDeviceMessage(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(!r.ok && r.ignored, false, raw);
  }
});

test("protocol/examples are valid", () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const msg = JSON.parse(readFileSync(join(EXAMPLES, f), "utf8")) as { type: string; card?: Card };
    assert.equal(typeof msg.type, "string", f);
    if (["voice.start", "choice", "voice.end", "key.tap"].includes(msg.type)) {
      assert.ok(parseDeviceMessage(JSON.stringify(msg)).ok, f);
    }
    if (msg.type === "card") {
      const c = msg.card!;
      assert.ok(c.id && c.agent && c.kind && c.title && typeof c.ts === "number", f);
      assert.ok(c.title.length <= CARD_LIMITS.title, f);
      assert.ok((c.options?.length ?? 0) <= CARD_LIMITS.options, f);
    }
  }
});
