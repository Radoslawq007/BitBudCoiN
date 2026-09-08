#!/usr/bin/env node
/*
 * ============================================================
 *  SPRAWDZENIE PODPISOW W CALEJ HISTORII LANCUCHA
 * ============================================================
 *
 * PO CO TO ISTNIEJE:
 * Do bbcblockchain.js dochodzi weryfikacja podpisu przy przyjmowaniu
 * blokow od peerow. Zanim to wdrozysz, trzeba wiedziec, czy KAZDY
 * dotychczasowy przelew w Twoim lancuchu ten sprawdzian przechodzi.
 *
 * Jesli choc jeden nie przechodzi, wezel po wdrozeniu odrzucilby wlasna
 * historie przy resynchronizacji z peerem i siec by stanela. To gorsze
 * niz luka, ktora ta zmiana zamyka.
 *
 * TYLKO ODCZYT. Baza otwierana z -readonly, nic nie jest zapisywane,
 * nic nie jest wysylane. Mozna uruchomic na produkcji.
 *
 * Uzycie:
 *     node sprawdz-podpisy.js
 *
 * Kod wyjscia:
 *     0  wszystkie podpisy poprawne - mozna wdrazac
 *     1  sa transakcje, ktore nie przechodza - NIE WDRAZAC
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BACKEND = __dirname;
const { verifyTransactionSignature } = require(path.join(BACKEND, "wallet.js"));

/* Wybor bazy po ZAWARTOSCI, nie po nazwie - w katalogu moga lezec
   smieciowe pliki .db i wybor pierwszego z brzegu juz raz dal falszywy
   wynik w exchange-readiness.js. */
function wybierzBaze() {
    if (process.env.BBC_DB && fs.existsSync(process.env.BBC_DB)) {
        return process.env.BBC_DB;
    }
    let najlepsza = null, najwiecej = -1;
    for (const f of fs.readdirSync(BACKEND).filter((x) => x.endsWith(".db"))) {
        const plik = path.join(BACKEND, f);
        try {
            const n = Number(execFileSync("sqlite3",
                ["-readonly", plik, "SELECT COUNT(*) FROM blocks;"],
                { encoding: "utf8", timeout: 15000 }).trim());
            if (Number.isFinite(n) && n > najwiecej) { najwiecej = n; najlepsza = plik; }
        } catch (e) {}
    }
    return najlepsza;
}

const BAZA = wybierzBaze();
if (!BAZA) {
    console.error("Nie znalazlem bazy z tabela blocks.");
    process.exit(2);
}

console.log("=".repeat(66));
console.log(" SPRAWDZENIE PODPISOW W CALEJ HISTORII");
console.log(" baza: " + BAZA);
console.log("=".repeat(66));

/* Bierzemy tylko typy, ktore MUSZA miec podpis. coinbase/fee/
   protocol_fee/genesis tworzy protokol - one podpisu nie maja
   i miec nie moga. */
const wiersze = execFileSync("sqlite3",
    ["-readonly", "-separator", "\u0001", BAZA,
     "SELECT blockHeight, from_address, to_address, amount, fee, timestamp, publicKey, signature, type " +
     "FROM transactions WHERE type IS NULL OR type='transfer' ORDER BY blockHeight;"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 300000 }
).split("\n").filter((l) => l.trim());

console.log("");
console.log("przelewow do sprawdzenia: " + wiersze.length.toLocaleString("pl"));
console.log("");

let ok = 0;
const zle = [];

for (const linia of wiersze) {
    const [height, from, to, amount, fee, timestamp, publicKey, signature, type] =
        linia.split("\u0001");

    const tx = {
        from,
        to,
        amount: Number(amount),
        fee: Number(fee),
        timestamp: Number(timestamp),
        publicKey,
        signature
    };

    try {
        if (verifyTransactionSignature(tx)) {
            ok++;
        } else {
            zle.push({ height, from, to, amount });
        }
    } catch (e) {
        zle.push({ height, from, to, amount, blad: e.message });
    }
}

console.log("poprawnych  : " + ok.toLocaleString("pl"));
console.log("bledny podpis: " + zle.length.toLocaleString("pl"));
console.log("");

if (zle.length === 0) {
    console.log(">> CALA HISTORIA PRZECHODZI WERYFIKACJE");
    console.log("   Nowa kontrola podpisu nie odrzuci wlasnego lancucha.");
    console.log("   Mozna wdrazac.");
    console.log("=".repeat(66));
    process.exit(0);
}

console.log("!! SA TRANSAKCJE, KTORE NIE PRZECHODZA - NIE WDRAZAJ");
console.log("");
console.log("   Pierwsze " + Math.min(10, zle.length) + ":");
for (const z of zle.slice(0, 10)) {
    console.log("   blok #" + z.height +
        "  " + String(z.from).slice(0, 14) + "..." +
        "  " + z.amount + " BbC" +
        (z.blad ? "  [" + z.blad + "]" : ""));
}
console.log("");
console.log("   Wdrozenie odrzuciloby te bloki przy resynchronizacji");
console.log("   i siec by stanela. Pokaz ten wynik przed dalszymi krokami.");
console.log("=".repeat(66));
process.exit(1);
