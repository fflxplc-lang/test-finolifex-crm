/* BOSS — Production Server
 * Real Node.js backend, replacing the browser-only window.storage
 * mechanism the prototype used, which never left the browser.
 *
 * Storage: a single JSON file on disk (data.json), read into memory on
 * boot and written back on every change. No native dependencies — the
 * first version of this used better-sqlite3, but that requires compiling
 * C++ against Node's headers at install time, which fails outright on
 * networks that block nodejs.org (confirmed by actually trying it before
 * shipping this). A plain JSON file has no such risk, and at the scale
 * this CRM's actual storage needs (a few dozen named keys, not millions
 * of rows), it's a perfectly real, durable choice — verified below by
 * actually writing, restarting the process, and reading it back.
 *
 * WHAT THIS FIXES: data now lives in a real file on disk, durable across
 * restarts, shared correctly across every real device that hits this
 * server — not per-browser, not ephemeral, not dependent on any one
 * browser session staying open.
 *
 * WHAT THIS DOES NOT FIX (see README.md "Honest Limitations" section):
 * there is still no real user authentication, and the role/permission
 * rules are still only enforced in the browser's JavaScript. The
 * CRM_API_KEY check below is a minimal shared-secret gate to keep the API
 * off the open internet — it is NOT equivalent to per-user login security.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const net = require('net');
const tls = require('tls');
const https = require('https');
// A model the firm runs is often on its own network over plain http; the
// outward-facing probes still refuse it, and only the self-hosted adapter uses this.
const http = require('http');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CRM_API_KEY || null; // set this in production — see README.md
const DB_FILE = process.env.CRM_DB_FILE || path.join(__dirname, 'data.json');
// Connection credentials live in their OWN file, never in data.json.
// data.json is handed to any signed-in browser through /api/storage, so an SMTP
// password kept there would be readable by every user of the CRM. This file is
// only ever read by this process: secrets go in, and the API never sends one back
// out. It sits beside data.json, which in production is outside the repo.
const CONN_FILE = process.env.CRM_CONNECTIONS_FILE || path.join(path.dirname(DB_FILE), 'connections.json');

// Sign-in. One account per person: email and password, kept in SQLite beside
// the data file. This replaces the single shared access code the CRM used to
// have, so the door now records who opened it rather than only that someone did.
//
// SQLite comes from node:sqlite, built into Node 22 — not better-sqlite3, which
// compiles at install time and would break npm ci on this VPS.
const USERS_DB_FILE = process.env.CRM_USERS_DB || path.join(path.dirname(DB_FILE), 'users.db');
const usersDb = new DatabaseSync(USERS_DB_FILE);
usersDb.exec('PRAGMA journal_mode = WAL');
usersDb.exec('PRAGMA busy_timeout = 5000');
usersDb.exec(`CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Added after the table existed, so guard it: 'user' or 'admin'. The only
// difference is that an admin can add accounts; both see the same CRM.
if (!usersDb.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'role'").get()) {
  usersDb.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
// An account belongs to a team member. The CRM creates it when the member is
// created and keeps it in step, so there is one person, one record and one
// sign-in rather than the same human typed in twice.
//
//   member_id       the CRM team member this account is                                     
//   crm_role        their role in the CRM, kept for display — the gate only knows admin/user
//   active          a deactivated member cannot sign in, and any open session ends at once
//   issued_password the generated password, readable by an admin until the person uses it
//   last_login_at   when they first proved they had it
const USER_COLUMNS = {
  member_id: "ALTER TABLE users ADD COLUMN member_id TEXT",
  crm_role: "ALTER TABLE users ADD COLUMN crm_role TEXT",
  active: "ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
  issued_password: "ALTER TABLE users ADD COLUMN issued_password TEXT",
  last_login_at: "ALTER TABLE users ADD COLUMN last_login_at TEXT",
  // Two-step sign-in: after the password, a code emailed to this address.
  two_factor: "ALTER TABLE users ADD COLUMN two_factor INTEGER NOT NULL DEFAULT 0",
};
for (const [column, ddl] of Object.entries(USER_COLUMNS)) {
  if (!usersDb.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?").get(column)) usersDb.exec(ddl);
}
const findUserByEmail = usersDb.prepare('SELECT * FROM users WHERE email = ?');
const findUserById = usersDb.prepare('SELECT * FROM users WHERE id = ?');
const findUserByMember = usersDb.prepare('SELECT * FROM users WHERE member_id = ?');
const listUsers = usersDb.prepare('SELECT * FROM users ORDER BY id');
/* An account with no team member behind it was only ever made by the
   form on /users, which is gone — Team Members makes the person and the
   account together, through insertMemberUser below. The command line
   (scripts/user.js) has its own statement for the first account on a
   fresh system, which is the one case Team Members cannot cover. */
const insertMemberUser = usersDb.prepare(
  'INSERT INTO users (email, password_hash, role, member_id, crm_role, active, issued_password) VALUES (?, ?, ?, ?, ?, ?, ?)');
const updateUserAccount = usersDb.prepare(
  'UPDATE users SET email = ?, role = ?, member_id = ?, crm_role = ?, active = ? WHERE id = ?');
const updateUserPassword = usersDb.prepare('UPDATE users SET password_hash = ?, issued_password = ? WHERE id = ?');
const noteUserLogin = usersDb.prepare("UPDATE users SET last_login_at = datetime('now'), issued_password = NULL WHERE id = ?");
const deleteUserById = usersDb.prepare('DELETE FROM users WHERE id = ?');
const setUserTwoFactor = usersDb.prepare('UPDATE users SET two_factor = ? WHERE id = ?');

// A password somebody has to read off a screen and type once. No look-alike
// characters, and enough of them that the length is doing the work.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generatePassword(length) {
  const n = length || 14;
  let out = '';
  for (let i = 0; i < n; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}
// What the CRM is told about an account. The password only ever leaves here
// while it is still unused; once the person has signed in there is nothing to
// show and a new one has to be issued.
function accountJson(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, role: u.role, crmRole: u.crm_role || '', memberId: u.member_id || '',
    active: u.active === undefined ? 1 : u.active, createdAt: u.created_at, lastLoginAt: u.last_login_at || null,
    issuedPassword: u.issued_password || null,
  };
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(plain, salt, 64).toString('hex');
}

function passwordMatches(plain, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(plain, salt, want.length);
  return crypto.timingSafeEqual(want, got);
}
// Persist this across restarts or every deploy signs everyone out.
const SESSION_SECRET = process.env.CRM_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'finowise_session';

// Load the whole store into memory once at boot; every request reads/writes this
// object, and writeToDisk() persists it. Simple, and correct at this scale.
let store = {};
if (fs.existsSync(DB_FILE)) {
  try { store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('Could not parse existing data.json — starting from an empty store. Original error:', e.message); }
}
let writePending = false, writeAgain = false;
/* ---------------------------------------------------------------------
   LIVE UPDATES — one stream for the whole system

   A client fills in their form on their own link; the adviser is looking at
   the record on another screen. Until now the adviser had to press reload to
   see it. This is the one mechanism that fixes that everywhere rather than
   per module: every write the server accepts bumps a version and names the
   collections it touched, and every signed-in browser hears about it over
   one Server-Sent Events stream and re-reads just those collections.

   SSE rather than WebSockets on purpose: the traffic is one-way, it rides
   the HTTP server already running, it reconnects by itself, and it needs no
   dependency — this deploys with `npm ci --omit=dev` onto a small VPS.

   The event carries no record data at all: a version number, the names of
   the collections that changed, and which browser caused it. Reading the
   data still goes through the authenticated API, so the stream widens
   nobody's access.
   --------------------------------------------------------------------- */
let storeVersion = 0;
const liveStreams = new Set();
/* The last few hundred changes, so a browser can ask what it missed rather
   than only being told as it happens. An EventSource is the fast path and
   it is not a guarantee: a proxy can buffer it, a phone can suspend it, a
   laptop lid can close on it, and a browser freezes the timers of a tab
   nobody is looking at. Any of those and the stream goes quiet with
   nothing to say so. This is what /api/changes answers from. */
const changeLog = [];
const CHANGE_LOG_MAX = 300;
let pendingKeys = new Set(), pendingOrigin = '', pendingTimer = null;
function liveSend(res, event, payload) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n'); }
  catch (e) { /* a stream that has gone away is cleaned up by its own close handler */ }
}
/* Writes arrive in bursts — one request often saves three collections — so
   they are coalesced into a single event rather than three. */
function publishChange(keys, origin) {
  (keys || []).forEach((k) => k && pendingKeys.add(k));
  if (origin) pendingOrigin = origin;
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const changed = Array.from(pendingKeys); pendingKeys = new Set();
    const origin2 = pendingOrigin; pendingOrigin = '';
    if (!changed.length) return;
    // The version moves whether or not anybody is listening: it is what a
    // browser coming back compares against to know it missed something.
    storeVersion++;
    const payload = { v: storeVersion, keys: changed, origin: origin2, at: new Date().toISOString() };
    changeLog.push(payload);
    if (changeLog.length > CHANGE_LOG_MAX) changeLog.shift();
    if (!liveStreams.size) return;
    liveStreams.forEach((res) => liveSend(res, 'change', payload));
  }, 40);
}

function writeToDisk() {
  if (writePending) { writeAgain = true; return; } // coalesce rapid back-to-back writes into one
  writePending = true;
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFile(tmpFile, JSON.stringify(store), (err) => {
    writePending = false;
    if (err) { console.error('Failed writing data.json:', err); return; }
    fs.rename(tmpFile, DB_FILE, (err2) => { // atomic-ish swap: never leaves a half-written data.json on disk
      if (err2) console.error('Failed finalizing data.json:', err2);
      if (writeAgain) { writeAgain = false; writeToDisk(); }
    });
  });
}

// ------------------------------------------------------- connections store --
/* Connector settings, split into two halves that are treated very differently.
 *
 *   config  — host, port, from-address, which provider, enabled. Not secret.
 *             The browser reads and writes this freely.
 *   secrets — passwords, API keys, access tokens. These go in and never come
 *             back out: no endpoint returns one, and the UI is told only
 *             whether a value is present, so the form can say "leave blank to
 *             keep existing" and mean it.
 *
 * Both live in connections.json, written 0600, beside data.json (outside the
 * repo in production) and never served by /api/storage.
 */
let connections = {};
if (fs.existsSync(CONN_FILE)) {
  try { connections = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8')); }
  catch (e) { console.error('Could not parse connections.json — starting from an empty store. Original error:', e.message); }
}
let connWritePending = false, connWriteAgain = false;
function writeConnections() {
  if (connWritePending) { connWriteAgain = true; return; }
  connWritePending = true;
  const tmpFile = CONN_FILE + '.tmp';
  fs.writeFile(tmpFile, JSON.stringify(connections, null, 2), { mode: 0o600 }, (err) => {
    connWritePending = false;
    if (err) { console.error('Failed writing connections.json:', err); return; }
    fs.rename(tmpFile, CONN_FILE, (err2) => {
      if (err2) console.error('Failed finalizing connections.json:', err2);
      if (connWriteAgain) { connWriteAgain = false; writeConnections(); }
    });
  });
}
// What the browser is allowed to see: everything except the secrets themselves,
// plus a flag per secret saying whether one is stored.
function publicConnection(id) {
  const c = connections[id] || {};
  const secrets = c.secrets || {};
  const has = {};
  Object.keys(secrets).forEach(k => { has[k] = !!(secrets[k] && String(secrets[k]).length); });
  return {
    id,
    config: c.config || {},
    hasSecret: has,
    enabled: !!c.enabled,
    status: c.status || 'Not Connected',
    lastTestAt: c.lastTestAt || null,
    lastTestOk: c.lastTestOk === true,
    lastTestMessage: c.lastTestMessage || null,
    updatedAt: c.updatedAt || null,
    // What the assistant is allowed to do through this connector, and why.
    ai: AI_CONNECTORS.indexOf(id) >= 0 ? aiPrivacyState(id) : null,
    statusDetail: connectorStatusOf(id),
  };
}

/* ---- a real SMTP conversation, using only Node's built-in sockets ----
 * No new dependency (this deployment forbids anything that compiles at install
 * time, and nodemailer would be a dependency to audit for no gain here). It
 * connects, greets, upgrades to TLS where the port calls for it, and — when a
 * username and password are set — actually authenticates. What it reports is
 * what the mail server said.
 */
function smtpTest(opts, cb){ return smtpSession(opts, cb); }
/* The same conversation, with or without a letter to hand over. Without a
   message it is the connection test; with one it delivers, using the envelope
   the caller gives it. One implementation, so a test that passes means a send
   will too. */
function smtpSession({ host, port, secure, username, password, message }, cb) {
  const timeoutMs = 12000;
  let socket = null, done = false, buffer = '', stage = 'connect';
  const finish = (ok, message) => {
    if (done) return; done = true;
    try { if (socket) { socket.removeAllListeners(); socket.destroy(); } } catch (e) {}
    cb({ ok, stage, message });
  };
  const fail = (msg) => finish(false, msg);

  // Each step sends a command and waits for the reply code it expects.
  let steps = [], stepIndex = 0;
  const send = (line) => { try { socket.write(line + '\r\n'); } catch (e) { fail('Could not write to the server: ' + e.message); } };
  const runNext = () => {
    if (stepIndex >= steps.length) return finish(true, message
      ? 'The mail server accepted the message for delivery to ' + message.to.join(', ') + '.'
      : 'Authenticated successfully — the mail server accepted these settings.');
    const step = steps[stepIndex++];
    stage = step.stage;
    if (step.send !== null && step.send !== undefined) send(step.send);
    if (!step.expect) return runNext();
  };
  const onLine = (code, text, lines) => {
    const step = steps[stepIndex - 1];
    if (!step || !step.expect) return;
    if (step.expect.includes(code)) {
      if (step.afterEhlo) return decideTls(lines);
      if (step.afterTls) return upgradeToTls();
      return runNext();
    }
    fail(smtpExplain(stage, code, text));
  };

  // A plain connection is only safe to authenticate over once the server has
  // said it speaks STARTTLS. If it has not, the password would go across in
  // clear text, so say so instead of sending it.
  const decideTls = (lines) => {
    const offersStartTls = (lines || []).some(l => /^STARTTLS\b/i.test(String(l).trim()));
    if (offersStartTls) {
      steps = [{ stage: 'starttls', send: 'STARTTLS', expect: [220], afterTls: true }];
      stepIndex = 0;
      return runNext();
    }
    if (password) {
      return fail('This server did not offer STARTTLS on port ' + port + ', so the password would travel unencrypted. Tick SSL/TLS and use port 465, or check the host and port with your provider.');
    }
    steps = authSteps();
    stepIndex = 0;
    return runNext();
  };

  const attachReader = () => {
    socket.setEncoding('utf8');
    let replyLines = [];
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) > -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        replyLines.push(m[3]);
        if (m[2] === '-') continue; // multi-line reply; keep the capability lines and wait for the last
        const lines = replyLines;
        replyLines = [];
        onLine(Number(m[1]), m[3], lines);
      }
    });
    socket.on('error', (e) => fail('Could not reach ' + host + ':' + port + ' — ' + e.message));
    socket.on('timeout', () => fail('Timed out after ' + (timeoutMs / 1000) + 's talking to ' + host + ':' + port + '.'));
    socket.setTimeout(timeoutMs);
  };

  const upgradeToTls = () => {
    stage = 'starttls';
    const plain = socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('timeout');
    socket = tls.connect({ socket: plain, servername: host, rejectUnauthorized: false }, () => {
      buffer = '';
      attachReader();
      steps = authSteps();
      stepIndex = 0;
      runNext();
    });
    socket.on('error', (e) => fail('TLS handshake failed — ' + e.message));
  };

  const authSteps = () => {
    const list = [{ stage: 'ehlo', send: 'EHLO finowise-crm', expect: [250] }];
    if (username) {
      list.push({ stage: 'auth', send: 'AUTH LOGIN', expect: [334] });
      list.push({ stage: 'auth-user', send: Buffer.from(String(username)).toString('base64'), expect: [334] });
      list.push({ stage: 'auth-pass', send: Buffer.from(String(password || '')).toString('base64'), expect: [235] });
    }
    if (message) {
      list.push({ stage: 'mail-from', send: 'MAIL FROM:<' + message.from + '>', expect: [250] });
      message.to.forEach(addr => list.push({ stage: 'rcpt-to', send: 'RCPT TO:<' + addr + '>', expect: [250, 251] }));
      list.push({ stage: 'data', send: 'DATA', expect: [354] });
      // The body ends with the lone dot that closes DATA; send() adds the CRLF.
      list.push({ stage: 'body', send: message.body + '\r\n.', expect: [250] });
    }
    list.push({ stage: 'quit', send: 'QUIT', expect: null });
    return list;
  };

  const start = () => {
    attachReader();
    if (secure) {
      // Implicit TLS (465): the greeting arrives already encrypted.
      steps = authSteps();
      stepIndex = 0;
      steps.unshift({ stage: 'greeting', send: null, expect: [220] });
      runNext();
    } else {
      steps = [
        { stage: 'greeting', send: null, expect: [220] },
        { stage: 'ehlo', send: 'EHLO finowise-crm', expect: [250], afterEhlo: true },
      ];
      stepIndex = 0;
      runNext();
    }
  };

  try {
    socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, start)
      : net.connect({ host, port }, start);
    socket.once('error', (e) => fail('Could not reach ' + host + ':' + port + ' — ' + e.message));
  } catch (e) {
    fail('Could not open a connection — ' + e.message);
  }
}
// Turn an SMTP reply into something worth reading.
function smtpExplain(stage, code, text) {
  if (stage === 'mail-from') return 'The server refused the From address (' + code + ' ' + text + '). It usually has to match the mailbox you signed in as — check From Email on the connector.';
  if (stage === 'rcpt-to') return 'The server refused the recipient (' + code + ' ' + text + '). Check the address, and whether this account is allowed to send outside your organisation.';
  if (stage === 'data' || stage === 'body') return 'The server accepted the envelope but not the message (' + code + ' ' + text + ').';
  if (stage === 'auth-pass' && (code === 535 || code === 534 || code === 530)) {
    return 'The server rejected the username or password (' + code + ' ' + text + '). For Microsoft 365 and Google Workspace this usually means the account needs an app password, or SMTP AUTH is switched off for it.';
  }
  if (stage === 'auth' && code === 503) return 'The server does not accept AUTH on this connection (503 ' + text + '). Try the TLS port instead.';
  if (stage === 'starttls') return 'The server would not start TLS (' + code + ' ' + text + '). Try port 465 with SSL/TLS ticked.';
  if (stage === 'greeting') return 'The server answered, but not with a mail greeting (' + code + ' ' + text + '). Check the host and port.';
  return 'The server replied ' + code + ' ' + text + ' at the ' + stage + ' step.';
}

/* ---- a real HTTPS probe for token-based connectors ----
 * The user supplies the endpoint their provider documents; this calls it for
 * real with the credential attached and reports the status line it got back.
 */
function httpsProbe({ url, method, headers, body }, cb) {
  let target;
  try { target = new URL(url); } catch (e) { return cb({ ok: false, message: 'That is not a valid URL.' }); }
  if (target.protocol !== 'https:') return cb({ ok: false, message: 'Use an https:// endpoint — a credential must not travel over plain http.' });
  const req = https.request({
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: method || 'GET',
    headers: Object.assign({ 'User-Agent': 'Finowise-CRM/1.0', 'Accept': 'application/json' }, headers || {}),
    timeout: 12000,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { if (data.length < 2000) data += d; });
    res.on('end', () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      const snippet = data.trim().replace(/\s+/g, ' ').slice(0, 220);
      cb({
        ok,
        message: ok
          ? 'The provider answered ' + res.statusCode + '. The credential was accepted.'
          : 'The provider answered ' + res.statusCode + ' ' + (res.statusMessage || '') + (snippet ? ' — ' + snippet : '') +
            (res.statusCode === 401 || res.statusCode === 403 ? ' This usually means the key or token is wrong, expired, or lacks the required scope.' : ''),
      });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, message: 'The provider did not answer within 12 seconds.' }); });
  req.on('error', (e) => cb({ ok: false, message: 'Could not reach the provider — ' + e.message }));
  if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
}

// httpsProbe reports whether a call worked; this one also hands back what
// came back, for the calls where the answer is the point.
function httpsProbeJson(opts, cb) {
  let target;
  try { target = new URL(opts.url); } catch (e) { return cb({ ok: false, message: 'That is not a valid URL.' }); }
  if (target.protocol !== 'https:') return cb({ ok: false, message: 'Use an https:// endpoint.' });
  const req = https.request({
    hostname: target.hostname, port: target.port || 443,
    path: target.pathname + target.search, method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'Finowise-CRM/1.0', 'Accept': 'application/json' }, opts.headers || {}),
    timeout: 15000,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', d => { if (data.length < 20000) data += d; });
    res.on('end', () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      let json = null;
      try { json = JSON.parse(data); } catch (e) { /* not json, which is itself informative */ }
      const why = json && json.error ? (json.error.message || json.error) : data.trim().replace(/\s+/g, ' ').slice(0, 220);
      cb({ ok, json, status: res.statusCode, message: ok ? 'OK' : ('HTTP ' + res.statusCode + (why ? ' — ' + why : '')) });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, message: 'The provider did not answer within 15 seconds.' }); });
  req.on('error', e => cb({ ok: false, message: 'Could not reach the provider — ' + e.message }));
  if (opts.body) req.write(opts.body);
  req.end();
}

const app = express();
app.set('trust proxy', 1); // nginx terminates TLS; needed for secure-cookie detection
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false })); // the sign-in form posts a normal HTML form // the Task Bank + Zoho mapping data is large; default 100kb limit would reject real saves

// ------------------------------------------------------------------ users --
// Adding accounts, for admins only. A plain server-rendered page rather than
// anything inside the CRM itself, so the app's own screens are untouched.
function usersPage({ error = null, added = null, removed = null, meId = null } = {}) {
  const rows = listUsers.all().map((u) => `
        <tr${u.active === 0 ? ' class="off"' : ''}>
          <td>${esc(u.email)}${u.member_id ? '<div class="sub2">from the Team Members module</div>' : ''}</td>
          <td class="role">${esc(u.crm_role || (u.role === 'admin' ? 'Admin' : 'User'))}
            ${u.role === 'admin' ? '<span class="tag">admin</span>' : ''}</td>
          <td class="pw">${u.active === 0
            ? '<span class="muted">deactivated</span>'
            : u.issued_password
              ? '<code>' + esc(u.issued_password) + '</code>'
              : u.last_login_at
                ? '<span class="muted">used ' + esc(u.last_login_at) + '</span>'
                : '<span class="muted">set by hand</span>'}</td>
          <td class="when">${esc(u.created_at)}</td>
          <td class="act">${u.id === meId
            ? '<span class="muted">this is you</span>'
            : `<form method="POST" action="/users/delete" onsubmit="return confirm('Delete the account for ${esc(u.email)}?\n\nThey will not be able to sign in. Their work in the CRM is untouched.')">
                 <input type="hidden" name="id" value="${u.id}">
                 <button type="submit" class="danger">Delete</button>
               </form>`}</td>
        </tr>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Users — BOSS</title>
<style>
  :root{ --navy:#0F1B2D; --navy-2:#152541; --gold:#B9863E; --line:#E4E7EC;
         --text:#1B2233; --muted:#6B7280; --ok:#1E7F5C; --danger:#B3432B;
         --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif; }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#F5F6F8;font-family:var(--font);color:var(--text);padding:32px 16px}
  h1{font-family:Georgia,serif;font-weight:400;font-size:23px;margin:0 0 4px}
  .sub{font-size:12px;color:var(--muted);margin-bottom:22px}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 20px;margin-bottom:18px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin:0 0 14px}
  label{display:block;font-size:12.5px;font-weight:600;margin:0 0 6px}
  input{width:100%;padding:11px 13px;font-size:15px;font-family:inherit;border:1px solid var(--line);
        border-radius:9px;margin-bottom:14px}
  input:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px rgba(185,134,62,.16)}
  button{padding:11px 18px;font-family:inherit;font-size:14px;font-weight:600;color:#fff;
         background:var(--navy);border:1px solid var(--navy);border-radius:9px;cursor:pointer}
  button:hover{background:var(--navy-2)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);
     padding:0 0 8px;border-bottom:1px solid var(--line)}
  td{padding:10px 0;border-bottom:1px solid var(--line)}
  .wrap{max-width:820px;margin:0 auto}
  td:first-child{word-break:break-all;padding-right:14px}
  .role{color:var(--muted);width:150px}
  .when{color:var(--muted);width:135px}
  .act{width:84px;text-align:right}
  .act form{margin:0}
  button.danger{padding:5px 10px;font-size:12px;font-weight:600;color:var(--danger);background:#fff;
    border:1px solid rgba(179,67,43,.35);border-radius:7px;cursor:pointer}
  button.danger:hover{background:rgba(179,67,43,.08)}
  .pw{width:150px}
  .pw code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
    background:rgba(185,134,62,.12);border:1px solid rgba(185,134,62,.3);border-radius:6px;padding:2px 6px}
  .muted{color:var(--muted);font-size:12px}
  .sub2{color:var(--muted);font-size:11px;margin-top:2px}
  .tag{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--gold);margin-left:4px}
  tr.off td{opacity:.55}
  .note{font-size:12px;color:var(--muted);margin-top:12px;line-height:1.5}
  .msg{padding:10px 12px;border-radius:9px;font-size:13px;margin-bottom:16px}
  .msg.ok{color:var(--ok);background:rgba(30,127,92,.08);border:1px solid rgba(30,127,92,.25)}
  .msg.bad{color:var(--danger);background:rgba(179,67,43,.08);border:1px solid rgba(179,67,43,.25)}
  a.back{display:inline-block;margin-top:6px;font-size:13px;color:var(--navy)}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Users</h1>
    <div class="sub">Who can sign in to the CRM</div>
    ${added ? `<div class="msg ok">Added ${esc(added)}.</div>` : ''}
    ${removed ? `<div class="msg ok">Deleted ${esc(removed)}. They can no longer sign in.</div>` : ''}
    ${error ? `<div class="msg bad">${esc(error)}</div>` : ''}
    <div class="card">
      <h2>Adding somebody</h2>
      <p>An account is made by adding the person in <b>BOSS &rsaquo; Team Members</b>. Doing it there creates
      their sign-in at the same time, sends them their password, and files their role, branch, reporting line
      and access against the same record &mdash; which is the point: a person and their account are one thing,
      and making them in two places is how the two drift apart.</p>
      <p><a class="btn" href="/">Open BOSS</a></p>
      <p class="hint">A system with nobody in it yet is the one exception, and it has its own way in:
      <code>npm run user -- add you@firm.in &lt;password&gt;</code> from the server.</p>
    </div>
    <div class="card">
      <h2>Existing</h2>
      <table>
        <tr><th>Email</th><th>Role</th><th>Password</th><th>Added</th><th></th></tr>${rows}
      </table>
      <div class="note">Accounts made from the Team Members module carry the password the CRM
        generated and emailed to that person. It is shown here only until they sign in with it;
        after that, issue a new one from their profile in the CRM. An account is deactivated by
        marking the member Inactive, which also ends any session they have open.</div>
    </div>
    <a class="back" href="/">&larr; Back to the CRM</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------- sign-in --
// Session cookie is "<expiry>.<hmac>" — no server-side session store to keep in
// sync, and a restart doesn't sign everyone out as long as CRM_SESSION_SECRET
// is set in the environment.
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(value)).digest('hex');
}
function issueToken(userId) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  return `${userId}.${exp}.${sign(userId + '.' + exp)}`;
}
function userIdFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || !/^\d+$/.test(id) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now()) return null;
  const expected = Buffer.from(sign(id + '.' + exp));
  const given = Buffer.from(sig);
  // Fixed-length compare: timingSafeEqual throws on a length mismatch.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return Number(id);
}
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}
function signedInUser(req) {
  const id = userIdFromToken(readCookie(req, COOKIE));
  const user = id ? findUserById.get(id) : undefined;
  // Deactivating somebody in the CRM ends the session they already have, at
  // their next request, rather than whenever the cookie happens to expire.
  if (user && user.active === 0) return undefined;
  return user;
}
function isSignedIn(req) {
  return !!signedInUser(req);
}

// Slow down password guessing. In-memory and per-process, which is all this
// single-process deployment needs.
const attempts = new Map();
const MAX_ATTEMPTS = 8, ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) { attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function noteFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

// Only ever redirect back to a path on this site, never to an absolute URL
// somebody appended to the query string.
function safeNext(value) {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : '/';
}

// The CRM keeps its own company branding in the "config" key; reuse whatever
// logo and name have been set there so the door matches the building.
function branding() {
  const fallback = { name: 'BOSS', tagline: 'Wealth Management', logo: null };
  try {
    const company = (JSON.parse(store.config || '{}').company) || {};
    return {
      name: company.name || fallback.name,
      tagline: company.tagline || fallback.tagline,
      logo: company.logoDataUrl || company.logoUrl || null,
    };
  } catch (e) { return fallback; }
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage({ error = null, next = '/', email = '' } = {}) {
  const b = branding();
  const mark = b.logo
    ? `<img class="logo-img" src="${esc(b.logo)}" alt="${esc(b.name)}">`
    : `<svg class="logo-svg" viewBox="0 0 64 64" role="img" aria-label="${esc(b.name)}">
         <rect x="1" y="1" width="62" height="62" rx="16" fill="#0F1B2D" stroke="#B9863E" stroke-width="1.5"/>
         <path d="M16 15 H32 V21 H23 V28 H31 V34 H23 V49 H16 Z" fill="#E8D3AE"/>
         <rect x="37" y="33" width="5" height="16" rx="2" fill="#B9863E" opacity=".55"/>
         <rect x="45" y="24" width="5" height="25" rx="2" fill="#B9863E" opacity=".85"/>
       </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Sign in — ${esc(b.name)}</title>
<style>
  :root{
    --navy:#0F1B2D; --navy-2:#152541; --gold:#B9863E; --gold-light:#E8D3AE;
    --card:#FFFFFF; --line:#E4E7EC; --text:#1B2233; --muted:#6B7280; --danger:#B3432B;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif;
  }
  *{box-sizing:border-box}
  body{
    margin:0; min-height:100vh; font-family:var(--font); color:var(--text);
    background:
      radial-gradient(900px 480px at 50% -10%, rgba(185,134,62,.22), transparent 70%),
      linear-gradient(165deg, var(--navy) 0%, var(--navy-2) 55%, #0B1524 100%);
    display:flex; align-items:center; justify-content:center;
    padding:32px 16px;
  }
  .wrap{width:100%; max-width:400px}
  .card{
    background:var(--card); border-radius:14px; padding:36px 30px 28px;
    box-shadow:0 24px 60px rgba(0,0,0,.38), 0 2px 6px rgba(0,0,0,.2);
  }
  /* The mark is the whole of the masthead now — no wordmark under it, no
     tagline — so it carries the card on its own and is sized to. */
  .mark{display:flex; justify-content:center; margin-bottom:4px}
  .logo-svg{width:128px; height:128px; display:block}
  .logo-img{max-height:128px; max-width:300px; width:auto; display:block}
  .rule{height:1px; background:var(--line); margin:24px 0 22px}
  label{display:block; font-size:12.5px; font-weight:600; margin-bottom:7px; letter-spacing:.2px}
  input[type=password], input[type=email]{
    width:100%; padding:12px 13px; font-size:15px; font-family:inherit; color:var(--text);
    border:1px solid var(--line); border-radius:9px; background:#fff; transition:border-color .15s, box-shadow .15s;
  }
  input[type=password]:focus, input[type=email]:focus{
    outline:none; border-color:var(--gold); box-shadow:0 0 0 3px rgba(185,134,62,.16);
  }
  button{
    width:100%; margin-top:18px; padding:12px 16px; font-family:inherit;
    font-size:14.5px; font-weight:600; letter-spacing:.3px; color:#fff; cursor:pointer;
    background:var(--navy); border:1px solid var(--navy); border-radius:9px;
    transition:background .15s, transform .05s;
  }
  button:hover{background:var(--navy-2)}
  button:active{transform:translateY(1px)}
  .error{
    margin:0 0 18px; padding:11px 13px; border-radius:9px; font-size:13px;
    color:var(--danger); background:rgba(179,67,43,.08); border:1px solid rgba(179,67,43,.25);
  }
  .foot{
    text-align:center; margin-top:22px; font-size:11.5px; color:rgba(255,255,255,.45);
    letter-spacing:.2px;
  }
  @media (max-width:420px){ .card{padding:30px 22px 24px}
    .logo-svg{width:96px; height:96px} .logo-img{max-height:96px; max-width:220px} }
</style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="POST" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <div class="mark">${mark}</div>
      <div class="rule"></div>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username"
             autofocus required value="${esc(email)}" placeholder="you@company.com">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password"
             required placeholder="Enter password">
      <button type="submit">Sign in</button>
    </form>
    <div class="foot">Authorised access only</div>
  </div>
</body>
</html>`;
}

app.get('/login', (req, res) => {
  if (isSignedIn(req)) return res.redirect(safeNext(req.query.next));
  res.type('html').set('Cache-Control', 'no-store').send(loginPage({ next: safeNext(req.query.next) }));
});

app.post('/login', (req, res) => {
  const next = safeNext((req.body || {}).next);
  const ip = req.ip || 'unknown';
  res.set('Cache-Control', 'no-store');

  if (tooManyAttempts(ip)) {
    return res.status(429).type('html')
      .send(loginPage({ error: 'Too many attempts. Wait a few minutes and try again.', next,
                       email: String((req.body || {}).email || '').trim() }));
  }
  const email = String((req.body || {}).email || '').trim();
  const password = String((req.body || {}).password || '');
  const user = findUserByEmail.get(email);
  // A member who has been deactivated in the CRM cannot sign in. Same message
  // as a wrong password, so the page still says nothing about who exists.
  if (user && user.active === 0) {
    noteFailure(ip);
    return res.status(401).type('html')
      .send(loginPage({ error: 'That email and password do not match.', next, email }));
  }
  // One message for both cases, so this cannot be used to discover which emails exist.
  if (!user || !passwordMatches(password, user.password_hash)) {
    noteFailure(ip);
    return res.status(401).type('html')
      .send(loginPage({ error: 'That email and password do not match.', next, email }));
  }
  attempts.delete(ip);
  if (user.two_factor) {
    // The password was right; the session waits for the emailed code.
    const ch = newOtpChallenge(user, 'login', next);
    return sendOtp(ch, (err) => {
      if (err) {
        otpChallenges.delete(ch.id);
        return res.status(503).type('html').send(loginPage({ next, email,
          error: 'Your account uses two-step sign-in, but the code could not be emailed (' + err
            + '). Ask an administrator to check the email connector.' }));
      }
      res.cookie(OTP_COOKIE, ch.id, { httpOnly: true, sameSite: 'lax', path: '/login',
        secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: OTP_TTL_MS * 2 });
      res.redirect('/login/otp');
    });
  }
  completeSignIn(req, res, user, next);
});

function completeSignIn(req, res, user, next) {
  // They have used the password they were sent, so the copy an admin could
  // read is deleted. Anyone who needs to give them one again issues a new one.
  noteUserLogin.run(user.id);
  noteLoginAlert(req, user);
  res.cookie(COOKIE, issueToken(user.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
  res.redirect(next);
}

/* ---------------------------------------------------------------------
   TWO-STEP SIGN-IN

   An account with two_factor on is not signed in by its password alone:
   a six-digit code is emailed to the account's own address and the
   session is issued only once it is typed. The code is random
   (crypto.randomInt), kept only as a keyed hash, good for five minutes
   and for five wrong tries, and can be sent again up to three times, no
   sooner than thirty seconds apart. Challenges live in memory: a restart
   in the middle of one simply means signing in again.

   Turning it on, and off, takes a code too, so a session left open on
   somebody's desk cannot quietly switch it off, and nobody can turn it
   on with an address that never receives mail and lock themselves out.
   If the mailbox is lost, an administrator on the server runs
     npm run user -- 2fa someone@company.com off
   --------------------------------------------------------------------- */
const OTP_COOKIE = 'finowise_otp';
const OTP_TTL_MS = 5 * 60 * 1000, OTP_MAX_TRIES = 5, OTP_RESEND_GAP_MS = 30 * 1000, OTP_MAX_RESENDS = 3;
const otpChallenges = new Map();
function otpHash(id, code) { return sign('otp.' + id + '.' + code); }
function newOtpChallenge(user, purpose, next) {
  for (const [k, c] of otpChallenges) if (c.expires < Date.now() - OTP_TTL_MS) otpChallenges.delete(k);
  // One pending challenge per account and purpose: a new one replaces the old.
  for (const [k, c] of otpChallenges) if (c.userId === user.id && c.purpose === purpose) otpChallenges.delete(k);
  const ch = { id: crypto.randomBytes(24).toString('hex'), userId: user.id, email: user.email, purpose,
    next: next || '/', tries: 0, resends: 0, sentAt: 0, expires: 0, hash: '' };
  otpChallenges.set(ch.id, ch);
  return ch;
}
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return email;
  return name.slice(0, 2) + '*'.repeat(Math.max(1, name.length - 2)) + '@' + domain;
}
function sendOtp(ch, cb) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  ch.hash = otpHash(ch.id, code);
  ch.sentAt = Date.now();
  ch.expires = Date.now() + OTP_TTL_MS;
  ch.tries = 0;
  const what = ch.purpose === 'login' ? 'sign in to'
    : ch.purpose === 'enable' ? 'turn on two-step sign-in for' : 'turn off two-step sign-in for';
  const firm = branding().name;
  sendMail({
    to: ch.email,
    subject: code + ' is your ' + firm + ' verification code',
    body: 'Your verification code to ' + what + ' your ' + firm + ' account is:\n\n    ' + code
      + '\n\nIt expires in 5 minutes. Nobody from the firm will ever ask you for it.\n\n'
      + 'If you did not just try to do this, someone may know your password: change it, and tell an administrator.',
  }, null, (status, json) => {
    if (status === 200 && json && json.ok) return cb(null);
    cb((json && json.message) || 'the mail server refused it');
  });
}
// null when the code is right; otherwise why not. A wrong try is counted.
function checkOtp(ch, code) {
  if (!ch || ch.expires < Date.now()) return 'expired';
  if (ch.tries >= OTP_MAX_TRIES) return 'locked';
  const given = Buffer.from(otpHash(ch.id, String(code || '').replace(/\s/g, '')));
  const want = Buffer.from(ch.hash);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return null;
  ch.tries++;
  return ch.tries >= OTP_MAX_TRIES ? 'locked' : 'wrong';
}
function resendProblem(ch) {
  if (ch.resends >= OTP_MAX_RESENDS) return 'The code has been sent ' + (OTP_MAX_RESENDS + 1) + ' times already. Start again.';
  const wait = Math.ceil((ch.sentAt + OTP_RESEND_GAP_MS - Date.now()) / 1000);
  if (wait > 0) return 'Wait ' + wait + ' more second' + (wait === 1 ? '' : 's') + ' before asking for another code.';
  return null;
}

/* A sign-in is told to the person it belongs to, inside BOSS, when they
   have asked for desktop notifications: every tab they have open hears
   it, and a sign-in they did not make is something they find out about
   at once rather than never. */
function noteLoginAlert(req, user) {
  if (!user || !user.member_id) return;
  try {
    const team = JSON.parse(store.team || '[]');
    const member = Array.isArray(team) ? team.find((t) => t && t.id === user.member_id) : null;
    if (!member || !member.desktopNotifEnabled) return;
    const list = JSON.parse(store.notifications || '[]');
    if (!Array.isArray(list)) return;
    const ua = String(req.get('user-agent') || '');
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    const now = new Date();
    list.push({ id: 'NTF-' + crypto.randomBytes(6).toString('hex'), at: now.toISOString(), userId: member.id,
      title: 'New sign-in to your account',
      body: 'Signed in from ' + browser + ' (' + (req.ip || 'unknown address') + ') at '
        + now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC. If this was not you, change your password now.',
      view: 'profile', arg: '', kind: 'login-alert', by: member.id });
    store.notifications = JSON.stringify(list);
    writeToDisk();
    publishChange(['notifications'], 'server');
  } catch (e) { /* an alert that cannot be written must not stop the sign-in */ }
}

function otpPage({ ch, error = null, info = null }) {
  const page = loginPage({ next: ch.next });
  const form = `<form class="card" method="POST" action="/login/otp">
      <div class="rule" style="margin-top:0"></div>
      <h2 style="margin:0 0 6px;font-size:18px">Enter your sign-in code</h2>
      <p style="margin:0 0 18px;font-size:13px;color:var(--muted)">We emailed a 6-digit code to
        <b>${esc(maskEmail(ch.email))}</b>. It expires in 5 minutes.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      ${info ? `<p class="error" style="color:#166534;background:rgba(22,101,52,.08);border-color:rgba(22,101,52,.25)">${esc(info)}</p>` : ''}
      <label for="code">Code</label>
      <input id="code" name="code" type="password" inputmode="numeric" autocomplete="one-time-code"
             maxlength="6" pattern="[0-9]{6}" autofocus required placeholder="123456"
             style="width:100%;padding:12px 13px;font-size:18px;letter-spacing:6px;border:1px solid var(--line);border-radius:9px">
      <button type="submit">Verify and sign in</button>
      <button type="submit" formaction="/login/otp/resend" formnovalidate
        style="background:#fff;color:var(--navy);margin-top:10px">Send a new code</button>
      <p style="margin:16px 0 0;font-size:12.5px;text-align:center"><a href="/login">Use a different account</a></p>
    </form>`;
  return page.replace(/<form class="card"[\s\S]*?<\/form>/, () => form);
}
function otpChallengeOf(req) {
  const ch = otpChallenges.get(readCookie(req, OTP_COOKIE) || '');
  return ch && ch.purpose === 'login' ? ch : null;
}
function otpRestart(res, why) {
  res.clearCookie(OTP_COOKIE, { path: '/login' });
  return res.status(401).type('html').send(loginPage({ error: why }));
}
app.get('/login/otp', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ch = otpChallengeOf(req);
  if (!ch || ch.expires < Date.now()) return otpRestart(res, 'That sign-in has expired. Sign in again to get a new code.');
  res.type('html').send(otpPage({ ch }));
});
app.post('/login/otp', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = req.ip || 'unknown';
  const ch = otpChallengeOf(req);
  if (!ch) return otpRestart(res, 'That sign-in has expired. Sign in again to get a new code.');
  const why = checkOtp(ch, (req.body || {}).code);
  if (why === 'expired') { otpChallenges.delete(ch.id); return otpRestart(res, 'That code has expired. Sign in again to get a new one.'); }
  if (why === 'locked') { otpChallenges.delete(ch.id); noteFailure(ip); return otpRestart(res, 'Too many wrong codes. Sign in again to get a new one.'); }
  if (why) {
    noteFailure(ip);
    return res.status(401).type('html').send(otpPage({ ch,
      error: 'That code is not right. ' + (OTP_MAX_TRIES - ch.tries) + ' tr' + (OTP_MAX_TRIES - ch.tries === 1 ? 'y' : 'ies') + ' left.' }));
  }
  otpChallenges.delete(ch.id);
  const user = findUserById.get(ch.userId);
  if (!user || user.active === 0) return otpRestart(res, 'That email and password do not match.');
  res.clearCookie(OTP_COOKIE, { path: '/login' });
  completeSignIn(req, res, user, ch.next);
});
app.post('/login/otp/resend', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ch = otpChallengeOf(req);
  if (!ch) return otpRestart(res, 'That sign-in has expired. Sign in again to get a new code.');
  const wait = resendProblem(ch);
  if (wait) return res.status(429).type('html').send(otpPage({ ch, error: wait }));
  ch.resends++;
  sendOtp(ch, (err) => {
    if (err) return res.status(503).type('html').send(otpPage({ ch, error: 'The new code could not be emailed: ' + err }));
    res.type('html').send(otpPage({ ch, info: 'A new code is on its way. Only the newest code works.' }));
  });
});

app.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/login'); });
app.get('/logout',  (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/login'); });

// Everything below this line needs a session. /api/health stays open so the
// deploy script can tell a release apart from a broken one without a password.
//
// (the users routes sit after this gate, so they are signed in by the time
// they are reached, and the admin check below is the only extra condition)
// A client with a form link has no account and should not need one. The page
// itself, and the three endpoints it uses, are open; every one of them checks
// the token and serves nothing beyond what that token names. /config.js is
// open too, and simply hands out nothing when nobody is signed in.
function isClientLinkRequest(req) {
  if (req.path.startsWith('/api/public/')) return true;
  if (req.path === '/config.js') return true;
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return false;
  const token = req.query.doc || req.query.support;
  return !!(token && publicScope(String(token)));
}
app.use((req, res, next) => {
  if (isSignedIn(req) || req.path === '/api/health') return next();
  // The service worker script carries no data; a browser fetches it without
  // being asked to sign in again, and it is what shows a push.
  if (req.path === '/sw.js') return next();
  if (isClientLinkRequest(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

// Minimal shared-secret gate. Real per-user authentication is a separate, larger
// project (see README.md) — this only stops the API being wide open to anyone
// who finds the URL.
function checkApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured — open access, fine for local/dev use only, see README
  const provided = req.get('X-API-Key');
  if (provided !== API_KEY) return res.status(401).json({ error: 'Invalid or missing X-API-Key header' });
  next();
}

// GET /api/storage/:key -> { key, value } | 404
app.get('/api/storage/:key', checkApiKey, (req, res) => {
  const value = store[req.params.key];
  if (value === undefined) return res.status(404).json({ error: 'not found' });
  res.json({ key: req.params.key, value });
});

/* AN ATTENDANCE ROW IS WRITTEN ONCE AND NOT EDITED.

   Everything else in BOSS is a whole-array PUT, which means the browser
   decides what the store holds. For attendance that is not good enough:
   a punch is a claim about where somebody was and when, and the one
   thing it must not be is adjustable afterwards by whoever has the page
   open. Nothing in the UI offers to edit one, but "the UI does not offer
   it" is not the same as "it cannot happen".

   So this is append-only, checked here rather than in the browser. A
   write may add a day, add a session to a day, and close an open session
   by setting its punch-out and that punch-out's location. It may not
   change a punch-in, change a punch-out that is already set, change or
   add a location to a punch already recorded, drop a session, or drop a
   day. Anything else comes back 409 naming what it tried to move.

   Since the punch clock allows Punch Out to be pressed again, a
   punch-out may also MOVE — but only later, and only with the one it
   replaces appended to that session's outHistory, so the earlier punch
   is still on the record. And a day has one punch-in: a second session
   cannot be added to a day that already has one.

   One exception, deliberate and narrow: an empty array is allowed
   through, because Reset System wipes every store and an administrator
   clearing the system is not the thing this is guarding against. What it
   guards against is a quiet edit to one timestamp among hundreds. */
const ATT_FIXED = ['in', 'inBy', 'inLoc', 'out', 'outBy', 'outLoc'];
const ATT_OUT = ['out', 'outBy', 'outLoc'];
// A later punch-out replacing an earlier one, with the earlier one kept.
function attendanceOutMoved(a, b) {
  if (!a.out || !b.out || b.out === a.out) return false;
  if (!(new Date(b.out).getTime() > new Date(a.out).getTime())) return false;
  const oldH = Array.isArray(a.outHistory) ? a.outHistory : [];
  const newH = Array.isArray(b.outHistory) ? b.outHistory : [];
  if (newH.length !== oldH.length + 1) return false;
  if (JSON.stringify(newH.slice(0, oldH.length)) !== JSON.stringify(oldH)) return false;
  const kept = newH[newH.length - 1] || {};
  return ATT_OUT.every((k) => JSON.stringify(kept[k] === undefined ? null : kept[k]) === JSON.stringify(a[k] === undefined ? null : a[k]));
}
function attendanceGuard(before, after) {
  let old;
  try { old = JSON.parse(before || '[]'); } catch (e) { return null; }
  let next;
  try { next = JSON.parse(after); } catch (e) { return 'that is not valid JSON'; }
  if (!Array.isArray(old) || !Array.isArray(next)) return null;
  if (!next.length) return null;                       // a full wipe: see above
  const byId = new Map(old.filter((r) => r && r.id).map((r) => [r.id, r]));
  const seen = new Set();
  for (const row of next) {
    if (!row || !row.id) continue;
    seen.add(row.id);
    const was = byId.get(row.id);
    if (!was) {                                        // a new day
      if (Array.isArray(row.sessions) && row.sessions.length > 1)
        return 'attendance ' + row.id + ' tried to start a day with more than one punch-in';
      continue;
    }
    if (row.userId !== was.userId || row.date !== was.date)
      return 'attendance ' + row.id + ' tried to move to another person or another date';
    const oldS = Array.isArray(was.sessions) ? was.sessions : [];
    const newS = Array.isArray(row.sessions) ? row.sessions : [];
    if (newS.length < oldS.length)
      return 'attendance ' + row.id + ' tried to drop a session';
    if (newS.length > oldS.length && oldS.length >= 1)
      return 'attendance ' + row.id + ' already has a punch-in for that day';
    for (let i = 0; i < oldS.length; i++) {
      const a = oldS[i] || {}, b = newS[i] || {};
      const moved = attendanceOutMoved(a, b);
      if (!moved && JSON.stringify(a.outHistory || []) !== JSON.stringify(b.outHistory || []))
        return 'attendance ' + row.id + ' tried to change an earlier punch-out';
      for (const k of ATT_FIXED) {
        const had = a[k] !== undefined && a[k] !== null;
        if (!had) continue;                            // not set yet: may be set now
        if (moved && ATT_OUT.includes(k)) continue;    // a later punch-out, the earlier one kept
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
          return 'attendance ' + row.id + ' tried to change a recorded ' + k;
      }
    }
  }
  for (const r of old) if (r && r.id && !seen.has(r.id))
    return 'attendance ' + r.id + ' was dropped';
  return null;
}

/* A CLIENT RECORD IS CHECKED HERE TOO, NOT ONLY IN THE FORM.

   The Add New Client form checks every box as it is typed. This is the
   half that cannot be bypassed: whatever arrives as the clients store is
   read again, and a value that breaks one of the form's rules is refused
   before it reaches data.json.

   Only what CHANGED is judged — a field on a record that this write does
   not touch is left alone, so a client saved years ago with an
   eleven-digit mobile does not stop somebody else's edit of a different
   client. And the full Aadhaar number never belongs in this store at all:
   it lives in the vault below, and only its last four digits come here. */
const CLIENT_RULES = {
  cmsName:      { test: (v) => /[A-Za-z]/.test(v) && /^[A-Za-z][A-Za-z .'\-]*$/.test(v), message: 'Please enter a valid client name.' },
  mobile:       { kind: 'mobile', message: 'Please enter a valid 10-digit mobile number.' },
  secondMobile: { kind: 'mobile', message: 'Please enter a valid 10-digit mobile number.' },
  email:        { kind: 'email', message: 'Please enter a valid email address.' },
  pan:          { kind: 'pan', message: 'Please enter a valid PAN number.' },
  aadhaar:      { test: (v) => /^[0-9]{4}$/.test(v), message: 'Only the last four digits of an Aadhaar number are kept on a client record.' },
  mailingZip:   { test: (v) => /^[1-9][0-9]{5}$/.test(v), message: 'Please enter a valid 6-digit PIN code.' },
  ifsc:         { test: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v), message: 'Please enter a valid IFSC code.' },
  accNo:        { test: (v) => /^[0-9]{9,18}$/.test(v), message: 'Please enter a valid bank account number.' },
  uccNo:        { test: (v) => /^[A-Za-z0-9]{3,20}$/.test(v), message: 'Please enter a valid UCC number.' },
};
function clientsGuard(before, after, strict) {
  let old;
  try { old = JSON.parse(before || '[]'); } catch (e) { old = []; }
  let next;
  try { next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(next)) return null;
  const byId = new Map((Array.isArray(old) ? old : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const problems = [];
  const uccSeen = new Map();
  next.forEach((r) => {
    if (r && !r.deletedAt && r.uccNo) {
      const k = String(r.uccNo).trim().toUpperCase();
      uccSeen.set(k, (uccSeen.get(k) || 0) + 1);
    }
  });
  for (const row of next) {
    if (!row || typeof row !== 'object' || row.deletedAt) continue;
    const was = byId.get(row.id) || {};
    /* Other screens (imports, quick edits, workflows) write clients too and
       were never held to the form's rules; holding them now would refuse a
       whole import over one odd name. Those writes get the one rule that
       is about privacy, not tidiness: a full Aadhaar number is cut to its
       last four digits instead of being stored. */
    if (!strict) {
      if (row.aadhaar != null && /^[0-9]{12}$/.test(String(row.aadhaar).replace(/\s/g, '')))
        row.aadhaar = String(row.aadhaar).replace(/\s/g, '').slice(-4);
      continue;
    }
    for (const [k, rule] of Object.entries(CLIENT_RULES)) {
      const v = row[k];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      if (String(v) === String(was[k] === undefined || was[k] === null ? '' : was[k])) continue;
      const s = String(v).trim();
      const ok = rule.kind ? checkValue(rule.kind, s).ok : rule.test(s);
      if (!ok) problems.push((row.cmsName || row.id) + ' — ' + rule.message);
      if (k === 'uccNo' && ok && uccSeen.get(s.toUpperCase()) > 1)
        problems.push((row.cmsName || row.id) + ' — UCC ' + s + ' is already on another client.');
    }
  }
  return problems.length ? { problems } : { value: strict ? after : JSON.stringify(next) };
}

/* WHEN A PUNCH IS ALLOWED, decided here and not only by a greyed-out button.
   A new punch in has to land inside the punch clock's hours on the firm's
   clock, on a day there is attendance, by somebody not on an approved
   full-day leave, and be stamped with the time it actually happened. A punch
   out has to land before the clock closes. Rows for other days (a restore,
   an import) are not judged: only a punch made today is a punch made now. */
function attendanceRulesGuard(before, after) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(old) || !Array.isArray(next)) return null;
  const now = bizNow();
  const cfg = hrConfigNow();
  const from = minsOf(cfg.day.from), until = minsOf(cfg.day.until);
  const byId = new Map(old.filter((r) => r && r.id).map((r) => [r.id, r]));
  for (const row of next) {
    if (!row || !row.id || row.date !== now.date) continue;
    const was = byId.get(row.id) || {};
    const oldS = Array.isArray(was.sessions) ? was.sessions : [];
    const newS = Array.isArray(row.sessions) ? row.sessions : [];
    if (newS.length > oldS.length) {
      const closed = hrClosedWhy(row.date, cfg);
      if (closed) return 'You cannot punch in today. ' + closed;
      const leave = hrApprovedLeave(row.userId, row.date);
      if (leave && !hrLeaveIsHalf(leave, cfg))
        return 'You cannot punch in today: you are on approved leave' + (leave.type ? ' (' + leave.type + ')' : '') + '.';
      if (now.mins < from) return 'Punch In opens at ' + cfg.day.from + '.';
      if (now.mins >= until) return 'The punch clock closed at ' + cfg.day.until + ' today.';
      const at = new Date((newS[newS.length - 1] || {}).in).getTime();
      // (The test suites lay down days punched in hours ago to drive; they run with CRM_ATTENDANCE_ANY_DAY=1.)
      if (process.env.CRM_ATTENDANCE_ANY_DAY !== '1' && (!isFinite(at) || Math.abs(Date.now() - at) > 10 * 60000))
        return 'A punch in has to carry the time it was made.';
    }
    for (let i = 0; i < Math.min(oldS.length, newS.length); i++) {
      const a = oldS[i] || {}, b = newS[i] || {};
      if (b.out && b.out !== a.out) {
        if (hrClosedWhy(row.date, cfg)) return 'You cannot punch out today. ' + hrClosedWhy(row.date, cfg);
        if (now.mins >= until) return 'Punch Out closed at ' + cfg.day.until + '. Ask for a regularization if your last punch out is wrong.';
      }
    }
  }
  return null;
}

/* A service task's Due Date cannot be earlier than its Assigned Date. Only a
   task this write adds, or whose dates it changes, is judged: an old row
   with odd dates does not block somebody else's edit. */
// Depth in the reporting tree (parentUserId), the same measure the page uses
// for "your level and below". A ring counts as top level.
function teamDepths(team) {
  const by = {};
  team.forEach((t) => { if (t && t.id) by[t.id] = t; });
  const depth = {};
  Object.keys(by).forEach((start) => {
    if (depth[start] !== undefined) return;
    const path = []; const walked = new Set();
    let cur = start;
    while (cur && by[cur] && !walked.has(cur) && depth[cur] === undefined) { walked.add(cur); path.push(cur); cur = by[cur].parentUserId; }
    if (cur && walked.has(cur)) { path.forEach((id) => { depth[id] = 0; }); return; }
    let d = (cur && depth[cur] !== undefined) ? depth[cur] : -1;
    for (let i = path.length - 1; i >= 0; i--) depth[path[i]] = ++d;
  });
  return depth;
}
// May this member give work to that one? Administrators and people who
// administer users may give it to anybody; everyone else to their own level
// of the reporting tree or below, never upwards.
function mayAssignTask(member, toId, team) {
  if (!member || !toId || toId === member.id) return true;
  const f = member.adminFlags || {};
  if (member.role === 'Admin' || f.manageUsers || f.managePermissions) return true;
  const d = teamDepths(team);
  return (d[toId] === undefined ? 0 : d[toId]) >= (d[member.id] === undefined ? 0 : d[member.id]);
}
function tasksGuard(before, after, member, fromForm) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(next)) return null;
  const byId = new Map((Array.isArray(old) ? old : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const team = storeList('team');
  const today = bizNow().date;
  for (const t of next) {
    if (!t || t.deletedAt) continue;
    const was = byId.get(t.id);
    if (member && t.assignTo && (!was || was.assignTo !== t.assignTo) && !mayAssignTask(member, t.assignTo, team)) {
      const to = team.find((x) => x && x.id === t.assignTo);
      return 'You can assign or reassign a task only to people at your own level or below you in the reporting line. '
        + ((to && to.name) || t.assignTo) + ' is above you' + (t.id ? ' (' + t.id + ')' : '') + '.';
    }
    if (fromForm && t.assignedDate && (!was || was.assignedDate !== t.assignedDate)
        && String(t.assignedDate).slice(0, 10) < today)
      return 'Assigned Date cannot be in the past. Please select today or a later date.';
  }
  for (const t of next) {
    if (!t || t.deletedAt || !t.assignedDate || !t.dueDate) continue;
    const was = byId.get(t.id);
    if (was && was.assignedDate === t.assignedDate && was.dueDate === t.dueDate) continue;
    if (String(t.dueDate).slice(0, 10) < String(t.assignedDate).slice(0, 10))
      return 'Due Date cannot be earlier than Assigned Date. Please select a valid Due Date.'
        + (t.id ? ' (' + t.id + (t.taskType ? ', ' + t.taskType : '') + ')' : '');
  }
  return null;
}

// Leave: one active request per person per date. A new or changed request
// that is Pending or Approved must not overlap another Pending or Approved
// request of the same person. Rows already on the server count even when the
// page sending this write never saw them, so two requests sent at the same
// moment cannot both land. Untouched older rows are left as they are.
function leaveGuard(before, after) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(next)) return null;
  const ACTIVE = ['Pending', 'Approved'];
  const day = (v) => String(v || '').slice(0, 10);
  const byId = new Map((Array.isArray(old) ? old : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const all = new Map(byId);
  next.forEach((r) => { if (r && r.id) all.set(r.id, r); });
  /* Cancelling: the request must say which dates went, those dates must be
     its own, and whatever is kept is written as requests that sit inside
     the original and on none of the cancelled dates. */
  const CANCELLED = ['Cancelled', 'Partially Cancelled'];
  const datesOf = (r) => {
    const out = [], d = new Date(day(r.from) + 'T00:00:00Z'), end = day(r.to || r.from);
    for (let i = 0; i < 400 && !isNaN(d) && d.toISOString().slice(0, 10) <= end; i++) {
      out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  };
  for (const r of next) {
    if (!r || !r.id) continue;
    const was = byId.get(r.id);
    if (was && ACTIVE.indexOf(was.status) >= 0 && CANCELLED.indexOf(r.status) >= 0) {
      const c = r.cancellation || {};
      const own = datesOf(was);
      if (!Array.isArray(c.dates) || !c.dates.length) return 'A cancelled leave must say which dates were cancelled.';
      if (c.dates.some((d) => own.indexOf(day(d)) < 0)) return 'Only dates inside the leave itself can be cancelled.';
      const kept = own.filter((d) => c.dates.map(day).indexOf(d) < 0);
      if ((r.status === 'Cancelled') !== (kept.length === 0))
        return r.status === 'Cancelled' ? 'Some dates of this leave are still kept, so it is Partially Cancelled, not Cancelled.'
          : 'Every date of this leave was cancelled, so it is Cancelled, not Partially Cancelled.';
    }
    if (!was && r.remainderOf && ACTIVE.indexOf(r.status) >= 0) {
      const o = all.get(r.remainderOf);
      if (!o || CANCELLED.indexOf(o.status) < 0) return 'Kept dates can only follow a cancellation of the leave they belong to.';
      const own = datesOf(o), gone = ((o.cancellation || {}).dates || []).map(day);
      if (datesOf(r).some((d) => own.indexOf(d) < 0 || gone.indexOf(d) >= 0))
        return 'The kept dates must lie inside the original leave and not on a cancelled date.';
    }
  }
  for (const r of next) {
    if (!r || !r.id || ACTIVE.indexOf(r.status) < 0 || !r.from) continue;
    const was = byId.get(r.id);
    if (was && was.status === r.status && day(was.from) === day(r.from) && day(was.to) === day(r.to)) continue;
    const a1 = day(r.from), a2 = day(r.to || r.from);
    for (const o of all.values()) {
      if (!o || o.id === r.id || o.userId !== r.userId || ACTIVE.indexOf(o.status) < 0 || !o.from) continue;
      const b1 = day(o.from), b2 = day(o.to || o.from);
      if (a1 <= b2 && b1 <= a2)
        return 'Leave is already ' + (o.status === 'Approved' ? 'approved' : 'requested') + ' for ' + b1
          + (b2 !== b1 ? ' to ' + b2 : '') + ', which overlaps ' + a1 + (a2 !== a1 ? ' to ' + a2 : '')
          + '. Choose dates that do not overlap, or cancel the earlier request first.';
    }
  }
  return null;
}

// PUT /api/storage/:key  body: { value: "..." } -> { key, value }
app.put('/api/storage/:key', checkApiKey, (req, res) => {
  let { value } = req.body || {};
  if (typeof value !== 'string') return res.status(400).json({ error: 'body.value must be a string (the CRM already JSON.stringifies before sending)' });
  if (req.params.key === 'hrAttendance') {
    const wrong = attendanceGuard(store.hrAttendance, value);
    if (wrong) return res.status(409).json({ error: 'attendance is append-only: ' + wrong });
    const refused = attendanceRulesGuard(store.hrAttendance, value);
    if (refused) return res.status(409).json({ error: refused });
  }
  if (req.params.key === 'hrLeave') {
    const wrong = leaveGuard(store.hrLeave, value);
    if (wrong) return res.status(422).json({ error: wrong });
  }
  if (req.params.key === 'tasks') {
    const wrong = tasksGuard(store.tasks, value, memberOfUser(signedInUser(req)), req.get('X-CRM-Form') === 'dst');
    if (wrong) return res.status(422).json({ error: wrong });
  }
  if (req.params.key === 'clients') {
    const checked = clientsGuard(store.clients, value, req.get('X-CRM-Form') === 'client');
    if (checked && checked.problems) {
      const wrong = checked.problems;
      return res.status(422).json({ error: 'Not saved: ' + wrong.slice(0, 5).join(' '), problems: wrong });
    }
    if (checked) value = checked.value;
  }
  store[req.params.key] = value;
  writeToDisk();
  publishChange([req.params.key], req.get('X-Client-Id') || '');
  res.json({ key: req.params.key, value });
});

// DELETE /api/storage/:key -> { key, deleted } | 404
// The CRM uses this to drop stores belonging to features that were removed (the Incentive
// and Appraisal modules, the old partner/level hierarchy), so their rows don't linger in
// data.json or reappear in a full-system export.
app.delete('/api/storage/:key', checkApiKey, (req, res) => {
  if (store[req.params.key] === undefined) return res.status(404).json({ error: 'not found' });
  delete store[req.params.key];
  writeToDisk();
  publishChange([req.params.key], req.get('X-Client-Id') || '');
  res.json({ key: req.params.key, deleted: true });
});

/* ---------------------------------------------------------------------
   CONNECTIONS API
   The browser sends configuration and, when the user types one, a secret.
   Secrets go into connections.json and are never sent back: the only thing
   the UI learns is whether one is stored, which is what lets the password
   box honestly say "leave blank to keep existing".

   The catalog of connectors — their labels, provider presets and help text —
   lives in public/index.html (search for CONNECTOR_CATALOG). This table is
   the half the server needs: which connectors exist, and how each one is
   actually tested. Field keys must agree between the two.
   --------------------------------------------------------------------- */
const CONNECTOR_KIND = {
  email:       'smtp',
  whatsapp:    'https',
  sms:         'https',
  gcal:        'https',
  outlook:     'graph',
  txnplatform: 'https',
  exchange:    'https',
  // AI Insights. Two of these are APIs the server can call and two are
  // editors that can only call us, so they are not the same kind of thing
  // and are not implemented as though they were.
  claude:      'https',
  gemini:      'https',
  vscode:      'inbound',
  cursor:      'inbound',
  /* A model the firm runs itself, or an enterprise gateway it controls, behind
     an OpenAI-compatible endpoint — Ollama, vLLM, LM Studio, a private
     deployment. This is the only shape in which "our data does not leave our
     control" can be true rather than promised, so it is the one the assistant
     prefers and the only kind that is privacy-verified by its nature. */
  bossai:      'selfhosted',
};
/* Which connectors the AI Assistant may speak through at all. The others are
   mail, calendars and transaction platforms: nothing about them is a model. */
const AI_CONNECTORS = ['bossai', 'claude', 'gemini'];
/* Where a connector's traffic goes. 'private' is an endpoint the firm runs or
   contracts for; 'public' is somebody else's multi-tenant API. The distinction
   is not cosmetic: it decides whether BOSS will put business data through it.
   An inbound connector sends nothing anywhere, so it is neither. */
const CONNECTOR_REACH = { bossai: 'private', claude: 'public', gemini: 'public' };
/* An administrator attests, per connector, that its privacy terms have been
   read and meet the firm's requirements — zero retention, no training on our
   data, no sharing. Until they do, a public endpoint is refused business data,
   whatever its key says. A private endpoint the firm runs is verified by what
   it is, because the data never leaves their own infrastructure.

   This is deliberately a gate and not a warning. The requirement BOSS was
   given says: if the privacy requirements cannot be verified, do not transmit
   confidential data to that connector. A banner nobody reads is not that. */
function aiPrivacyState(id) {
  const c = connections[id] || {};
  const config = c.config || {};
  const reach = CONNECTOR_REACH[id] || null;
  if (!reach) return { ok: false, reach: null, why: 'This connector is not a model BOSS can talk to.' };
  if (reach === 'private') {
    return { ok: true, reach, verified: true, by: 'deployment',
      why: 'A private endpoint this firm runs or contracts for. Nothing is sent to a shared service.' };
  }
  if (config.privacyVerified === true) {
    return { ok: true, reach, verified: true, by: config.privacyVerifiedBy || 'an administrator',
      at: config.privacyVerifiedAt || null, note: config.privacyNote || '',
      why: 'An administrator has recorded that this provider\'s terms meet the firm\'s requirements.' };
  }
  return { ok: false, reach, verified: false,
    why: 'This is a public API and nobody has recorded that its privacy terms were checked. '
       + 'BOSS will not send business data through it until an administrator verifies it in Setup \u2192 Connections.' };
}
/* The four things a connector's status can honestly be. */
function connectorStatusOf(id) {
  const c = connections[id] || {};
  const stored = c.status || 'Not Connected';
  if (AI_CONNECTORS.indexOf(id) >= 0 && stored === 'Connected') {
    const p = aiPrivacyState(id);
    if (!p.ok) return 'Privacy Requirements Not Verified';
  }
  if (/^Configured/.test(stored)) return 'Configuration Error';
  return stored;
}
/* An editor is not an API with an endpoint to probe. VS Code and Cursor
   reach BOSS, not the other way round: the connector issues a key, the
   extension sends it to /api/ai/hello, and only then — once a call has
   actually arrived and been accepted — does the connector read Connected.
   Nothing here ever claims a connection that has not happened. */
const INBOUND_CONNECTORS = ['vscode', 'cursor'];

// Presets write URLs like .../Accounts/{{accountSid}}.json; fill them from the
// connector's own configuration so the user edits an ID field, not a URL.
function fillTemplate(text, config) {
  // An empty field is not a value: leave the placeholder in place so the test
  // reports which field is missing instead of calling a half-built URL.
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (config && config[k] !== undefined && config[k] !== null && String(config[k]).length ? String(config[k]) : m));
}

// Turns the saved auth style into the header (or query string) the provider wants.
function buildHttpsProbe(config, secrets) {
  let url = fillTemplate(config.testUrl, config);
  const headers = {};
  const style = config.authStyle || 'Bearer token';
  if (style === 'Bearer token') {
    if (!secrets.token) return { error: 'No access token is stored yet. Enter one and save first.' };
    headers.Authorization = 'Bearer ' + secrets.token;
  } else if (style === 'API key header') {
    if (!secrets.apiKey) return { error: 'No API key is stored yet. Enter one and save first.' };
    headers[config.headerName || 'X-API-Key'] = secrets.apiKey;
  } else if (style === 'Basic auth') {
    if (!secrets.password) return { error: 'No password or auth token is stored yet. Enter one and save first.' };
    headers.Authorization = 'Basic ' + Buffer.from((config.username || '') + ':' + secrets.password).toString('base64');
  } else if (style === 'Query parameter') {
    if (!secrets.apiKey) return { error: 'No API key is stored yet. Enter one and save first.' };
    url += (url.indexOf('?') === -1 ? '?' : '&') + encodeURIComponent(config.paramName || 'key') + '=' + encodeURIComponent(secrets.apiKey);
  } else {
    return { error: 'Unknown authentication style "' + style + '".' };
  }
  // Some providers want a second, non-secret header alongside the credential
  // — Anthropic's API version, for one. The connector's preset carries it.
  String(config.staticHeaders || '').split(/[\n;]+/).forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  if (!url) return { error: 'No test endpoint is set for this connector.' };
  if (/\{\{\w+\}\}/.test(url)) return { error: 'The test endpoint still contains a placeholder (' + (url.match(/\{\{\w+\}\}/) || [])[0] + '). Fill in that field and save.' };
  return { url, method: config.testMethod || 'GET', headers };
}

// GET /api/connections -> [{ id, config, hasSecret, enabled, status, ... }]
app.get('/api/connections', checkApiKey, (req, res) => {
  const ids = Object.keys(CONNECTOR_KIND);
  // An API connector's credential lives in the same file under its own
  // prefix; it is not one of these and is never listed here.
  Object.keys(connections).forEach(id => {
    if (id.indexOf('apiconn:') === 0) return;
    if (ids.indexOf(id) === -1) ids.push(id);
  });
  res.json({ connections: ids.map(publicConnection) });
});

// PUT /api/connections/:id  body: { config, enabled, secrets }
// A secret arriving as an empty string means "keep what is stored"; sending
// null for one clears it.
app.put('/api/connections/:id', checkApiKey, (req, res) => {
  const id = req.params.id;
  if (!CONNECTOR_KIND[id]) return res.status(404).json({ error: 'unknown connector: ' + id });
  const body = req.body || {};
  const existing = connections[id] || { config: {}, secrets: {} };
  if (body.config && typeof body.config === 'object') existing.config = Object.assign({}, existing.config, body.config);
  if (typeof body.enabled === 'boolean') existing.enabled = body.enabled;
  existing.secrets = existing.secrets || {};
  if (body.secrets && typeof body.secrets === 'object') {
    Object.keys(body.secrets).forEach(k => {
      const v = body.secrets[k];
      if (v === null) { delete existing.secrets[k]; return; }   // explicitly cleared
      if (typeof v === 'string' && v.length) existing.secrets[k] = v;
      // '' — the user left the box blank, so the stored value stands
    });
  }
  // Changing the configuration invalidates an earlier successful test.
  if (body.config || (body.secrets && Object.keys(body.secrets).length)) {
    if (existing.status === 'Connected') existing.status = 'Configured — not tested since the last change';
    existing.lastTestOk = false;
  }
  existing.updatedAt = new Date().toISOString();
  connections[id] = existing;
  writeConnections();
  res.json({ connection: publicConnection(id) });
});

/* ---------------------------------------------------------------------
   MAIL — sending for real, through the stored Email connector.

   The CRM has always recorded what it "sent"; with SMTP credentials on the
   server it can actually send. If the connector is not set up, this says so
   and sends nothing: the caller records an honest "not sent" rather than a
   cheerful lie.
   --------------------------------------------------------------------- */
function encodeHeader(text) {
  const str = String(text || '');
  // Plain ASCII goes as-is; anything else is encoded so accents and ₹ survive.
  return /^[\x20-\x7E]*$/.test(str) ? str : '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}
function b64lines(buf) {
  return Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');
}
// A filename a mail client will accept: no quotes, no CR/LF, nothing that could
// smuggle another header in, and non-ASCII encoded rather than sent raw.
function safeFilename(name) {
  const clean = String(name || 'attachment').replace(/[\r\n"\\]/g, '').replace(/[\/]/g, '-').trim().slice(0, 120);
  return clean || 'attachment';
}
const ATTACH_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}$/;
function buildMessage({ fromEmail, fromName, to, cc, replyTo, subject, body, html, attachments }) {
  const boundaryDate = new Date().toUTCString();
  const id = '<' + crypto.randomBytes(12).toString('hex') + '@finowise-crm>';
  // base64 keeps UTF-8 intact and sidesteps line-length limits entirely.
  // base64 also means no body line can begin with a dot, so the lone dot that
  // ends DATA is never forged by the message itself.
  const encoded = b64lines(Buffer.from(String(body || ''), 'utf8'));
  const files = Array.isArray(attachments) ? attachments.filter(a => a && a.content) : [];
  const headers = [
    'From: ' + (fromName ? encodeHeader(fromName) + ' <' + fromEmail + '>' : fromEmail),
    'To: ' + to.join(', '),
  ];
  if (cc && cc.length) headers.push('Cc: ' + cc.join(', '));
  if (replyTo) headers.push('Reply-To: ' + replyTo);
  headers.push('Subject: ' + encodeHeader(subject));
  headers.push('Date: ' + boundaryDate);
  headers.push('Message-ID: ' + id);
  headers.push('MIME-Version: 1.0');
  if (!files.length) {
    headers.push('Content-Type: text/' + (html ? 'html' : 'plain') + '; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    return { text: headers.join('\r\n') + '\r\n\r\n' + encoded, messageId: id };
  }
  // With attachments the message becomes multipart/mixed: the note first, then
  // one part per file. The boundary is random, so nothing in a document can
  // accidentally (or deliberately) end a part early.
  const boundary = '=_finowise_' + crypto.randomBytes(16).toString('hex');
  headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  const parts = [
    '--' + boundary,
    'Content-Type: text/' + (html ? 'html' : 'plain') + '; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encoded,
  ];
  files.forEach(a => {
    const name = safeFilename(a.filename);
    const type = ATTACH_TYPE_RE.test(String(a.contentType || '')) ? a.contentType : 'application/octet-stream';
    parts.push('--' + boundary,
      'Content-Type: ' + type + '; name="' + name + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + name + '"',
      '',
      b64lines(Buffer.from(String(a.content), 'base64')));
  });
  parts.push('--' + boundary + '--', '');
  return { text: headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n'), messageId: id };
}
const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function cleanAddresses(value) {
  return String(value == null ? '' : value).split(/[,;]/).map(a => a.trim()).filter(Boolean);
}

// The client-credentials flow, which is what a server-to-server integration
// uses: no user sits in front of this, so there is nobody to send to a consent
// screen. The secret never leaves this process.
function graphToken(config, secrets, cb) {
  const body = new URLSearchParams({
    client_id: config.clientId || '',
    client_secret: secrets.clientSecret || '',
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();
  const target = new URL('https://login.microsoftonline.com/' + encodeURIComponent(config.tenantId || '') + '/oauth2/v2.0/token');
  const req = https.request({
    hostname: target.hostname, path: target.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    timeout: 12000,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', d => { if (data.length < 8000) data += d; });
    res.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(data); } catch (e) { /* fall through to the message below */ }
      if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) return cb(null, parsed.access_token);
      const why = parsed.error_description ? String(parsed.error_description).split('\n')[0] : (parsed.error || ('HTTP ' + res.statusCode));
      cb('Microsoft refused the credentials — ' + why);
    });
  });
  req.on('timeout', () => { req.destroy(); cb('Microsoft did not answer within 12 seconds.'); });
  req.on('error', e => cb('Could not reach Microsoft — ' + e.message));
  req.write(body);
  req.end();
}

// POST /api/outlook/meeting  { subject, start, end }
// Creates a real Teams meeting on the connected mailbox and returns its join
// link. 409 when the connector is not set up, so the UI can say which part.
app.post('/api/outlook/meeting', checkApiKey, (req, res) => {
  const c = connections.outlook;
  const config = (c && c.config) || {}, secrets = (c && c.secrets) || {};
  if (!c || !config.tenantId || !config.clientId) return res.status(409).json({ ok: false, notConfigured: true,
    message: 'Microsoft 365 is not connected. Add it under Setup → Connections.' });
  if (!c.enabled) return res.status(409).json({ ok: false, notConfigured: true,
    message: 'The Microsoft 365 connector is switched off. Tick "Enable this channel" on it.' });
  if (!config.userId) return res.status(409).json({ ok: false, notConfigured: true,
    message: 'The connector has no mailbox on it. Set the user principal name (you@firm.com) that meetings should be created under.' });
  const body = req.body || {};
  const start = body.start ? new Date(body.start) : new Date();
  if (isNaN(start)) return res.status(400).json({ ok: false, message: 'That start time is not a date.' });
  const end = body.end ? new Date(body.end) : new Date(start.getTime() + 60 * 60 * 1000);
  graphToken(config, secrets, (err, token) => {
    if (err) return res.status(502).json({ ok: false, message: err });
    const payload = JSON.stringify({
      startDateTime: start.toISOString(),
      endDateTime: (isNaN(end) ? new Date(start.getTime() + 3600000) : end).toISOString(),
      subject: String(body.subject || 'Meeting').slice(0, 250),
    });
    httpsProbeJson({
      url: 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(config.userId) + '/onlineMeetings',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: payload,
    }, (r) => {
      if (!r.ok) return res.status(502).json({ ok: false, message: 'Microsoft refused to create the meeting — ' + r.message });
      const join = r.json && (r.json.joinWebUrl || r.json.joinUrl);
      if (!join) return res.status(502).json({ ok: false, message: 'Microsoft created the meeting but returned no join link.' });
      res.json({ ok: true, joinUrl: join, id: r.json.id || '' });
    });
  });
});

// POST /api/mail/send  { to, cc?, subject, body, html?, replyTo?, attachments? }
// attachments: [{ filename, contentType, content }] where content is base64.
// 200 with { ok:true } only when the mail server took the message.
app.post('/api/mail/send', checkApiKey, (req, res) => sendMailRequest(req.body || {}, res, null));

/* ---------------------------------------------------------------------
   PIN AND IFSC LOOKUPS

   A team member's PIN fills their city, state and country; their IFSC
   fills the bank and the branch. Both are public directories — India
   Post's PIN list and the RBI IFSC list Razorpay publishes — asked from
   here rather than from the page, because a browser cannot call either
   without CORS they do not grant. The answer is cached, since a PIN or
   an IFSC does not move. Either base URL can be pointed elsewhere by
   environment variable, which is how the tests run without the internet.
   --------------------------------------------------------------------- */
const PIN_LOOKUP_URL = process.env.CRM_PIN_LOOKUP_URL || 'https://api.postalpincode.in/pincode/';
const IFSC_LOOKUP_URL = process.env.CRM_IFSC_LOOKUP_URL || 'https://ifsc.razorpay.com/';
const lookupCache = new Map();
async function lookupJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Finowise-CRM/1.0' },
    signal: AbortSignal.timeout(8000) });
  let json = null;
  try { json = await res.json(); } catch (e) { /* a 404 page is not JSON, which is itself the answer */ }
  return { status: res.status, json };
}
function cachedLookup(key, work, res) {
  if (lookupCache.has(key)) return res.json(lookupCache.get(key));
  work().then((answer) => {
    if (answer.ok || answer.notFound) {
      if (lookupCache.size > 5000) lookupCache.clear();
      lookupCache.set(key, answer);
    }
    res.status(answer.ok || answer.notFound ? 200 : 502).json(answer);
  }).catch((e) => res.status(502).json({ ok: false,
    message: e && e.name === 'TimeoutError' ? 'the directory did not answer in time' : 'the directory could not be reached' }));
}
/* Two-step sign-in, from My Profile. Status, then a code to the account's
   own address, then the code back — and only then is it switched. */
const meOtp = new Map();   // userId -> challenge for enabling or disabling
app.get('/api/me/2fa', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'not signed in' });
  res.set('Cache-Control', 'no-store').json({ ok: true, enabled: !!user.two_factor, email: maskEmail(user.email) });
});
app.post('/api/me/2fa/start', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'not signed in' });
  const action = (req.body || {}).action === 'disable' ? 'disable' : 'enable';
  if ((action === 'enable') === !!user.two_factor)
    return res.status(409).json({ ok: false, message: 'Two-step sign-in is already ' + (user.two_factor ? 'on' : 'off') + '.' });
  const was = meOtp.get(user.id);
  if (was && was.purpose === action && (req.body || {}).resend) {
    const wait = resendProblem(was);
    if (wait) return res.status(429).json({ ok: false, message: wait });
    was.resends++;
    return sendOtp(was, (err) => err ? res.status(503).json({ ok: false, message: 'The code could not be emailed: ' + err })
      : res.json({ ok: true, sentTo: maskEmail(user.email), resendsLeft: OTP_MAX_RESENDS - was.resends }));
  }
  const ch = newOtpChallenge(user, action);
  otpChallenges.delete(ch.id);           // not a sign-in: it lives in meOtp only
  meOtp.set(user.id, ch);
  sendOtp(ch, (err) => {
    if (err) { meOtp.delete(user.id); return res.status(503).json({ ok: false, message: 'The code could not be emailed: ' + err }); }
    res.json({ ok: true, sentTo: maskEmail(user.email), resendsLeft: OTP_MAX_RESENDS });
  });
});
app.post('/api/me/2fa/verify', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'not signed in' });
  const ch = meOtp.get(user.id);
  if (!ch) return res.status(409).json({ ok: false, message: 'Ask for a code first.' });
  const why = checkOtp(ch, (req.body || {}).code);
  if (why === 'expired' || why === 'locked') {
    meOtp.delete(user.id);
    return res.status(401).json({ ok: false, restart: true, message: why === 'expired'
      ? 'That code has expired. Ask for a new one.' : 'Too many wrong codes. Ask for a new one.' });
  }
  if (why) return res.status(401).json({ ok: false, message: 'That code is not right. '
    + (OTP_MAX_TRIES - ch.tries) + ' tr' + (OTP_MAX_TRIES - ch.tries === 1 ? 'y' : 'ies') + ' left.' });
  meOtp.delete(user.id);
  setUserTwoFactor.run(ch.purpose === 'enable' ? 1 : 0, user.id);
  res.json({ ok: true, enabled: ch.purpose === 'enable' });
});

app.get('/api/lookup/pincode/:pin', checkApiKey, (req, res) => {
  const pin = String(req.params.pin || '');
  if (!/^[1-9][0-9]{5}$/.test(pin)) return res.status(400).json({ ok: false, message: 'A PIN code is 6 digits.' });
  cachedLookup('pin:' + pin, async () => {
    const { json } = await lookupJson(PIN_LOOKUP_URL + pin);
    const row = Array.isArray(json) ? json[0] : null;
    if (!row || typeof row !== 'object') return { ok: false, message: 'the PIN directory gave no usable answer' };
    const offices = Array.isArray(row.PostOffice) ? row.PostOffice : [];
    if (String(row.Status) !== 'Success' || !offices.length) return { ok: false, notFound: true };
    const first = offices[0] || {};
    return { ok: true, pin, city: first.District || first.Block || '', state: first.State || '',
      country: first.Country || 'India', offices: offices.slice(0, 20).map((o) => o && o.Name).filter(Boolean) };
  }, res);
});
app.get('/api/lookup/ifsc/:code', checkApiKey, (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ ok: false, message: 'An IFSC is 11 characters, like SBIN0001234.' });
  cachedLookup('ifsc:' + code, async () => {
    const { status, json } = await lookupJson(IFSC_LOOKUP_URL + code);
    if (status === 404) return { ok: false, notFound: true };
    if (status !== 200 || !json || !json.BANK) return { ok: false, message: 'the IFSC directory gave no usable answer' };
    return { ok: true, ifsc: code, bank: json.BANK, branch: json.BRANCH || '', city: json.CITY || '',
      state: json.STATE || '', address: json.ADDRESS || '' };
  }, res);
});

/* ---------------------------------------------------------------------
   THE AADHAAR VAULT.

   A client record keeps the last four digits of an Aadhaar number and
   nothing more, because data.json is handed to every signed-in browser.
   The full number, where the firm needs it, lives here instead: in its
   own file beside data.json, encrypted, and served by this process only
   to an account management has approved by name or by role.

   Approval is decided here, against the sign-in account, not by hiding a
   button in the page — the page only asks. An admin account is
   management: it grants and withdraws access, and it is not exempt
   itself; an admin who wants to see a number approves themselves, and
   that approval is on the record like anybody else's. Every look, and
   every refusal, is written to the vault's own log.
   --------------------------------------------------------------------- */
const AADHAAR_FILE = process.env.CRM_AADHAAR_FILE || path.join(path.dirname(DB_FILE), 'aadhaar-vault.json');
const AADHAAR_KEY_FILE = AADHAAR_FILE.replace(/\.json$/, '') + '.key';
function aadhaarKey() {
  if (process.env.CRM_AADHAAR_KEY) return crypto.createHash('sha256').update(process.env.CRM_AADHAAR_KEY).digest();
  if (process.env.CRM_SESSION_SECRET) {
    return crypto.createHash('sha256').update(process.env.CRM_SESSION_SECRET + ':aadhaar-vault').digest();
  }
  // No secret configured (a laptop): a key of its own, kept beside the vault.
  try { return Buffer.from(fs.readFileSync(AADHAAR_KEY_FILE, 'utf8').trim(), 'hex'); } catch (e) { /* first run */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(AADHAAR_KEY_FILE, k.toString('hex'), { mode: 0o600 });
  return k;
}
function vaultRead() {
  try {
    const v = JSON.parse(fs.readFileSync(AADHAAR_FILE, 'utf8'));
    return { clients: v.clients || {}, approved: { emails: (v.approved || {}).emails || [], roles: (v.approved || {}).roles || [] },
      log: Array.isArray(v.log) ? v.log : [] };
  } catch (e) { return { clients: {}, approved: { emails: [], roles: [] }, log: [] }; }
}
function vaultWrite(v) {
  v.log = v.log.slice(-5000);
  const tmp = AADHAAR_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  fs.renameSync(tmp, AADHAAR_FILE);
}
function vaultSeal(number) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aadhaarKey(), iv);
  const enc = Buffer.concat([c.update(number, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), enc: enc.toString('hex') };
}
function vaultOpen(row) {
  const d = crypto.createDecipheriv('aes-256-gcm', aadhaarKey(), Buffer.from(row.iv, 'hex'));
  d.setAuthTag(Buffer.from(row.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(row.enc, 'hex')), d.final()]).toString('utf8');
}
// The same check the page makes: 12 digits, not starting 0 or 1, Verhoeff check digit.
const VH_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
  [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
  [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VH_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function aadhaarValid(d) {
  if (!/^[2-9][0-9]{11}$/.test(d)) return false;
  let c = 0;
  d.split('').reverse().forEach((ch, i) => { c = VH_D[c][VH_P[i % 8][Number(ch)]]; });
  return c === 0;
}
function aadhaarApproved(user, v) {
  if (!user) return false;
  const email = String(user.email || '').toLowerCase();
  if (v.approved.emails.some((e) => String(e).toLowerCase() === email)) return true;
  return !!user.crm_role && v.approved.roles.indexOf(user.crm_role) >= 0;
}
function vaultLog(v, user, action, clientId, note) {
  v.log.push({ at: new Date().toISOString(), by: (user && user.email) || '', action, clientId: clientId || '', note: note || '' });
}
// Who may see, and whether the person asking is one of them.
app.get('/api/aadhaar/access', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const v = vaultRead();
  const admin = !!(user && user.role === 'admin');
  res.set('Cache-Control', 'no-store').json({ ok: true, me: { email: (user && user.email) || '', admin,
    approved: aadhaarApproved(user, v) }, approved: admin ? v.approved : undefined,
    log: admin ? v.log.slice(-200).reverse() : undefined });
});
app.put('/api/aadhaar/access', checkApiKey, requireApiAdmin, (req, res) => {
  const user = signedInUser(req);
  const b = req.body || {};
  const v = vaultRead();
  const list = (x) => Array.from(new Set((Array.isArray(x) ? x : []).map((s) => String(s).trim()).filter(Boolean)));
  const before = JSON.stringify(v.approved);
  v.approved = { emails: list(b.emails).map((e) => e.toLowerCase()), roles: list(b.roles) };
  if (JSON.stringify(v.approved) !== before) {
    vaultLog(v, user, 'access changed', '', 'accounts: ' + (v.approved.emails.join(', ') || 'none')
      + '; roles: ' + (v.approved.roles.join(', ') || 'none'));
  }
  vaultWrite(v);
  res.json({ ok: true, approved: v.approved });
});
// Store a full number. Anybody who may edit a client may put one in; seeing
// it again is the approved question.
app.put('/api/aadhaar/:clientId', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const id = String(req.params.clientId || '');
  const number = String((req.body || {}).number || '').replace(/[\s-]/g, '');
  if (!id) return res.status(400).json({ ok: false, message: 'Which client?' });
  const v = vaultRead();
  if (!number) {
    if (v.clients[id]) { delete v.clients[id]; vaultLog(v, user, 'removed', id); vaultWrite(v); }
    return res.json({ ok: true, removed: true });
  }
  if (!aadhaarValid(number)) return res.status(422).json({ ok: false, message: 'Please enter a valid Aadhaar number.' });
  v.clients[id] = Object.assign(vaultSeal(number), { last4: number.slice(-4), at: new Date().toISOString(),
    by: (user && user.email) || '' });
  vaultLog(v, user, 'stored', id, 'ending ' + number.slice(-4));
  vaultWrite(v);
  res.json({ ok: true, last4: number.slice(-4) });
});
app.get('/api/aadhaar/:clientId', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const id = String(req.params.clientId || '');
  const v = vaultRead();
  res.set('Cache-Control', 'no-store');
  if (!aadhaarApproved(user, v)) {
    vaultLog(v, user, 'refused', id); vaultWrite(v);
    return res.status(403).json({ ok: false, message: 'The full Aadhaar number is shown only to people management has approved.' });
  }
  const row = v.clients[id];
  if (!row) return res.status(404).json({ ok: false, message: 'Only the last four digits of this Aadhaar number are on file.' });
  let number;
  try { number = vaultOpen(row); } catch (e) {
    return res.status(500).json({ ok: false, message: 'The stored number could not be read.' });
  }
  vaultLog(v, user, 'viewed', id, 'ending ' + row.last4); vaultWrite(v);
  res.json({ ok: true, number });
});

/* ---------------------------------------------------------------------
   LIVE NAVs

   AMFI publishes every scheme's latest NAV in one public text file, once
   each business day. The page cannot read it (no CORS), so it asks here:
   it sends the scheme names (and ISINs, when an import gave them) of the
   holdings it is drawing, and gets back each one's latest NAV and its
   date. The file is read at most once every thirty minutes. The URL can be
   pointed elsewhere by environment variable, which is how the tests run
   without the internet.
   --------------------------------------------------------------------- */
const NAV_URL = process.env.CRM_NAV_URL || 'https://www.amfiindia.com/spages/NAVAll.txt';
let navCache = null, navLoading = null;
const NAV_DROP = new Set(['fund', 'plan', 'option', 'growth', 'the', 'india', 'scheme', 'of', 'mutual', 'mf']);
function navTokens(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !NAV_DROP.has(w));
}
async function navList() {
  if (navCache && Date.now() - navCache.at < 30 * 60 * 1000) return navCache;
  if (navLoading) return navLoading;
  navLoading = (async () => {
    const res = await fetch(NAV_URL, { headers: { 'User-Agent': 'Finowise-CRM/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('AMFI answered ' + res.status);
    const rows = [];
    String(await res.text()).split(/\r?\n/).forEach((line) => {
      const f = line.split(';');
      if (f.length < 6 || !/^\d+$/.test(f[0].trim())) return;
      const nav = parseFloat(f[4]);
      if (!isFinite(nav)) return;
      const name = f[3].trim();
      rows.push({ code: f[0].trim(), isin: [f[1].trim(), f[2].trim()].filter((x) => x && x !== '-'), name, nav, date: f[5].trim(),
        toks: new Set(navTokens(name)), direct: /\bdirect\b/i.test(name), growth: /growth/i.test(name) && !/idcw|dividend|bonus/i.test(name) });
    });
    if (!rows.length) throw new Error('the NAV file had no schemes in it');
    navCache = { at: Date.now(), fetchedAt: new Date().toISOString(), rows };
    return navCache;
  })();
  try { return await navLoading; } finally { navLoading = null; }
}
/* The scheme a holding is: by ISIN when there is one; otherwise the AMFI
   name holding every word of the holding's name, the same plan (direct
   or regular) and the growth option preferred, the shortest name winning. */
function navMatch(list, q) {
  const isin = String(q.isin || '').trim().toUpperCase();
  if (isin) { const hit = list.rows.find((r) => r.isin.includes(isin)); if (hit) return hit; }
  const want = navTokens(q.name).filter((w) => !['direct', 'regular', 'idcw', 'dividend', 'payout', 'reinvestment'].includes(w));
  if (!want.length) return null;
  const direct = /\bdirect\b/i.test(q.name || '');
  let best = null, score = -1;
  for (const r of list.rows) {
    if (!want.every((w) => r.toks.has(w))) continue;
    const s = (r.direct === direct ? 4 : 0) + (r.growth ? 2 : 0) - r.toks.size / 100;
    if (s > score) { score = s; best = r; }
  }
  return best;
}
app.post('/api/market/nav', checkApiKey, async (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 500) : [];
  try {
    const list = await navList();
    const results = items.map((q) => {
      const hit = navMatch(list, q || {});
      return hit ? { name: q.name, isin: q.isin || '', code: hit.code, scheme: hit.name, nav: hit.nav, date: hit.date } : { name: q.name, isin: q.isin || '', missing: true };
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, source: 'AMFI', fetchedAt: list.fetchedAt, results });
  } catch (e) {
    // A 200 with ok:false, not a 5xx: AMFI being down is an answer the
    // client card shows ("statement values shown"), not a failed request
    // for the browser to log against the page.
    res.set('Cache-Control', 'no-store').json({ ok: false, message: e && e.name === 'TimeoutError' ? 'AMFI did not answer in time' : 'the AMFI NAV list could not be read: ' + (e && e.message || e) });
  }
});

/* ---------------------------------------------------------------------
   LIVE MARKET PRICES

   "HDFC Bank ka share live dikhao", "Reliance ya TCS, konsa loon?": LEXI
   reads any listed company or index here. The page sends a name or a
   symbol; this resolves it to an NSE (or BSE) listing, reads a year of
   daily prices and works out what an advisor looks at: the day's move,
   where it sits in its 52-week range, returns, RSI and the 20/50/200-day
   averages. Headlines come with the search.

   The source is Yahoo Finance's public chart and search endpoints, which
   need no key. They are unofficial and can change or be rate-limited, so
   everything that knows their shape is in the two functions below: a
   licensed feed replaces them without touching anything else. Answers are
   kept for a minute. CRM_MARKET_URL points it elsewhere (the tests).
   --------------------------------------------------------------------- */
const MARKET_URL = String(process.env.CRM_MARKET_URL || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
const MARKET_SOURCE = 'Yahoo Finance';
const marketCache = new Map();
// How long a price answer is kept; the tests set CRM_MARKET_CACHE_SECONDS=0 so a second read sees the feed's new price.
const marketTtl = (ms) => (process.env.CRM_MARKET_CACHE_SECONDS ? Number(process.env.CRM_MARKET_CACHE_SECONDS) * 1000 : ms);
async function marketGet(path, ttl) {
  const url = MARKET_URL + path;
  const hit = marketCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.json;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Finowise-CRM/1.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(12000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('the price feed answered ' + res.status);
  const json = await res.json();
  marketCache.set(url, { at: Date.now(), json });
  if (marketCache.size > 400) marketCache.delete(marketCache.keys().next().value);
  return json;
}
// The names people use for the indices, mapped to the feed's symbols.
const MARKET_ALIASES = {
  'nifty': '^NSEI', 'nifty 50': '^NSEI', 'nifty50': '^NSEI', 'sensex': '^BSESN', 'bse sensex': '^BSESN',
  'bank nifty': '^NSEBANK', 'banknifty': '^NSEBANK', 'nifty bank': '^NSEBANK', 'nifty it': '^CNXIT',
  'nifty midcap': '^NSEMDCP50', 'midcap': '^NSEMDCP50', 'nifty pharma': '^CNXPHARMA', 'nifty auto': '^CNXAUTO',
};
const marketIndian = (s) => /\.(NS|BO)$/.test(s) || /^\^/.test(s);
/* A name or a symbol to listings, best first: NSE before BSE, and the
   headlines the search returned. */
async function marketSearch(q) {
  const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
  if (MARKET_ALIASES[key]) return { listings: [{ symbol: MARKET_ALIASES[key], name: q.toUpperCase(), type: 'INDEX' }], news: [] };
  const json = await marketGet('/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=10&newsCount=6&lang=en-IN&region=IN', 10 * 60 * 1000);
  const quotes = ((json && json.quotes) || []).filter((x) => x && x.symbol && marketIndian(x.symbol)
    && /^(EQUITY|INDEX|ETF)$/i.test(x.quoteType || 'EQUITY'));
  quotes.sort((a, b) => (/\.NS$/.test(b.symbol) - /\.NS$/.test(a.symbol)));
  const seen = new Set(), listings = [];
  quotes.forEach((x) => {
    const base = x.symbol.replace(/\.(NS|BO)$/, '');
    if (seen.has(base)) return; seen.add(base);
    listings.push({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, type: x.quoteType || 'EQUITY',
      sector: x.sectorDisp || x.sector || '', industry: x.industryDisp || x.industry || '' });
  });
  // A bare NSE code ("TCS", "HDFCBANK") that the search did not return still gets tried as itself.
  if (!listings.length && /^[A-Z0-9&-]{2,20}$/i.test(q.trim())) listings.push({ symbol: q.trim().toUpperCase() + '.NS', name: q.trim().toUpperCase(), type: 'EQUITY' });
  const news = ((json && json.news) || []).slice(0, 6).map((n) => ({ title: n.title, publisher: n.publisher || '',
    time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : '' }));
  return { listings, news };
}
const marketRound = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
function marketSma(c, n) { return c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null; }
function marketRsi(c, n = 14) {
  if (c.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n; loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
/* The checks a chartist runs, computed here so the model reads them and never
   works them out: trend strength (ADX), momentum (MACD, RSI), volatility (ATR,
   Bollinger Bands), the nearest levels, volume against its norm and how many
   of the standard checks lean up. A checklist of what the chart shows, not a
   forecast. */
function marketEma(c, n) {
  if (c.length < n) return [];
  const k = 2 / (n + 1), out = new Array(c.length).fill(null);
  let e = c.slice(0, n).reduce((a, b) => a + b, 0) / n; out[n - 1] = e;
  for (let i = n; i < c.length; i++) { e = c[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function marketAdx(H, L, C, n = 14) {
  if (C.length < n * 2 + 1) return null;
  let tr = 0, pdm = 0, ndm = 0; const dx = [];
  for (let i = 1; i <= C.length - 1; i++) {
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    const t = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; pdm += p; ndm += m; }
    else { tr = tr - tr / n + t; pdm = pdm - pdm / n + p; ndm = ndm - ndm / n + m; }
    if (i >= n && tr > 0) {
      const pdi = 100 * pdm / tr, ndi = 100 * ndm / tr;
      dx.push({ dx: pdi + ndi === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi), pdi, ndi });
    }
  }
  if (dx.length < n) return null;
  let adx = dx.slice(0, n).reduce((a, b) => a + b.dx, 0) / n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i].dx) / n;
  const last = dx[dx.length - 1];
  return { adx, plusDi: last.pdi, minusDi: last.ndi };
}
function marketAtr(H, L, C, n = 14) {
  if (C.length <= n) return null;
  const tr = (i) => Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  let a = 0; for (let i = 1; i <= n; i++) a += tr(i); a /= n;
  for (let i = n + 1; i < C.length; i++) a = (a * (n - 1) + tr(i)) / n;
  return a;
}
function marketTechnicals(C, H, L, V, price, rsi, sma50, sma200) {
  const R = marketRound, t = {};
  const e12 = marketEma(C, 12), e26 = marketEma(C, 26);
  if (e26.length) {
    const line = []; for (let i = 0; i < C.length; i++) if (e26[i] != null) line.push(e12[i] - e26[i]);
    const sig = marketEma(line, 9);
    if (sig.length) {
      const m = line[line.length - 1], sg = sig[sig.length - 1], h = m - sg, hp = line[line.length - 2] - sig[sig.length - 2];
      t.macd = { line: R(m, 2), signal: R(sg, 2), histogram: R(h, 2), histogramRising: h > hp,
        state: m > sg ? (m > 0 ? 'above its signal line and above zero: bullish momentum' : 'above its signal line but still below zero: a recovery attempt')
          : (m < 0 ? 'below its signal line and below zero: bearish momentum' : 'below its signal line but above zero: momentum fading') };
    }
  }
  if (C.length >= 20) {
    const w = C.slice(-20), mid = w.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / 20);
    const up = mid + 2 * sd, lo = mid - 2 * sd;
    t.bollinger = { upper: R(up), middle: R(mid), lower: R(lo), percentB: sd ? R((price - lo) / (up - lo) * 100, 0) : null, bandwidthPct: mid ? R(4 * sd / mid * 100, 1) : null };
  }
  const adx = marketAdx(H, L, C);
  if (adx) t.trendStrength = { adx: R(adx.adx, 0), plusDi: R(adx.plusDi, 0), minusDi: R(adx.minusDi, 0),
    reading: adx.adx >= 40 ? 'very strong trend' : adx.adx >= 25 ? 'a trending market' : adx.adx >= 20 ? 'a trend is forming' : 'no real trend: a range-bound market',
    direction: adx.plusDi > adx.minusDi ? 'buyers lead' : 'sellers lead' };
  const atr = marketAtr(H, L, C);
  if (atr) t.atr14 = { value: R(atr), pctOfPrice: price ? R(atr / price * 100, 1) : null };
  if (C.length > 20) {
    const r = []; for (let i = C.length - 60 > 0 ? C.length - 60 : 1; i < C.length; i++) r.push(Math.log(C[i] / C[i - 1]));
    const mu = r.reduce((a, b) => a + b, 0) / r.length;
    t.volatilityPct = R(Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100, 1);
  }
  const lv = {}; [20, 60].forEach((n) => { if (L.length >= n) { lv['low' + n] = R(Math.min(...L.slice(-n))); lv['high' + n] = R(Math.max(...H.slice(-n))); } });
  if (lv.low20 != null) {
    t.levels = lv;
    t.levels.note = 'support is the recent lows, resistance the recent highs; ' + (price <= lv.low20 * 1.01 ? 'price is sitting on its 20-day support' : price >= lv.high20 * 0.99 ? 'price is pressing its 20-day resistance' : 'price is between them');
  }
  const vs = V.filter((v) => v > 0);
  if (V.length >= 21 && V[V.length - 1] > 0 && vs.length > V.length * 0.8) {
    const avg = V.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    if (avg > 0) t.volumeVsAvg20 = R(V[V.length - 1] / avg, 2);
  }
  // A cross of the 50- and 200-day averages in the last 30 sessions.
  if (C.length >= 230) {
    const sm = (i, n) => C.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
    let was = null;
    for (let i = C.length - 31; i < C.length; i++) { const above = sm(i, 50) > sm(i, 200); if (was != null && above !== was) t.crossLast30 = above ? 'golden cross (50-day moved above the 200-day)' : 'death cross (50-day moved below the 200-day)'; was = above; }
  }
  // The checklist: one point each way, so the advisor sees how broad the lean is.
  const checks = [];
  const add = (label, ok) => { if (ok != null) checks.push({ label, up: !!ok }); };
  if (sma50 != null) add('price vs 50-day average', price > sma50);
  if (sma200 != null) add('price vs 200-day average', price > sma200);
  if (sma50 != null && sma200 != null) add('50-day vs 200-day average', sma50 > sma200);
  if (t.macd) { add('MACD vs signal line', t.macd.line > t.macd.signal); add('MACD histogram direction', t.macd.histogramRising); }
  if (rsi != null) add('RSI vs 50', rsi > 50);
  if (t.trendStrength) add('buyers vs sellers (+DI vs -DI)', t.trendStrength.plusDi > t.trendStrength.minusDi);
  const ups = checks.filter((c) => c.up).length;
  if (checks.length >= 4) {
    const share = ups / checks.length;
    t.checklist = { positive: ups, of: checks.length, bias: share >= 0.75 ? 'bullish' : share <= 0.25 ? 'bearish' : share >= 0.55 ? 'leaning bullish' : share <= 0.45 ? 'leaning bearish' : 'neutral',
      againstTheLean: checks.filter((c) => c.up !== (share >= 0.5)).map((c) => c.label) };
  }
  if (rsi != null) t.rsiReading = rsi >= 70 ? 'overbought: stretched, prone to a pause' : rsi <= 30 ? 'oversold: stretched down, prone to a bounce' : rsi >= 55 ? 'firm' : rsi <= 45 ? 'weak' : 'neutral';
  return t;
}
/* One listing's year of daily prices, read down to what an advisor uses. */
async function marketQuote(symbol) {
  const json = await marketGet('/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1y&interval=1d', marketTtl(60 * 1000));
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.meta) return null;
  const m = r.meta, q = ((r.indicators || {}).quote || [])[0] || {};
  const bars = (r.timestamp || []).map((t, i) => ({ t: t * 1000, c: (q.close || [])[i], h: (q.high || [])[i], l: (q.low || [])[i], v: (q.volume || [])[i] || 0 }))
    .filter((b) => b.c != null && isFinite(b.c));
  if (!bars.length && m.regularMarketPrice == null) return null;
  const price = m.regularMarketPrice != null ? m.regularMarketPrice : bars[bars.length - 1].c;
  const time = m.regularMarketTime ? m.regularMarketTime * 1000 : bars[bars.length - 1].t;
  // The previous session's close: the last bar from an earlier trading day than the price's own (in IST).
  const istDay = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
  const earlier = bars.filter((b) => istDay(b.t) < istDay(time));
  const prev = earlier.length ? earlier[earlier.length - 1].c : (m.previousClose != null ? m.previousClose : null);
  const closes = bars.map((b) => b.c);
  if (closes.length && istDay(bars[bars.length - 1].t) === istDay(time)) closes[closes.length - 1] = price; else closes.push(price);
  const history = bars.map((b) => [istDay(b.t), marketRound(b.c)]);
  if (history.length && history[history.length - 1][0] === istDay(time)) history[history.length - 1][1] = marketRound(price); else history.push([istDay(time), marketRound(price)]);
  const back = (n) => (closes.length > n ? (price / closes[closes.length - 1 - n] - 1) * 100 : null);
  const hi = m.fiftyTwoWeekHigh != null ? m.fiftyTwoWeekHigh : Math.max(...bars.map((b) => b.h || b.c));
  const lo = m.fiftyTwoWeekLow != null ? m.fiftyTwoWeekLow : Math.min(...bars.map((b) => b.l || b.c));
  const sma50 = marketSma(closes, 50), sma200 = marketSma(closes, 200);
  // High, low and volume lined up with `closes` (a live price on a new day adds a bar of its own).
  const H = bars.map((b) => (b.h != null && isFinite(b.h) ? b.h : b.c)), L = bars.map((b) => (b.l != null && isFinite(b.l) ? b.l : b.c)), V = bars.map((b) => b.v);
  if (closes.length > H.length) { H.push(price); L.push(price); V.push(0); } else { H[H.length - 1] = Math.max(H[H.length - 1], price); L[L.length - 1] = Math.min(L[L.length - 1], price); }
  const technical = marketTechnicals(closes, H, L, V, price, marketRsi(closes), sma50, sma200);
  return {
    symbol: m.symbol || symbol, name: m.longName || m.shortName || symbol, exchange: m.fullExchangeName || m.exchangeName || '',
    currency: m.currency || 'INR', price: marketRound(price), time: new Date(time).toISOString(),
    prevClose: marketRound(prev), change: prev ? marketRound(price - prev) : null, changePct: prev ? marketRound((price / prev - 1) * 100) : null,
    dayHigh: marketRound(m.regularMarketDayHigh), dayLow: marketRound(m.regularMarketDayLow),
    high52: marketRound(hi), low52: marketRound(lo), fromHigh52Pct: hi ? marketRound((price / hi - 1) * 100) : null,
    returnsPct: { week: marketRound(back(5)), month: marketRound(back(21)), quarter: marketRound(back(63)), halfYear: marketRound(back(126)),
      year: closes.length > 200 ? marketRound((price / closes[0] - 1) * 100) : null },
    technical,
    rsi14: marketRound(marketRsi(closes), 1), sma20: marketRound(marketSma(closes, 20)), sma50: marketRound(sma50), sma200: marketRound(sma200),
    trend: sma50 && sma200 ? (price > sma50 && sma50 > sma200 ? 'uptrend: above the 50-day average, which is above the 200-day'
      : price < sma50 && sma50 < sma200 ? 'downtrend: below the 50-day average, which is below the 200-day'
      : 'mixed: between its 50-day and 200-day averages') : null,
    closes: bars.slice(-60).map((b, i, a) => [istDay(b.t), marketRound(i === a.length - 1 && istDay(b.t) === istDay(time) ? price : b.c)]),
    // The whole year, for the large chart a click on the card opens. Not sent to the model.
    history: history,
  };
}
const MARKET_SYMBOL_RE = /^[\^A-Za-z0-9.&_-]{1,30}$/;
// GET /api/market/quote?q=<company, index or symbol>, or ?symbol=<the feed's own symbol> to refresh one listing without searching
app.get('/api/market/quote', checkApiKey, async (req, res) => {
  const sym = String(req.query.symbol || '').trim();
  if (sym) {
    res.set('Cache-Control', 'no-store');
    if (!MARKET_SYMBOL_RE.test(sym)) return res.json({ ok: false, message: 'That is not a symbol.' });
    try {
      const quote = await marketQuote(sym);
      if (!quote) return res.json({ ok: false, notFound: true, query: sym, message: 'No price for "' + sym + '".' });
      return res.json({ ok: true, source: MARKET_SOURCE, fetchedAt: new Date().toISOString(), query: sym, quote, news: [], alternatives: [] });
    } catch (e) {
      return res.json({ ok: false, query: sym, message: 'live prices could not be read: ' + (e && e.message || e) });
    }
  }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.status(400).json({ ok: false, message: 'Say which company or index.' });
  res.set('Cache-Control', 'no-store');
  try {
    const found = await marketSearch(q);
    for (const l of found.listings.slice(0, 3)) {
      const quote = await marketQuote(l.symbol);
      if (!quote) continue;
      if (l.sector) quote.sector = l.sector;
      if (l.industry) quote.industry = l.industry;
      return res.json({ ok: true, source: MARKET_SOURCE, fetchedAt: new Date().toISOString(), query: q, quote,
        news: found.news, alternatives: found.listings.filter((x) => x.symbol !== l.symbol).slice(0, 3) });
    }
    res.json({ ok: false, notFound: true, query: q, message: 'No NSE or BSE listing matched "' + q + '".' });
  } catch (e) {
    // As with NAVs: the feed being down is an answer for LEXI to pass on, not a failed request.
    res.json({ ok: false, query: q, message: e && e.name === 'TimeoutError' ? 'the price feed did not answer in time' : 'live prices could not be read: ' + (e && e.message || e) });
  }
});

/* The candles behind the large chart: open, high, low, close and volume for
   the timeframe asked, in the feed's own bar size for it. */
const MARKET_RANGES = { '1D': ['1d', '5m'], '5D': ['5d', '15m'], '1M': ['1mo', '1d'], '3M': ['3mo', '1d'], '6M': ['6mo', '1d'],
  YTD: ['ytd', '1d'], '1Y': ['1y', '1d'], '5Y': ['5y', '1wk'], ALL: ['max', '1mo'] };
// GET /api/market/candles?symbol=<the feed's symbol>&range=1D|5D|1M|3M|6M|YTD|1Y|5Y|ALL
app.get('/api/market/candles', checkApiKey, async (req, res) => {
  const symbol = String(req.query.symbol || '').trim(), range = String(req.query.range || '6M').toUpperCase(), rg = MARKET_RANGES[range];
  res.set('Cache-Control', 'no-store');
  if (!MARKET_SYMBOL_RE.test(symbol) || !rg) return res.json({ ok: false, message: 'Say which symbol and which range.' });
  try {
    const json = await marketGet('/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + rg[0] + '&interval=' + rg[1],
      marketTtl(rg[1].endsWith('m') && rg[1] !== '1mo' ? 20 * 1000 : 45 * 1000));
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.meta) return res.json({ ok: false, notFound: true, symbol, message: 'No prices for "' + symbol + '".' });
    const m = r.meta, q = ((r.indicators || {}).quote || [])[0] || {};
    const candles = (r.timestamp || []).map((t, i) => [t * 1000, (q.open || [])[i], (q.high || [])[i], (q.low || [])[i], (q.close || [])[i], (q.volume || [])[i] || 0])
      .filter((c) => [1, 2, 3, 4].every((k) => c[k] != null && isFinite(c[k])))
      .map((c) => [c[0], marketRound(c[1]), marketRound(c[2]), marketRound(c[3]), marketRound(c[4]), c[5]]);
    res.json({ ok: true, source: MARKET_SOURCE, fetchedAt: new Date().toISOString(), symbol: m.symbol || symbol, range, interval: rg[1],
      currency: m.currency || 'INR', price: marketRound(m.regularMarketPrice), time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : '',
      prevClose: marketRound(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose), candles });
  } catch (e) {
    res.json({ ok: false, symbol, message: e && e.name === 'TimeoutError' ? 'the price feed did not answer in time' : 'candles could not be read: ' + (e && e.message || e) });
  }
});

// One send, whether it came from the CRM or from a client's own page. `allowed`
// is null for a signed-in sender and a list of addresses for a public one, so a
// form link can write to the people it concerns and to nobody else.
function sendMailRequest(body, res, allowed) {
  sendMail(body, allowed, (status, json) => res.status(status).json(json));
}
// The same send for the server's own letters (a sign-in code), which have
// no request to answer: done(status, { ok, message }).
function sendMail(body, allowed, done) {
  const c = connections.email;
  const config = (c && c.config) || {}, secrets = (c && c.secrets) || {};
  const to = cleanAddresses(body.to), cc = cleanAddresses(body.cc);
  if (!to.length) return done(400, { ok: false, message: 'No recipient.' });
  const bad = to.concat(cc).find(a => !ADDRESS_RE.test(a));
  if (bad) return done(400, { ok: false, message: '"' + bad + '" is not a usable email address.' });
  if (allowed) {
    const set = new Set(allowed.filter(Boolean).map((a) => String(a).toLowerCase()));
    const outside = to.concat(cc).find((a) => !set.has(a.toLowerCase()));
    if (outside) return done(403, { ok: false,
      message: 'This link may only write to the people it concerns, not to ' + outside + '.' });
  }

  if (!c || !config.host) return done(409, { ok: false, notConfigured: true,
    message: 'No email connector is set up yet. Add your SMTP details under Setup → Developer Hub → Connections.' });
  if (!c.enabled) return done(409, { ok: false, notConfigured: true,
    message: 'The email connector is switched off. Tick "Enable this channel" on it and test the connection.' });
  if (c.status !== 'Connected') return done(409, { ok: false, notConfigured: true,
    message: 'The email connector has not passed a connection test' + (c.lastTestMessage ? ' — ' + c.lastTestMessage : '') + '.' });

  const fromEmail = (config.fromEmail || config.username || '').trim();
  if (!ADDRESS_RE.test(fromEmail)) return done(409, { ok: false, notConfigured: true,
    message: 'The connector has no usable From address. Set From Email on it.' });

  // Attachments are capped well under the JSON body limit, so a huge file is
  // refused with a sentence rather than by the request dying halfway.
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];
  let attachBytes = 0;
  for (const a of attachments) {
    if (!a || typeof a.content !== 'string') return done(400, { ok: false, message: 'An attachment had no content.' });
    if (!/^[A-Za-z0-9+/=\s]*$/.test(a.content)) return done(400, { ok: false, message: 'An attachment was not base64.' });
    attachBytes += Math.ceil(a.content.replace(/\s/g, '').length * 3 / 4);
  }
  if (attachBytes > 12 * 1024 * 1024) return done(413, { ok: false,
    message: 'The attachments come to ' + Math.round(attachBytes / (1024 * 1024)) + 'MB. Most mailboxes refuse anything over about 10MB — send a link instead.' });

  const msg = buildMessage({
    fromEmail, fromName: config.fromName, to, cc,
    replyTo: (body.replyTo || '').trim() || undefined,
    subject: body.subject || '(no subject)',
    body: body.body || '',
    html: !!body.html,
    attachments,
  });
  smtpSession({
    host: config.host,
    port: Number(config.port) || (config.secure ? 465 : 587),
    secure: !!config.secure,
    username: config.username || '',
    password: secrets.password || '',
    message: { from: fromEmail, to: to.concat(cc), body: msg.text },
  }, (result) => {
    done(200, { ok: !!result.ok, message: result.message, messageId: result.ok ? msg.messageId : undefined,
      from: fromEmail, to, cc });
  });
}

/* ---------------------------------------------------------------------
   API CONNECTORS

   A connector is a piece of configuration the firm writes in Setup: an
   external system, a URL, an authentication method, a module and a
   field map. It lives in the CRM's own store like everything else the
   firm configures — except its credential, which lives here, beside the
   SMTP password, in connections.json outside the repository. The
   browser can set it and can say whether one is stored; it can never
   read one back.

   Three things have to happen on the server rather than in the page.

   1. THE CREDENTIAL. A key in the browser is a key in the DOM, in the
      backup file and in anybody's devtools. It is written once and
      never served.
   2. THE CALL. A page cannot call an arbitrary API anyway — the browser
      refuses it without CORS the other side has no reason to grant —
      and a call made here can have the credential attached without the
      page ever holding it.
   3. THE OTHER DIRECTION. An external system that wants BOSS data, or
      wants to push into BOSS, needs somewhere to knock. That is
      /api/share/:id, authorised by a token held here, which answers
      from this server's own copy of the store.

   The proxy is an admin tool that makes the server fetch a URL, so it
   is deliberately narrow: https only, no private or loopback address,
   one call per request, a size cap and a timeout.
   --------------------------------------------------------------------- */
const API_CONN_PREFIX = 'apiconn:';
function apiConnEntry(id) {
  return connections[API_CONN_PREFIX + id] || { secrets: {} };
}
/* An address this server must not be talked into fetching. The proxy is
   open to an administrator by design; it is not a way to reach whatever
   else happens to be listening on this machine or its network. */
function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]') return true;
  if (/\.(internal|local|lan|home|intranet)$/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
/* The one outbound call, with the stored credential put on it here. */
function apiConnFetch(opts, cb) {
  let target;
  try { target = new URL(opts.url); } catch (e) { return cb({ ok: false, status: 0, message: 'That is not a valid URL.' }); }
  if (target.protocol !== 'https:')
    return cb({ ok: false, status: 0, message: 'Use an https:// endpoint — a credential must not travel over plain http.' });
  if (privateHost(target.hostname))
    return cb({ ok: false, status: 0, message: 'That address is on this server\'s own network, which a connector may not reach.' });
  const started = Date.now();
  const req = https.request({
    hostname: target.hostname, port: target.port || 443,
    path: target.pathname + target.search, method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'BOSS-CRM/1.0', 'Accept': 'application/json' }, opts.headers || {}),
    timeout: Number(opts.timeout) || 20000,
  }, (res) => {
    let data = '', over = false;
    res.setEncoding('utf8');
    res.on('data', d => { if (data.length < 400000) data += d; else over = true; });
    res.on('end', () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      let json = null;
      try { json = JSON.parse(data); } catch (e) { /* not json, which is itself informative */ }
      cb({
        ok, status: res.statusCode, json,
        text: json ? null : data.slice(0, 4000),
        truncated: over, ms: Date.now() - started,
        message: ok ? ('HTTP ' + res.statusCode)
          : ('HTTP ' + res.statusCode + ' ' + (res.statusMessage || '')
             + (data ? ' — ' + data.trim().replace(/\s+/g, ' ').slice(0, 300) : '')),
      });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, status: 0, message: 'The external system did not answer in time.' }); });
  req.on('error', e => cb({ ok: false, status: 0, message: 'Could not reach it — ' + e.message }));
  if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  req.end();
}
// GET /api/apiconnectors -> which connectors hold a credential, and nothing else
app.get('/api/apiconnectors', checkApiKey, (req, res) => {
  const out = {};
  Object.keys(connections).forEach(k => {
    if (k.indexOf(API_CONN_PREFIX) !== 0) return;
    const s = connections[k].secrets || {};
    out[k.slice(API_CONN_PREFIX.length)] = {
      hasSecret: !!(s.secret && String(s.secret).length),
      hasShareToken: !!(s.shareToken && String(s.shareToken).length),
      updatedAt: connections[k].updatedAt || null,
    };
  });
  res.json({ connectors: out });
});
/* PUT /api/apiconnectors/:id  { secret, shareToken }
   '' leaves what is stored alone; null clears it; anything else replaces
   it. Nothing here is ever read back out. */
app.put('/api/apiconnectors/:id', checkApiKey, (req, res) => {
  const id = String(req.params.id || '').slice(0, 80);
  if (!/^[A-Za-z0-9_\-:.]+$/.test(id)) return res.status(400).json({ error: 'bad connector id' });
  const key = API_CONN_PREFIX + id;
  const entry = connections[key] || { secrets: {} };
  entry.secrets = entry.secrets || {};
  ['secret', 'shareToken'].forEach(k => {
    const v = (req.body || {})[k];
    if (v === null) { delete entry.secrets[k]; return; }
    if (typeof v === 'string' && v.length) entry.secrets[k] = v;
  });
  entry.updatedAt = new Date().toISOString();
  connections[key] = entry;
  writeConnections();
  const s = entry.secrets;
  res.json({ id, hasSecret: !!s.secret, hasShareToken: !!s.shareToken });
});
app.delete('/api/apiconnectors/:id', checkApiKey, (req, res) => {
  const key = API_CONN_PREFIX + req.params.id;
  if (!connections[key]) return res.status(404).json({ error: 'nothing stored for that connector' });
  delete connections[key];
  writeConnections();
  res.json({ id: req.params.id, deleted: true });
});
/* POST /api/apiconnectors/:id/call  { url, method, headers, body, auth }
   auth says where the stored credential goes; the credential itself is
   never in the request and never in the reply. */
app.post('/api/apiconnectors/:id/call', checkApiKey, (req, res) => {
  const id = String(req.params.id || '');
  const b = req.body || {};
  const secret = (apiConnEntry(id).secrets || {}).secret || '';
  const auth = b.auth || {};
  const headers = {};
  Object.keys(b.headers || {}).forEach(k => { headers[k] = String((b.headers || {})[k]); });
  let url = String(b.url || '');
  if (auth.kind && auth.kind !== 'none') {
    if (!secret) return res.json({ ok: false, status: 0,
      message: 'No credential is stored for this connector. Paste it in Setup and save, then try again.' });
    if (auth.kind === 'bearer') headers['Authorization'] = 'Bearer ' + secret;
    else if (auth.kind === 'basic') headers['Authorization'] = 'Basic ' + Buffer.from(String(auth.username || '') + ':' + secret).toString('base64');
    else if (auth.kind === 'header') headers[String(auth.headerName || 'X-API-Key')] = String(auth.prefix || '') + secret;
    else if (auth.kind === 'query') {
      const sep = url.indexOf('?') >= 0 ? '&' : '?';
      url += sep + encodeURIComponent(String(auth.paramName || 'api_key')) + '=' + encodeURIComponent(secret);
    }
  }
  apiConnFetch({ url, method: b.method || 'GET', headers, body: b.body, timeout: b.timeout }, (r) => res.json(r));
});
/* POST /api/apiconnectors/:id/token  { url, clientId, scope }
   OAuth 2.0 client credentials: the one grant a server can complete on
   its own. The client secret is the stored credential, so it never
   leaves this process; what comes back is handed to the caller as a
   bearer token to use for the next call and nothing is kept. */
app.post('/api/apiconnectors/:id/token', checkApiKey, (req, res) => {
  const b = req.body || {};
  const secret = (apiConnEntry(String(req.params.id || '')).secrets || {}).secret || '';
  if (!secret) return res.json({ ok: false, message: 'No client secret is stored for this connector.' });
  const form = 'grant_type=client_credentials'
    + '&client_id=' + encodeURIComponent(String(b.clientId || ''))
    + '&client_secret=' + encodeURIComponent(secret)
    + (b.scope ? '&scope=' + encodeURIComponent(String(b.scope)) : '');
  apiConnFetch({
    url: String(b.url || ''), method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    body: form,
  }, (r) => {
    const tok = r.json && (r.json.access_token || r.json.accessToken);
    if (!r.ok || !tok) return res.json({ ok: false, message: r.message || 'No access_token came back.' });
    res.json({ ok: true, token: tok, expiresIn: r.json.expires_in || null });
  });
});
/* ---- the other direction: a door the external system knocks on ----
   GET  /api/share/:id?token=…  hands over the rows that connector shares.
   POST /api/share/:id?token=…  takes rows it pushes, into a queue BOSS
   drains. Both are authorised by that connector's own share token, held
   in connections.json and compared here; neither uses the CRM's API key,
   so giving a partner a token does not give them the CRM. */
function shareConnector(id) {
  let list = [];
  try { list = JSON.parse(store['apiConnectors'] || '[]'); } catch (e) { list = []; }
  return (Array.isArray(list) ? list : []).find(c => c && c.id === id) || null;
}
function shareAuthorised(req, id) {
  const want = (apiConnEntry(id).secrets || {}).shareToken || '';
  const got = String(req.query.token || req.get('X-Share-Token') || '');
  if (!want) return 'No share token is set for this connector.';
  if (got.length !== want.length || got !== want) return 'That token is not the one for this connector.';
  return '';
}
app.get('/api/share/:id', (req, res) => {
  const id = String(req.params.id || '');
  const conn = shareConnector(id);
  if (!conn) return res.status(404).json({ error: 'unknown connector' });
  if (conn.active === false) return res.status(403).json({ error: 'that connector is switched off' });
  if (conn.direction === 'in') return res.status(403).json({ error: 'that connector only imports; it shares nothing' });
  const why = shareAuthorised(req, id);
  if (why) return res.status(401).json({ error: why });
  const cap = Number(conn.shareLimit) || 1000;
  const read = (key) => {
    let rows = [];
    try { rows = JSON.parse(store[key] || '[]'); } catch (e) { rows = []; }
    return Array.isArray(rows) ? rows.filter(r => r && !r.deletedAt) : [];
  };
  /* A whole-system connector answers in BOSS's own export shape — the
     same { modules: { … } } the Export screen writes — so a mirror or a
     second BOSS needs no field map and no translation. */
  if (conn.module === '*') {
    const want = Array.isArray(conn.stores) && conn.stores.length ? conn.stores : [];
    if (!want.length) return res.status(409).json({
      error: 'that connector carries no module — open it in Setup and choose what it should share' });
    const modules = {};
    let count = 0;
    want.forEach(k => { modules[k] = read(k).slice(0, cap); count += modules[k].length; });
    return res.json({ source: 'BOSS', connector: conn.name || id, exportedAt: new Date().toISOString(),
      count, modules });
  }
  /* The connector names the store its module lives in; the browser
     writes it when the connector is saved, so this process needs no
     second copy of that map to fall out of step with. */
  if (!conn.store) return res.status(409).json({
    error: 'that connector does not say which store it reads — open it in Setup and save it again' });
  const maps = (conn.map || []).filter(m => m && m.boss && m.ext);
  const out = read(conn.store).slice(0, cap)
    .map(r => {
      const o = {};
      maps.forEach(m => { o[m.ext] = r[m.boss] === undefined ? null : r[m.boss]; });
      return o;
    });
  res.json({ connector: conn.name || id, module: conn.module || '', count: out.length, records: out });
});
app.post('/api/share/:id', (req, res) => {
  const id = String(req.params.id || '');
  const conn = shareConnector(id);
  if (!conn) return res.status(404).json({ error: 'unknown connector' });
  if (conn.active === false) return res.status(403).json({ error: 'that connector is switched off' });
  if (conn.direction === 'out') return res.status(403).json({ error: 'that connector only shares; it imports nothing' });
  const why = shareAuthorised(req, id);
  if (why) return res.status(401).json({ error: why });
  const body = req.body || {};
  /* A whole-system push is one object carrying every module, and goes
     into the queue as one item; anything else is a list of records. */
  const whole = conn.module === '*';
  const rows = whole ? [body]
    : (Array.isArray(body) ? body : (Array.isArray(body.records) ? body.records : [body]));
  if (whole && !(body.modules && typeof body.modules === 'object'))
    return res.status(400).json({ error: 'a whole-system connector expects {"modules":{"leads":[…]}} — the shape the Export screen writes' });
  if (!rows.length) return res.status(400).json({ error: 'no records in that body' });
  if (!whole && rows.length > 500) return res.status(413).json({ error: 'send at most 500 records at a time' });
  let inbox = [];
  try { inbox = JSON.parse(store['apiInbox'] || '[]'); } catch (e) { inbox = []; }
  if (!Array.isArray(inbox)) inbox = [];
  inbox.push({ id: 'IN-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    connectorId: id, at: new Date().toISOString(), rows, from: req.ip || '' });
  while (inbox.length > 200) inbox.shift();          // a queue, not an archive
  store['apiInbox'] = JSON.stringify(inbox);
  writeToDisk();
  publishChange(['apiInbox'], '');
  res.json({ ok: true, queued: whole
      ? Object.values(body.modules).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
      : rows.length,
    note: 'Queued. BOSS maps and applies these the moment a session picks the change up.' });
});

// DELETE /api/connections/:id — forgets the stored credential entirely, for
// when a connector is being retired or a key has to be revoked.
app.delete('/api/connections/:id', checkApiKey, (req, res) => {
  const id = req.params.id;
  if (!connections[id]) return res.status(404).json({ error: 'nothing stored for ' + id });
  delete connections[id];
  writeConnections();
  res.json({ id, deleted: true, connection: publicConnection(id) });
});

// POST /api/connections/:id/test -> runs a real check and records what happened
app.post('/api/connections/:id/test', checkApiKey, (req, res) => {
  const id = req.params.id;
  const kind = CONNECTOR_KIND[id];
  if (!kind) return res.status(404).json({ error: 'unknown connector: ' + id });
  const c = connections[id] || { config: {}, secrets: {} };
  const config = c.config || {}, secrets = c.secrets || {};

  const finish = (result) => {
    c.status = result.ok ? 'Connected' : 'Not Connected';
    c.lastTestAt = new Date().toISOString();
    c.lastTestOk = !!result.ok;
    c.lastTestMessage = result.message;
    connections[id] = c;
    writeConnections();
    res.json({ ok: !!result.ok, message: result.message, connection: publicConnection(id) });
  };

  // Microsoft Graph speaks OAuth rather than a bearer token you can paste, so
  // the test is the token exchange itself: if the tenant, the application and
  // the secret line up, a token comes back and the mailbox is reachable.
  if (kind === 'graph') {
    if (!config.tenantId || !config.clientId) return finish({ ok: false,
      message: 'Microsoft 365 needs a Directory (tenant) ID and an Application (client) ID. Both are on the app registration in Entra ID.' });
    if (!secrets.clientSecret) return finish({ ok: false,
      message: 'No client secret is stored. Paste the secret VALUE (not its ID) from Certificates & secrets, then save.' });
    return graphToken(config, secrets, (err, token) => {
      if (err) return finish({ ok: false, message: err });
      if (!config.userId) return finish({ ok: true,
        message: 'Microsoft 365 issued a token, so the tenant, application and secret are right. Add the mailbox (a user principal name, like you@firm.com) to create meeting links.' });
      httpsProbe({
        url: 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(config.userId),
        headers: { Authorization: 'Bearer ' + token },
      }, (r) => finish(r.ok
        ? { ok: true, message: 'Connected. Microsoft 365 issued a token and the mailbox ' + config.userId + ' was found.' }
        : { ok: false, message: 'A token was issued, but the mailbox could not be read — ' + r.message }));
    });
  }

  if (kind === 'smtp') {
    if (!config.host) return finish({ ok: false, message: 'No SMTP host is set. Fill the form in and save first.' });
    if (config.username && !secrets.password) return finish({ ok: false, message: 'A username is set but no password is stored. Enter the password and save first.' });
    return smtpTest({
      host: config.host,
      port: Number(config.port) || (config.secure ? 465 : 587),
      secure: !!config.secure,
      username: config.username || '',
      password: secrets.password || '',
    }, finish);
  }

  /* The firm's own model. The honest test is to ask it what it serves: a
     model list that answers proves the endpoint is up, reachable from this
     server, and speaking the protocol the assistant will use. */
  if (kind === 'selfhosted') {
    const base = String(config.baseUrl || '').replace(/\/+$/, '');
    if (!base) return finish({ ok: false, message: 'No endpoint is set. Put your model server\u2019s base URL here \u2014 the one ending /v1 on most of them.' });
    const headers = {};
    if (secrets.apiKey) headers.Authorization = 'Bearer ' + secrets.apiKey;
    return httpProbeJsonAny({ url: base + '/models', headers }, (r) => {
      if (!r.ok) return finish({ ok: false, message: r.message });
      const list = ((r.json && r.json.data) || []).map(m => m && m.id).filter(Boolean);
      if (config.model && list.length && list.indexOf(config.model) === -1)
        return finish({ ok: false, message: 'The server answered, but it does not serve \u201c' + config.model
          + '\u201d. It serves: ' + list.slice(0, 8).join(', ') + '.' });
      return finish({ ok: true, message: 'Connected. Your own model server answered'
        + (list.length ? ' and serves ' + list.length + ' model(s)' : '')
        + '. Nothing from BOSS leaves your infrastructure through this connector.' });
    });
  }

  if (kind === 'inbound') {
    if (!secrets.apiKey) return finish({ ok: false,
      message: 'No key has been issued yet. Save one here, then paste it — with this BOSS address — into the editor extension.' });
    if (!config.lastSeenAt) return finish({ ok: false,
      message: 'The key is stored, but no editor has called in with it yet. Until one does this stays Not Connected.' });
    return finish({ ok: true,
      message: 'Connected. The last call in was at ' + config.lastSeenAt + (config.lastSeenAgent ? ' from ' + config.lastSeenAgent : '') + '.' });
  }

  const probe = buildHttpsProbe(config, secrets);
  if (probe.error) return finish({ ok: false, message: probe.error });
  httpsProbe(probe, finish);
});


/* ---------------------------------------------------------------------
   THE AI SERVICE LAYER

   One endpoint, one place credentials live, one place the privacy rules
   are enforced. No module calls a provider itself and no key ever reaches
   a browser: the page sends what it wants said, the server decides whether
   it may be said at all and, if so, says it.

   What this will not do:
     - talk to a connector that is not enabled, not connected, or whose
       privacy terms nobody has verified;
     - write a prompt, a completion or anything out of a record to disk.
       The access log keeps who asked, through which connector, how long
       the exchange was and whether it worked. It does not keep what was
       in it, because an application log is the easiest place in a system
       for client data to end up by accident;
     - act on anything. It returns text. Every change to a BOSS record is
       made by BOSS, by a user who pressed something.
   --------------------------------------------------------------------- */
const AI_MAX_CHARS = 120000;      // a request larger than this is a mistake, not a prompt
const AI_TIMEOUT_MS = 60000;
let aiCallSeq = 0;
/* Zero-retention / no-training controls, where the provider publishes one.
   Sent on every call so the posture does not depend on somebody having
   ticked a box in a console. */
function aiPrivacyHeaders(id) {
  if (id === 'claude') return { 'anthropic-version': '2023-06-01' };
  return {};
}
function aiProviderCall({ id, kind, config, secrets, system, messages, maxTokens, temperature }, cb) {
  const cap = Math.min(Number(maxTokens) || 1500, 4000);
  const temp = temperature === undefined ? 0.2 : Math.max(0, Math.min(1, Number(temperature) || 0));
  if (id === 'claude') {
    const model = config.model;
    if (!model) return cb({ ok: false, message: 'No model is set on the Claude connector. Put the model identifier from your account’s documentation in its Model field.' });
    return httpsProbeJson({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: Object.assign({ 'x-api-key': secrets.apiKey || '', 'Content-Type': 'application/json' }, aiPrivacyHeaders(id)),
      body: JSON.stringify({ model, max_tokens: cap, temperature: temp,
        system: system || undefined, messages }),
    }, (r) => {
      if (!r.ok) return cb({ ok: false, message: r.message });
      const parts = (r.json && r.json.content) || [];
      const text = parts.filter(p => p && p.type === 'text').map(p => p.text).join('').trim();
      cb(text ? { ok: true, text } : { ok: false, message: 'The provider answered, but with nothing in it.' });
    });
  }
  if (id === 'gemini') {
    const model = config.model;
    if (!model) return cb({ ok: false, message: 'No model is set on the Gemini connector. Put the model identifier from Google’s documentation in its Model field.' });
    const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }] }));
    return httpsProbeJson({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model)
         + ':generateContent?key=' + encodeURIComponent(secrets.apiKey || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ contents,
        generationConfig: { maxOutputTokens: cap, temperature: temp } },
        system ? { systemInstruction: { parts: [{ text: system }] } } : {})),
    }, (r) => {
      if (!r.ok) return cb({ ok: false, message: r.message });
      const cands = (r.json && r.json.candidates) || [];
      const text = ((cands[0] || {}).content || {}).parts
        ? cands[0].content.parts.map(p => p.text || '').join('').trim() : '';
      cb(text ? { ok: true, text } : { ok: false, message: 'The provider answered, but with nothing in it.' });
    });
  }
  // The firm's own model, behind an OpenAI-compatible endpoint. Ollama, vLLM,
  // LM Studio and every enterprise gateway worth the name speak this, so one
  // adapter covers them all and the firm is not locked to a vendor.
  if (kind === 'selfhosted') {
    const base = String(config.baseUrl || '').replace(/\/+$/, '');
    if (!base) return cb({ ok: false, message: 'No endpoint is set. Put your model server’s base URL in the connector.' });
    const model = config.model;
    if (!model) return cb({ ok: false, message: 'No model is set on the connector.' });
    const msgs = (system ? [{ role: 'system', content: system }] : []).concat(messages);
    const headers = { 'Content-Type': 'application/json' };
    if (secrets.apiKey) headers.Authorization = 'Bearer ' + secrets.apiKey;
    return httpProbeJsonAny({
      url: base + '/chat/completions', method: 'POST', headers,
      body: JSON.stringify({ model, messages: msgs, max_tokens: cap, temperature: temp, stream: false }),
    }, (r) => {
      if (!r.ok) return cb({ ok: false, message: r.message });
      const ch = ((r.json && r.json.choices) || [])[0] || {};
      const text = String((ch.message && ch.message.content) || ch.text || '').trim();
      cb(text ? { ok: true, text } : { ok: false, message: 'The model answered, but with nothing in it.' });
    });
  }
  cb({ ok: false, message: 'That connector is not a model BOSS can talk to.' });
}
/* A model the firm runs is often on its own network over plain http, which is
   fine — the traffic never leaves their infrastructure — so this one allows
   it where the outward-facing probe does not. Everything else is identical. */
function httpProbeJsonAny(opts, cb) {
  let target;
  try { target = new URL(opts.url); } catch (e) { return cb({ ok: false, message: 'That is not a valid URL.' }); }
  const lib = target.protocol === 'http:' ? http : https;
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    return cb({ ok: false, message: 'Use an http:// or https:// endpoint.' });
  const req = lib.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'http:' ? 80 : 443),
    path: target.pathname + target.search,
    method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'Finowise-BOSS/1.0', 'Accept': 'application/json' }, opts.headers || {}),
    timeout: AI_TIMEOUT_MS,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { if (data.length < 400000) data += d; });
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(data); } catch (e) { /* reported below */ }
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      cb({ ok, json, message: ok ? 'ok'
        : 'The model server answered ' + res.statusCode + ' ' + (res.statusMessage || '')
          + (data ? ' — ' + data.trim().replace(/\s+/g, ' ').slice(0, 220) : '') });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, message: 'The model server did not answer within 60 seconds.' }); });
  req.on('error', (e) => cb({ ok: false, message: 'Could not reach the model server — ' + e.message }));
  if (opts.body) req.write(opts.body);
  req.end();
}

// POST /api/ai/chat  { connector, system?, messages:[{role,content}], maxTokens?, temperature? }
// Returns { ok, text } or { ok:false, message, reason }. Signed-in users only.
app.post('/api/ai/chat', checkApiKey, (req, res) => {
  const t0 = Date.now();
  const seq = ++aiCallSeq;
  const body = req.body || {};
  const id = String(body.connector || '').toLowerCase();
  const deny = (code, message, extra) => {
    console.log('[ai] #' + seq + ' ' + (id || '?') + ' refused: ' + code);
    res.status(code === 'not_configured' ? 409 : 403)
       .json(Object.assign({ ok: false, reason: code, message }, extra || {}));
  };
  if (AI_CONNECTORS.indexOf(id) === -1)
    return deny('unknown', 'That is not a connector the assistant can speak through.');
  const c = connections[id];
  if (!c) return deny('not_configured', 'That connector has not been set up yet.');
  if (!c.enabled) return deny('disabled', 'That connector is switched off. Tick “Enable this channel” on it.');
  if (c.status !== 'Connected')
    return deny('not_connected', 'That connector is not connected. Test it in Setup → Connections first.');
  /* The gate. A public API with unverified terms gets nothing, however good
     its key is — which is the whole point of the requirement. */
  const p = aiPrivacyState(id);
  if (!p.ok) return deny('privacy', p.why, { privacy: p });

  const messages = Array.isArray(body.messages) ? body.messages
    .filter(m => m && typeof m.content === 'string' && m.content.length)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }))
    : [];
  if (!messages.length) return res.status(400).json({ ok: false, message: 'There is nothing to ask.' });
  const size = messages.reduce((n, m) => n + m.content.length, 0) + String(body.system || '').length;
  if (size > AI_MAX_CHARS)
    return res.status(413).json({ ok: false, reason: 'too_big',
      message: 'That is ' + Math.round(size / 1000) + 'KB of context. Narrow the request — a filter, a shorter period, fewer records — so only what the task needs is sent.' });

  aiProviderCall({ id, kind: CONNECTOR_KIND[id], config: c.config || {}, secrets: c.secrets || {},
    system: body.system ? String(body.system) : '', messages,
    maxTokens: body.maxTokens, temperature: body.temperature }, (r) => {
    /* What goes in the log: who, through what, how big, how long, and whether
       it worked. Not the prompt, not the answer, not a record id. */
    console.log('[ai] #' + seq + ' ' + id + ' ' + (r.ok ? 'ok' : 'failed')
      + ' in=' + size + 'ch out=' + (r.ok ? String(r.text).length : 0) + 'ch '
      + (Date.now() - t0) + 'ms');
    if (!r.ok) return res.status(502).json({ ok: false, reason: 'provider', message: r.message });
    res.json({ ok: true, text: r.text, connector: id, reach: p.reach, via: p.by || p.reach });
  });
});
// GET /api/ai/status -> which connectors the assistant may actually use, and why not where it may not.
app.get('/api/ai/status', checkApiKey, (req, res) => {
  res.json({ connectors: AI_CONNECTORS.map(id => {
    const c = connections[id] || {};
    const p = aiPrivacyState(id);
    return { id, enabled: !!c.enabled, status: connectorStatusOf(id), reach: p.reach,
             usable: !!c.enabled && c.status === 'Connected' && p.ok, privacy: p };
  }) });
});

/* The editors' way in. Not behind the CRM's API key: an extension running on
   somebody's laptop holds the connector's own key and nothing else, which is
   exactly the credential being checked here. A wrong key is a 401 and is not
   recorded; a right one marks the connector Connected and stamps when. */
app.post('/api/ai/hello', (req, res) => {
  const body = req.body || {};
  const id = String(body.connector || '').toLowerCase();
  if (INBOUND_CONNECTORS.indexOf(id) === -1) return res.status(404).json({ ok: false, error: 'unknown editor connector' });
  const c = connections[id];
  const stored = c && c.secrets && c.secrets.apiKey;
  if (!stored) return res.status(409).json({ ok: false, error: 'no key has been issued for this connector yet' });
  const given = String(body.key || '');
  if (given.length !== String(stored).length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(String(stored)))) {
    return res.status(401).json({ ok: false, error: 'that key does not match the one stored' });
  }
  c.config = c.config || {};
  c.config.lastSeenAt = new Date().toISOString();
  c.config.lastSeenAgent = String(body.agent || '').slice(0, 120);
  c.status = 'Connected';
  c.lastTestAt = c.config.lastSeenAt;
  c.lastTestOk = true;
  c.lastTestMessage = 'The editor called in' + (c.config.lastSeenAgent ? ' from ' + c.config.lastSeenAgent : '') + '.';
  connections[id] = c;
  writeConnections();
  res.json({ ok: true, connector: id, at: c.config.lastSeenAt });
});

/* GET /api/events — the stream. Signed in, like the rest of the CRM; the
   browser cannot put a header on an EventSource, so the session cookie is
   what authenticates it, and the payload carries no record data either way. */
app.get('/api/events', (req, res) => {
  if (!isSignedIn(req) && API_KEY && req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'sign in first' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx must not buffer a stream
  });
  res.write('retry: 3000\n\n');
  liveStreams.add(res);
  // What the version is right now, so a browser that reconnects can tell
  // whether it missed anything while it was away.
  liveSend(res, 'hello', { v: storeVersion, at: new Date().toISOString() });
  const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch (e) {} }, 25000);
  const stop = () => { clearInterval(beat); liveStreams.delete(res); };
  req.on('close', stop);
  req.on('error', stop);
});

/* GET /api/changes?since=N - what this browser has missed.
   The stream's safety net: the same information, pulled rather than
   pushed, so a tab that was asleep, behind a buffering proxy or off the
   network catches up by asking instead of by being reloaded by hand.
   `gap` says the log no longer reaches back that far, so the browser
   should re-read everything rather than trust a partial list. */
app.get('/api/changes', (req, res) => {
  if (!isSignedIn(req) && API_KEY && req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'sign in first' });
  }
  const since = Number(req.query.since || 0) || 0;
  const oldestHeld = changeLog.length ? changeLog[0].v : storeVersion + 1;
  res.set('Cache-Control', 'no-store').json({
    version: storeVersion,
    gap: since > 0 && since < oldestHeld - 1,
    changes: changeLog.filter((c) => c.v > since),
  });
});

/* The build being served, so a browser can say which one it has. Taken
   from the file itself rather than from git: the deploy script lives on
   the server and this has to be true whatever put the file there. */
function currentBuild() {
  try {
    const st = fs.statSync(path.join(__dirname, 'public', 'index.html'));
    return String(Math.round(st.mtimeMs)).slice(-9) + '-' + st.size;
  } catch (e) { return 'unknown'; }
}
const buildStamp = currentBuild();
app.get('/api/health', (req, res) => res.set('Cache-Control', 'no-store').json({
  ok: true, keys: Object.keys(store).length, version: storeVersion,
  build: currentBuild(), startedBuild: buildStamp,
}));

// Hands the browser the shared API key from the environment, so the secret
// stays out of git. Not itself a secret channel — the whole site sits behind
// nginx basic auth in production; see README.md on what this key does and doesn't do.
function requireAdmin(req, res, next) {
  const user = signedInUser(req);
  if (user && user.role === 'admin') return next();
  res.status(403).type('html').send(
    '<p style="font-family:system-ui;padding:24px">Only an admin can manage users. '
    + '<a href="/">Back to the CRM</a></p>');
}

app.get('/users', requireAdmin, (req, res) => {
  res.type('html').set('Cache-Control', 'no-store')
     .send(usersPage({ meId: (signedInUser(req) || {}).id }));
});

// Deleting an account is the other half of adding one. The person's records in
// the CRM are left exactly as they are — this only takes away the way in, and
// their session stops working at their next request.
app.post('/users/delete', requireAdmin, (req, res) => {
  const me = signedInUser(req) || {};
  const id = Number((req.body || {}).id);
  res.set('Cache-Control', 'no-store');
  const user = id ? findUserById.get(id) : null;
  if (!user) return res.status(404).type('html').send(usersPage({ error: 'No such account.', meId: me.id }));
  if (user.id === me.id) {
    return res.status(409).type('html')
      .send(usersPage({ error: 'That is the account you are signed in with.', meId: me.id }));
  }
  // Never leave the system with nobody who can manage accounts.
  if (user.role === 'admin' && listUsers.all().filter((u) => u.role === 'admin' && u.active !== 0).length <= 1) {
    return res.status(409).type('html')
      .send(usersPage({ error: 'That is the only admin account — make somebody else an admin first.', meId: me.id }));
  }
  deleteUserById.run(user.id);
  res.type('html').send(usersPage({ removed: user.email, meId: me.id }));
});

/* Accounts are made in one place: Team Members, which creates the person
   and the account they sign in with in the same breath. This page used to
   be a second way, and a second way is how a person and their account
   drift apart — an account with no team member behind it has no role, no
   branch, no reporting line and no access, and nothing in the CRM to
   attach them to. The form is gone and so is the route behind it, because
   a route left answering is a form somebody can still post to.

   A system with nobody in it is the one case this cannot cover, and that
   has the command line: npm run user -- add <email> <password>. */
app.post('/users', requireAdmin, (req, res) => {
  res.status(410).set('Cache-Control', 'no-store').type('html').send(usersPage({
    error: 'Accounts are made in BOSS \u203a Team Members now, which creates the person and their sign-in '
         + 'together. Nothing was added.',
    meId: (signedInUser(req) || {}).id,
  }));
});

// ------------------------------------------------- accounts, from the CRM --
// The Team Members module owns these. It creates a member, and the account
// that member signs in with is created here in the same breath — same email,
// same role, and a generated password the CRM mails to them. Nothing is typed
// in twice, and the two cannot drift apart.
function requireApiAdmin(req, res, next) {
  const user = signedInUser(req);
  if (user && user.role === 'admin') return next();
  res.status(403).json({ ok: false, message: 'Only an admin can manage sign-in accounts.' });
}

// Every account, for the CRM's Team Members screens.
app.get('/api/users', checkApiKey, requireApiAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, users: listUsers.all().map(accountJson) });
});

// Create or update the account a team member signs in with. Called whenever a
// member is saved, so it has to be safe to call again with nothing changed.
app.post('/api/users/sync', checkApiKey, requireApiAdmin, (req, res) => {
  const body = req.body || {};
  const memberId = String(body.memberId || '').trim();
  const email = String(body.email || '').trim();
  const crmRole = String(body.crmRole || '').trim();
  const role = body.admin ? 'admin' : 'user';
  const active = body.active === false ? 0 : 1;
  res.set('Cache-Control', 'no-store');
  if (!memberId) return res.status(400).json({ ok: false, message: 'Which team member is this for?' });
  if (!ADDRESS_RE.test(email)) return res.status(400).json({ ok: false, message: '"' + email + '" is not a usable email address.' });

  const byMember = findUserByMember.get(memberId);
  const byEmail = findUserByEmail.get(email);
  if (byEmail && byMember && byEmail.id !== byMember.id) {
    return res.status(409).json({ ok: false, message: email + ' already signs in as somebody else.' });
  }
  // An account that exists for this member, or one already on this address that
  // nobody owns yet — adopt it rather than refusing, so a CRM installed after
  // the accounts were made lines up with them.
  const existing = byMember || (byEmail && !byEmail.member_id ? byEmail : null);
  if (existing) {
    updateUserAccount.run(email, role, memberId, crmRole, active, existing.id);
    const after = findUserById.get(existing.id);
    return res.json({ ok: true, created: false, adopted: !byMember, account: accountJson(after) });
  }
  if (byEmail) return res.status(409).json({ ok: false, message: email + ' already signs in as somebody else.' });

  const password = String(body.password || '') || generatePassword();
  if (password.length < 8) return res.status(400).json({ ok: false, message: 'A password needs at least 8 characters.' });
  insertMemberUser.run(email, hashPassword(password), role, memberId, crmRole, active, password);
  const made = findUserByEmail.get(email);
  res.json({ ok: true, created: true, password, account: accountJson(made) });
});

// A fresh password for a member who never got theirs, or lost it.
app.post('/api/users/:memberId/password', checkApiKey, requireApiAdmin, (req, res) => {
  const user = findUserByMember.get(String(req.params.memberId || ''));
  res.set('Cache-Control', 'no-store');
  if (!user) return res.status(404).json({ ok: false, message: 'That team member has no sign-in account yet.' });
  const password = generatePassword();
  updateUserPassword.run(hashPassword(password), password, user.id);
  res.json({ ok: true, password, account: accountJson(findUserById.get(user.id)) });
});

// Removing a team member removes the account with them.
app.delete('/api/users/:memberId', checkApiKey, requireApiAdmin, (req, res) => {
  const user = findUserByMember.get(String(req.params.memberId || ''));
  res.set('Cache-Control', 'no-store');
  if (!user) return res.json({ ok: true, removed: false });
  const signedIn = signedInUser(req);
  if (signedIn && signedIn.id === user.id) {
    return res.status(409).json({ ok: false, message: 'That is the account you are signed in with.' });
  }
  deleteUserById.run(user.id);
  res.json({ ok: true, removed: true, email: user.email });
});

// ------------------------------------------------- the client's own pages --
// A lead filling in a BIS, a client signing off an allocation, somebody asking
// a question on their support link: none of them have an account here, and it
// would be absurd to ask them to sign in to answer their own adviser.
//
// So those pages are open — but only as far as their token reaches. The token
// names one record; this works out what that record is, hands the page a copy
// of just that much of the store, and accepts back only writes that stay
// inside it. The CRM's own key is never given out, and nothing here can read
// another client's anything.
function storeList(key) {
  const raw = store[key];
  if (raw === undefined) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function storeValue(key, fallback) {
  const raw = store[key];
  if (raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}
/* Everything a client's own link writes goes through here, so this is where
   their submissions join the stream. The origin says it came from a client
   link rather than from a CRM tab, which is exactly the case no open browser
   should ignore. */
function putList(key, list) { store[key] = JSON.stringify(list); publishChange([key], 'client-link'); }

/* ---------------------------------------------------------------------
   FIELD VALIDATION, on the side that cannot be bypassed.

   The page checks a mobile, an email and a PAN as they are typed, which
   is where it helps the person filling the form. This is the other half:
   what a client's own link posts back arrives from outside, over a token
   anyone holding the link has, so it is checked again here before it
   reaches a record.

   The patterns and the wording are the same settings the page reads, so
   a firm that relaxes a rule relaxes it in both places at once; the
   defaults below are only what applies before anybody has set one.
   --------------------------------------------------------------------- */
const VALIDATION_DEFAULTS = {
  mobile: { pattern: '^[0-9]{10}$', message: 'Please enter a valid 10-digit mobile number.' },
  email:  { pattern: '^[^@\\s]+@[^@\\s.]+(\\.[^@\\s.]+)+$', message: 'Please enter a valid email address.' },
  pan:    { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', message: 'Please enter a valid PAN number in the format ABCDE1234F.', upper: true },
};
function validationSetting(kind, what) {
  const settings = storeValue('settings', {}) || {};
  const key = 'validation.' + kind + (what === 'pattern' ? 'Pattern' : 'Message');
  const row = settings[key];
  const v = row && row.value;
  return (typeof v === 'string' && v.trim()) ? v : VALIDATION_DEFAULTS[kind][what];
}
/* { ok, value, message }. A blank passes — whether an answer is required
   is the form's question, not this one's. An unreadable pattern turns the
   check off rather than locking everybody out of their own forms. */
function checkValue(kind, raw) {
  const spec = VALIDATION_DEFAULTS[kind];
  if (!spec) return { ok: true, value: raw };
  let value = raw === null || raw === undefined ? '' : String(raw);
  if (spec.upper) value = value.toUpperCase();
  if (!value.trim()) return { ok: true, value };
  let re;
  try { re = new RegExp(validationSetting(kind, 'pattern')); } catch (e) { return { ok: true, value }; }
  return re.test(value) ? { ok: true, value }
                        : { ok: false, value, message: validationSetting(kind, 'message') };
}
/* Which rule a key is under, by what it is called — the same reading the
   page does, so neither side can decide a field is exempt. */
function validationKindOfKey(key) {
  const k = String(key || '').toLowerCase();
  if (/(^|[^a-z])pan([^a-z]|$)/.test(k) || k.endsWith('pan')) return 'pan';
  if (/mobile|phone/.test(k)) return 'mobile';
  if (/email/.test(k)) return 'email';
  return '';
}
/* Walk anything a client posted and report what breaks a rule. Values are
   corrected in place where correcting is right (a PAN in lower case is
   the same PAN); anything else is reported and nothing is stored. */
function validateSubmitted(value, path, out) {
  out = out || [];
  path = path || '';
  if (Array.isArray(value)) {
    value.forEach((v, i) => validateSubmitted(v, path + '[' + i + ']', out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((k) => {
      const kind = validationKindOfKey(k);
      const v = value[k];
      if (kind && (typeof v === 'string' || typeof v === 'number')) {
        const got = checkValue(kind, v);
        if (got.ok) { if (got.value !== v) value[k] = got.value; }
        else out.push({ field: path ? path + '.' + k : k, message: got.message });
        return;
      }
      validateSubmitted(v, path ? path + '.' + k : k, out);
    });
  }
  return out;
}

/* The blueprint input sheets. Mirrors APPROACH_FORMS in the page — kept here
   because what a client sends back on one of these must land on the record
   whatever the browser manages to do about it. */
const PLAN_FORM_TYPES = ['GAB', 'MULTIGOAL', 'INSPIRING', 'DURATION', 'INCOME', 'SINGLEGOAL'];

/* The record a plan belongs to, wherever it is now: the lead it was built for,
   or the client that lead became. */
function planOwnerFor(leadId) {
  if (!leadId) return null;
  const leads = storeList('leads');
  const lead = leads.find((l) => l && l.id === leadId);
  if (lead) return { record: lead, key: 'leads', list: leads };
  const clients = storeList('clients');
  const client = clients.find((c) => c && (c.id === leadId || c.convertedFromLeadId === leadId));
  return client ? { record: client, key: 'clients', list: clients } : null;
}

/* An ISEQ coming back is the other half of the same problem, and it is the
   half that bit. The input sheet has had this since Mod 14: the server writes
   what came back onto the record, so the answers never depend on the page's
   own patch getting through. The ISEQ had nothing of the kind — the page set
   the score on the lead and PUT the whole list, and a tab holding that lead
   from before the client answered could PUT it back without one. The
   submission survives, the score card survives, and the stage goes on reading
   "Awaiting the ISEQ score" with the answer sitting one table away.

   So the score is applied here too, on the server, from the row that arrived.
   A score already on the record is left alone: a later ISEQ replaces an
   earlier one only because it is the later submission, which is the row the
   page sends. */
function applyIseqSubmissionToOwner(link, sub) {
  if (!link || !sub) return false;
  if (!/^ISEQ/.test(String(sub.type || ''))) return false;
  if (sub.score === undefined || sub.score === null) return false;
  const owner = link.recordModule === 'CMS' && link.recordId
    ? (() => { const list = storeList('clients');
               const rec = list.find((c) => c && c.id === link.recordId);
               return rec ? { record: rec, key: 'clients', list } : null; })()
    : planOwnerFor(link.leadId || sub.leadId);
  if (!owner) return false;
  const rec = owner.record;
  const when = sub.submittedAt || new Date().toISOString();
  // Only a newer answer moves it, so re-posting an old row cannot walk the
  // profile backwards.
  if (rec.iseqAnsweredAt && String(rec.iseqAnsweredAt) > String(when)) return false;
  rec.iseqScore = sub.score;
  rec.iseqMaxScore = sub.maxScore;
  rec.iseqCategory = sub.category;
  rec.iseqFormType = sub.type;
  rec.iseqProfileDate = String(when).slice(0, 10);
  rec.iseqAnsweredAt = when;
  putList(owner.key, owner.list);
  return true;
}
/* An input sheet coming back IS the answer of record, so the server writes it
   onto the lead or client itself rather than trusting the page to. The page
   still does its own half — the stage it moves, the notification it raises —
   but the answers no longer depend on that patch getting through. Only blanks
   are filled, so an adviser's later correction is never overwritten. */
function applyPlanSubmissionToOwner(link, sub) {
  if (!link || !sub || PLAN_FORM_TYPES.indexOf(link.type) < 0) return false;
  const answers = sub.answers && typeof sub.answers === 'object' ? sub.answers : null;
  if (!answers) return false;
  const owner = planOwnerFor(link.leadId);
  if (!owner) return false;
  const rec = owner.record;
  const blank = (v) => v === undefined || v === null || v === ''
    || (Array.isArray(v) && !v.length);
  rec.formData = rec.formData && typeof rec.formData === 'object' ? rec.formData : {};
  const held = Object.assign({}, rec.formData[link.type]);
  let filled = 0;
  Object.keys(answers).forEach((k) => {
    if (blank(answers[k])) return;
    if (!blank(held[k])) return;
    held[k] = answers[k];
    filled++;
  });
  rec.formData[link.type] = held;
  rec.planFormReturnedAt = sub.submittedAt || new Date().toISOString();
  // …and the round the answers were for is told it has them, which is what the
  // Prepare Plan step actually waits on. A sheet can come back before any round
  // exists — the adviser sent it straight from the Plan tab — so one is opened
  // here rather than letting the answers arrive with nowhere to belong.
  const rounds = Array.isArray(rec.planRounds) ? rec.planRounds : [];
  let round = rounds.length ? rounds[rounds.length - 1] : null;
  if (!round || round.clientDecision) {
    round = { n: rounds.length + 1, type: link.type, createdAt: new Date().toISOString() };
    rounds.push(round);
    rec.planRounds = rounds;
  }
  if (!round.type) round.type = link.type;
  if (!round.inputSubmittedAt) {
    round.inputSubmittedAt = rec.planFormReturnedAt;
    round.inputSubmittedBy = sub.submittedBy || 'Client';
  }
  putList(owner.key, owner.list);
  return filled > 0 || !!round;
}

// What a token is allowed to see and touch. Returns null when it means nothing.
function publicScope(token) {
  if (!token || typeof token !== 'string') return null;
  const links = storeList('docLinks');
  const clients = storeList('clients');
  const leads = storeList('leads');
  const reviews = storeList('reviews');
  const recs = storeList('recommendations');
  const team = storeList('team');

  const link = links.find((l) => l && l.token === token);
  if (link) {
    const lead = link.leadId ? leads.find((l) => l.id === link.leadId) : null;
    // A lead that converted while its link was out with the client is no longer
    // in LMS. The link still names it, so the client it became is found here —
    // otherwise their page would load empty and every write from it be refused.
    const converted = !lead && link.leadId
      ? clients.find((c) => c && (c.id === link.leadId || c.convertedFromLeadId === link.leadId))
      : null;
    const client = link.recordModule === 'CMS' ? clients.find((c) => c.id === link.recordId)
      : converted
      || (lead && lead.convertedToClientId ? clients.find((c) => c.id === lead.convertedToClientId) : null);
    const review = reviews.find((r) => r && (r.ctFormToken === token || (link.recordModule === 'RMS' && r.id === link.recordId))) || null;
    const rec = link.allocationId ? recs.find((r) => r.id === link.allocationId) : null;
    const reviewClient = review ? clients.find((c) => c.id === review.clientId) : null;
    const owner = (lead && lead.assignedTo) || (client && client.rmName) || (review && review.assignTo) || '';
    return {
      kind: 'doc', token, link,
      ids: new Set([link.token, lead && lead.id, client && client.id, review && review.id, rec && rec.id,
                    reviewClient && reviewClient.id].filter(Boolean)),
      records: { lead, client: client || reviewClient, review, rec },
      owner: team.find((t) => t.id === owner) || null,
    };
  }
  const client = clients.find((c) => c && c.supportToken === token);
  if (client) {
    // Their own tickets are theirs to add to — writing back on one they raised
    // last week is the ordinary case, not an escape from the link.
    const mine = storeList('queries').filter((q) => q && q.clientId === client.id).map((q) => q.id);
    return {
      kind: 'support', token, link: null,
      ids: new Set([client.id].concat(mine)),
      records: { client },
      owner: team.find((t) => t.id === client.rmName) || null,
    };
  }
  return null;
}
// The addresses a page may write to: the person it belongs to, their adviser,
// and the firm itself. Not the world.
function publicMailTargets(scope) {
  const out = [];
  const r = scope.records || {};
  [r.lead, r.client, r.review].forEach((rec) => { if (rec && rec.email) out.push(rec.email); });
  if (scope.owner && scope.owner.email) out.push(scope.owner.email);
  const conn = connections.email || {};
  const from = (conn.config || {}).fromEmail || (conn.config || {}).username || '';
  if (from) out.push(from);
  const company = (storeValue('config', {}) || {}).company || {};
  if (company.email) out.push(company.email);
  return out;
}
// The slice of the store a public page is given. Lists the page needs whole
// (its own form templates, the firm's branding) come whole; lists about people
// are cut down to the one record the token names.
// The 7 Events sheet keeps the planner's own half on the record: the goal
// planning, the asset mapping and the execution plan, with the notes they
// wrote on each. The client's page needs the input form and nothing else, so
// the rest never leaves the building.
const SEVEN_EVENTS_INTERNAL = ['gp', 'map', 'mapMeta', 'exec', 'eaa'];
function scrubForClient(record) {
  const se = record && record.formData && record.formData.SEVENEVENTS;
  if (!se || typeof se !== 'object') return record;
  const copy = Object.assign({}, record);
  copy.formData = Object.assign({}, record.formData);
  const kept = {};
  Object.keys(se).forEach((k) => { if (!SEVEN_EVENTS_INTERNAL.includes(k)) kept[k] = se[k]; });
  copy.formData.SEVENEVENTS = kept;
  return copy;
}

// A public page holds part of a record, so what comes back is merged, not
// substituted — and `formData` is merged a level deeper, because each form's
// answers live under their own key and a page that only saw one of them must
// not be able to wipe the others. The planner's half of a 7 Events sheet is
// never sent out, so it is put back from what is on file.
function mergeFromClient(stored, incoming) {
  const out = Object.assign({}, stored, incoming, { id: stored.id });
  if (incoming && (incoming.formData || stored.formData)) {
    out.formData = Object.assign({}, stored.formData || {}, incoming.formData || {});
    const se = out.formData.SEVENEVENTS, old = (stored.formData || {}).SEVENEVENTS;
    if (se && typeof se === 'object' && old && typeof old === 'object') {
      const kept = Object.assign({}, se);
      SEVEN_EVENTS_INTERNAL.forEach((k) => { if (old[k] !== undefined) kept[k] = old[k]; });
      out.formData.SEVENEVENTS = kept;
    }
  }
  return out;
}

function publicBundle(scope) {
  const only = (key, keep) => storeList(key).filter(keep);
  const r = scope.records || {};
  const ids = scope.ids;
  const mine = (x) => x && ids.has(x.id);
  const bundle = {
    docLinks: scope.link ? [scope.link] : [],
    docSubmissions: only('docSubmissions', (x) => x && x.token === scope.token),
    leads: [r.lead].filter(Boolean).map(scrubForClient),
    clients: [r.client].filter(Boolean).map(scrubForClient),
    reviews: [r.review].filter(Boolean),
    recommendations: [r.rec].filter(Boolean),
    // The adviser's name and address appear on what the client is sent; nothing
    // else about the team goes out.
    team: (scope.owner ? [scope.owner] : []).map((t) => ({ id: t.id, name: t.name, email: t.email, role: t.role })),
    config: storeValue('config', null),
    settings: storeValue('settings', {}),
    schemes: storeList('schemes'),
    amcs: storeList('amcs'),
    // The service tasks that belong to this record. A form coming back closes
    // the task that was chasing it, so the page has to see them — but only
    // their bones: what a colleague wrote on one is not the client's business.
    tasks: only('tasks', (x) => x && !x.deletedAt && (ids.has(x.leadId) || ids.has(x.clientId)))
      .map((t) => ({ id: t.id, taskType: t.taskType, leadId: t.leadId, clientId: t.clientId,
                     overallStatus: t.overallStatus, dueDate: t.dueDate })),
    transactions: [],
    // The business entry this lead's plan has already raised, so approving a
    // plan updates that row instead of writing a second one.
    businessEntries: only('businessEntries', (x) => x && !x.deletedAt && ids.has(x.leadId)),
    communications: [], auditLog: [], notifications: [],
    queries: [], queryReplies: [],
  };
  if (scope.kind === 'support' && r.client) {
    bundle.queries = only('queries', (x) => x && x.clientId === r.client.id && !x.deletedAt);
    const qids = new Set(bundle.queries.map((q) => q.id));
    // Internal notes are the team's, and stay the team's.
    bundle.queryReplies = only('queryReplies', (x) => x && qids.has(x.queryId) && !x.internal && !x.deletedAt);
  }
  void mine;
  return bundle;
}
// Rows a public page may add to, and records it may change. Anything else is
// refused by name rather than ignored, so a mistake here is loud.
const PUBLIC_APPEND_KEYS = ['docSubmissions', 'tasks', 'communications', 'auditLog', 'notifications',
  'queries', 'queryReplies', 'leads', 'transactions',
  // A client approving their plan raises the business entry from it.
  'businessEntries',
  /* …and the allocation the plan decided, which the Asset Allocation module
     is supposed to hold for every plan. It was being refused here and the
     refusal was swallowed by the page, so a plan approved on the client's
     own link left no allocation row behind — only one approved inside the
     CRM did. The row names the lead it belongs to, so it comes back into
     this link's reach for the updates that follow. */
  'recommendations'];
const PUBLIC_UPDATE_KEYS = ['docLinks', 'leads', 'clients', 'reviews', 'recommendations', 'queries',
  'tasks', 'transactions', 'businessEntries'];
// A row is this token's business if it IS one of its records, or if it hangs
// off one — the task chasing this form, the transaction from this allocation.
function rowInScope(row, scope) {
  if (!row) return false;
  if (scope.ids.has(row.id)) return true;
  return ['leadId', 'clientId', 'recordId', 'reviewId', 'allocationId', 'queryId', 'refId']
    .some((k) => row[k] && scope.ids.has(row[k]));
}

// Serving the page IS the client opening the form, so that is where it is
// recorded — a link has no id of its own for the page to patch back, and this
// is the one place that always knows the form was actually looked at.
function noteLinkOpened(scope) {
  const link = scope && scope.link;
  if (!link || link.openedAt) return;
  const links = storeList('docLinks');
  const row = links.find((l) => l && l.token === link.token);
  if (!row || row.openedAt) return;
  row.openedAt = new Date().toISOString();
  row.history = (row.history || []).concat([{ at: row.openedAt, what: 'Opened by the client' }]);
  putList('docLinks', links);
  writeToDisk();
}

app.get('/api/public/bundle', (req, res) => {
  const scope = publicScope(String(req.query.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  noteLinkOpened(scope);
  // Whether a mail this page sends can actually go. The page cannot read the
  // connector itself — it only needs to know whether to promise anything.
  const conn = connections.email || {};
  const mail = {
    // The firm's own address is on the certificate this page may issue, so the
    // page is told it. It is the address mail already arrives from.
    from: ((conn.config || {}).fromEmail || (conn.config || {}).username || ''),
    ready: !!(conn.enabled && conn.status === 'Connected' && ((conn.config || {}).fromEmail || (conn.config || {}).username)),
    message: !conn.config || !(conn.config || {}).host ? 'No email connector is set up yet.'
      : !conn.enabled ? 'The email connector is switched off.'
      : conn.status !== 'Connected' ? 'The email connector has not passed a connection test.' : '',
  };
  res.json({ ok: true, kind: scope.kind, store: publicBundle(scope), mail });
});

// What the page did: rows added, and records changed. Every id is checked
// against the token's own scope before anything is written.
/* Who owns the record a client link belongs to, and a line in their bell
   when the client sends something back. Written here, on the server, so one
   submission makes one notification however many CRM tabs happen to be
   open — and so it exists at all when none is. */
function ownerOfLinkRecord(link) {
  if (!link) return null;
  if (link.leadId) {
    const lead = storeList('leads').find((l) => l && l.id === link.leadId);
    return lead ? { userId: lead.assignedTo, name: ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim(), view: 'lms', arg: lead.id } : null;
  }
  if (link.recordModule === 'CMS' && link.recordId) {
    const c = storeList('clients').find((x) => x && x.id === link.recordId);
    return c ? { userId: c.rmName, name: c.cmsName || '', view: 'cms', arg: c.id } : null;
  }
  if (link.recordModule === 'RMS' && link.recordId) {
    const r = storeList('reviews').find((x) => x && x.id === link.recordId);
    const c = r ? storeList('clients').find((x) => x && x.id === r.clientId) : null;
    return r ? { userId: (c && c.rmName) || r.assignedTo, name: (c && c.cmsName) || '', view: 'rms', arg: r.id } : null;
  }
  return null;
}
function notifyOwnerOfSubmission(link, row) {
  const owner = ownerOfLinkRecord(link);
  if (!owner || !owner.userId) return;
  // The link carries the form's own name; a link minted before it did falls
  // back to its type, tidied rather than printed raw.
  const what = (link.formName || String(link.type || 'form').replace(/_/g, ' ')).toString();
  const list = storeList('notifications');
  list.push({
    id: 'NTF-' + Math.random().toString(36).slice(2, 7).toUpperCase() + Date.now().toString().slice(-4),
    at: new Date().toISOString(), userId: owner.userId,
    title: what + ' submitted' + (owner.name ? ' by ' + owner.name : ''),
    body: 'It came back at ' + new Date().toLocaleString('en-IN') + ' and is on the record now.',
    view: owner.view, arg: owner.arg, kind: 'submission', by: 'Client',
  });
  putList('notifications', list);
}
app.post('/api/public/patch', (req, res) => {
  const scope = publicScope(String(req.query.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  const body = req.body || {};
  const appends = body.appends || {}, updates = body.updates || {};
  const refused = [];

  /* What a client's own link posts arrives from outside. The page checks
     a mobile, an email and a PAN as they are typed; this is the check
     that cannot be skipped by posting straight at the endpoint. Nothing
     is stored unless it passes, so a refused submission leaves the record
     exactly as it was.

     Only what the client is actually entering is checked — the rows they
     are adding, which is where their answers arrive. An update carries a
     whole record forward, including fields filled in long before these
     rules existed; refusing those would mean a lead with one bad PAN on
     file could never be written to again, which is not a validation rule
     but a lockout. Those fields reach the record through the answers
     above, and the answers are checked. */
  const wrong = validateSubmitted(appends);
  if (wrong.length) {
    return res.status(400).json({ ok: false, invalid: wrong,
      message: wrong.length === 1 ? wrong[0].message
        : 'Some of what was sent is not valid: ' + wrong.map((w) => w.message).join(' ') });
  }

  for (const [key, rows] of Object.entries(appends)) {
    if (!PUBLIC_APPEND_KEYS.includes(key)) { refused.push('add to ' + key); continue; }
    if (!Array.isArray(rows) || !rows.length) continue;
    const list = storeList(key);
    const have = new Set(list.map((x) => x && x.id));
    rows.forEach((row) => {
      if (!row || typeof row !== 'object' || !row.id || have.has(row.id)) return;
      list.push(row);
      have.add(row.id);
      // A row this page just created belongs to it, so it may amend it again.
      scope.ids.add(row.id);
    });
    putList(key, list);
    // A form coming back is the link's own history — recorded here because the
    // page cannot patch a link row (it has a token, not an id).
    if (key === 'docSubmissions') {
      const links = storeList('docLinks');
      let touched = false;
      rows.forEach((row) => {
        if (!row || !row.token) return;
        const link = links.find((l) => l && l.token === row.token);
        if (!link) return;
        const again = !!link.submittedAt;
        // An FQ link goes out before the client has said which age bracket
        // they are in, so what came back names the assessment they actually
        // answered. The link becomes that one — otherwise its own module
        // would file it under the bracket it happened to boot on.
        if (link.fqPick && row.type && row.type !== link.type) link.type = row.type;
        link.status = 'Submitted';
        link.submittedAt = row.submittedAt || new Date().toISOString();
        link.submittedBy = row.submittedBy || 'Client';
        link.history = (link.history || []).concat([{ at: link.submittedAt,
          what: again ? 'Re-submitted' : 'Submitted', note: row.submittedVia || '' }]);
        touched = true;
      });
      if (touched) putList('docLinks', links);
      // An input sheet is the one submission that has to change the record it
      // came from, so it is applied here rather than left to the page.
      rows.forEach((row) => {
        if (!row || !row.token) return;
        const link = links.find((l) => l && l.token === row.token);
        if (link) applyPlanSubmissionToOwner(link, row);
        // …and an ISEQ, whichever link it came back on. A submission whose
        // link has gone still names its lead, so it is applied from the row.
        if (link) applyIseqSubmissionToOwner(link, row);
        else if (row.leadId) applyIseqSubmissionToOwner({ leadId: row.leadId }, row);
      });
      // …and whoever owns that record is told, so a submission that lands
      // while nobody is looking at the right screen is still waiting for
      // them when they come back to it.
      rows.forEach((row) => {
        if (!row || !row.token) return;
        const link = links.find((l) => l && l.token === row.token);
        if (link) notifyOwnerOfSubmission(link, row);
      });
    }
  }
  for (const [key, byId] of Object.entries(updates)) {
    if (!PUBLIC_UPDATE_KEYS.includes(key)) { refused.push('change ' + key); continue; }
    const list = storeList(key);
    let touched = false;
    for (const [id, row] of Object.entries(byId || {})) {
      const idx = list.findIndex((x) => x && x.id === id);
      if (idx < 0) { refused.push(key + '/' + id); continue; }
      if (!scope.ids.has(id) && !rowInScope(list[idx], scope)) { refused.push(key + '/' + id); continue; }
      // Merge rather than replace: the page only ever held part of the store,
      // and must not be able to blank a field it never saw.
      list[idx] = mergeFromClient(list[idx], row);
      touched = true;
    }
    if (touched) putList(key, list);
  }
  writeToDisk();
  if (refused.length) return res.status(403).json({ ok: false, message: 'Outside this link: ' + refused.join(', ') });
  res.json({ ok: true });
});

/* =====================================================================
   THE APPROVAL TRAIL

   Every approval in the CRM — the reporting manager signing a plan off,
   and the client saying yes to it — is written here rather than only onto
   the record it decided. The browser cannot be trusted with the address it
   came from, so the address, the time and (for a signed-in approver) the
   account are stamped by the server; everything else is what the approver
   actually said.

   Two ways in, because there are two kinds of approver: one for somebody
   signed into the CRM, one for the client on their own document link. Both
   append to the same list, so the trail reads as one.
   ===================================================================== */
function callerIp(req) {
  const raw = (req.ip || (req.connection && req.connection.remoteAddress) || '').toString();
  // ::ffff:203.0.113.9 is an IPv4 address wearing an IPv6 coat. Written plainly.
  return raw.replace(/^::ffff:/, '') || 'unknown';
}
function recordApproval(req, fields) {
  const list = storeList('approvals');
  const row = Object.assign({}, fields, {
    id: fields.id || ('APR-' + Math.random().toString(36).slice(2, 10).toUpperCase()),
    at: new Date().toISOString(),
    ip: callerIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  });
  list.push(row);
  putList('approvals', list);
  writeToDisk();
  return row;
}
// An approval given by somebody signed into the CRM: a reporting manager, an
// admin. The account is taken from the session, not from the body.
app.post('/api/approvals', checkApiKey, (req, res) => {
  const b = req.body || {};
  const user = signedInUser(req);
  res.set('Cache-Control', 'no-store');
  if (!b.decision) return res.status(400).json({ ok: false, message: 'decision is required' });
  const row = recordApproval(req, {
    module: String(b.module || 'LMS'),
    recordId: String(b.recordId || ''),
    leadId: b.leadId || null,
    clientId: b.clientId || null,
    subject: String(b.subject || ''),
    kind: String(b.kind || 'Plan'),
    planRound: b.planRound === undefined ? null : b.planRound,
    planType: String(b.planType || ''),
    planVersionLabel: String(b.planVersionLabel || ''),
    ref: String(b.ref || ''),
    approverType: 'Internal',
    approverName: String(b.approverName || (user && user.email) || ''),
    approverId: String(b.approverId || ''),
    account: (user && user.email) || '',
    decision: String(b.decision),
    remarks: String(b.remarks || ''),
    via: 'CRM',
  });
  res.json({ ok: true, approval: row });
});
// An approval given by the person the document was sent to. The link is the
// authority: whatever it is scoped to is what the approval may name.
app.post('/api/public/approval', (req, res) => {
  const token = String(req.query.token || '');
  const scope = publicScope(token);
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  const b = req.body || {};
  if (!b.decision) return res.status(400).json({ ok: false, message: 'decision is required' });
  const links = storeList('docLinks');
  const link = links.find((l) => l && l.token === token) || {};
  const row = recordApproval(req, {
    module: link.recordModule || 'LMS',
    recordId: link.leadId || link.recordId || '',
    leadId: link.leadId || null,
    clientId: link.recordModule === 'CMS' ? link.recordId : null,
    subject: String(b.subject || ''),
    kind: String(b.kind || 'Plan'),
    planRound: link.planRound === undefined ? (b.planRound === undefined ? null : b.planRound) : link.planRound,
    planType: String(b.planType || link.type || ''),
    planVersionLabel: String(b.planVersionLabel || ''),
    // What exactly was approved, when a record can hold more than one thing
    // that gets approved: an asset allocation carries its own reference.
    ref: String(b.ref || link.allocationId || ''),
    approverType: 'External',
    approverName: String(b.approverName || ''),
    approverId: '',
    account: '',
    decision: String(b.decision),
    remarks: String(b.remarks || ''),
    via: 'Client link',
    token,
  });
  res.json({ ok: true, approval: row });
});

// The mails a client's own page sends: their score card, their copy of a form,
// the note that tells their adviser they have answered.
app.post('/api/public/mail', (req, res) => {
  const scope = publicScope(String(req.query.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  sendMailRequest(req.body || {}, res, publicMailTargets(scope));
});

app.get('/config.js', (req, res) => {
  const user = signedInUser(req);
  // A client's form page loads this too. It gets nothing: no API key, no
  // identity — that page talks only to the public endpoints, with its token.
  if (!user) {
    return res.type('application/javascript').set('Cache-Control', 'no-store')
      .send('window.CRM_API_KEY = "";window.CRM_IS_ADMIN = false;'
          + 'window.CRM_USER_EMAIL = "";window.CRM_MEMBER_ID = "";');
  }
  res.type('application/javascript').set('Cache-Control', 'no-store')
     .send('window.CRM_API_KEY = ' + JSON.stringify(API_KEY || '') + ';'
         + 'window.CRM_IS_ADMIN = ' + JSON.stringify(!!(user && user.role === 'admin')) + ';'
         // Who is signed in, so the CRM can work as them rather than as
         // whichever team member happens to be first in the list.
         + 'window.CRM_USER_EMAIL = ' + JSON.stringify((user && user.email) || '') + ';'
         + 'window.CRM_MEMBER_ID = ' + JSON.stringify((user && user.member_id) || '') + ';');
});

/* ---------------------------------------------------------------------
   REMINDERS THE SERVER SENDS BY ITSELF

   A reminder that only exists while somebody happens to have a tab open
   is not a reminder. These run here, on a timer, against the records as
   they stand at that minute, and each one is written down when it goes
   out so a restart, a second timer tick or a deploy never sends it twice.

   Two kinds:
     - attendance: 09:15 "you have not punched in" (email + browser push),
       18:00 "you are still punched in" (BOSS notification + push),
       19:00 the same by email, if they still have not punched out.
     - the Daily Working Tracker: a meeting, call or planned activity
       reaches its start time (and, if the person asked for one, a few
       minutes before it) — a BOSS notification, a push, and email if
       they chose it.

   Times are the firm's, not the server's: BUSINESS_TZ (Asia/Kolkata unless
   CRM_BUSINESS_TZ says otherwise). Browser push needs the person to have
   allowed it on that device; when they have not, the BOSS notification is
   still there for them.
   --------------------------------------------------------------------- */
const webpush = require('web-push');
const BUSINESS_TZ = process.env.CRM_BUSINESS_TZ || 'Asia/Kolkata';
const REMINDER_FILE = process.env.CRM_REMINDER_FILE || path.join(path.dirname(DB_FILE), 'reminders.json');
const VAPID_FILE = process.env.CRM_VAPID_FILE || path.join(path.dirname(DB_FILE), 'push-vapid.json');

/* The firm's date, clock and weekday right now. */
function bizNow(at) {
  const d = at ? new Date(at) : new Date();
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return { date: parts.year + '-' + parts.month + '-' + parts.day, hhmm: parts.hour + ':' + parts.minute,
    mins: Number(parts.hour) * 60 + Number(parts.minute), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
}
function storeObj(key) {
  try { const v = JSON.parse(store[key] || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
}
function hhmmOk(v) { return /^\d{1,2}:\d{2}$/.test(String(v || '')); }
function minsOf(hhmm) { const b = String(hhmm).split(':'); return Number(b[0]) * 60 + Number(b[1]); }
/* "11:00", "11:00 AM", "4:30pm" -> minutes after midnight, or null. */
function clockMins(v) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?\s*$/i.exec(String(v || ''));
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]);
  if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function clockText(mins) { return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); }

/* ---- the attendance calendar, read the way the page reads it ---- */
function hrConfigNow() {
  const c = storeObj('hrConfig');
  const day = Object.assign({ punchInFrom: '08:45', punchOutUntil: '20:45' }, c.day || {});
  const r = Object.assign({ enabled: true, inEmailAt: '09:15', outNotifyAt: '18:00', outEmailAt: '19:00' }, c.reminders || {});
  return {
    day: { from: hhmmOk(day.punchInFrom) ? day.punchInFrom : '08:45', until: hhmmOk(day.punchOutUntil) ? day.punchOutUntil : '20:45' },
    weeklyOff: Array.isArray(c.weeklyOff) ? c.weeklyOff : [],
    holidays: Array.isArray(c.holidays) ? c.holidays : [],
    leaveTypes: Array.isArray(c.leaveTypes) ? c.leaveTypes : [],
    reminders: {
      enabled: r.enabled !== false,
      inAt: hhmmOk(r.inEmailAt) ? r.inEmailAt : '09:15',
      outNotifyAt: hhmmOk(r.outNotifyAt) ? r.outNotifyAt : '18:00',
      outEmailAt: hhmmOk(r.outEmailAt) ? r.outEmailAt : '19:00',
    },
  };
}
function dowOf(date) { const d = new Date(date + 'T12:00:00Z'); return isNaN(d) ? -1 : d.getUTCDay(); }
/* Why there is no attendance on this date, or ''. */
function hrClosedWhy(date, cfg) {
  cfg = cfg || hrConfigNow();
  if (process.env.CRM_ATTENDANCE_ANY_DAY === '1') return '';
  if (dowOf(date) === 0) return 'There is no attendance on Sundays.';
  const h = cfg.holidays.find((x) => x && x.date === date);
  if (h) return 'It is a holiday' + (h.name ? ' — ' + h.name : '') + '.';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (cfg.weeklyOff.indexOf(names[dowOf(date)]) >= 0) return 'It is a weekly off.';
  return '';
}
function hrApprovedLeave(userId, date) {
  return storeList('hrLeave').find((l) => l && l.userId === userId && l.status === 'Approved'
    && String(l.from || '') <= date && date <= String(l.to || l.from || '')) || null;
}
function hrLeaveIsHalf(leave, cfg) {
  if (!leave) return false;
  if (leave.unit) return leave.unit === 'half';
  const t = (cfg || hrConfigNow()).leaveTypes.find((x) => (typeof x === 'string' ? x : (x && x.name)) === leave.type);
  return !!(t && typeof t === 'object' && t.unit === 'half');
}
function hrDayRecord(userId, date) {
  return storeList('hrAttendance').find((r) => r && r.userId === userId && r.date === date) || null;
}
function hrOpen(rec) { return rec && Array.isArray(rec.sessions) ? rec.sessions.find((s) => s && s.in && !s.out) || null : null; }
function hrEverIn(rec) { return !!(rec && Array.isArray(rec.sessions) && rec.sessions.some((s) => s && s.in)); }

/* Everybody who keeps attendance: the active team. */
function activeMembers() {
  return storeList('team').filter((t) => t && t.id && !t.deletedAt
    && !/inactive|left|disabled|deactivated/i.test(String(t.status || 'Active')));
}
function memberEmail(m) {
  if (m.email && ADDRESS_RE.test(String(m.email))) return String(m.email).trim();
  try { const u = findUserByMember.get(m.id); if (u && ADDRESS_RE.test(u.email)) return u.email; } catch (e) { /* no account */ }
  return '';
}
/* The member a signed-in account is, by the link the account was made with
   or, for older accounts, by its address. */
function memberOfUser(user) {
  if (!user) return null;
  const team = storeList('team');
  return team.find((t) => t && t.id === user.member_id)
    || team.find((t) => t && t.email && String(t.email).toLowerCase() === String(user.email || '').toLowerCase()) || null;
}

/* ---- the ledger: what went out, so nothing goes twice ---- */
function remindersRead() {
  try {
    const v = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    return { sent: v.sent && typeof v.sent === 'object' ? v.sent : {}, log: Array.isArray(v.log) ? v.log : [],
      subs: v.subs && typeof v.subs === 'object' ? v.subs : {} };
  } catch (e) { return { sent: {}, log: [], subs: {} }; }
}
let reminders = remindersRead();
function remindersWrite() {
  // Ten days of "already sent" is all that can ever matter again.
  const cutoff = bizNow(Date.now() - 10 * 86400000).date;
  Object.keys(reminders.sent).forEach((k) => { if (String(reminders.sent[k].date || '') < cutoff) delete reminders.sent[k]; });
  reminders.log = reminders.log.slice(-3000);
  const tmp = REMINDER_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(reminders)); fs.renameSync(tmp, REMINDER_FILE); }
  catch (e) { console.error('reminders: could not write the ledger —', e.message); }
}
function reminderLog(entry) { reminders.log.push(Object.assign({ at: new Date().toISOString() }, entry)); }

/* ---- browser push ---- */
function vapidKeys() {
  if (process.env.CRM_VAPID_PUBLIC && process.env.CRM_VAPID_PRIVATE)
    return { publicKey: process.env.CRM_VAPID_PUBLIC, privateKey: process.env.CRM_VAPID_PRIVATE };
  try { const v = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); if (v.publicKey && v.privateKey) return v; } catch (e) { /* first run */ }
  const k = webpush.generateVAPIDKeys();
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(k), { mode: 0o600 }); } catch (e) { console.error('push: could not keep the VAPID keys —', e.message); }
  return k;
}
const VAPID = vapidKeys();
webpush.setVapidDetails(process.env.CRM_VAPID_SUBJECT || 'mailto:admin@localhost', VAPID.publicKey, VAPID.privateKey);

/* Push to every device a person has allowed it on. A subscription the push
   service says is gone (404/410) is forgotten. */
async function pushTo(memberId, payload) {
  const subs = (reminders.subs[memberId] || []).slice();
  if (!subs.length) return { sent: 0, why: 'no device has allowed browser notifications' };
  let sent = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }); sent++; }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410))
        reminders.subs[memberId] = (reminders.subs[memberId] || []).filter((x) => x.endpoint !== s.endpoint);
    }
  }
  return { sent, why: sent ? '' : 'the push service refused it' };
}
/* A BOSS notification: the bell, the toast, and a desktop notification in
   any tab the person has open. */
function notifyInApp(memberId, n) {
  const list = storeList('notifications');
  const row = Object.assign({ id: 'NTF-' + crypto.randomBytes(6).toString('hex'), at: new Date().toISOString(),
    userId: memberId, view: '', arg: '', by: 'server' }, n);
  list.push(row);
  store.notifications = JSON.stringify(list);
  writeToDisk();
  publishChange(['notifications'], 'server');
  return row;
}
function mailTo(address, subject, body) {
  return new Promise((resolve) => {
    if (!address) return resolve({ ok: false, message: 'no email address on the account' });
    sendMail({ to: address, subject, body }, null, (status, json) => resolve({ ok: !!(json && json.ok), message: (json && json.message) || '' }));
  });
}
/* Once per key, ever. The key is written before anything is sent, so two
   ticks racing each other cannot both send. */
function claim(key, date) {
  if (reminders.sent[key]) return false;
  reminders.sent[key] = { date, at: new Date().toISOString() };
  return true;
}

/* ---- attendance ---- */
async function attendanceReminders(now) {
  const cfg = hrConfigNow();
  if (!cfg.reminders.enabled) return;
  if (hrClosedWhy(now.date, cfg)) return;
  const until = minsOf(cfg.day.until);
  const site = process.env.CRM_PUBLIC_URL || '';
  for (const m of activeMembers()) {
    if (m.attendanceExempt) continue;
    const leave = hrApprovedLeave(m.id, now.date);
    const rec = hrDayRecord(m.id, now.date);
    // 09:15 — nobody has punched in. Checked again right before each send.
    if (now.mins >= minsOf(cfg.reminders.inAt) && now.mins < until && !leave && !hrEverIn(rec)) {
      if (claim('in-mail:' + m.id + ':' + now.date, now.date)) {
        const r = await mailTo(memberEmail(m), 'Reminder: you have not punched in today',
          'Hello ' + (m.name || '') + ',\n\nIt is past ' + cfg.reminders.inAt + ' and BOSS has no punch in for you today ('
          + now.date + ').\n\nPlease punch in from the Dashboard' + (site ? ': ' + site : '') + '.\n\nIf you are on leave or working '
          + 'elsewhere, speak to your reporting manager.\n\n— BOSS');
        reminderLog({ kind: 'punch-in', channel: 'email', userId: m.id, date: now.date, ok: r.ok, message: r.message });
      }
      if (claim('in-push:' + m.id + ':' + now.date, now.date)) {
        const r = await pushTo(m.id, { title: 'You have not punched in', body: 'It is past ' + cfg.reminders.inAt
          + ' and there is no punch in on your record for today.', url: '/?view=dashboard', tag: 'punch-in-' + now.date });
        reminderLog({ kind: 'punch-in', channel: 'push', userId: m.id, date: now.date, ok: r.sent > 0, message: r.why });
      }
    }
    // 18:00 — punched in, not out: in BOSS and as a push.
    const open = hrOpen(rec);
    if (open && now.mins >= minsOf(cfg.reminders.outNotifyAt) && now.mins < until) {
      if (claim('out-app:' + m.id + ':' + now.date, now.date)) {
        notifyInApp(m.id, { title: 'You are still punched in', kind: 'hr-reminder', view: 'dashboard', tag: 'punch-out-' + now.date,
          body: 'It is past ' + cfg.reminders.outNotifyAt + ' and you have not punched out today. Punch out before '
            + cfg.day.until + '.' });
        reminderLog({ kind: 'punch-out', channel: 'in-app', userId: m.id, date: now.date, ok: true, message: '' });
      }
      if (claim('out-push:' + m.id + ':' + now.date, now.date)) {
        const r = await pushTo(m.id, { title: 'You are still punched in', body: 'It is past ' + cfg.reminders.outNotifyAt
          + ' and you have not punched out today.', url: '/?view=dashboard', tag: 'punch-out-' + now.date });
        reminderLog({ kind: 'punch-out', channel: 'push', userId: m.id, date: now.date, ok: r.sent > 0, message: r.why });
      }
    }
    // 19:00 — the same, by email, only if the record still says so now.
    if (now.mins >= minsOf(cfg.reminders.outEmailAt) && now.mins < until && hrOpen(hrDayRecord(m.id, now.date))) {
      if (claim('out-mail:' + m.id + ':' + now.date, now.date)) {
        const r = await mailTo(memberEmail(m), 'Reminder: you have not punched out today',
          'Hello ' + (m.name || '') + ',\n\nYou punched in today (' + now.date + ') and have not punched out yet. Punch out in BOSS before '
          + cfg.day.until + (site ? ': ' + site : '') + '.\n\nIf you forgot and have already left, raise an attendance regularization.\n\n— BOSS');
        reminderLog({ kind: 'punch-out', channel: 'email', userId: m.id, date: now.date, ok: r.ok, message: r.message });
      }
    }
  }
}

/* ---- the Daily Working Tracker ---- */
/* The page's own rule for whether a planned activity lands on a date. */
function weekStartOfDate(date, startsMonday) {
  const d = new Date(date + 'T12:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (startsMonday ? (dow + 6) % 7 : dow));
  return d.toISOString().slice(0, 10);
}
function activityOccursOn(a, day, startsMonday) {
  if ((a.skipDates || []).includes(day)) return false;
  if (day < a.date && !(a.days && a.days.length)) return false;
  if (a.days && a.days.length) {
    if (!a.days.includes(dowOf(day))) return false;
    if (a.repeatWeekly) return weekStartOfDate(day, startsMonday) >= weekStartOfDate(a.date, startsMonday);
    return weekStartOfDate(day, startsMonday) === weekStartOfDate(a.date, startsMonday);
  }
  const rec = a.recurrence && a.recurrence !== 'none' ? a.recurrence : null;
  if (!rec) return day === a.date;
  if (a.recurrenceUntil && day > a.recurrenceUntil) return false;
  const diff = Math.round((new Date(day + 'T12:00:00Z') - new Date(a.date + 'T12:00:00Z')) / 86400000);
  if (rec === 'daily') return diff >= 0;
  if (rec === 'weekdays') return diff >= 0 && dowOf(day) >= 1 && dowOf(day) <= 5;
  if (rec === 'weekly') return diff >= 0 && diff % 7 === 0;
  if (rec === 'monthly') return new Date(day + 'T12:00:00Z').getUTCDate() === new Date(a.date + 'T12:00:00Z').getUTCDate();
  return day === a.date;
}
function nameOfClient(id) { const c = storeList('clients').find((x) => x && x.id === id); return c ? (c.cmsName || '') : ''; }
function nameOfLead(id) { const l = storeList('leads').find((x) => x && x.id === id); return l ? ((l.firstName || '') + ' ' + (l.lastName || '')).trim() : ''; }
/* Everything on somebody's day that has a start time, as the planner shows it. */
function scheduledToday(memberId, date, startsMonday) {
  const out = [];
  storeList('meetings').forEach((m) => {
    if (!m || m.deletedAt || (m.assignTo || m.createdBy) !== memberId || m.scheduledDate !== date) return;
    if (/completed|cancelled|not required/i.test(m.status || '')) return;
    const start = clockMins(m.scheduledTime);
    if (start === null) return;
    out.push({ kind: 'meeting', id: m.id, title: m.subject || m.meetingType || 'Meeting', start,
      who: m.clientId ? nameOfClient(m.clientId) : (m.withName || ''), link: m.meetingLink || '', where: m.location || '' });
  });
  storeList('callEntries').forEach((c) => {
    if (!c || c.deletedAt || (c.loggedBy || c.createdBy) !== memberId || c.callDate !== date) return;
    if (/completed|cancelled/i.test(c.status || '')) return;
    const start = clockMins(c.startTime);
    if (start === null) return;
    out.push({ kind: 'call', id: c.id, title: c.subject || ((c.callCategory || 'Call') + (c.callType ? ' (' + c.callType + ')' : '')), start,
      who: c.clientId ? nameOfClient(c.clientId) : (c.leadId ? nameOfLead(c.leadId) : ''), link: '', where: '' });
  });
  storeList('workActivities').forEach((a) => {
    if (!a || a.deletedAt || a.userId !== memberId || !activityOccursOn(a, date, startsMonday)) return;
    if (a.status === 'Cancelled') return;
    if (a.status === 'Completed' && (a.completedOn === date || !(a.days && a.days.length > 1) && !a.repeatWeekly)) return;
    if ((a.startedOn || {})[date]) return;
    const start = clockMins(a.plannedStart);
    if (start === null) return;
    const isMeeting = /meeting/i.test(a.activityType || '');
    out.push({ kind: isMeeting ? 'meeting' : 'activity', source: 'manual', id: a.id, title: a.title || a.activityType || 'Activity', start,
      who: a.clientId ? nameOfClient(a.clientId) : (a.leadId ? nameOfLead(a.leadId) : ''), link: '', where: '' });
  });
  return out;
}
function dwtPrefs(m) {
  const p = Object.assign({ activities: true, meetings: true, inApp: true, desktop: true, email: false, advanceMinutes: 0 }, m.reminderPrefs || {});
  p.advanceMinutes = Math.max(0, Math.min(120, Number(p.advanceMinutes) || 0));
  return p;
}
async function dwtReminders(now) {
  const startsMonday = (((storeObj('config').general) || {}).weekStartsOn) !== 'Sunday';
  for (const m of activeMembers()) {
    const p = dwtPrefs(m);
    for (const it of scheduledToday(m.id, now.date, startsMonday)) {
      if (it.kind === 'meeting' ? !p.meetings : !p.activities) continue;
      /* Which reminder is due: the one at the start, or the one ahead of it.
         A reminder more than 15 minutes late is not sent by push or email —
         the BOSS notification is still written, so it is waiting for them. */
      const marks = [{ at: it.start, which: 'start' }];
      if (p.advanceMinutes) marks.push({ at: it.start - p.advanceMinutes, which: 'pre' });
      for (const mk of marks) {
        if (now.mins < mk.at) continue;
        if (mk.which === 'pre' && now.mins >= it.start) continue;
        const late = now.mins - mk.at > 15;
        if (late && mk.which === 'pre') continue;
        // The time is in the key: a rescheduled item is a new reminder, and the old time never fires.
        const key = 'dwt:' + mk.which + ':' + m.id + ':' + it.kind + ':' + it.id + ':' + now.date + ':' + clockText(it.start);
        if (!claim(key, now.date)) continue;
        const when = clockText(it.start);
        const title = it.kind === 'meeting' ? 'Meeting: ' + it.title : 'Scheduled: ' + it.title;
        const body = mk.which === 'pre'
          ? (it.kind === 'meeting' ? 'Your meeting “' + it.title + '” starts at ' + when + ', in ' + (it.start - now.mins) + ' minutes.'
            : 'Your scheduled activity “' + it.title + '” starts at ' + when + ', in ' + (it.start - now.mins) + ' minutes.')
          : (it.kind === 'meeting' ? 'Your meeting “' + it.title + '” is scheduled to start now (' + when + '). Please join or begin the meeting.'
            : 'Your scheduled activity “' + it.title + '” is due to start now (' + when + ').');
        const extra = [it.who ? 'With: ' + it.who : '', it.where ? 'Where: ' + it.where : '', it.link ? 'Link: ' + it.link : ''].filter(Boolean).join(' · ');
        const meta = { kind: it.kind, source: it.source || it.kind, id: it.id, date: now.date, time: when, who: it.who, link: it.link, where: it.where, which: mk.which };
        if (p.inApp) {
          notifyInApp(m.id, { title, body: body + (extra ? '\n' + extra : ''), kind: 'dwt-reminder', view: 'dwt', arg: now.date, meta, tag: key });
          reminderLog({ kind: 'dwt-' + mk.which, channel: 'in-app', userId: m.id, date: now.date, ok: true, message: it.title + ' ' + when });
        }
        if (p.desktop && !late) {
          const r = await pushTo(m.id, { title, body: body + (extra ? ' ' + extra : ''), url: '/?view=dwt', tag: key });
          reminderLog({ kind: 'dwt-' + mk.which, channel: 'push', userId: m.id, date: now.date, ok: r.sent > 0, message: r.why });
        }
        if (p.email && !late) {
          const r = await mailTo(memberEmail(m), title + ' at ' + when, body + (extra ? '\n\n' + extra.split(' · ').join('\n') : '') + '\n\n— BOSS');
          reminderLog({ kind: 'dwt-' + mk.which, channel: 'email', userId: m.id, date: now.date, ok: r.ok, message: r.message });
        }
      }
    }
  }
}
/* ---- insurance renewals (Insurance Agency SOP, Phase 5) ----
   A policy in force on the CMS insurance journey has its next premium due
   date on the client (insNextDueDate). The client is emailed 30, 15 and 7
   days before it, on the day, and through the grace period (7, 15 and 30
   days after); the RM gets a BOSS notification with the first one. Each
   is sent once per policy, due date and step, from 10:00 in the firm's day.
   The wording is the firm's "Insurance — renewal premium reminder"
   template, and the firm's email switches hold it like any other letter. */
const INS_REMINDER_DAYS = [30, 15, 7, 0, -7, -15, -30];
const INS_REMINDER_DEFAULT = {
  subject: 'Premium due on {DueDate} — policy {PolicyNo}',
  body: 'Dear {ClientName},\n\nThis is a reminder that the premium of {Premium} on your {Company} policy {PolicyNo} ({Plan}) is due on {DueDate}.\n\nPaying on time keeps your cover in force without a break. If you have already paid, please ignore this note, or send us the receipt and we will update our records.\n\n{Signature}',
};
function dayDiff(from, to) {
  const a = new Date(from + 'T12:00:00Z'), b = new Date(to + 'T12:00:00Z');
  return Math.round((b - a) / 86400000);
}
function addDays(date, n) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fmtDay(date) {
  const d = new Date(date + 'T12:00:00Z');
  return isNaN(d) ? date : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function inr(v) { const n = Number(v); return v && isFinite(n) ? '₹' + n.toLocaleString('en-IN') : ''; }
/* Which reminder is due today for a premium `left` days away, or null. */
function insReminderStep(left) {
  if (left > INS_REMINDER_DAYS[0] || left < INS_REMINDER_DAYS[INS_REMINDER_DAYS.length - 1]) return null;
  for (let i = 0; i < INS_REMINDER_DAYS.length; i++) {
    const step = INS_REMINDER_DAYS[i], next = INS_REMINDER_DAYS[i + 1];
    if (left <= step && (next === undefined || left > next)) return step;
  }
  return null;
}
async function insuranceRenewalReminders(now) {
  if (now.mins < 10 * 60) return;
  const cfg = storeObj('config');
  const held = cfg.mailOutflow === false ? 'Email outflow is switched off'
    : (cfg.mailModuleOff || {}).CMS ? 'Email for CMS is switched off'
    : (cfg.mailTemplatesOff || {}).insRenewalReminder ? 'The renewal reminder template is switched off' : '';
  const tpl = Object.assign({}, INS_REMINDER_DEFAULT, (cfg.mailTemplates || {}).insRenewalReminder || {});
  const firm = (cfg.company || {}).name || '';
  const clients = storeList('clients');
  let touched = false;
  for (const c of clients) {
    if (!c || c.deletedAt || c.cmsStage !== 'insActive' || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.insNextDueDate || ''))) continue;
    const due = c.insNextDueDate, left = dayDiff(now.date, due);
    const step = insReminderStep(left);
    if (step === null) continue;
    // Kept until a month past the due date, so a step is never sent twice.
    if (!claim('ins-renewal:' + c.id + ':' + (c.insPolicyNo || '') + ':' + due + ':' + step, addDays(due, 40))) continue;
    const company = c.insCompany === 'Other' ? (c.insCompanyOther || '') : (c.insCompany || '');
    const vars = { ClientName: c.cmsName || '', Name: c.cmsName || '', PolicyNo: c.insPolicyNo || '', Company: company,
      Plan: c.insPlanName || '', Premium: inr(c.insPremium), DueDate: fmtDay(due), FirmName: firm, Signature: firm };
    const fill = (t) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    const subject = fill(tpl.subject), body = fill(tpl.body);
    const address = ADDRESS_RE.test(String(c.email || '')) ? String(c.email).trim() : '';
    let r;
    if (held) r = { ok: false, held: true, message: held + ' — nothing was sent.' };
    else if (!address) r = { ok: false, message: 'no email address on this client' };
    else r = await mailTo(address, subject, body);
    const when = left > 0 ? left + ' days before' : left === 0 ? 'on the due date' : -left + ' days into the grace period';
    reminderLog({ kind: 'insurance-renewal', channel: 'email', clientId: c.id, date: now.date, due, step, ok: r.ok, message: r.message });
    // On the client's Sent Mail tab and in its insurance history, like a letter sent from the page.
    const comms = storeList('communications');
    comms.push({ id: 'COM-' + crypto.randomBytes(6).toString('hex'), clientId: c.id, leadId: null, channel: 'Email', direction: 'Outbound',
      status: r.ok ? 'Sent' : r.held ? 'Held' : 'Not Sent', statusNote: r.message || '', subject, body, address,
      at: new Date().toISOString(), by: 'server', module: 'CMS', recordId: c.id, label: 'Insurance Renewal Reminder (automatic)' });
    store.communications = JSON.stringify(comms);
    c.insHistory = (Array.isArray(c.insHistory) ? c.insHistory : []).concat([{ at: new Date().toISOString(), by: 'server', step: 'insRenewalAuto',
      label: 'Renewal reminder (' + when + ')', note: (r.ok ? 'Emailed to ' + address : 'Not sent: ' + (r.message || '')) + ' — premium due ' + fmtDay(due) }]);
    touched = true;
    if (step === INS_REMINDER_DAYS[0] && c.rmName) {
      notifyInApp(c.rmName, { title: 'Renewal premium due in 30 days', kind: 'insurance-renewal', view: 'cms', arg: c.id,
        body: (c.cmsName || 'A client') + ' — policy ' + (c.insPolicyNo || '') + ', ' + inr(c.insPremium) + ' due ' + fmtDay(due) + '.' });
    }
  }
  if (touched) {
    store.clients = JSON.stringify(clients);
    writeToDisk();
    publishChange(['clients', 'communications'], 'server');
  }
}

let reminderRunning = false;
async function reminderTick(at) {
  if (reminderRunning) return;           // one tick at a time: a slow mail server must not overlap the next
  reminderRunning = true;
  try {
    const now = bizNow(at);
    await attendanceReminders(now);
    await dwtReminders(now);
    await insuranceRenewalReminders(now);
  } catch (e) { console.error('reminders:', e && e.message || e); }
  finally { remindersWrite(); reminderRunning = false; }
}
if (process.env.CRM_REMINDERS !== 'off' && process.env.CRM_REMINDERS !== 'manual') {
  setTimeout(() => reminderTick(), 5000);
  setInterval(() => reminderTick(), 30000).unref();
}
/* The test suites run with CRM_REMINDERS=manual: no timer, and a tick is
   run on request at a time of their choosing. Never available otherwise. */
if (process.env.CRM_REMINDERS === 'manual') {
  app.post('/api/reminders/run', checkApiKey, async (req, res) => {
    await reminderTick(req.body && req.body.at);
    res.json({ ok: true, log: reminders.log.slice(-50) });
  });
}

/* The page's side of push: the public key, and this device's subscription. */
app.get('/api/push/key', (req, res) => res.json({ publicKey: VAPID.publicKey }));
app.post('/api/push/subscribe', checkApiKey, (req, res) => {
  const member = memberOfUser(signedInUser(req));
  if (!member) return res.status(403).json({ error: 'this account is not linked to a team member' });
  const s = req.body && req.body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth)
    return res.status(400).json({ error: 'that is not a push subscription' });
  const list = (reminders.subs[member.id] || []).filter((x) => x.endpoint !== s.endpoint);
  list.push({ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }, at: new Date().toISOString() });
  reminders.subs[member.id] = list.slice(-10);
  remindersWrite();
  res.json({ ok: true, devices: reminders.subs[member.id].length });
});
app.post('/api/push/unsubscribe', checkApiKey, (req, res) => {
  const member = memberOfUser(signedInUser(req));
  if (!member) return res.status(403).json({ error: 'this account is not linked to a team member' });
  const endpoint = req.body && req.body.endpoint;
  reminders.subs[member.id] = (reminders.subs[member.id] || []).filter((x) => endpoint && x.endpoint !== endpoint);
  remindersWrite();
  res.json({ ok: true, devices: reminders.subs[member.id].length });
});
/* What went out: your own, or everybody's for an administrator. */
app.get('/api/reminders/log', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const member = memberOfUser(user);
  const all = user && user.role === 'admin';
  const rows = reminders.log.filter((r) => all || (member && r.userId === member.id)).slice(-300).reverse();
  res.json({ rows, devices: member ? (reminders.subs[member.id] || []).length : 0, timezone: BUSINESS_TZ, now: bizNow() });
});
/* Attendance as the server sees it today, for the page to check itself against. */
app.get('/api/attendance/today', checkApiKey, (req, res) => {
  const member = memberOfUser(signedInUser(req));
  // An account with no team member behind it has no attendance to answer for.
  if (!member) return res.json({ member: false });
  const now = bizNow();
  const cfg = hrConfigNow();
  const rec = hrDayRecord(member.id, now.date);
  const leave = hrApprovedLeave(member.id, now.date);
  res.json({ userId: member.id, date: now.date, time: now.hhmm, punchedIn: hrEverIn(rec), open: !!hrOpen(rec),
    leave: leave ? { type: leave.type || '', half: hrLeaveIsHalf(leave, cfg) } : null, closed: hrClosedWhy(now.date, cfg) });
});

// Serve the CRM itself — one process, one command, no separate static host needed.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const HOST = process.env.HOST || '0.0.0.0'; // in production bind to 127.0.0.1 so only nginx can reach it
app.listen(PORT, HOST, () => {
  console.log(`BOSS server running on http://localhost:${PORT}`);
  console.log(`Database file: ${DB_FILE}`);
  console.log(API_KEY ? 'API key protection: ENABLED' : 'API key protection: DISABLED (set CRM_API_KEY env var before real deployment)');
});
