/*
 * ============================================================
 *  TEST BEZPIECZENSTWA - wyczerpanie pamieci przez P2P
 * ============================================================
 *
 * PYTANIE: ile polaczen przychodzacych przyjmie wezel i ile pamieci
 * moze przez nie zjesc?
 *
 * DLACZEGO TO PYTANIE MA SENS:
 *   MAX_PEERS = 64 sprawdzane jest WYLACZNIE w connectToPeer(), czyli
 *   dla polaczen WYCHODZACYCH. Callback net.createServer() wola
 *   _handleConnection() bezwarunkowo.
 *
 *   Jedyna kontrola w _handleConnection to:
 *       if (this.sockets.has(remoteAddr)) { socket.destroy(); }
 *   gdzie remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`.
 *
 *   Port jest EFEMERYCZNY - kazde nowe polaczenie z tego samego IP ma
 *   inny numer, wiec ten warunek nigdy nie trafia.
 *
 *   Kazde polaczenie buforuje do MAX_BUFFER_BYTES = 64 MB.
 *   Maszyna produkcyjna ma 950 MB RAM.
 *
 * BEZPIECZENSTWO TESTU:
 *   - port 61001, nie 6001 - nie dotyka zywej sieci
 *   - zaden peer nie jest konfigurowany (peers: [])
 *   - storage w pamieci, zero zapisow
 *   - polaczenia z localhost do localhost
 *
 * NIE uruchamiac na produkcji.
 */

const path = require("path");
const Module = require("module");
const net = require("net");

const BACKEND = __dirname;
const PORT = 61001;
const ILE_POLACZEN = 40;

let PRELOAD = [];
class FakeStorage {
    constructor() { this.blocks = PRELOAD.slice(); }
    hasBlocks() { return PRELOAD.length > 0; }
    loadChain() { return PRELOAD.slice(); }
    loadMempool() { return []; }
    saveBlock() {} replaceAllBlocks() {} saveCredit() {}
    saveMempoolTx() {} deleteMempoolTx() {}
    getCreditsForAddress() { return []; }
    close() {}
}
const origResolve = Module._resolveFilename;
const STORAGE_ID = path.join(BACKEND, "storage.js");
Module._resolveFilename = function (r, ...a) {
    if (r === "./storage" || r === "./storage.js") return STORAGE_ID;
    return origResolve.call(this, r, ...a);
};
require.cache[STORAGE_ID] = { id: STORAGE_ID, filename: STORAGE_ID, loaded: true, exports: FakeStorage };

const CONFIG = require(path.join(BACKEND, "config.js"));
CONFIG.DIFFICULTY = 1;

const Blockchain = require(path.join(BACKEND, "bbcblockchain.js"));
const { computeBlockHash, difficultyToTargetHex } = Blockchain;
const P2PNode = require(path.join(BACKEND, "p2p.js"));

function mk(o) {
    const b = { ...o, nonce: 0 };
    const t = difficultyToTargetHex(o.difficulty);
    b.hash = computeBlockHash(b);
    while (b.hash > t) { b.nonce++; b.hash = computeBlockHash(b); }
    return b;
}

const L = (s) => console.log(s);

L("=".repeat(66));
L(" P2P - LIMIT POLACZEN PRZYCHODZACYCH");
L("=".repeat(66));

const genesis = mk({
    height: 0, timestamp: 1700000000000, previousHash: "0".repeat(64),
    transactions: [], difficulty: CONFIG.DIFFICULTY
});
PRELOAD = [genesis];

const chain = new Blockchain();
const wezel = new P2PNode(chain, { port: PORT, peers: [] });
wezel.start ? wezel.start() : null;

const gniazda = [];
let polaczone = 0, odrzucone = 0;

function polacz(i) {
    return new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port: PORT }, () => {
            polaczone++;
            gniazda.push(s);
            resolve();
        });
        s.on("error", () => { odrzucone++; resolve(); });
        setTimeout(() => resolve(), 1500);
    });
}

(async () => {

    await new Promise((r) => setTimeout(r, 800));

    const pamiecPrzed = process.memoryUsage().rss;

    for (let i = 0; i < ILE_POLACZEN; i++) {
        await polacz(i);
    }

    await new Promise((r) => setTimeout(r, 1200));

    const wSockets = wezel.sockets ? wezel.sockets.size : "?";
    const pamiecPo = process.memoryUsage().rss;

    L("");
    L("  probowano otworzyc      : " + ILE_POLACZEN);
    L("  udalo sie polaczyc      : " + polaczone);
    L("  odrzucone przez wezel   : " + odrzucone);
    L("  w mapie wezla (sockets) : " + wSockets);
    L("  MAX_PEERS w kodzie      : 64");
    L("");

    if (typeof wSockets === "number" && wSockets >= ILE_POLACZEN) {
        L("!! BRAK LIMITU POLACZEN PRZYCHODZACYCH");
        L("");
        L("   Wezel przyjal wszystkie " + wSockets + " polaczen z JEDNEGO adresu.");
        L("   Kazde buforuje do 64 MB (MAX_BUFFER_BYTES).");
        L("   Maszyna produkcyjna ma 950 MB RAM.");
        L("");
        L("   " + Math.ceil(950 / 64) + " polaczen wystarczy do wyczerpania pamieci.");
    } else {
        L("Limit dziala - przyjeto " + wSockets + " z " + ILE_POLACZEN + ".");
    }

    L("=".repeat(66));

    for (const s of gniazda) { try { s.destroy(); } catch (e) {} }
    try { wezel.close && wezel.close(); } catch (e) {}
    process.exit(0);
})();
