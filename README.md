# KyPost Demo Mail Server

A sandbox IMAP, SMTP and CardDAV server for KyPost Server development, automated
testing and app store review. It serves three pre-seeded personas, accepts any
login, and destroys every message you send it.

Nothing here ever touches the live internet: there is no relay path, no MX
lookup, and no public route to any mail port.

## Quick start

```sh
cp .env.example .env
$EDITOR .env                 # set CLOUDFLARED_TUNNEL_TOKEN
docker compose up -d --build
```

That brings up three containers on `KyPost-Net` (`172.30.0.0/24`):

| Container          | Address       | Reachable from                    |
|--------------------|---------------|-----------------------------------|
| `kypost-server`    | `172.30.0.10` | cloudflared, and the demo mail server's allowlist |
| `kypost-demo-mail` | `172.30.0.20` | **KyPost Server only**            |
| `kypost-cloudflared` | `172.30.0.30` | the internet, via `demo.kypost.org` |

Point the tunnel's `demo.kypost.org` hostname at `http://kypost-server:5866` in
the Cloudflare dashboard. Do not add a hostname for the mail server.

## Personas

Any username and password is accepted. The username selects which seeded
mailbox you get; the password is ignored.

| Persona | Address                      | What it exercises                              |
|---------|------------------------------|------------------------------------------------|
| alice   | `alice@kypost-demo.local`    | plain text, HTML, multi-recipient, deep threads, empty body |
| bob     | `bob@kypost-demo.local`      | inline PGP, PGP/MIME, clear-signed, malformed MIME boundary |
| charlie | `charlie@kypost-demo.local`  | attachments, `multipart/related`, legacy charsets, Bcc |

The **local part** of the username selects the mailbox: `bob@anything` maps to
bob, `charlie@anything` to charlie, and a name that is not one of the three
seeded personas gets a mailbox of its own, created on first login. SMTP files a
session's Sent copies against the account it authenticated as, so they always
land in the mailbox that session reads. Persona selection is KyPost Server's
decision — the demo server only looks up the name it is handed.

Every persona exposes `INBOX`, `Drafts`, `Sent Items`, `Trash` and `Archive`.
`Sent`, `INBOX/Sent`, `Deleted Items` and friends are aliases of those five, so
a client that guesses a different name still lands in the right tray.

## Making mail arrive

Send a message from the app to any of these addresses. The domain does not
matter and case is ignored, so `Deliver-Mail@anything` works.

| Address | Delivers |
|---|---|
| `deliver-mail@` | An ordinary message |
| `deliver-crypto-good@` | A real OpenPGP message encrypted to the sender's Autocrypt public key |
| `deliver-crypto-bad@` | Broken signature, truncated armor, bad keydata |
| `deliver-mime-bad@` | Unclosed boundary, bogus charset, broken base64 |
| `deliver-batch@` | One of each |

An unrecognised `deliver-*` address, or any other address, delivers nothing —
the SMTP submission is still accepted and filed to `Sent Items` as usual.
Delivery failures (a bug in header rewriting, for instance) are logged
server-side and never change the SMTP response, so a demo that silently isn't
receiving injected mail needs a look at the server log, not the SMTP
transcript.

The encrypted trigger requires KyPost's outgoing `Autocrypt` header. The demo
server validates that its `addr` matches the SMTP envelope sender and uses only
the public key; it never receives or stores the user's private key.

Mail also arrives on its own every 15–30 minutes for any account that has
logged in, so a reviewer who touches nothing still sees a notification. Set
`DRIP_SECONDS` to override the interval for testing.

Every login gets its own mailbox, seeded from the same template. Log in as
`anything@kypost-demo.local` with any password. Up to `MAX_PERSONAS` (default
100) mailboxes exist at once, seeded personas included. A non-numeric or
non-positive `MAX_PERSONAS` stops the server at startup rather than silently
lifting the limit.

Mailboxes are never removed, so once the cap is reached further logins are
refused for the life of the process. `/admin/reset` re-seeds the existing
mailboxes but does not free any: restart the container to get the demo back.

### Adding a case to the corpus

Drop an `.eml` file in `corpus/` and add three lines to `corpus/manifest.json`:
the filename, one of the four categories, and what KyPost should do with it. No
code changes. A malformed manifest fails startup by name.

### Known limitation: IDLE

The server advertises `IDLE` but never sends an untagged `EXISTS`. A client
sitting in IDLE will not see injected mail until it polls. KyPost Server polls
on an interval, so the notification path works; a push-only client would not
see delivery promptly.

## Services

| Service | Port | Transport |
|---------|------|-----------|
| IMAP    | 993  | implicit TLS |
| SMTP    | 587  | STARTTLS (required before AUTH) |
| CardDAV | 443  | HTTPS, at `https://kypost-demo-mail/carddav/{persona}/` |

TLS uses a self-signed certificate generated on first start. The private key
stays on a `tmpfs` inside the container; the certificate alone is published to a
volume that KyPost Server mounts read-only and picks up through `SSL_CERT_DIR`.
No key or certificate is committed to this repository or baked into the image.

### SMTP behaviour

Every message is accepted, validated as well-formed, filed into the sending
persona's `Sent Items` so the app shows it immediately, and then dropped. The
SMTP path has no forwarding code in it at all.

KyPost Server also APPENDs its own copy of a sent message. `Sent Items`
de-duplicates on `Message-ID`, so the user sees one message, not two.

### CardDAV

Each persona has a writable address book with test contacts covering standard
recipients, encrypted-mail recipients, multi-recipient lists, a contact with no
key, a contact with malformed key armor, a rotated key and a duplicate address.
Contacts carry mock ASCII-armored PGP public keys matching the seeded mail.

Creates, updates and deletes are held in memory for the life of the process.

## Reset mode

Disabled by default, which is the App Store testing configuration. Enable it for
demos:

```ini
RESET_ENABLED=true
RESET_TOKEN=a-long-random-string-16-chars-or-more
```

```sh
docker compose exec kypost-server \
  curl -fsS -X POST https://kypost-demo-mail/admin/reset \
       -H "Authorization: Bearer $RESET_TOKEN"
```

Reset restores every folder, flag, generated `Sent Items` message and CardDAV
contact to its seed state. It is idempotent, and it answers `403` whenever
`RESET_ENABLED` is not `true`. The server refuses to start if reset is enabled
without a token of at least 16 characters, so there is no window in which the
endpoint is both live and unauthenticated.

The endpoint lives on the mail server, which has no public route, so it is not
reachable through the Cloudflared tunnel under any configuration.

## Security model

* **Network**: mail ports are published nowhere — not to the host, not to the
  internet. Only `KyPost-Net` members can address them at all.
* **Application**: connections from anything other than `172.30.0.10` are
  dropped before a greeting is written, on all three listeners.
* **Container**: non-root user, read-only root filesystem, every capability
  dropped, `no-new-privileges`.
* **Secrets**: the tunnel token arrives as a runtime environment variable in the
  cloudflared container and is passed by environment rather than argv, so it
  does not appear in `ps` or `docker inspect`'s command line.
* **Auth**: deliberately universal. The allowlist, not the password, is the
  control that keeps this sandbox closed. There is no rate limiting or CAPTCHA
  in front of permitted traffic.

## Tests

```sh
./test/run.sh
```

The suite starts the server on high ports and drives it with the same IMAP
client library KyPost Server uses (`github.com/BrianLeishman/go-imap` v0.1.28),
plus `net/smtp` and `net/http`. Certificate verification is left on, so a
certificate KyPost Server would reject fails the suite.

It covers the acceptance list in `PROMPT.md` section 4E: reading seeded and
session-created mail for each persona, sending mail and finding it in
`Sent Items`, applying and reading keyword labels, the IMAP delete flow, and
copy/move between folders — plus CardDAV read/write and both reset states.

Requires `node` and `go` on `PATH`; it uses the local Go module cache and works
offline.

## Known limitations

* **Deliberate deviation from `PROMPT.md` section 3.** The IMAP side is written
  against Node's standard library instead of an `imap-server` npm package. The
  only published package by that name has been unmaintained since 2014, and a
  security-first project should not take an eleven-year-old unpatched dependency
  into an image. The result has zero runtime dependencies. `smtp-server` was
  dropped for the same reason of consistency, not necessity.
* **KyPost Server reaches this server's CardDAV through a named allowance.** Its
  SSRF guard (`internal/api/ssrf_guard.go`) refuses private and reserved
  addresses for user-supplied CardDAV URLs, and `172.30.0.20` is private space
  by definition, so the compose file sets `SANDBOX_PRIVATE_HOSTS=kypost-demo-mail`
  on KyPost Server. Exact hostname, no IP literals, empty everywhere else. Point
  the client at `https://kypost-demo-mail/carddav/{persona}/`. Do not publish
  CardDAV through a tunnel instead: authentication here is universal, so a
  public hostname is a world-writable address book.
* State is in memory. A restart is a reset, always — including when
  `RESET_ENABLED` is `false`.
* The IMAP subset covers the commands KyPost Server issues. `CONDSTORE`,
  `QRESYNC`, `BODYSTRUCTURE` and partial (`BODY[]<n.m>`) fetches are not
  implemented.
* A single command is capped at 33 MiB and a single message at 26 MiB. Both are
  well above anything the client sends and exist so one connection cannot
  exhaust the container's memory.
