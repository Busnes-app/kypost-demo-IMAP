// Corpus delivery: trigger addresses, per-delivery header rewriting, and the
// ambient drip. Nothing here relays: it appends canned corpus bytes to a
// sandbox persona's own INBOX.

import { randomUUID } from 'node:crypto';
import { createMessage, encrypt, readKey } from 'openpgp';
import { addMessageDeduped } from './store.js';
import { CATEGORIES } from './corpus.js';

// Local part -> categories delivered. Matched case-insensitively with the
// domain ignored, so a reviewer typing on a phone keyboard cannot get it wrong.
export const TRIGGERS = new Map([
  ['deliver-mail', ['plain']],
  ['deliver-crypto-good', ['crypto-good']],
  ['deliver-crypto-bad', ['crypto-bad']],
  ['deliver-mime-bad', ['mime-bad']],
  ['deliver-batch', [...CATEGORIES]],
]);

export function triggerFor(address) {
  const local = String(address ?? '').split('@')[0].trim().toLowerCase();
  return TRIGGERS.get(local) || null;
}

// addMessageDeduped drops a second copy sharing a Message-ID — the mechanism
// that keeps Sent and Sent Items one tray. Without a fresh ID the second tap on
// a trigger would silently do nothing. The Date goes with it: mail dated when
// the fixture was authored sorts to the bottom and does not read as new.
export function freshen(raw, now = new Date()) {
  const id = `<${randomUUID()}@kypost-demo.local>`;
  return raw
    .replace(/^message-id:.*$/im, `Message-ID: ${id}`)
    .replace(/^date:.*$/im, `Date: ${now.toUTCString().replace('GMT', '+0000')}`);
}

export function injectEntry(persona, entry, now = new Date()) {
  return addMessageDeduped(persona, 'INBOX', freshen(entry.raw, now), [], now);
}

function headerValues(raw, name) {
  const head = String(raw).split('\r\n\r\n', 1)[0].replace(/\r\n[ \t]+/g, ' ');
  const prefix = `${name.toLowerCase()}:`;
  return head.split('\r\n')
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

async function autocryptKey(raw, from) {
  for (const value of headerValues(raw, 'Autocrypt')) {
    const fields = new Map(value.split(';').map((field) => {
      const i = field.indexOf('=');
      return [field.slice(0, i).trim().toLowerCase(), field.slice(i + 1).trim()];
    }));
    const addr = fields.get('addr')?.toLowerCase();
    const keydata = fields.get('keydata')?.replace(/\s/g, '');
    if (addr !== String(from).toLowerCase() || !keydata || keydata.length > 128 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(keydata)) continue;
    return readKey({ binaryKey: Buffer.from(keydata, 'base64') });
  }
  throw new Error('encrypted demo reply requires a valid sender-matching Autocrypt public key');
}

async function encryptedEntry(persona, submission) {
  const publicKey = await autocryptKey(submission.raw, submission.from);
  const ciphertext = await encrypt({
    message: await createMessage({ text: 'This demo message was encrypted to your OpenPGP public key.' }),
    encryptionKeys: publicKey,
  });
  return {
    raw: `From: KyPost Demo <encrypted-reply@kypost-demo.local>\r
To: ${persona.address}\r
Subject: Encrypted demo reply\r
Date: Thu, 01 Jan 1970 00:00:00 +0000\r
Message-ID: <encrypted-placeholder@kypost-demo.local>\r
MIME-Version: 1.0\r
Content-Type: text/plain; charset=utf-8\r
\r
${ciphertext.replace(/\r?\n/g, '\r\n')}\r
`,
  };
}

// One delivery per distinct trigger address. Called from the SMTP session after
// it has already filed and dropped the message. Repeats are collapsed first:
// SMTP accepts 100 recipients, so a single submission naming the same trigger
// each time would otherwise inject hundreds of messages.
export async function deliverForRecipients(persona, rcpts, corpus, log, submission = {}) {
  if (!persona) return 0;
  let n = 0;
  const seen = new Set();
  for (const rcpt of rcpts || []) {
    const categories = triggerFor(rcpt);
    if (!categories) continue;
    const local = String(rcpt).split('@')[0].trim().toLowerCase();
    if (seen.has(local)) continue;
    seen.add(local);
    const before = n;
    for (const category of categories) {
      if (category === 'crypto-good') {
        try {
          injectEntry(persona, await encryptedEntry(persona, submission));
        } catch (e) {
          log('encrypted corpus skipped', { persona: persona.key, trigger: rcpt, error: e.message });
          continue;
        }
      } else {
        injectEntry(persona, corpus.next(category));
      }
      n++;
    }
    log('corpus delivered', { persona: persona.key, trigger: rcpt, count: n - before });
  }
  return n;
}

const DRIP_MIN_SECONDS = 15 * 60;
const DRIP_MAX_SECONDS = 30 * 60;

// Hard cap per INBOX. After each drip delivery the oldest messages are evicted
// so the folder never exceeds this count. Keeps memory bounded without stopping
// the drip, so the demo always looks alive.
export const MAX_DRIP_MESSAGES = 15;

// One timer per provisioned persona, each at its own random interval, so thirty
// testers do not all get a notification in the same second. That is the seed
// set from boot plus every persona a later LOGIN creates.
export function startDrip({ store, corpus, log, seconds }) {
  const delay = () => {
    if (seconds > 0) return seconds * 1000;
    const span = DRIP_MAX_SECONDS - DRIP_MIN_SECONDS;
    return (DRIP_MIN_SECONDS + Math.floor(Math.random() * span)) * 1000;
  };

  // A throw inside a timer is an uncaughtException that kills the server, and
  // it would also end this persona's drip for good, so the next tick is booked
  // in `finally` whatever happened.
  const schedule = (persona) => {
    setTimeout(() => {
      try {
        const entry = corpus.pickWeighted();
        injectEntry(persona, entry);
        const inbox = persona.folders.get('INBOX');
        if (inbox && inbox.messages.length > MAX_DRIP_MESSAGES) {
          const excess = inbox.messages.length - MAX_DRIP_MESSAGES;
          inbox.messages.splice(0, excess);
          log('drip evicted', { persona: persona.key, removed: excess });
        }
        log('drip delivered', { persona: persona.key, file: entry.file });
      } catch (e) {
        log('drip failed', { persona: persona.key, error: e.message });
      } finally {
        schedule(persona);
      }
    }, delay()).unref();
  };

  store.onPersonaCreated(schedule);
  for (const persona of store.personas.values()) schedule(persona);
}
