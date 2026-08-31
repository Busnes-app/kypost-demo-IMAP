// KyPost Demo Mail Server entrypoint: IMAPS, SMTP submission and CardDAV, all
// restricted to KyPost Server's address on KyPost-Net.

import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { ensureCert } from './tls.js';
import { createImapSession } from './imap.js';
import { createSmtpSession } from './smtp.js';
import { createDavHandler } from './carddav.js';
import { store, PERSONAS } from './store.js';
import { loadCorpus } from './corpus.js';
import { deliverForRecipients, startDrip } from './deliver.js';

const env = (k, d) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const list = (k, d) => env(k, d).split(',').map((s) => s.trim()).filter(Boolean);
const bool = (k, d) => ['true', '1', 'yes'].includes(env(k, d).toLowerCase());
// Whole seconds, at least one: DRIP_SECONDS=0.05 would otherwise be a 50 ms
// delivery loop per persona. 0 (or unset, or junk) keeps the 15-30 min default.
const seconds = (k) => {
  const n = Number(env(k, '0'));
  return n > 0 ? Math.max(1, Math.floor(n)) : 0;
};

const cfg = {
  bind: env('BIND_ADDRESS', '0.0.0.0'),
  imapPort: Number(env('IMAP_PORT', '993')),
  smtpPort: Number(env('SMTP_PORT', '587')),
  httpsPort: Number(env('HTTPS_PORT', '443')),
  allowedIps: list('ALLOWED_CLIENT_IPS', '172.30.0.10,127.0.0.1,::1'),
  resetEnabled: bool('RESET_ENABLED', 'false'),
  resetToken: env('RESET_TOKEN', ''),
  keyDir: env('TLS_KEY_DIR', '/run/kypost-tls'),
  publishDir: env('TLS_PUBLISH_DIR', '/srv/tls-public'),
  hostnames: list('TLS_HOSTNAMES', 'kypost-demo-mail,localhost'),
  ips: list('TLS_IPS', '172.30.0.20,127.0.0.1'),
  dripSeconds: seconds('DRIP_SECONDS'),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Reset mode without a token would be an unauthenticated wipe endpoint. Fail
// to start rather than come up with the gate wide open.
if (cfg.resetEnabled && cfg.resetToken.length < 16) {
  console.error('RESET_ENABLED=true requires RESET_TOKEN of at least 16 characters');
  process.exit(1);
}

let key;
let cert;
try {
  ({ key, cert } = ensureCert({
    keyDir: cfg.keyDir,
    publishDir: cfg.publishDir,
    hostnames: cfg.hostnames,
    ips: cfg.ips,
    log,
  }));
} catch (e) {
  // Without a published certificate KyPost Server cannot trust this host, so
  // coming up anyway would only fail later and less clearly.
  console.error(`TLS setup failed (${e.message}).`);
  console.error(`TLS_KEY_DIR=${cfg.keyDir} and TLS_PUBLISH_DIR=${cfg.publishDir} must both be writable;`);
  console.error('docker-compose.yml mounts a tmpfs and a volume for exactly this.');
  process.exit(1);
}
const secureContext = tls.createSecureContext({ key, cert });
const tlsOptions = { key, cert, minVersion: 'TLSv1.2' };

// A broken fixture must fail startup by name rather than surface as a demo that
// silently delivers nothing.
let corpus;
try {
  corpus = loadCorpus();
} catch (e) {
  console.error('corpus failed to load:', e.message);
  process.exit(1);
}

// Docker's network filtering is the first fence; this is the second. Both are
// required by the spec, and a container that is accidentally attached to a
// second network must still refuse everyone but KyPost Server.
const allowed = new Set(cfg.allowedIps);
function permitted(remote) {
  if (!remote) return false;
  const ip = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  return allowed.has(ip) || allowed.has(remote);
}

// Prepended so it runs before any TLS handshake or protocol greeting: an
// unlisted peer must not even learn what certificate this host presents.
function guardConnections(server, label) {
  server.prependListener('connection', (socket) => {
    if (permitted(socket.remoteAddress)) return;
    log('rejected', label, 'from', socket.remoteAddress);
    socket.destroy();
  });
}

// Universal authentication: any non-empty, printable credential pair is
// accepted so bots and store reviewers never hit a login wall. The network
// allowlist above, not the password, is what keeps this sandbox closed.
const printable = (s) => typeof s === 'string' && s.length > 0 && s.length <= 255 && !/[\x00-\x1f\x7f]/.test(s);
const allowLogin = (user, pass) => printable(user) && printable(pass);

// --- IMAP over implicit TLS (KyPost Server's client dials TLS directly) ---
const imap = tls.createServer(tlsOptions, (socket) => {
  socket.setTimeout(30 * 60 * 1000, () => socket.destroy());
  socket.on('error', (e) => log('imap socket error', e.message));
  createImapSession(socket, { log, allowLogin });
});

// --- SMTP submission with mandatory STARTTLS before anything interesting ---
const smtp = net.createServer();
smtp.on('connection', (socket) => {
  if (socket.destroyed) return;
  socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
  socket.on('error', (e) => log('smtp socket error', e.message));
  createSmtpSession(socket, {
    log,
    secureContext,
    secure: false,
    allowLogin,
    onAccepted: ({ persona, from, rcpts, raw }) =>
      deliverForRecipients(persona, rcpts, corpus, log, { from, raw }),
  });
});

// --- CardDAV + reset over HTTPS ---
const dav = https.createServer(tlsOptions, createDavHandler({
  log,
  resetEnabled: cfg.resetEnabled,
  resetToken: cfg.resetToken,
}));

guardConnections(imap, 'imap');
guardConnections(smtp, 'smtp');
guardConnections(dav, 'carddav');

function listen(server, port, label) {
  server.listen(port, cfg.bind, () => log(`${label} listening on ${cfg.bind}:${port}`));
  server.on('error', (e) => {
    console.error(`${label} failed:`, e.message);
    process.exit(1);
  });
}

listen(imap, cfg.imapPort, 'IMAPS');
listen(smtp, cfg.smtpPort, 'SMTP');
listen(dav, cfg.httpsPort, 'CardDAV/HTTPS');

startDrip({ store, corpus, log, seconds: cfg.dripSeconds });
log('drip', cfg.dripSeconds > 0 ? `every ${cfg.dripSeconds}s` : 'every 15-30 min');

log('personas seeded', PERSONAS.map((p) => store.get(p).address));
log('client allowlist', [...allowed]);
log('reset mode', cfg.resetEnabled ? 'ENABLED' : 'disabled');
log('corpus loaded', corpus.size, 'messages across', corpus.categories.join(', '));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    for (const s of [imap, smtp, dav]) s.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
