// bridge-tags.js - "dziennik" adnotacji do eventów na moście BTC/BCH<->BbC
// (widoczne publicznie przez GET /bridge/annotations), dopisywanych tylko
// przez admina (ADMIN_SECRET) przez POST /bridge/annotations.
// Ten plik w ogóle nie istniał w repo - server.js robi
// "require('./bridge-tags')" na starcie, więc bez niego serwer w ogóle
// się nie podnosi (nie tylko /admin jest niezabezpieczony - cały proces
// pada na starcie z "Cannot find module").
//
// Wzorzec pliku (load/save do JSON w tym katalogu) skopiowany 1:1 ze
// swap-offers.js, dla spójności z resztą backendu.
//
// ADMIN_SECRET NIE jest wpisany w kod - czytany WYŁĄCZNIE z
// process.env.ADMIN_SECRET. Brak/za krótki env = serwer NIE WSTAJE (rzuca
// przy starcie), zamiast cicho działać z pustym albo zgadywalnym sekretem.
// Celowe po tym co znaleźliśmy w claim-htlc.js - żaden sekret nie ląduje
// w commitowanym pliku.
//
// UWAGA ARCHITEKTONICZNA: to wciąż "wspólny sekret administratora" -
// dokładnie ten model, który swap-offers.js świadomie porzucił (patrz tam
// komentarz "AUTORYZACJA od 01.08.2026") na rzecz podpisu Ed25519
// przypisanego do konkretnego adresu. Zrobiłem tu minimalną, bezpieczną
// wersję OBECNEGO interfejsu (server.js już go oczekuje dokładnie takim,
// jaki jest: bridgeTags.ADMIN_SECRET) - nie przepisywałem server.js na
// wzorzec adresowy, bo to osobna, większa zmiana. Jeśli chcesz migrację na
// Ed25519 tak jak w swap-offers - to następny, osobny krok.
//
// Pole "signature" jest PRZYJMOWANE i ZAPISYWANE, ale NIE jest
// kryptograficznie weryfikowane - server.js nie przekazuje tu żadnego
// docelowego adresu do porównania, więc nie ma przeciw czemu tego sprawdzić.
// Jeśli ma być faktycznie wymuszone - powiedz jaki adres/klucz.

const fs = require("fs");
const path = require("path");
const FILE_PATH = path.join(__dirname, "bridge-tags.json");

const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!ADMIN_SECRET || typeof ADMIN_SECRET !== "string" || ADMIN_SECRET.length < 16) {
    throw new Error(
        "bridge-tags.js: brak (lub za krotki, min. 16 znakow) ADMIN_SECRET " +
        "w zmiennych srodowiskowych.\n" +
        "Wygeneruj i ustaw PRZED startem serwera:\n" +
        "  export ADMIN_SECRET=\"$(openssl rand -hex 32)\"\n" +
        "  pm2 restart bitbudcoin --update-env\n" +
        "i dopisz go w ecosystem.config.js -> env jako " +
        "'ADMIN_SECRET: process.env.ADMIN_SECRET' (NIE jako literal string - " +
        "ten plik jest w publicznym repo)."
    );
}

function load() {
    try { return JSON.parse(fs.readFileSync(FILE_PATH, "utf8")); }
    catch (err) { return []; }
}
function save(tags) {
    fs.writeFileSync(FILE_PATH, JSON.stringify(tags, null, 2));
}

function getAll() {
    return load();
}

// info = { signature, blockHash, to, amount, chain, note }
function addTag({ signature, blockHash, to, amount, chain, note }) {
    if (typeof blockHash !== "string" || blockHash.length === 0) {
        throw new Error('addTag: brak lub puste pole "blockHash"');
    }
    if (typeof to !== "string" || to.length === 0) {
        throw new Error('addTag: brak lub puste pole "to"');
    }
    if (amount !== undefined && amount !== null && typeof amount !== "number") {
        throw new Error('addTag: "amount" musi byc liczba, jesli podane');
    }
    if (chain !== undefined && chain !== null && typeof chain !== "string") {
        throw new Error('addTag: "chain" musi byc stringiem, jesli podane');
    }
    if (note !== undefined && note !== null) {
        if (typeof note !== "string") throw new Error('addTag: "note" musi byc stringiem, jesli podane');
        if (note.length > 2000) throw new Error('addTag: "note" za dlugie (max 2000 znakow)');
    }
    if (signature !== undefined && signature !== null && typeof signature !== "string") {
        throw new Error('addTag: "signature" musi byc stringiem, jesli podane');
    }

    const tags = load();
    const tag = {
        id: tags.length > 0 ? Math.max(...tags.map((t) => t.id)) + 1 : 1,
        signature: signature || null,
        blockHash,
        to,
        amount: amount ?? null,
        chain: chain || null,
        note: note || null,
        createdAt: Date.now()
    };
    tags.push(tag);
    save(tags);
    return tag;
}

module.exports = { ADMIN_SECRET, getAll, addTag };
