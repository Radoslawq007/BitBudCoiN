/*
 * ============================================================
 *  TEST BEZPIECZENSTWA - replaceChain a znaczniki czasu
 * ============================================================
 *
 * PYTANIE: czy replaceChain() przyjmie lancuch ze sfabrykowanymi
 * znacznikami czasu, skoro receiveBlock() takie bloki odrzuca
 * (MAX_FUTURE_DRIFT_MS = 10000 plus monotonicznosc)?
 *
 * BEZPIECZENSTWO:
 *   - kopia kodu, nie serwer
 *   - storage w pamieci, zero SQLite, zero plikow
 *   - zero sieci, zero P2P, nic nie jest nadawane
 *   - zywy lancuch BbC nietkniety
 *
 * NIE uruchamiac na produkcji.
 */

const path = require("path");
const Module = require("module");
const BACKEND = __dirname;

let PRELOAD = [];

class FakeStorage {
    constructor() { this.blocks = PRELOAD.slice(); this.credits = []; }
    hasBlocks() { return PRELOAD.length > 0; }
    loadChain() { return PRELOAD.slice(); }
    saveBlock(b) { this.blocks.push(b); }
    replaceAllBlocks(c) { this.blocks = c.slice(); }
    saveCredit(c) { this.credits.push(c); }
    getCreditsForAddress() { return []; }
    close() {}
}

const origResolve = Module._resolveFilename;
const STORAGE_ID = path.join(BACKEND, "storage.js");
Module._resolveFilename = function (request, ...rest) {
    if (request === "./storage" || request === "./storage.js") return STORAGE_ID;
    return origResolve.call(this, request, ...rest);
};
require.cache[STORAGE_ID] = { id: STORAGE_ID, filename: STORAGE_ID, loaded: true, exports: FakeStorage };

const CONFIG = require(path.join(BACKEND, "config.js"));
CONFIG.DIFFICULTY = 1;   // kopanie w ulamku sekundy

const Blockchain = require(path.join(BACKEND, "bbcblockchain.js"));
const { computeBlockHash, difficultyToTargetHex } = Blockchain;

const L = (s) => console.log(s);

/* Klasa Block nie jest eksportowana. replaceChain waliduje strukture,
   nie instanceof - wiec zwykly obiekt wystarczy. */
function makeBlock({ height, timestamp, previousHash, transactions, difficulty }) {
    const b = { height, timestamp, previousHash, transactions, difficulty, nonce: 0 };
    const target = difficultyToTargetHex(difficulty);
    b.hash = computeBlockHash(b);
    while (b.hash > target) {
        b.nonce++;
        b.hash = computeBlockHash(b);
    }
    return b;
}

L("=".repeat(60));
L(" replaceChain() a sfabrykowane znaczniki czasu");
L("=".repeat(60));

const genesis = makeBlock({
    height: 0,
    timestamp: 1700000000000,
    previousHash: "0".repeat(64),
    transactions: [],
    difficulty: CONFIG.DIFFICULTY
});
PRELOAD = [genesis];

const chain = new Blockchain();
L("uczciwy lancuch, wysokosc:   " + (chain.chain.length - 1));

const ROK = 365 * 24 * 3600 * 1000;
const kandydat = chain.chain.slice();
let prev = kandydat[kandydat.length - 1];

for (let i = 0; i < 2; i++) {
    const b = makeBlock({
        height: prev.height + 1,
        timestamp: Date.now() + ROK + i * 480000,
        previousHash: prev.hash,
        transactions: [],
        difficulty: CONFIG.DIFFICULTY
    });
    kandydat.push(b);
    prev = b;
}

L("kandydat, wysokosc:          " + (kandydat.length - 1));
L("czas ostatniego bloku:       " + new Date(prev.timestamp).toISOString());
L("odchylenie w przyszlosc:     ~365 dni (limit receiveBlock: 10 s)");
L("");

const wynik = chain.replaceChain(kandydat);

L("WYNIK replaceChain():");
L("  przyjety : " + wynik.accepted);
L("  powod    : " + (wynik.reason || "-"));
L("");

if (wynik.accepted) {
    L("!! PRZYJETY");
    L("   replaceChain nie waliduje znacznikow czasu.");
    L("   receiveBlock te same bloki by odrzucil.");
    L("   LUKA POTWIERDZONA.");
} else {
    L("ODRZUCONY - powod wyzej.");
    L("   Jesli powod NIE dotyczy czasu, luka moze istniec mimo to;");
    L("   zatrzymalo go cos innego i trzeba to obejsc w tescie.");
}
L("=".repeat(60));


/* ============================================================
   KONTROLA: czy receiveBlock() odrzuci DOKLADNIE ten sam blok?
   Bez tego nie mam asymetrii, tylko luzna walidacje w jednym
   miejscu. Dowod wymaga obu stron.
   ============================================================ */
L("");
L("=".repeat(60));
L(" KONTROLA - ten sam blok przez receiveBlock()");
L("=".repeat(60));

PRELOAD = [genesis];
const chain2 = new Blockchain();

const bloknaPojedynczo = makeBlock({
    height: 1,
    timestamp: Date.now() + ROK,
    previousHash: genesis.hash,
    transactions: [],
    difficulty: CONFIG.DIFFICULTY
});

const wynik2 = chain2.receiveBlock(bloknaPojedynczo);

L("  przyjety : " + wynik2.accepted);
L("  powod    : " + (wynik2.reason || "-"));
L("");

if (!wynik2.accepted && wynik.accepted) {
    L(">> ASYMETRIA POTWIERDZONA");
    L("   ten sam blok: receiveBlock ODRZUCA, replaceChain PRZYJMUJE");
} else if (wynik2.accepted) {
    L(">> receiveBlock tez przyjal - moja diagnoza byla bledna");
} 
L("=".repeat(60));


/* ============================================================
   PO NAPRAWIE - dwa testy, oba musza przejsc:
   A) sfabrykowany lancuch ODRZUCONY
   B) UCZCIWY dluzszy lancuch nadal PRZYJETY
      (bez B naprawa moglaby po prostu zablokowac sync)
   ============================================================ */
L("");
L("=".repeat(60));
L(" PO NAPRAWIE");
L("=".repeat(60));

PRELOAD = [genesis];
const chain3 = new Blockchain();
const wynikA = chain3.replaceChain(kandydat);
L("A) lancuch ze sfabrykowanym czasem (+365 dni)");
L("   przyjety : " + wynikA.accepted);
L("   powod    : " + (wynikA.reason || "-"));
L("");

PRELOAD = [genesis];
const chain4 = new Blockchain();
const uczciwyDluzszy = chain4.chain.slice();
let pv = uczciwyDluzszy[uczciwyDluzszy.length - 1];
for (let i = 0; i < 2; i++) {
    const b = makeBlock({
        height: pv.height + 1,
        timestamp: pv.timestamp + 480000,   // normalny odstep, w przeszlosci
        previousHash: pv.hash,
        transactions: [],
        difficulty: CONFIG.DIFFICULTY
    });
    uczciwyDluzszy.push(b);
    pv = b;
}
const wynikB = chain4.replaceChain(uczciwyDluzszy);
L("B) uczciwy dluzszy lancuch (normalne odstepy 8 min)");
L("   przyjety : " + wynikB.accepted);
L("   powod    : " + (wynikB.reason || "-"));
L("");

if (!wynikA.accepted && wynikB.accepted) {
    L(">> NAPRAWA DZIALA");
    L("   atak odrzucony, normalna synchronizacja nietknieta");
} else if (!wynikB.accepted) {
    L("!! NAPRAWA ZA OSTRA - blokuje uczciwy lancuch. NIE WDRAZAC.");
} else {
    L("!! NAPRAWA NIE DZIALA - atak nadal przechodzi.");
}
L("=".repeat(60));
