'use strict';
/**
 * BitBudCoin SDK v2 — Node 18+, zero zależności.
 * Zgodność portfela/podpisów oparta na wallet.js z serwera (wklejone przez właściciela):
 *   adres  = prefiks + pierwsze 40 hex z SHA-256(klucz publiczny SPKI DER)
 *   podpis = Ed25519 po UTF-8 z JSON.stringify({from,to,amount,fee,timestamp}), zapis base64
 *   tx     = {from,to,amount,fee,timestamp,publicKey(PEM SPKI),signature(base64)} -> POST /transactions/send
 * NIE ZAWIERA: weryfikacji sumy kontrolnej adresu (address-checksum-frontend.js nie widziałem).
 */
const crypto = require('crypto');
let chain = null;
try { chain = require('./bbc-chain.json'); } catch (e) { /* podaj opts.chain */ }

const ADDRESS_PREFIX = 'BbC';
const ADDRESS_HASH_LENGTH = 40;
const ADDR_RE = /^BbC[0-9a-fA-F]{40}$/;           // frontend pokazuje adresy z wielkością liter (suma kontrolna)
const isAddress = (a) => typeof a === 'string' && ADDR_RE.test(a);
/** Do sieci i do podpisu idzie ZAWSZE forma znormalizowana (małe litery) — jak w wallet.html. */
const toNetworkForm = (a) => { if (!isAddress(a)) throw new Error('Zły adres'); return a.slice(0, 3) + a.slice(3).toLowerCase(); };

function deriveAddress(publicKeyPem, prefix) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return (prefix || ADDRESS_PREFIX) + crypto.createHash('sha256').update(der).digest('hex').slice(0, ADDRESS_HASH_LENGTH);
}
function generateWallet(prefix) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  return { address: deriveAddress(pub, prefix), publicKey: pub, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
function walletFromPrivateKey(privateKeyPem, prefix) {
  const k = crypto.createPrivateKey(privateKeyPem);
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('Klucz musi być Ed25519');
  const pub = crypto.createPublicKey(k).export({ type: 'spki', format: 'pem' });
  return { address: deriveAddress(pub, prefix), publicKey: pub, privateKey: privateKeyPem };
}
function signingPayload({ from, to, amount, fee, timestamp }) {
  return JSON.stringify({ from, to, amount, fee, timestamp });
}
function signTransaction(tx, privateKeyPem) {
  return crypto.sign(null, Buffer.from(signingPayload(tx), 'utf8'), privateKeyPem).toString('base64');
}
function verifyTransaction(tx, prefix) {
  try {
    if (!tx || typeof tx.publicKey !== 'string' || typeof tx.signature !== 'string' || typeof tx.from !== 'string') return false;
    const pk = crypto.createPublicKey(tx.publicKey);
    if (pk.asymmetricKeyType !== 'ed25519') return false;
    if (deriveAddress(tx.publicKey, prefix) !== tx.from) return false;
    const sig = Buffer.from(tx.signature, 'base64');
    if (!sig.length) return false;
    return crypto.verify(null, Buffer.from(signingPayload(tx), 'utf8'), pk, sig);
  } catch (e) { return false; }
}
/** Buduje i podpisuje transakcję. amount/fee podajesz dokładnie tak, jak je rozumie węzeł (liczby). */
function buildTransaction(wallet, { to, amount, fee, timestamp }) {
  if (!isAddress(to)) throw new Error('Zły adres odbiorcy');
  if (!(Number.isFinite(amount) && amount > 0)) throw new Error('Kwota musi być liczbą > 0');
  if (!(Number.isFinite(fee) && fee >= 0)) throw new Error('Opłata musi być liczbą >= 0');
  const body = { from: wallet.address, to: toNetworkForm(to), amount, fee, timestamp: timestamp != null ? timestamp : Date.now() };
  return Object.assign({}, body, { publicKey: wallet.publicKey, signature: signTransaction(body, wallet.privateKey) });
}

// --- Opłaty: identyczne z wallet.html (poziomy rosną z kwotą, z minimum) ---
function calculateTierFee(tier, amount) {
  const amt = Math.max(0, Number(amount) || 0);
  if (tier === 'low') return Math.max(0.001, amt * 0.0005);
  if (tier === 'fast') return Math.max(0.003, amt * 0.0015);
  if (tier === 'turbo') return Math.max(0.008, amt * 0.004);
  throw new Error('Poziom: low | fast | turbo');
}
const fmtFee = (n) => Number(n.toFixed(6));

// --- Plik z kluczami z portfela WWW: klucz publiczny PEM + prywatny PEM jeden pod drugim ---
function exportBundle(w) { return w.publicKey + '\n' + w.privateKey; }
function parseBundle(text) {
  const pub = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(text);
  const priv = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(text);
  if (!priv) throw new Error('Brak klucza prywatnego w tekście');
  const w = walletFromPrivateKey(priv[0] + '\n');
  if (pub && deriveAddress(pub[0] + '\n') !== w.address) throw new Error('Klucz publiczny nie pasuje do prywatnego');
  return w;
}

// --- HTLC (kolejność pól = htlcCreatePayload/htlcClaimPayload/htlcRefundPayload z wallet.js) ---
const htlcCreatePayload = ({ htlcId, from, amount, fee, hashLock, timeoutHeight, claimant, refundee, timestamp }) =>
  JSON.stringify({ htlcId, from, amount, fee, hashLock, timeoutHeight, claimant, refundee, timestamp });
const htlcClaimPayload = ({ htlcId, claimant, secret, timestamp }) => JSON.stringify({ htlcId, claimant, secret, timestamp });
const htlcRefundPayload = ({ htlcId, refundee, timestamp }) => JSON.stringify({ htlcId, refundee, timestamp });
const signString = (str, pem) => crypto.sign(null, Buffer.from(str, 'utf8'), pem).toString('base64');
/** Jak wallet.html: hashLock = SHA-256 z TEKSTU sekretu (sekret to 64-znakowy hex traktowany jako tekst UTF-8). */
function newHtlcSecret() {
  const secret = crypto.randomBytes(32).toString('hex');
  return { htlcId: crypto.randomBytes(16).toString('hex'), secret, hashLock: crypto.createHash('sha256').update(secret, 'utf8').digest('hex') };
}
function buildHtlcCreate(w, { htlcId, amount, fee, hashLock, timeoutHeight, claimant, timestamp }) {
  const p = { htlcId, from: w.address, amount, fee, hashLock, timeoutHeight, claimant: toNetworkForm(claimant), refundee: w.address, timestamp: timestamp != null ? timestamp : Date.now() };
  return Object.assign({}, p, { type: 'HTLC_CREATE', publicKey: w.publicKey, signature: signString(htlcCreatePayload(p), w.privateKey) });
}
function buildHtlcClaim(w, { htlcId, secret, timestamp }) {
  const p = { htlcId, claimant: w.address, secret, timestamp: timestamp != null ? timestamp : Date.now() };
  return Object.assign({}, p, { type: 'HTLC_CLAIM', publicKey: w.publicKey, signature: signString(htlcClaimPayload(p), w.privateKey) });
}
function buildHtlcRefund(w, { htlcId, timestamp }) {
  const p = { htlcId, refundee: w.address, timestamp: timestamp != null ? timestamp : Date.now() };
  return Object.assign({}, p, { type: 'HTLC_REFUND', publicKey: w.publicKey, signature: signString(htlcRefundPayload(p), w.privateKey) });
}

// --- Fraza 12 słów (identyczna z seed-phrase.js portfela WWW; lista 256 słów = 1 bajt na słowo) ---
const SEED_WORDLIST = [
  "able", "acid", "aged", "also", "area", "army", "away", "baby", "back", "ball",
  "band", "bank", "base", "bath", "bean", "bear", "beat", "bell", "belt", "bend",
  "best", "bike", "bird", "blue", "boat", "body", "bold", "bolt", "bone", "book",
  "boot", "born", "boss", "both", "bowl", "boys", "bulk", "burn", "bush", "busy",
  "cake", "call", "calm", "camp", "card", "care", "case", "cash", "cast", "cave",
  "cell", "chat", "chip", "city", "clay", "clip", "club", "coal", "coat", "code",
  "cold", "come", "cook", "cool", "cope", "copy", "cord", "core", "corn", "cost",
  "crop", "dark", "dawn", "days", "deal", "dear", "debt", "deep", "deny", "desk",
  "dial", "diet", "dirt", "dish", "dive", "dock", "does", "done", "door", "dose",
  "down", "draw", "drop", "drug", "drum", "dust", "duty", "each", "earn", "ease",
  "east", "easy", "edge", "else", "even", "ever", "evil", "exit", "face", "fact",
  "fair", "fall", "farm", "fast", "fear", "feed", "feel", "file", "fill", "film",
  "find", "fine", "fire", "firm", "fish", "fist", "five", "flag", "flat", "flow",
  "folk", "fond", "food", "fool", "foot", "fork", "form", "fort", "four", "free",
  "from", "fuel", "full", "fund", "gain", "game", "gate", "gaze", "gear", "gift",
  "girl", "give", "glad", "goal", "goat", "gold", "golf", "good", "grew", "grey",
  "grip", "grow", "gulf", "hair", "half", "hall", "hand", "hang", "hard", "harm",
  "hate", "have", "head", "heal", "heap", "hear", "heat", "help", "herb", "here",
  "hero", "hide", "high", "hill", "hint", "hire", "hold", "hole", "holy", "home",
  "hope", "horn", "hour", "huge", "hunt", "hurt", "idea", "inch", "into", "iron",
  "item", "join", "joke", "jump", "june", "just", "keen", "keep", "kick", "kind",
  "king", "knee", "knew", "know", "lack", "lady", "lake", "lamp", "land", "lane",
  "last", "late", "lawn", "lead", "leaf", "lean", "left", "lens", "less", "life",
  "lift", "like", "line", "link", "lion", "list", "live", "load", "loan", "lock",
  "logo", "long", "look", "loop", "lord", "lose", "loss", "lost", "loud", "love",
  "luck", "lump", "lung", "made", "mail", "main",
];

function generateSeedPhrase() {
  return Array.from(crypto.randomBytes(12)).map((i) => SEED_WORDLIST[i]);
}
function seedPhraseToEntropy(words) {
  if (!Array.isArray(words)) words = String(words).trim().split(/\s+/).filter(Boolean);
  if (words.length !== 12) throw new Error('Fraza musi mieć dokładnie 12 słów');
  return Buffer.from(words.map((w) => {
    const i = SEED_WORDLIST.indexOf(String(w).toLowerCase().trim());
    if (i === -1) throw new Error('Słowo "' + w + '" nie jest na liście - sprawdź pisownię');
    return i;
  }));
}
/** seed32 = SHA-256("BitBudCoin-seed-v1:" + 12 bajtów indeksów) -> klucz prywatny Ed25519 (PKCS8) */
function walletFromMnemonic(words, prefix) {
  const seed32 = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('BitBudCoin-seed-v1:', 'utf8'), seedPhraseToEntropy(words)])).digest();
  const pem = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed32]), format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' });
  return walletFromPrivateKey(pem, prefix);
}
function generateWalletWithPhrase(prefix) {
  const words = generateSeedPhrase();
  return Object.assign({ words }, walletFromMnemonic(words, prefix));
}

function client(opts) {
  opts = opts || {};
  const c = opts.chain || chain;
  const net = opts.testnet ? (c && c.testnet) : c;
  const base = String(opts.url || (net && net.rpc.urls[0]) || '').replace(/\/+$/, '') + (opts.prefix || '');
  if (!base) throw new Error('Podaj opts.url albo opts.chain');
  const f = opts.fetch || fetch;
  const timeout = opts.timeoutMs || 10000;
  async function call(method, path, body) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
    try {
      const init = { method, signal: ctl.signal, headers: {} };
      if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
      const r = await f(base + (path[0] === '/' ? path : '/' + path), init), txt = await r.text();
      let data; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
      if (!r.ok) { const err = new Error('HTTP ' + r.status + (data && (data.error || data.reason) ? ': ' + (data.error || data.reason) : '')); err.status = r.status; err.data = data; throw err; }
      return data;
    } catch (e) { if (e.name === 'AbortError') throw new Error('Timeout po ' + timeout + ' ms'); throw e; }
    finally { clearTimeout(t); }
  }
  const enc = encodeURIComponent;
  const chk = (a) => { if (!isAddress(a)) throw new Error('Zły adres'); return enc(a); };
  return {
    baseUrl: base, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}),
    info: () => call('GET', '/info'),
    state: () => call('GET', '/state'),
    balance: (a) => call('GET', '/balance/' + chk(a)),
    blocks: () => call('GET', '/blocks'),
    block: (h) => call('GET', '/blocks/' + enc(h)),
    transactions: (a) => call('GET', '/transactions/address/' + chk(a)),
    peers: () => call('GET', '/peers'),
    sendRaw: (tx) => call('POST', '/transactions/send', tx),
    /** buduje, podpisuje lokalnie (klucz prywatny nie opuszcza procesu) i wysyła */
    send: (wallet, o) => call('POST', '/transactions/send', buildTransaction(wallet, o)),
    htlc: (id) => call('GET', '/htlc/' + enc(id)),
    htlcCreate: (w, o) => call('POST', '/htlc/submit', buildHtlcCreate(w, o)),
    htlcClaim: (w, o) => call('POST', '/htlc/submit', buildHtlcClaim(w, o)),
    htlcRefund: (w, o) => call('POST', '/htlc/submit', buildHtlcRefund(w, o)),
  };
}

// pomocnicze (ogólne) — NIE używane przy wysyłce; kwoty w tx są liczbami, jak w węźle
function parseUnits(value, decimals) {
  if (decimals == null) decimals = 18;
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Zła kwota: ' + value);
  const p = s.split('.'), frac = p[1] || '';
  if (frac.length > decimals) throw new Error('Za dużo miejsc po przecinku (max ' + decimals + ')');
  return BigInt(p[0] + frac + '0'.repeat(decimals - frac.length));
}
function formatUnits(value, decimals) {
  if (decimals == null) decimals = 18;
  let v = BigInt(value); const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, '0');
  const i = s.slice(0, s.length - decimals), fr = s.slice(s.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + i + (fr ? '.' + fr : '');
}

module.exports = { chain, SEED_WORDLIST, generateSeedPhrase, seedPhraseToEntropy, walletFromMnemonic, generateWalletWithPhrase, toNetworkForm, calculateTierFee, fmtFee, exportBundle, parseBundle, newHtlcSecret, buildHtlcCreate, buildHtlcClaim, buildHtlcRefund, htlcCreatePayload, htlcClaimPayload, htlcRefundPayload, isAddress, deriveAddress, generateWallet, walletFromPrivateKey, signingPayload, signTransaction, verifyTransaction, buildTransaction, client, parseUnits, formatUnits };

