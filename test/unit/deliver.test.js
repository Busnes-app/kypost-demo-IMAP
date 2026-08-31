import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../../src/store.js';
import { loadCorpus } from '../../src/corpus.js';
import { freshen, injectEntry, TRIGGERS, deliverForRecipients, startDrip, MAX_DRIP_MESSAGES } from '../../src/deliver.js';

const corpus = loadCorpus();

test('freshen replaces the Message-ID', () => {
  const before = corpus.next('plain').raw;
  const a = freshen(before, new Date());
  const b = freshen(before, new Date());
  const idOf = (s) => /^message-id:\s*(<[^>]+>)/im.exec(s)[1];
  assert.notEqual(idOf(a), idOf(before));
  assert.notEqual(idOf(a), idOf(b), 'two injections must not share an ID');
});

test('freshen sets Date to now in RFC 5322 form', () => {
  const now = new Date('2026-08-12T10:20:30Z');
  const out = freshen(corpus.next('plain').raw, now);
  const date = /^date:\s*(.+)$/im.exec(out)[1].trim();
  assert.equal(new Date(date).toUTCString(), now.toUTCString());
});

test('freshen leaves the body untouched', () => {
  const entry = corpus.next('mime-bad');
  const out = freshen(entry.raw, new Date());
  const body = (s) => s.slice(s.indexOf('\r\n\r\n'));
  assert.equal(body(out), body(entry.raw));
});

test('injecting the same entry twice yields two messages', () => {
  const p = store.forUser('inject-test');
  const before = p.folders.get('INBOX').messages.length;
  const entry = corpus.next('plain');
  injectEntry(p, entry);
  injectEntry(p, entry);
  assert.equal(p.folders.get('INBOX').messages.length, before + 2,
    'dedup on Message-ID must not swallow the second copy');
});

test('injected mail is unseen', () => {
  const p = store.forUser('inject-unseen');
  const msg = injectEntry(p, corpus.next('plain'));
  assert.ok(!msg.flags.has('\\Seen'), 'new mail must be unread or it fires no notification');
});

test('a repeated trigger recipient delivers once', async () => {
  const p = store.forUser('rcpt-dedup');
  const before = p.folders.get('INBOX').messages.length;
  const rcpts = Array(20).fill('deliver-mail@kypost-demo.local');
  rcpts.push('Deliver-Mail@elsewhere.test');
  assert.equal(await deliverForRecipients(p, rcpts, corpus, () => {}), 1);
  assert.equal(p.folders.get('INBOX').messages.length, before + 1);
});

test('crypto-good encrypts to the submitting user Autocrypt key', async () => {
  const { generateKey, readKey, readMessage, readPrivateKey, decrypt } = await import('openpgp');
  const { privateKey, publicKey } = await generateKey({
    type: 'ecc', curve: 'curve25519', userIDs: [{ email: 'crypto-user@example.test' }],
  });
  const key = await readKey({ armoredKey: publicKey });
  const binary = await key.write();
  const raw = `From: <crypto-user@example.test>\r\nAutocrypt: addr=crypto-user@example.test; keydata=${Buffer.from(binary).toString('base64')}\r\n\r\ntrigger`;
  const p = store.forUser('crypto-reply-test');
  const before = p.folders.get('INBOX').messages.length;

  assert.equal(await deliverForRecipients(p, ['deliver-crypto-good@test'], corpus, () => {}, {
    from: 'crypto-user@example.test', raw,
  }), 1);

  const delivered = p.folders.get('INBOX').messages.slice(before)[0].raw;
  const armor = delivered.slice(delivered.indexOf('-----BEGIN PGP MESSAGE-----'));
  const result = await decrypt({
    message: await readMessage({ armoredMessage: armor }),
    decryptionKeys: await readPrivateKey({ armoredKey: privateKey }),
  });
  assert.match(result.data, /encrypted to your OpenPGP public key/);
});

test('the trigger table covers every category plus batch', () => {
  assert.deepEqual(TRIGGERS.get('deliver-mail'), ['plain']);
  assert.deepEqual(TRIGGERS.get('deliver-crypto-good'), ['crypto-good']);
  assert.deepEqual(TRIGGERS.get('deliver-crypto-bad'), ['crypto-bad']);
  assert.deepEqual(TRIGGERS.get('deliver-mime-bad'), ['mime-bad']);
  assert.deepEqual(TRIGGERS.get('deliver-batch'),
    ['plain', 'crypto-good', 'crypto-bad', 'mime-bad']);
});

test('drip evicts oldest messages when INBOX exceeds the cap', async () => {
  const p = store.forUser('drip-evict-test');
  const inbox = p.folders.get('INBOX');
  // Clear seed messages and fill with 20 tagged messages
  inbox.messages.length = 0;
  inbox.uidNext = 1;
  for (let i = 0; i < 20; i++) {
    inbox.messages.push({
      uid: inbox.uidNext++,
      flags: new Set(),
      date: new Date(Date.now() - (20 - i) * 60000),
      raw: `From: test-${i}\r\nMessage-ID: <evict-${i}@test>\r\nDate: Mon, 01 Jan 2026 00:00:00 +0000\r\n\r\nbody ${i}`,
    });
  }
  const oldestUidBefore = inbox.messages[0].uid;
  const mockStore = {
    onPersonaCreated: () => {},
    personas: new Map([['drip-evict-test', p]]),
  };
  startDrip({ store: mockStore, corpus, log: () => {}, seconds: 1 });
  // Wait for at least one drip tick
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(inbox.messages.length, MAX_DRIP_MESSAGES,
    `INBOX must be trimmed to ${MAX_DRIP_MESSAGES}`);
  assert.ok(inbox.messages[0].uid > oldestUidBefore,
    'oldest messages must have been evicted');
});
