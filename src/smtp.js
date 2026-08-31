// SMTP black hole. Every message is accepted, filed into the sending persona's
// Sent Items so the app sees it immediately, then dropped. There is no relay
// path and no MX lookup anywhere in this file — that absence is the feature.

import tls from 'node:tls';
import { store, addMessageDeduped } from './store.js';

const MAX_MESSAGE = 26 * 1024 * 1024;
const HOSTNAME = 'kypost-demo-mail';

const addr = (arg, keyword) => {
  const m = new RegExp(`^${keyword}:\\s*<?([^>\\s]*)>?`, 'i').exec(arg.trim());
  return m ? m[1] : null;
};

export function createSmtpSession(socket, { log, secureContext, secure, allowLogin, onAccepted }) {
  let stream = socket;
  let buf = '';
  let inData = false;
  let data = '';
  let from = null;
  let rcpts = [];
  let user = null;
  let tlsActive = Boolean(secure);
  let authStep = null;

  const send = (s) => { if (!stream.destroyed) stream.write(s + '\r\n'); };

  function attach() {
    stream.on('data', onChunk);
    stream.on('error', (e) => log('smtp socket error', e.message));
  }

  function onChunk(chunk) {
    buf += chunk.toString('binary');
    if (buf.length > MAX_MESSAGE) {
      send('552 Message too large');
      return stream.destroy();
    }
    for (;;) {
      const i = buf.indexOf('\r\n');
      if (i === -1) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) onDataLine(line);
      else onCommand(line);
      if (stream.destroyed) return;
    }
  }

  function onDataLine(line) {
    if (line === '.') {
      inData = false;
      deliver(data);
      data = '';
      return;
    }
    // The buffer check in onChunk cannot catch this: buf is drained line by line
    // into data, so a client that streams CRLF-terminated lines and never sends
    // the terminating dot grows data until the container is OOM-killed — and
    // makes the advertised SIZE a lie in the meantime.
    if (data.length + line.length + 2 > MAX_MESSAGE) {
      inData = false;
      data = '';
      send('552 5.3.4 Message exceeds the advertised SIZE limit');
      return stream.destroy();
    }
    data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
  }

  function deliver(raw) {
    const persona = store.forAddress(from, user);
    if (persona) addMessageDeduped(persona, 'Sent Items', raw, ['\\Seen'], new Date());
    log('smtp accepted+discarded', {
      persona: persona ? persona.key : 'none',
      from,
      rcptCount: rcpts.length,
      bytes: raw.length,
    });
    // The payload is not kept anywhere else and is not forwarded. This callback
    // is told what was accepted; it does not get to change what happened to it.
    // Recipient-dependent behaviour lives in deliver.js, never here.
    if (onAccepted) {
      try {
        Promise.resolve(onAccepted({ persona, from, rcpts: [...rcpts], raw }))
          .catch((e) => log('onAccepted failed', e.message));
      } catch (e) {
        log('onAccepted failed', e.message);
      }
    }
    from = null;
    rcpts = [];
    send('250 2.0.0 Ok: queued to /dev/null');
  }

  function ehlo(domain) {
    const lines = [`250-${HOSTNAME} greets ${domain || 'anonymous'}`, `250-SIZE ${MAX_MESSAGE}`, '250-8BITMIME', '250-ENHANCEDSTATUSCODES'];
    if (!tlsActive && secureContext) lines.push('250-STARTTLS');
    lines.push('250 AUTH PLAIN LOGIN');
    lines.forEach(send);
  }

  function startTls() {
    send('220 2.0.0 Ready to start TLS');
    stream.removeAllListeners('data');
    const upgraded = new tls.TLSSocket(stream, { isServer: true, secureContext });
    upgraded.on('error', (e) => log('smtp tls error', e.message));
    stream = upgraded;
    tlsActive = true;
    // RFC 3207: discard all state learned before the handshake.
    buf = '';
    from = null;
    rcpts = [];
    user = null;
    attach();
  }

  function finishAuth(username, password) {
    authStep = null;
    if (!allowLogin(username, password)) return send('535 5.7.8 Authentication credentials invalid');
    user = username;
    send('235 2.7.0 Authentication successful');
  }

  function onCommand(line) {
    if (authStep) {
      const decoded = Buffer.from(line.trim(), 'base64').toString('utf8');
      if (authStep === 'plain') {
        const [, u, p] = decoded.split('\0');
        return finishAuth(u, p);
      }
      if (authStep === 'user') {
        user = decoded;
        authStep = 'pass';
        return send('334 UGFzc3dvcmQ6');
      }
      return finishAuth(user, decoded);
    }

    const sp = line.indexOf(' ');
    const verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp === -1 ? '' : line.slice(sp + 1);

    switch (verb) {
      case 'EHLO': return ehlo(arg);
      case 'HELO': return send(`250 ${HOSTNAME}`);
      case 'STARTTLS':
        if (tlsActive || !secureContext) return send('503 5.5.1 STARTTLS not available');
        return startTls();
      case 'AUTH': {
        const [mech, initial] = arg.split(/\s+/);
        const m = (mech || '').toUpperCase();
        if (m === 'PLAIN') {
          if (initial) {
            const [, u, p] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
            return finishAuth(u, p);
          }
          authStep = 'plain';
          return send('334 ');
        }
        if (m === 'LOGIN') {
          authStep = 'user';
          return send('334 VXNlcm5hbWU6');
        }
        return send('504 5.5.4 Unsupported authentication mechanism');
      }
      case 'MAIL': {
        const a = addr(arg, 'FROM');
        if (a === null) return send('501 5.5.4 Syntax: MAIL FROM:<address>');
        from = a;
        rcpts = [];
        return send('250 2.1.0 Ok');
      }
      case 'RCPT': {
        const a = addr(arg, 'TO');
        if (a === null) return send('501 5.5.4 Syntax: RCPT TO:<address>');
        if (from === null) return send('503 5.5.1 Need MAIL before RCPT');
        if (rcpts.length >= 100) return send('452 4.5.3 Too many recipients');
        rcpts.push(a);
        return send('250 2.1.5 Ok');
      }
      case 'DATA':
        if (from === null || !rcpts.length) return send('503 5.5.1 Need MAIL and RCPT before DATA');
        inData = true;
        data = '';
        return send('354 End data with <CR><LF>.<CR><LF>');
      case 'RSET':
        from = null;
        rcpts = [];
        return send('250 2.0.0 Ok');
      case 'NOOP': return send('250 2.0.0 Ok');
      case 'VRFY': return send('252 2.5.2 Cannot VRFY user');
      case 'QUIT':
        send('221 2.0.0 Bye');
        return stream.end();
      default:
        return send('502 5.5.2 Command not implemented');
    }
  }

  send(`220 ${HOSTNAME} KyPost Demo SMTP (black hole) ready`);
  attach();
}
