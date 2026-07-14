# Contributing to pushforge

Issues, discussions and pull requests are all welcome — this project aims to
stay small, zero-dependency at runtime, and boringly correct about the RFCs.

## Getting started

Requirements: Node.js >= 22.13 (stable `node:test` runner + WebCrypto on `globalThis`).

```bash
git clone https://github.com/JaydenCJ/pushforge.git
cd pushforge
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 90 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check in a temp dir
```

`scripts/smoke.sh` exercises the real CLI (keygen, mock subscriber, store,
encrypted dry-run send, decrypt round-trip, queue, exit codes) entirely
offline and must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass; anything touching `ece.ts` must keep
   the RFC 8291 Appendix A vector test green byte-for-byte.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable modules
   (crypto, store and queue all take injected clocks/transports — only the
   CLI touches `Date.now()` and real I/O defaults).
5. Never introduce a test that opens a socket or sleeps: transports are
   injected, clocks are parameters.

## Ground rules

- **No runtime dependencies.** Node's `crypto.subtle`, `fs` and `path` are
  the entire platform surface; adding a dependency needs justification in
  the PR and will usually be declined.
- **No network calls except the one the user asked for** — the POST to the
  push service on a real `send`/`drain`. No telemetry, no update checks,
  nothing at startup. Every test and the smoke script run fully offline.
- Key material never leaks: private keys stay out of stdout listings, logs
  and error messages; the CLI prints subscription ids, not capability URLs.
- Follow the RFC over the folklore. Where 0.1.0 deliberately narrows scope
  (single-record `aes128gcm` only), the limitation is documented and the
  rejection is explicit — extend it, don't silently accept garbage.
- File formats are versioned envelopes; a format change bumps the version
  and keeps a loud error for files this build cannot read.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `pushforge --version` output, the exact command line, and —
for delivery problems — the push service's HTTP status code and the
relevant `queue-status --json` snippet. For encryption interop reports, a
mock-subscriber reproduction (`pushforge mock` + `send --dry-run` +
`decrypt`) is ideal because it is fully shareable: no real endpoints, no
real keys.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead. Reports about key
handling, the encryption path or the JWT construction are treated with
priority.
