/*
 * ============================================================
 *  TEST BEZPIECZENSTWA - podrobiony podpis w bloku od peera
 * ============================================================
 *
 * PYTANIE: czy wezel przyjmie blok zawierajacy przelew, ktorego
 * nadawca NIGDY nie podpisal?
 *
 * DLACZEGO TO PYTANIE MA SENS:
 * verifyTransactionSignature() jest wolane WYLACZNIE w mempool.js,
 * czyli przy wejsciu transakcji przez API tego wezla. Blok przyslany
 * przez P2P omija mempool calkowicie. Komentarz w receiveBlock() sam
 * to nazywa - i domyka na tej podstawie format adresu, ale NIE podpis.
 *
 * Sprawdzamy tez, czy jest kontrola salda: grep nie znalazl w
 * receiveBlock zadnego odwolania do getBalance.
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

/*
 * Prog na 0, bo lancuch w tescie zaczyna sie od genesis, a mainnetowy
 * prog to 3070. Bez tego sztuczny blok #1 leci ponizej progu i kontrola
 * go nie obejmuje - test pokazywalby "przyjety" i wygladal na porazke
 * naprawy, choc na zywym lancuchu (wysokosc 102 888) nowy blok NIGDY
 * nie trafi ponizej progu.
 */
const PROG_ORYGINALNY = CONFIG.SIGNATURE_ENFORCEMENT_HEIGHT;
CONFIG.SIGNATURE_ENFORCEMENT_HEIGHT = 0;

const Blockchain = require(path.join(BACKEND, "bbcblockchain.js"));
const { computeBlockHash, difficultyToTargetHex } = Blockchain;
const Wallet = require(path.join(BACKEND, "wallet.js"));

const L = (s) => console.log(s);

function makeBlock(o) {
    const b = { ...o, nonce: 0 };
    const target = difficultyToTargetHex(o.difficulty);
    b.hash = computeBlockHash(b);
    while (b.hash > target) { b.nonce++; b.hash = computeBlockHash(b); }
    return b;
}

L("=".repeat(64));
L(" PODROBIONY PODPIS W BLOKU OD PEERA");
L("=".repeat(64));

const OFIARA = Wallet.generateWallet();
const ATAKUJACY = Wallet.generateWallet();

L("ofiara     : " + OFIARA.address);
L("atakujacy  : " + ATAKUJACY.address);

/* Ofiara ma srodki z coinbase w genesis */
const genesis = makeBlock({
    height: 0,
    timestamp: 1700000000000,
    previousHash: "0".repeat(64),
    transactions: [
        { from: null, to: OFIARA.address, amount: 50, fee: 0, type: "coinbase", timestamp: 1700000000000 }
    ],
    difficulty: CONFIG.DIFFICULTY
});

PRELOAD = [genesis];
const chain = new Blockchain();

L("");
L("saldo ofiary przed    : " + chain.getBalance(OFIARA.address));
L("saldo atakujacego przed: " + chain.getBalance(ATAKUJACY.address));

/* Trudnosc, jakiej oczekuje walidator dla bloku #1 */
const ts = 1700000000000 + 480000;
let TRUDNOSC = CONFIG.DIFFICULTY;
{
    const probny = makeBlock({
        height: 1, timestamp: ts, previousHash: genesis.hash,
        transactions: [], difficulty: CONFIG.DIFFICULTY
    });
    const r = chain.receiveBlock(probny);
    const m = /oczekiwano (\d+(?:\.\d+)?)/.exec(r.reason || "");
    if (m) TRUDNOSC = Number(m[1]);
}

/*
 * PRZELEW, KTOREGO OFIARA NIGDY NIE PODPISALA.
 *
 * publicKey atakujacego, signature to smieci. Gdyby to poszlo przez
 * POST /transactions/send, mempool.js odrzucilby to natychmiast.
 * Tutaj wchodzi jako gotowy blok od peera.
 */
const kradziez = {
    from: OFIARA.address,
    to: ATAKUJACY.address,
    amount: 40,
    fee: 0.001,
    timestamp: ts,
    type: "transfer",
    publicKey: ATAKUJACY.publicKey,
    signature: "AAAApodrobionyPodpisKtoregoNiktNiePodpisalAAAA=="
};

const zlyBlok = makeBlock({
    height: 1,
    timestamp: ts,
    previousHash: genesis.hash,
    transactions: [
        { from: null, to: ATAKUJACY.address, amount: 50, fee: 0, type: "coinbase", timestamp: ts },
        kradziez,
        { from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: 0.001, fee: 0, type: "fee", timestamp: ts }
    ],
    difficulty: TRUDNOSC
});

const wynik = chain.receiveBlock(zlyBlok);

L("");
L("BLOK Z PODROBIONYM PODPISEM:");
L("  przyjety : " + wynik.accepted);
L("  powod    : " + (wynik.reason || "-"));
L("");

if (wynik.accepted) {
    L("saldo ofiary po       : " + chain.getBalance(OFIARA.address));
    L("saldo atakujacego po  : " + chain.getBalance(ATAKUJACY.address));
    L("");
    L("!! LUKA POTWIERDZONA");
    L("   Wezel przyjal przelew, ktorego nadawca nigdy nie podpisal.");
    L("   Kazdy peer moze oprozniac dowolny adres w sieci.");
} else {
    L("ODRZUCONY - powod wyzej.");
    L("   Jesli powod NIE dotyczy podpisu, luka moze istniec mimo to");
    L("   i zatrzymalo blok cos innego - trzeba to obejsc w tescie.");
}
L("=".repeat(64));


/* ============================================================
   REGRESJA - czy PRAWDZIWY, podpisany przelew nadal przechodzi?
   Bez tego naprawa moglaby odrzucic cala uczciwa historie.
   ============================================================ */
L("");
L("=".repeat(64));
L(" REGRESJA - prawdziwy podpisany przelew");
L("=".repeat(64));

PRELOAD = [genesis];
const chain2 = new Blockchain();

const body = {
    from: OFIARA.address,
    to: ATAKUJACY.address,
    amount: 10,
    fee: 0.001,
    timestamp: ts
};
const sig = Wallet.signTransaction(body, OFIARA.privateKey);
const uczciwy = { ...body, type: "transfer", publicKey: OFIARA.publicKey, signature: sig };

const dobryBlok = makeBlock({
    height: 1,
    timestamp: ts,
    previousHash: genesis.hash,
    transactions: [
        { from: null, to: OFIARA.address, amount: 50, fee: 0, type: "coinbase", timestamp: ts },
        uczciwy,
        { from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: 0.001, fee: 0, type: "fee", timestamp: ts }
    ],
    difficulty: TRUDNOSC
});

const r1 = chain2.receiveBlock(dobryBlok);
L("1) blok z PRAWDZIWYM podpisem");
L("   przyjety : " + r1.accepted + "   " + (r1.reason || ""));

/* replaceChain uczciwym lancuchem */
PRELOAD = [genesis];
const chain3 = new Blockchain();
const r2 = chain3.replaceChain([genesis, dobryBlok]);
L("2) replaceChain uczciwym lancuchem");
L("   przyjety : " + r2.accepted + "   " + (r2.reason || ""));

/* Stary format: przelew BEZ pola type (tx.type === undefined) */
const body2 = { from: OFIARA.address, to: ATAKUJACY.address, amount: 5, fee: 0.001, timestamp: ts + 1 };
const stary = { ...body2, publicKey: OFIARA.publicKey, signature: Wallet.signTransaction(body2, OFIARA.privateKey) };
const blokStary = makeBlock({
    height: 1, timestamp: ts, previousHash: genesis.hash,
    transactions: [
        { from: null, to: OFIARA.address, amount: 50, fee: 0, type: "coinbase", timestamp: ts },
        stary,
        { from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: 0.001, fee: 0, type: "fee", timestamp: ts }
    ],
    difficulty: TRUDNOSC
});
PRELOAD = [genesis];
const chain4 = new Blockchain();
const r3 = chain4.receiveBlock(blokStary);
L("3) stary format (bez pola type), podpisany poprawnie");
L("   przyjety : " + r3.accepted + "   " + (r3.reason || ""));
L("");

if (r1.accepted && r2.accepted && r3.accepted && !wynik.accepted) {
    L(">> NAPRAWA BEZPIECZNA");
    L("   podrobiony podpis odrzucony, uczciwy ruch nietkniety");
} else {
    L("!! UWAGA - sprawdz wyniki powyzej, NIE WDRAZAC na slepo");
}
L("=".repeat(64));


/* ============================================================
   PROG WYSOKOSCI - swiadomy kompromis, wiec testujemy go wprost.
   ============================================================ */
L("");
L("=".repeat(64));
L(" PROG WYSOKOSCI (mainnet: " + PROG_ORYGINALNY + ")");
L("=".repeat(64));

CONFIG.SIGNATURE_ENFORCEMENT_HEIGHT = 5;

PRELOAD = [genesis];
const chain5 = new Blockchain();
const r4 = chain5.receiveBlock(zlyBlok);
L("blok #1 z podrobionym podpisem, prog 5 (blok PONIZEJ progu)");
L("   przyjety : " + r4.accepted + "   " + (r4.reason || ""));
L("   -> ponizej progu kontrola nie obowiazuje, historia nietknieta");
L("");

CONFIG.SIGNATURE_ENFORCEMENT_HEIGHT = 0;
PRELOAD = [genesis];
const chain6 = new Blockchain();
const r5 = chain6.receiveBlock(zlyBlok);
L("ten sam blok, prog 0 (blok POWYZEJ progu)");
L("   przyjety : " + r5.accepted + "   " + (r5.reason || ""));
L("");

if (r4.accepted && !r5.accepted) {
    L(">> PROG DZIALA");
    L("   Ponizej progu historia przechodzi, powyzej podpis wymagany.");
    L("   Zywy lancuch ma wysokosc 102 888, wiec kazdy nowy blok");
    L("   jest daleko powyzej progu " + PROG_ORYGINALNY + ".");
} else {
    L("!! PROG NIE DZIALA JAK ZAKLADANO");
}
L("=".repeat(64));
