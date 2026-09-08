#!/usr/bin/env node
/*
 * ============================================================
 *  SPRAWDZENIE PODPISOW W CALEJ HISTORII LANCUCHA
 * ============================================================
 *
 * PO CO: do bbcblockchain.js dochodzi weryfikacja podpisu przy
 * przyjmowaniu blokow od peerow. Zanim to wdrozysz, trzeba wiedziec,
 * czy KAZDY dotychczasowy przelew ten sprawdzian przechodzi. Jesli
 * choc jeden nie przechodzi, wezel odrzucilby wlasna historie przy
 * resynchronizacji i siec by stanela.
 *
 * BLAD POPRZEDNIEJ WERSJI: czytala wynik z polecenia sqlite3 i dzielila
 * go po znakach nowej linii. publicKey jest zapisany jako PEM, ktory MA
 * znaki nowej linii w srodku:
 *     -----BEGIN PUBLIC KEY-----
 *     MCowBQYDK2VwAyEA...
 *     -----END PUBLIC KEY-----
 * Kazdy wiersz rozpadal sie wiec na kilka kawalkow. Stad 104 163
 * "przelewow" zamiast 28 229 i 100% odrzutow. Teraz czytamy baze
 * bezposrednio przez node:sqlite - ten sam modul, ktorego uzywa wezel -
 * wiec zaden tekst nie jest parsowany.
 *
 * TYLKO ODCZYT: polaczenie w trybie readOnly, zero zapisow, zero sieci.
 * Mozna uruchomic na produkcji.
 *
 * Kod wyjscia: 0 = mozna wdrazac, 1 = NIE wdrazac.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const BACKEND = __dirname;
const { verifyTransactionSignature } = require(path.join(BACKEND, "wallet.js"));

/* Baza wybierana po ZAWARTOSCI, nie po nazwie - w katalogu leza smieciowe
   pliki .db i wybor pierwszego z brzegu juz raz dal falszywy wynik. */
function wybierzBaze() {
    if (process.env.BBC_DB && fs.existsSync(process.env.BBC_DB)) return process.env.BBC_DB;
    let najlepsza = null, najwiecej = -1;
    for (const f of fs.readdirSync(BACKEND).filter((x) => x.endsWith(".db"))) {
        const plik = path.join(BACKEND, f);
        try {
            const db = new DatabaseSync(plik, { readOnly: true });
            const r = db.prepare("SELECT COUNT(*) AS n FROM blocks").get();
            db.close();
            if (r && r.n > najwiecej) { najwiecej = r.n; najlepsza = plik; }
        } catch (e) {}
    }
    return najlepsza;
}

const BAZA = wybierzBaze();
if (!BAZA) { console.error("Nie znalazlem bazy z tabela blocks."); process.exit(2); }

console.log("=".repeat(66));
console.log(" SPRAWDZENIE PODPISOW W CALEJ HISTORII");
console.log(" baza: " + BAZA);
console.log("=".repeat(66));

const db = new DatabaseSync(BAZA, { readOnly: true });

const CONFIG = require(path.join(BACKEND, "config.js"));
const PROG =
    typeof CONFIG.SIGNATURE_ENFORCEMENT_HEIGHT === "number"
        ? CONFIG.SIGNATURE_ENFORCEMENT_HEIGHT
        : 0;

console.log("");
console.log("prog wymagania podpisu: blok #" + PROG);
console.log("(ponizej progu historia zostaje nietknieta)");

const wiersze = db.prepare(
    "SELECT blockHeight, from_address, to_address, amount, fee, timestamp, publicKey, signature " +
    "FROM transactions WHERE (type IS NULL OR type='transfer') AND blockHeight >= ? " +
    "ORDER BY blockHeight"
).all(PROG);

console.log("");
console.log("");
console.log("przelewow od progu w gore: " + wiersze.length.toLocaleString("pl"));
console.log("");

let ok = 0, brakDanych = 0;
const zle = [];

for (const w of wiersze) {
    // Transakcje bez publicKey/signature w ogole nie moga byc sprawdzone -
    // liczymy je osobno, zeby nie mieszac ich z podrobionymi.
    // Stary mechanizm HTLC: type "transfer", ale odbiorca HTLC_INTERNAL
    // i podpis obejmujacy inny zestaw pol. Nie sprawdzamy go tym
    // weryfikatorem - kod produkcyjny tez go pomija.
    if (w.to_address === "HTLC_INTERNAL") { continue; }

    if (!w.publicKey || !w.signature || !w.from_address) { brakDanych++; continue; }

    const tx = {
        from: w.from_address,
        to: w.to_address,
        amount: Number(w.amount),
        fee: Number(w.fee),
        timestamp: Number(w.timestamp),
        publicKey: w.publicKey,
        signature: w.signature
    };

    try {
        if (verifyTransactionSignature(tx)) ok++;
        else zle.push({ h: w.blockHeight, from: w.from_address, a: w.amount });
    } catch (e) {
        zle.push({ h: w.blockHeight, from: w.from_address, a: w.amount, blad: e.message });
    }
}

db.close();

console.log("podpis poprawny   : " + ok.toLocaleString("pl"));
console.log("podpis bledny     : " + zle.length.toLocaleString("pl"));
console.log("bez publicKey/sig : " + brakDanych.toLocaleString("pl"));
console.log("");

if (zle.length === 0 && brakDanych === 0) {
    console.log(">> CALA HISTORIA PRZECHODZI WERYFIKACJE - mozna wdrazac.");
    console.log("=".repeat(66));
    process.exit(0);
}

if (zle.length === 0 && brakDanych > 0) {
    console.log("!! " + brakDanych + " transakcji nie ma publicKey albo signature.");
    console.log("   Zadna nie ma BLEDNEGO podpisu - po prostu go nie maja.");
    console.log("   Nowa kontrola odrzucilaby je przy resynchronizacji.");
    console.log("   Pokaz ten wynik - trzeba zdecydowac, co z historia.");
    console.log("=".repeat(66));
    process.exit(1);
}

console.log("!! SA TRANSAKCJE Z BLEDNYM PODPISEM - NIE WDRAZAJ");
console.log("");
for (const z of zle.slice(0, 10)) {
    console.log("   blok #" + z.h + "  " + String(z.from).slice(0, 14) + "...  " +
        z.a + " BbC" + (z.blad ? "  [" + z.blad + "]" : ""));
}
console.log("=".repeat(66));
process.exit(1);
