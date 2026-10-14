import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { createApnsJwt } from "../src/push/apns.js";

test("APNs JWT is ES256 with kid/iss/iat and a valid P-1363 signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwt = createApnsJwt(privateKey, "ABC123DEFG", "TEAM123456", 1_700_000_000);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "ES256", kid: "ABC123DEFG" });
  assert.deepEqual(JSON.parse(Buffer.from(c!, "base64url").toString()), { iss: "TEAM123456", iat: 1_700_000_000 });
  const sig = Buffer.from(s!, "base64url");
  assert.equal(sig.length, 64);
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig));
});
