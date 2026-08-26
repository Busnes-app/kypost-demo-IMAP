# System Prompt: KyPost Demo IMAP & SMTP Server

## 1. Executive Summary & Goal
The objective is to build a single, lightweight, self-contained mock IMAP and SMTP server architecture named **KyPost Demo Mail Server**. This server acts exclusively as an isolated "sandbox" for development, automated testing, and app store deployment reviews. It must simulate standard email functionality, provide pre-seeded test payloads (including encrypted PGP/MIME data), and act as a black hole for outbound mail, ensuring no traffic ever touches the live internet.

## 2. Core Constraints & Guarantees
* **Absolute Isolation**: The SMTP server must accept any outbound email request, log it locally, and instantly discard/destroy the payload. It must *never* attempt external network relays or look up DNS MX records.
* **KyPost-Net Only**: The server must run only on `KyPost-Net` and accept traffic exclusively from the designated KyPost Server. IMAP and SMTP ports must not be exposed directly to the public internet. Enforce this restriction at both the network/firewall layer and the application layer.
* **Static KyPost-Net Addresses**: Use a private Docker network named `KyPost-Net` with subnet `172.30.0.0/24`. Reserve `172.30.0.10` for the KyPost Server, `172.30.0.20` for this KyPost Demo Mail Server, and `172.30.0.30` for `cloudflared`. The network gateway is `172.30.0.1`; these values must be configurable through deployment settings without changing application code.
* **Cloudflared Deployment**: Ship `cloudflared`, KyPost Server, and the demo mail server together in one `docker-compose.yml`, all attached to the same `KyPost-Net` with matching static network settings. `cloudflared` must route to KyPost Server only; it must never connect directly to the demo mail server. No IMAP, SMTP, or CardDAV port may be directly published to the public internet or host interface.
* **IP-Only Trust Boundary**: The demo mail server must allow connections only from KyPost Server at `172.30.0.10` and reject all other source IPs, including direct connections from `cloudflared`. Enforce this allowlist at the Docker/network layer and in the application.
* **Universal Authentication**: The IMAP server must accept any alphanumeric username and password combination to guarantee frictionless testing for automated bots and app store human reviewers.
* **Zero Real Cryptography Overhead**: The server does not need to perform live PGP encryption or decryption. It only hosts pre-configured, hardcoded, raw text strings that simulate encrypted payloads.
* **Stateless Persistence**: Keep mailbox states, generated messages, and CardDAV changes in memory only. All state resets when the service restarts; no database or local persistence file is required.
* **Controlled Reset Mode**: Provide an easy reset operation that restores all mailbox and CardDAV data to the original seeded state. Reset mode must be explicitly configurable, enabled for demonstrations when requested, and disabled by default for App Store testing. When disabled, reset endpoints and commands must be unavailable and must not be reachable through the public Cloudflared route.
* **Build Secret**: Accept the Cloudflare Tunnel token as a deployment secret. Never hardcode it in source, seed data, Compose files, logs, or the image filesystem. Inject it at runtime using the Cloudflared container environment.

## 3. Technical Stack Selection
Implement this server using the following blueprint:

 **Blueprint A (Node.js)**: Built using the `smtp-server` and `imap-server` npm packages inside a single clean executable. Build KyPost-Server from the `main` branch of [its repository](https://github.com/Busness-app/KyPost-Server), and use its runtime and dependency versions.


## 4. Feature Requirements

### A. IMAP Server Specifications
* **Ports**: Listen on port `143` (Plain/STARTTLS) or `993` (Implicit SSL/TLS).
* **Pre-Seeded Accounts**: Authenticate any user, but map requests to one of three pre-seeded baseline mailbox personas:
  1. `alice@kypost-demo.local` (Standard User)
  2. `bob@kypost-demo.local` (User with heavy PGP/Encrypted traffic)
  3. `charlie@kypost-demo.local` (User with large attachments and mixed MIME types)
* **Persona Ownership**: KyPost Server performs persona mapping and supplies the selected persona context when proxying IMAP, SMTP, or CardDAV traffic. The demo server must not independently infer personas from arbitrary usernames.
* **KyPost-Server Integration**: KyPost Server is the protocol-facing upstream for IMAP, SMTP, and CardDAV. The demo server communicates only with KyPost Server over the permitted internal IP connection and must not expose a separate direct client-facing protocol implementation.
* **Mailbox Structure**: Automatically expose standard folders upon login: `INBOX`, `Drafts`, `Sent Items`, `Trash`, `Archive`.
* **Seed Content Matrices**:
  * **Standard Email**: Text-only, HTML formatting, multi-recipient headers.
  * **Encrypted Email**: Raw text bodies containing mock `-----BEGIN PGP MESSAGE-----` blocks, PGP headers, and signatures to test the KyPost app client-side parsing.
  * **Edge Cases**: Empty bodies, malformed MIME boundaries, deep nested thread headers (`In-Reply-To`, `References`).

### B. SMTP "Black Hole" Specifications
* **Ports**: Listen on port `25` or `587`.
* **Universal Acceptance**: Accept all inbound traffic matching standard SMTP commands (`HELO/EHLO`, `MAIL FROM`, `RCPT TO`, `DATA`).
* **Behavior**: 
  * Validate that the payload is well-formed.
  * Dynamically push the sent message into the connected user's IMAP `Sent Items` folder so it reflects instantly in the app UI.
  * Terminate the message loop without forwarding it externally.

### C. CardDAV Address Book Specifications
* Provide a CardDAV address book for each pre-seeded mailbox persona.
* Use the internal HTTPS endpoint `https://kypost-demo-mail:443/carddav/{persona}/` as the default CardDAV URL, resolving the mail server at `172.30.0.20` on `KyPost-Net`. The default persona paths are `/carddav/alice/`, `/carddav/bob/`, and `/carddav/charlie/`.
* Support writable CardDAV operations required by the KyPost client, including contact creation, update, deletion, retrieval, and address-book discovery. Changes must be reflected in later reads during the active session.
* Allow all CardDAV credentials for permitted KyPost Server traffic, matching the demo authentication model.
* Each address book must contain test contacts with names, email addresses, and ASCII-armored public PGP keys used by the seeded and generated test emails.
* Include contacts covering standard messages, encrypted-message recipients, multi-recipient messages, malformed or missing-key cases, and key rotation or duplicate-address cases.
* CardDAV data must remain local to the KyPost-Net sandbox and must not contact external address-book services.
* The CardDAV endpoint must use the same KyPost-Net access restriction as IMAP and SMTP and expose only the minimum methods required by the KyPost client.

### D. Reset Specifications
* Reset must restore every persona's mail folders, message flags, generated `Sent Items` messages, and CardDAV contacts to their seed data.
* Expose reset through a protected administrative operation suitable for demos, such as an authenticated internal HTTP endpoint or container command.
* Gate the operation with an explicit deployment setting such as `RESET_ENABLED`; the operation is available only when this value is `true`, and the App Store testing configuration must set it to `false`.
* Reset must be idempotent, report completion clearly, and reject requests when reset mode is disabled.

### E. KyPost-Server Acceptance Tests
* KyPost Server must be able to read seeded and session-created mail for each pre-seeded account.
* KyPost Server must be able to send mail and have the resulting message appear in the correct persona's `Sent Items` folder.
* KyPost Server must be able to apply and read mail labels or IMAP keyword flags.
* KyPost Server must be able to delete mail using the supported IMAP deletion flow.
* KyPost Server must be able to move or copy mail into each exposed mailbox folder and observe the change on subsequent reads.

## 5. Security & Deployment Compliance
* **TLS Configuration**: Use Cloudflare-managed TLS for external access. Configure the internal tunnel-to-service transport and IMAP/SMTP TLS according to the KyPost-Server client expectations, without committing private keys or certificates to the repository.
* **No Public Bot Friction**: Do not add rate-limiting or CAPTCHA mechanisms for permitted KyPost traffic. The KyPost Server network allowlist is mandatory and is not considered a bot-friction feature. App reviewers must access the sandbox through the KyPost Server.
* **CardDAV Transport**: Serve CardDAV over TLS, using the internal HTTPS endpoint and the same KyPost Server network restriction as IMAP and SMTP.
* **Public Demo Route**: Publish the Cloudflared tunnel at `https://demo.kypost.org`.

## 6. Output Delivery Expectations
The generated output code must include:
1. All core source code file definitions.
2. A single, working `Dockerfile` configuring the environment.
3. A single `docker-compose.yml` containing `cloudflared`, KyPost Server, and the demo mail server, assigning their static `KyPost-Net` addresses without publishing IMAP, SMTP, or CardDAV ports to the host.
4. Cloudflared configuration equivalent to `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token $CLOUDFLARED_TUNNEL_TOKEN`, with the token supplied at runtime and the tunnel routing `https://demo.kypost.org` to KyPost Server only.
5. CardDAV endpoint configuration and seeded vCards containing the public keys used by test emails.
6. Reset-mode configuration and documentation showing demo and App Store testing settings.
7. Build/deployment secret wiring that does not store the Cloudflare Tunnel token in source control or the final image.
8. A small block of mock raw PGP email data to embed in the seed step.
