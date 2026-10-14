import assert from "node:assert/strict";
import { test } from "node:test";
import { isTailscaleIp, lanIPv4 } from "../src/pairing/network.js";
import { buildPairUrl, parsePairUrl } from "../src/pairing/qr.js";

test("pairing URL matches the protocol format", () => {
  const url = buildPairUrl({ host: "192.168.1.20", port: 8787, token: "abc_DEF-123", name: "Mac-mini", ts: "mac-mini.tail1234.ts.net" });
  assert.equal(url, "hikaro://pair?v=1&host=192.168.1.20&port=8787&token=abc_DEF-123&name=Mac-mini&ts=mac-mini.tail1234.ts.net");
  assert.deepEqual(parsePairUrl(url), { host: "192.168.1.20", port: 8787, token: "abc_DEF-123", name: "Mac-mini", ts: "mac-mini.tail1234.ts.net" });
  const noTs = buildPairUrl({ host: "10.0.0.2", port: 9000, token: "t", name: "Mac di Alberto" });
  assert.ok(!noTs.includes("ts="));
  assert.equal(parsePairUrl(noTs)?.name, "Mac di Alberto");
  assert.equal(parsePairUrl("https://example.com"), null);
});

test("LAN IP selection prefers en* private addresses and skips Tailscale", () => {
  const mk = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
  const ifaces = {
    lo0: [mk("127.0.0.1", true)],
    utun4: [mk("100.101.102.103")],
    bridge100: [mk("192.168.64.1")],
    en1: [mk("10.0.0.7")],
    en0: [mk("192.168.1.20")],
  };
  assert.equal(lanIPv4(ifaces), "192.168.1.20");
  assert.equal(lanIPv4({ lo0: [mk("127.0.0.1", true)] }), null);
  assert.ok(isTailscaleIp("100.64.0.1"));
  assert.ok(!isTailscaleIp("100.20.0.1"));
});
