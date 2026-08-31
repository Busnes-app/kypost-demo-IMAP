# KyPost IMAP DEMO

KyPost IMAP DEMO is a demo backend IMAP / SMTP server for a demo KyPost server for testing and app store validation.

## Layout

| Path | Owns |
|------|------|
| `src/index.js` | config, listeners, TLS wiring, IP allowlist |
| `src/imap.js` | IMAP4rev1 subset (see invariants) |
| `src/smtp.js` | SMTP submission, STARTTLS, black hole |
| `src/carddav.js` | CardDAV over HTTPS + gated `/admin/reset` |
| `src/store.js` | in-memory personas, folder aliasing, reset |
| `src/corpus.js` | loads and validates the deliverable `.eml` corpus |
| `src/deliver.js` | trigger addresses, header rewriting, ambient drip |
| `corpus/` | `.eml` fixtures plus `manifest.json` |
| `src/seed.js` | seed messages and vCards |
| `src/tls.js` | boot-time self-signed certificate |
| `test/acceptance/` | Go acceptance suite, run via `./test/run.sh` |

## Invariants

Break one of these and the demo stops working with KyPost Server:

- **The IMAP client is the spec.** KyPost Server uses
  `github.com/BrianLeishman/go-imap` v0.1.28. It dials **implicit TLS only**,
  never sets `TLSSkipVerify`, parses `INTERNALDATE` with a hard error, and needs
  RFC 4731 `ESEARCH` for `GetMaxUID`. Read that library before changing a
  response format.
- **No relay path in `src/smtp.js`.** Accepting, filing into `Sent Items` and
  dropping is the whole contract. No MX lookup, no forwarding, ever.
- **Mail ports are never published.** No `ports:` on `kypost-demo-mail`, and the
  application allowlist rejects before the TLS handshake, not after.
- **`Sent` and `Sent Items` are the same tray.** SMTP writes one copy and KyPost
  Server APPENDs another; `store.js` aliases the names and de-duplicates on
  `Message-ID`.
- **Reset is off by default** and refuses to start enabled without a 16+
  character token.
- **No keys or certificates in the repository or the image.** Generated at boot;
  only the certificate is shared, never the key.
- **Personas are created by IMAP `LOGIN` only.** Never by an SMTP envelope and
  never by CardDAV, or a stranger's `MAIL FROM` would allocate a mailbox.
  Creation is capped at `MAX_PERSONAS` (checked in `store.js`, which refuses to
  start on a value that is not a positive integer). SMTP files against the
  authenticated login; `forAddress` consults the envelope sender only for a
  session that never authenticated, so a spoofed `MAIL FROM` cannot write into
  another tester's mailbox.
- **Corpus delivery regenerates `Message-ID` and `Date`.** `addMessageDeduped`
  drops a second copy sharing an ID, so a fixture delivered twice with its
  stored ID would silently vanish.
- **Encrypted trigger replies use only the sender-matching Autocrypt public
  key.** The demo server never requests, receives, or stores a user's private
  key; a missing or invalid key skips the encrypted reply instead of sending
  plaintext.
- **Drip delivery is capped at 15 messages per INBOX.** After each drip the
  oldest messages are evicted so the folder never exceeds this count. Without
  this the drip loop grows every persona's INBOX without bound and the
  container OOMs after a few days of uptime. The cap lives in `deliver.js` as
  `MAX_DRIP_MESSAGES`.
- **`src/smtp.js` never branches on recipients.** It reports what it accepted
  through `onAccepted` and nothing more. Trigger routing lives in
  `src/deliver.js`.

## Verification

`./test/run.sh` starts the server on high ports and drives it with the real
client library. Anything that changes protocol behaviour needs a test there.
`docker build .` plus a run with `--read-only --cap-drop ALL` is the deployment
check.

# Ponytail, lazy senior dev mode

Use the smallest correct change.

1. Reuse what already exists.
2. Prefer stdlib and native platform APIs.
3. Add dependencies only when they remove meaningful code.
4. Fix shared root causes, not one caller.
5. If a shortcut has a limit, mark it with `ponytail:` and name the upgrade path.

Non-trivial logic must include one runnable check (unit test or minimal self-check).

# DOX framework

## Core Contract

- AGENTS.md files are binding contracts for their subtree.
- Read from root to nearest AGENTS.md before editing.
- The nearest AGENTS.md controls local details; parent docs keep global rules.

## Update After Editing

- Run a DOX pass for every meaningful change.
- Update nearest owning AGENTS.md when behavior, responsibilities, or verification changes.
- Keep Child DOX Index entries current and delete stale rules.

## User Preferences

- Best-effort 90-second keyword refresh policy (foreground cadence; background catch-up on resume).
- DOX hierarchy scope is app-only.

## Child DOX Index

