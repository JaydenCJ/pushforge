/** Shared fixtures for the pushforge test suite: the RFC 8291 Appendix A
 * test vector, temp-dir plumbing and a CLI runner. Everything is offline
 * and deterministic — no sockets are ever opened. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CLI = join(ROOT, "dist", "cli.js");

/** RFC 8291 Appendix A — the one interop vector every Web Push stack must hit. */
export const RFC8291_VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLoc" +
    "InmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLV" +
    "WGNWQexSgSxsj_Qulcy4a-fN",
};

/** Create a temp dir that is removed when the test (or subtest) finishes. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pushforge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the built CLI synchronously; returns { code, stdout, stderr }. */
export function runCli(args, options = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    input: options.input,
    cwd: options.cwd ?? ROOT,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Build an EC private JWK from compact base64url public + private parts. */
export function jwkFrom(publicKeyB64, privateKeyB64, b64urlDecode, b64urlEncode) {
  const raw = b64urlDecode(publicKeyB64);
  return {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(raw.slice(1, 33)),
    y: b64urlEncode(raw.slice(33, 65)),
    d: privateKeyB64,
  };
}

/** A transport stub that records requests and replies from a status script. */
export function scriptedTransport(statuses) {
  const requests = [];
  let index = 0;
  const transport = async (request) => {
    requests.push(request);
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    if (status === "throw") throw new Error("network unreachable (simulated)");
    return { status };
  };
  transport.requests = requests;
  return transport;
}
