/*
 * ============================================================
 *  TEST BEZPIECZENSTWA - powtorzenie transakcji (replay)
 * ============================================================
 *
 * PYTANIE: czy transakcja, ktora JUZ jest w lancuchu, moze zostac
 * przyjeta ponownie? mempool.addTransaction() sprawdza tylko
 * this.pending.has(tx.signature) - czyli biezaca kolejke. Po
 * wykopaniu transakcja z kolejki znika. Czy cos jeszcze ja zatrzyma?
 *
 * DLACZEGO TO WAZNE DLA GIELDY: gielda podpisuje wyplate. Transakcja
 * lezy jawnie w publicznym lancuchu wraz z podpisem. Jesli da sie ja
 * odtworzyc, atakujacy powtarza ja w kolko az gorący portfel jest pusty.
 *
 * BEZPIECZENSTWO TESTU:
 *   - kopia kodu, nie serwer
 *   - storage w pamieci, zero SQLite, zero plikow
 *   - zero sieci, zero P2P, nic nie jest nadawane
 *   - zywy lancuch BbC nietkniety
 *
 * NIE uruchamiac na produkcji.
 */

const path = require("path");
const Module = require("module");
const crypto = require("crypto");
const BACKEND = __dirname;

let PRELOAD = [];

class FakeStorage {
    constructor() { this.blocks = PRELOAD.slice(); this.credits = []; }
    hasBlocks() { return PRELOAD.length > 0; }
    loadChain() { return PRELOAD.slice(); }
    loadMempool() { return []; }
    saveBlock(b) { this.blocks.push(b); }
    replaceAllBlocks(c) { this.blocks = c.slice(); }
    saveCredit(c) { this.credits.push(c); }
    saveMempoolTx() {}
    deleteMempoolTx() {}
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
CONFIG.DIFFICULTY = 1;

const Blockchain = require(path.join(BACKEND, "bbcblockchain.js"));
const { computeBlockHash, difficultyToTargetHex } = Blockchain;
const Wallet = require(path.join(BACKEND, "wallet.js"));
const Mempool = require(path.join(BACKEND, "mempool.js"));

const L = (s) => console.log(s);

function makeBlock({ height, timestamp, previousHash, transactions, difficulty }) {
    const b = { height, timestamp, previousHash, transactions, difficulty, nonce: 0 };
    const target = difficultyToTargetHex(difficulty);
    b.hash = computeBlockHash(b);
    while (b.hash > target) { b.nonce++; b.hash = computeBlockHash(b); }
    return b;
}

L("=".repeat(62));
L(" POWTORZENIE TRANSAKCJI (replay)");
L("=".repeat(62));

/* --- Dwa portfele --- */
const A = Wallet.generateWallet();
const B = Wallet.generateWallet();
L("nadawca  A: " + A.address);
L("odbiorca B: " + B.address);

/* --- A dostaje srodki przez coinbase w genesis --- */
const coinbase = {
    from: null,
    to: A.address,
    amount: 50,
    fee: 0,
    type: "coinbase",
    timestamp: 1700000000000
};

const genesis = makeBlock({
    height: 0,
    timestamp: Date.now() - 90 * 60 * 1000,
    previousHash: "0".repeat(64),
    transactions: [coinbase],
    difficulty: CONFIG.DIFFICULTY
});

/* --- Transakcja A -> B, podpisana poprawnie --- */
/* Czas bazowy MUSI byc realistyczny: mempool odrzuca transakcje starsze
   niz 24 h (wyrownane z MEMPOOL_TTL_MS). Staly znacznik z 2023 roku
   przechodzil, zanim ta kontrola powstala. */
const ts = Date.now() - 30 * 60 * 1000;
const txBody = { from: A.address, to: B.address, amount: 10, fee: 0.001, timestamp: ts };
const TYPE = "transfer";
const sig = Wallet.signTransaction(txBody, A.privateKey);
const tx = { ...txBody, type: TYPE, publicKey: A.publicKey, signature: sig };

/* --- Blok 1 ZAWIERA te transakcje: jest juz w lancuchu --- */
const blok1 = makeBlock({
    height: 1,
    timestamp: ts + 1000,
    previousHash: genesis.hash,
    transactions: [
        { from: null, to: A.address, amount: 50, fee: 0, type: "coinbase", timestamp: ts + 1000 },
        tx,
        { from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: 0.001, fee: 0, type: "fee", timestamp: ts + 1000 }
    ],
    difficulty: CONFIG.DIFFICULTY
});

PRELOAD = [genesis, blok1];
const chain = new Blockchain();
const storage = new FakeStorage();
const mempool = new Mempool(chain, storage);

L("");
L("stan poczatkowy (transakcja JUZ w bloku #1):");
L("  saldo A: " + chain.getBalance(A.address));
L("  saldo B: " + chain.getBalance(B.address));
L("");

/* --- PROBA POWTORZENIA: ten sam obiekt, ten sam podpis --- */
const wynik = mempool.addTransaction(tx);

L("PROBA PONOWNEGO WYSLANIA tej samej podpisanej transakcji:");
L("  przyjeta : " + wynik.accepted);
L("  powod    : " + (wynik.reason || "-"));
L("");

if (wynik.accepted) {
    L("!! PRZYJETA - transakcja z lancucha wraca do mempoola.");
    L("   Sprawdzany jest tylko this.pending, nie historia lancucha.");
    L("   REPLAY POTWIERDZONY.");
    L("");
    L("   Powtorzenie N razy przy saldzie " + chain.getBalance(A.address) +
      " => do " + Math.floor(chain.getBalance(A.address) / (tx.amount + tx.fee)) +
      " dodatkowych wyplat z jednego podpisu.");
} else {
    L("ODRZUCONA - powod wyzej.");
    L("   Jesli powod dotyczy salda, a nie duplikatu, luka moze");
    L("   istniec mimo to - zatrzymalo ja co innego.");
}
L("=".repeat(62));


/* ============================================================
   DRUGA POLOWA: czy blok zawierajacy DUPLIKAT zostanie przyjety
   przez receiveBlock()? Samo wejscie do mempoola to za malo -
   dopiero wykopanie odejmuje saldo po raz drugi.
   ============================================================ */
L("");
L("=".repeat(62));
L(" BLOK Z DUPLIKATEM przez receiveBlock()");
L("=".repeat(62));

const saldoAprzed = chain.getBalance(A.address);
const saldoBprzed = chain.getBalance(B.address);

/* Trudnosc bierzemy z tego, czego oczekuje sam walidator - inaczej
   blok odpada na trudnosci i o duplikacie nadal nic nie wiemy. */
let TRUDNOSC = CONFIG.DIFFICULTY;
{
    const probny = makeBlock({
        height: 2, timestamp: ts + 1000 + 480000, previousHash: blok1.hash,
        transactions: [], difficulty: CONFIG.DIFFICULTY
    });
    const r = chain.receiveBlock(probny);
    const m = /oczekiwano (\d+(?:\.\d+)?) dla czasu/.exec(r.reason || "");
    if (m) TRUDNOSC = Number(m[1]);
    L("  trudnosc wymagana przez walidator: " + TRUDNOSC);
}

const blok2 = makeBlock({
    height: 2,
    timestamp: ts + 1000 + 480000,
    previousHash: blok1.hash,
    transactions: [
        { from: null, to: A.address, amount: 50, fee: 0, type: "coinbase", timestamp: ts + 1000 + 480000 },
        tx,                                 // TEN SAM podpis co w bloku #1
        // Blok musi zawierac transakcje "fee" na sume oplat, inaczej
        // odpada na strukturze i nic sie o duplikacie nie dowiemy.
        { from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: 0.001, fee: 0, type: "fee", timestamp: ts + 1000 + 480000 }
    ],
    difficulty: TRUDNOSC
});

const w2 = chain.receiveBlock(blok2);
L("  przyjety : " + w2.accepted);
L("  powod    : " + (w2.reason || "-"));
L("");

if (w2.accepted) {
    const dA = chain.getBalance(A.address) - saldoAprzed;
    const dB = chain.getBalance(B.address) - saldoBprzed;
    L("  saldo A: " + saldoAprzed + " -> " + chain.getBalance(A.address) + "  (" + dA.toFixed(3) + ")");
    L("  saldo B: " + saldoBprzed + " -> " + chain.getBalance(B.address) + "  (+" + dB + ")");
    L("");
    if (dB > 0) {
        L("!! PELNY REPLAY POTWIERDZONY");
        L("   Jeden podpis => druga wyplata. Srodki przeniesione dwa razy.");
    }
} else {
    L("  Blok odrzucony - replay zatrzymany na poziomie bloku.");
    L("  Mempool go przyjmuje, ale do lancucha nie wejdzie.");
    L("  Skutek: zanieczyszczony mempool, ale BEZ podwojnego wydatku.");
}
L("=".repeat(62));


/* ============================================================
   REGRESJA - czy NORMALNY ruch nadal dziala?
   Bez tego naprawa moglaby po prostu zablokowac lancuch.
   ============================================================ */
L("");
L("=".repeat(62));
L(" REGRESJA - normalny ruch po naprawie");
L("=".repeat(62));

// NOWA transakcja: inny timestamp => inny podpis
const ts2 = ts + 999;
const body2 = { from: A.address, to: B.address, amount: 5, fee: 0.001, timestamp: ts2 };
const sig2 = Wallet.signTransaction(body2, A.privateKey);
const tx2 = { ...body2, type: "transfer", publicKey: A.publicKey, signature: sig2 };

const r1 = mempool.addTransaction(tx2);
L("1) nowa transakcja do mempoola");
L("   przyjeta : " + r1.accepted + "   " + (r1.reason || ""));

const blok2b = makeBlock({
    height: 2,
    timestamp: ts + 1000 + 480000,
    previousHash: blok1.hash,
    transactions: [
        { from: null, to: A.address, amount: 50, fee: 0, type: "coinbase", timestamp: ts + 1000 + 480000 },
        tx2,
        { from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: 0.001, fee: 0, type: "fee", timestamp: ts + 1000 + 480000 }
    ],
    difficulty: TRUDNOSC
});
const r2 = chain.receiveBlock(blok2b);
L("2) blok z nowa transakcja");
L("   przyjety : " + r2.accepted + "   " + (r2.reason || ""));

// replaceChain uczciwym, dluzszym lancuchem
PRELOAD = [genesis, blok1];
const chainR = new Blockchain();
const uczciwy = [genesis, blok1, blok2b];
const r3 = chainR.replaceChain(uczciwy);
L("3) replaceChain uczciwym lancuchem");
L("   przyjety : " + r3.accepted + "   " + (r3.reason || ""));
L("");

if (r1.accepted && r2.accepted && r3.accepted) {
    L(">> NAPRAWA BEZPIECZNA");
    L("   replay zablokowany, normalny ruch nietkniety");
} else {
    L("!! NAPRAWA ZA OSTRA - blokuje uczciwy ruch. NIE WDRAZAC.");
}
L("=".repeat(62));
