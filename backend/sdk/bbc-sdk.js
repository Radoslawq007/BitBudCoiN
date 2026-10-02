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

// --- Standardowy portfel: BIP39 (12 słów, lista 2048) + SLIP-0010 (Ed25519, ścieżki utwardzone) ---
// To NOWY typ portfela: daje INNE adresy niż stara fraza 256-słowna. Stare portfele działają bez zmian.
const BIP39_ENGLISH = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo".split(" ");

// TYMCZASOWY numer monety (SLIP-44). Przed zgłoszeniem do rejestru trzeba potwierdzić, że jest wolny.
const BBC_COIN_TYPE = 28000000;
const bip39Bits = (buf) => Array.from(buf).map((b) => b.toString(2).padStart(8, '0')).join('');

function entropyToBip39(entropy) {
  if (!Buffer.isBuffer(entropy) || entropy.length !== 16) throw new Error('Potrzeba 16 bajtów entropii (12 słów)');
  const cs = bip39Bits(crypto.createHash('sha256').update(entropy).digest()).slice(0, 4);
  const bits = bip39Bits(entropy) + cs;
  const out = [];
  for (let i = 0; i < 12; i++) out.push(BIP39_ENGLISH[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
  return out;
}
function bip39ToEntropy(words) {
  if (!Array.isArray(words)) words = String(words).trim().split(/\s+/).filter(Boolean);
  if (words.length !== 12) throw new Error('Fraza musi mieć dokładnie 12 słów');
  let bits = '';
  for (const w of words) {
    const i = BIP39_ENGLISH.indexOf(String(w).toLowerCase().trim());
    if (i === -1) throw new Error('Słowo "' + w + '" nie jest na liście BIP39');
    bits += i.toString(2).padStart(11, '0');
  }
  const entropy = Buffer.from(bits.slice(0, 128).match(/.{8}/g).map((b) => parseInt(b, 2)));
  if (bip39Bits(crypto.createHash('sha256').update(entropy).digest()).slice(0, 4) !== bits.slice(128)) throw new Error('Zła suma kontrolna frazy (literówka lub zła kolejność)');
  return entropy;
}
const isValidBip39 = (words) => { try { bip39ToEntropy(words); return true; } catch (e) { return false; } };
const generateBip39Phrase = () => entropyToBip39(crypto.randomBytes(16));
function bip39ToSeed(words, passphrase) {
  bip39ToEntropy(words);
  if (!Array.isArray(words)) words = String(words).trim().split(/\s+/).filter(Boolean);
  const m = words.map((x) => x.toLowerCase().trim()).join(' ').normalize('NFKD');
  return crypto.pbkdf2Sync(Buffer.from(m, 'utf8'), Buffer.from(('mnemonic' + (passphrase || '')).normalize('NFKD'), 'utf8'), 2048, 64, 'sha512');
}
function slip10Master(seed) {
  const I = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  return { key: I.subarray(0, 32), chain: I.subarray(32) };
}
function slip10Child(parent, index) { // tylko utwardzone (Ed25519)
  const data = Buffer.alloc(37); data[0] = 0; parent.key.copy(data, 1); data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
  const I = crypto.createHmac('sha512', parent.chain).update(data).digest();
  return { key: I.subarray(0, 32), chain: I.subarray(32) };
}
function slip10Derive(seed, pathArr) { return pathArr.reduce(slip10Child, slip10Master(seed)); }
/** Ścieżka: m/44'/coinType'/account'/0'/index' (wszystko utwardzone) */
function walletFromBip39(words, o) {
  o = o || {};
  const path = [44, o.coinType != null ? o.coinType : BBC_COIN_TYPE, o.account || 0, 0, o.index || 0];
  const k = slip10Derive(bip39ToSeed(words, o.passphrase), path).key;
  const pem = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), k]), format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' });
  return walletFromPrivateKey(pem, o.prefix);
}
function generateBip39Wallet(o) { const words = generateBip39Phrase(); return Object.assign({ words }, walletFromBip39(words, o)); }

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

module.exports = { chain, BIP39_ENGLISH, BBC_COIN_TYPE, entropyToBip39, bip39ToEntropy, isValidBip39, generateBip39Phrase, bip39ToSeed, slip10Master, slip10Child, slip10Derive, walletFromBip39, generateBip39Wallet, walletFromLegacyPhrase: walletFromMnemonic, SEED_WORDLIST, generateSeedPhrase, seedPhraseToEntropy, walletFromMnemonic, generateWalletWithPhrase, toNetworkForm, calculateTierFee, fmtFee, exportBundle, parseBundle, newHtlcSecret, buildHtlcCreate, buildHtlcClaim, buildHtlcRefund, htlcCreatePayload, htlcClaimPayload, htlcRefundPayload, isAddress, deriveAddress, generateWallet, walletFromPrivateKey, signingPayload, signTransaction, verifyTransaction, buildTransaction, client, parseUnits, formatUnits };
