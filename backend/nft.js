'use strict';
/**
 * BitBudCoin — Legendary NFT (rejestr węzła)
 *
 * UCZCIWIE: to NIE jest smart kontrakt w konsensusie łańcucha BbC (łańcuch nie ma VM).
 * To rejestr trzymany w OSOBNYM pliku nft.db na serwerze — nie dotyka bazy łańcucha.
 *  - mint:     tylko właściciel serwera (CLI przez SSH) = odpowiednik onlyOwner()
 *  - transfer: podpis Ed25519 właściciela tokenu (klucz NFT), z nonce przeciw replay
 *  - log zdarzeń ze skrótami łańcuchowymi (wykrywa przerabianie historii)
 *  - NIE synchronizuje się przez P2P — drugi węzeł ma własny, osobny rejestr
 *
 * Użycie:
 *   node nft.js mint <adres> "<nazwa>" "<opis>" [url_https_obrazka]   (adres: BbC… z portfela albo NFT…)
 *   node nft.js keygen                                  -> osobny adres NFT… + klucz prywatny (opcjonalnie)
 *   node nft.js list
 *   node nft.js admin-token [--rotate]                  -> włącza wybijanie ze strony nft.html (token w ~/secrets/nft-admin-token)
 *   W server.js (jedna linia, po utworzeniu `app`):  require('./nft').mount(app);
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// Właścicielem może być adres z portfela BbC (BbC… / tBbC…) albo osobny adres NFT… — w bazie zawsze małe litery
const ADDR_RE = /^(NFT|BbC|tBbC)[0-9a-fA-F]{40}$/;
const normAddr = (a) => (typeof a === 'string' && ADDR_RE.test(a)) ? a.replace(/^(NFT|tBbC|BbC)(.*)$/, (m, p, h) => p + h.toLowerCase()) : null;
const RARITY = 'Legendary';

function addressFromPublicKey(pubHex) {
  return 'NFT' + crypto.createHash('sha256').update(Buffer.from(pubHex, 'hex')).digest('hex').slice(0, 40);
}
function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  return { address: addressFromPublicKey(pub), publicKey: pub, privateKey: seed };
}
/** Podpis przelewu NFT kluczem z portfela BbC (PEM PKCS8) — base64, jak podpisy transakcji BbC */
function signTransferPem(privateKeyPem, tokenId, to, nonce) {
  return crypto.sign(null, Buffer.from(transferMessage(tokenId, to, nonce)), privateKeyPem).toString('base64');
}
function verifySigPem(publicKeyPem, msg, sigB64) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const sig = Buffer.from(sigB64, 'base64');
    return sig.length === 64 && crypto.verify(null, Buffer.from(msg), key, sig);
  } catch (e) { return false; }
}
function transferMessage(tokenId, to, nonce) {
  return `BBCNFT1|transfer|${tokenId}|${to}|${nonce}`;
}
function signTransfer(privateKeyHex, tokenId, to, nonce) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, 'hex')]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(transferMessage(tokenId, to, nonce)), key).toString('hex');
}
function verifySig(pubHex, msg, sigHex) {
  try {
    if (!/^[0-9a-f]{64}$/.test(pubHex) || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(msg), key, Buffer.from(sigHex, 'hex'));
  } catch (e) { return false; }
}

function createNFT(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nft_tokens(
      id INTEGER PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      image TEXT NOT NULL, rarity TEXT NOT NULL, minted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS nft_owner_idx ON nft_tokens(owner);
    CREATE TABLE IF NOT EXISTS nft_nonces(addr TEXT PRIMARY KEY, nonce INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS nft_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, token_id INTEGER NOT NULL,
      from_addr TEXT, to_addr TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT NOT NULL);
  `);

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  };
  const addEvent = (type, tokenId, from, to, ts) => {
    const last = db.prepare('SELECT hash FROM nft_events ORDER BY seq DESC LIMIT 1').get();
    const prev = last ? last.hash : 'GENESIS';
    const hash = crypto.createHash('sha256').update([prev, type, tokenId, from || '', to, ts].join('|')).digest('hex');
    db.prepare('INSERT INTO nft_events(type,token_id,from_addr,to_addr,ts,hash) VALUES(?,?,?,?,?,?)').run(type, tokenId, from, to, ts, hash);
  };
  const fail = (msg, code = 400) => { const e = new Error(msg); e.code = code; return e; };

  return {
    mint(to, name, description, image) {
      name = String(name || '').trim(); description = String(description || '').trim(); image = String(image || '').trim();
      to = normAddr(to);
      if (!to) throw fail('Zły adres odbiorcy (oczekiwano BbC… z portfela albo NFT… + 40 znaków hex)');
      if (!name || name.length > 80) throw fail('Nazwa: 1–80 znaków');
      if (description.length > 500) throw fail('Opis: max 500 znaków');
      if (image && !/^https:\/\/[^\s"'<>]{1,280}$/.test(image)) throw fail('Obrazek: pusty albo URL https://');
      return tx(() => {
        const id = db.prepare('SELECT COALESCE(MAX(id)+1,0) AS n FROM nft_tokens').get().n;
        const ts = Date.now();
        db.prepare('INSERT INTO nft_tokens VALUES(?,?,?,?,?,?,?)').run(id, to, name, description, image, RARITY, ts);
        addEvent('Mint', id, null, to, ts);
        return id;
      });
    },
    transfer({ publicKey, to, tokenId, signature }) {
      tokenId = Number(tokenId);
      if (!Number.isInteger(tokenId) || tokenId < 0) throw fail('Zły tokenId');
      to = normAddr(to);
      if (!to) throw fail('Zły adres odbiorcy');
      if (typeof publicKey !== 'string' || typeof signature !== 'string') throw fail('Brak podpisu');
      const pem = publicKey.includes('BEGIN PUBLIC KEY');
      return tx(() => {
        const t = db.prepare('SELECT owner FROM nft_tokens WHERE id=?').get(tokenId);
        if (!t) throw fail('Token nie istnieje', 404);
        let from;
        if (pem) { // klucz z portfela BbC: adres = prefiks + 40 hex z SHA-256(SPKI DER), jak w wallet.js
          let der;
          try { der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }); } catch (e) { throw fail('Zły klucz publiczny'); }
          from = (t.owner.startsWith('tBbC') ? 'tBbC' : 'BbC') + crypto.createHash('sha256').update(der).digest('hex').slice(0, 40);
        } else from = addressFromPublicKey(publicKey);
        if (t.owner !== from) throw fail('To nie jest twój token', 403);
        const row = db.prepare('SELECT nonce FROM nft_nonces WHERE addr=?').get(from);
        const nonce = (row ? row.nonce : 0) + 1;
        const good = pem ? verifySigPem(publicKey, transferMessage(tokenId, to, nonce), signature) : verifySig(publicKey, transferMessage(tokenId, to, nonce), signature);
        if (!good) throw fail('Zły podpis', 403);
        db.prepare('INSERT INTO nft_nonces VALUES(?,?) ON CONFLICT(addr) DO UPDATE SET nonce=excluded.nonce').run(from, nonce);
        db.prepare('UPDATE nft_tokens SET owner=? WHERE id=?').run(to, tokenId);
        addEvent('Transfer', tokenId, from, to, Date.now());
        return { from, to, tokenId };
      });
    },
    ownerOf: (id) => { const r = db.prepare('SELECT owner FROM nft_tokens WHERE id=?').get(Number(id)); return r ? r.owner : null; },
    getMetadata: (id) => db.prepare('SELECT id,owner,name,description,image,rarity,minted_at AS mintedAt FROM nft_tokens WHERE id=?').get(Number(id)) || null,
    balanceOf: (a) => db.prepare('SELECT COUNT(*) AS n FROM nft_tokens WHERE owner=?').get(normAddr(a) || String(a)).n,
    nextNonce: (a) => { const r = db.prepare('SELECT nonce FROM nft_nonces WHERE addr=?').get(normAddr(a) || String(a)); return (r ? r.nonce : 0) + 1; },
    list(owner, limit = 100, offset = 0) {
      limit = Math.min(Math.max(Number(limit) || 100, 1), 200); offset = Math.max(Number(offset) || 0, 0);
      const cols = 'id,owner,name,description,image,rarity,minted_at AS mintedAt';
      return owner
        ? db.prepare(`SELECT ${cols} FROM nft_tokens WHERE owner=? ORDER BY id DESC LIMIT ? OFFSET ?`).all(normAddr(owner) || String(owner), limit, offset)
        : db.prepare(`SELECT ${cols} FROM nft_tokens ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset);
    },
    total: () => db.prepare('SELECT COUNT(*) AS n FROM nft_tokens').get().n,
    events: (limit = 50) => db.prepare('SELECT seq,type,token_id AS tokenId,from_addr AS "from",to_addr AS "to",ts,hash FROM nft_events ORDER BY seq DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 50, 1), 200)),
  };
}

function openDb(file) {
  let db;
  try { const B = require('better-sqlite3'); db = new B(file); }
  catch (e) { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(file); }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  return db;
}

// ---- Wybijanie ze strony: token administratora (mint = onlyOwner) ----
const httpErr = (msg, code) => { const e = new Error(msg); e.code = code; return e; };
const adminTokenFile = () => process.env.NFT_ADMIN_TOKEN_FILE || path.join(os.homedir(), 'secrets', 'nft-admin-token');
/** Czytany przy każdym żądaniu: po `node nft.js admin-token` wybijanie działa od razu, bez restartu. */
function loadAdminToken(opts) {
  if (opts && opts.adminToken) return opts.adminToken.length >= 32 ? opts.adminToken : null;
  const env = process.env.NFT_ADMIN_TOKEN;
  if (env && env.length >= 32) return env;
  try { const t = fs.readFileSync((opts && opts.tokenFile) || adminTokenFile(), 'utf8').trim(); return t.length >= 32 ? t : null; }
  catch (e) { return null; }
}
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

function mount(app, opts = {}) {
  const express = require('express');
  const db = opts.db || openDb(opts.file || process.env.NFT_DB || path.join(__dirname, 'nft.db'));
  const nft = createNFT(db);
  const r = express.Router();
  r.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const hits = new Map();
  const limited = (req, res, next) => {
    const k = req.ip, now = Date.now(), a = (hits.get(k) || []).filter((t) => now - t < 60000);
    if (a.length >= 20) return res.status(429).json({ error: 'Za dużo żądań, poczekaj minutę' });
    a.push(now); hits.set(k, a); next();
  };
  setInterval(() => hits.clear(), 600000).unref();
  const safe = (fn) => (req, res) => { try { res.json(fn(req)); } catch (e) { res.status(e.code && e.code < 600 ? e.code : 500).json({ error: e.code ? e.message : 'Błąd serwera' }); } };

  r.get('/list', safe((q) => ({ total: nft.total(), tokens: nft.list(q.query.owner, q.query.limit, q.query.offset) })));
  r.get('/token/:id', safe((q) => { const m = nft.getMetadata(q.params.id); if (!m) throw Object.assign(new Error('Token nie istnieje'), { code: 404 }); return m; }));
  r.get('/balance/:addr', safe((q) => ({ address: q.params.addr, balance: nft.balanceOf(q.params.addr) })));
  r.get('/nonce/:addr', safe((q) => ({ address: q.params.addr, nonce: nft.nextNonce(q.params.addr) })));
  r.get('/events', safe((q) => ({ events: nft.events(q.query.limit) })));
  // Błędne próby tokenu: 5 / 15 min na adres IP oraz 30 / godz. łącznie — potem blokada (także dla dobrego tokenu).
  const bad = new Map(); let badAll = [];
  const recent = (arr, ms) => { const n = Date.now(); return arr.filter((t) => n - t < ms); };
  r.get('/mint-status', safe(() => ({ enabled: !!loadAdminToken(opts) })));
  r.post('/mint', limited, express.json({ limit: '4kb' }), safe((q) => {
    const token = loadAdminToken(opts);
    if (!token) throw httpErr('Wybijanie przez stronę jest wyłączone (brak tokenu na serwerze)', 403);
    const mine = recent(bad.get(q.ip) || [], 900000); bad.set(q.ip, mine); badAll = recent(badAll, 3600000);
    if (mine.length >= 5 || badAll.length >= 30) throw httpErr('Za dużo błędnych prób — spróbuj za 15 minut', 429);
    const given = String((q.headers && q.headers['x-admin-token']) || '');
    if (!given || !sameSecret(given, token)) { mine.push(Date.now()); badAll.push(Date.now()); throw httpErr('Zły token', 403); }
    const b = q.body || {};
    return { id: nft.mint(b.to, b.name, b.description, b.image) };
  }));
  r.post('/transfer', limited, express.json({ limit: '2kb' }), safe((q) => nft.transfer(q.body || {})));
  app.use('/api/nft', r);
  app.use('/nft', r); // alias: działa też, gdyby proxy kierowało /api/* do innego procesu
  return nft;
}

module.exports = { signTransferPem, normAddr, loadAdminToken, mount, createNFT, openDb, keygen, signTransfer, transferMessage, addressFromPublicKey, verifySig };

if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  const file = process.env.NFT_DB || path.join(__dirname, 'nft.db');
  if (cmd === 'keygen') { const k = keygen(); console.log('Adres NFT:    ', k.address, '\nKlucz publ.:  ', k.publicKey, '\nKlucz PRYWATNY (zapisz, nigdy nie pokazuj):', k.privateKey); }
  else if (cmd === 'mint') { const id = createNFT(openDb(file)).mint(a[0], a[1], a[2], a[3]); console.log('Wybito token #' + id); }
  else if (cmd === 'list') { console.table(createNFT(openDb(file)).list()); }
  else if (cmd === 'admin-token') {
    const f = adminTokenFile();
    if (fs.existsSync(f) && !a.includes('--rotate')) console.log('Token już istnieje: ' + f + '\nAby go wymienić: node nft.js admin-token --rotate');
    else {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tok = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(f, tok + '\n', { mode: 0o600 }); fs.chmodSync(f, 0o600);
      console.log('Token do wybijania ze strony (zapisz w menedżerze haseł):\n' + tok + '\nPlik na serwerze: ' + f + '\nWybijanie ze strony jest teraz włączone.');
    }
  }
  else console.log('Komendy: keygen | mint <adres> "<nazwa>" "<opis>" [https-obrazek] | list | admin-token [--rotate]');
}
