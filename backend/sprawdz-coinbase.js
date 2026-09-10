#!/usr/bin/env node
/*
 * ============================================================
 *  SPRAWDZENIE LICZBY COINBASE W CALEJ HISTORII
 * ============================================================
 *
 * PO CO: do bbcblockchain.js dochodzi wymog "dokladnie jedna transakcja
 * coinbase na blok". Zanim to wdrozysz, trzeba wiedziec, czy KAZDY blok
 * w Twoim lancuchu ten wymog spelnia.
 *
 * Jesli choc jeden go nie spelnia, wezel po wdrozeniu odrzucilby wlasna
 * historie przy resynchronizacji z peerem i siec by stanela.
 *
 * TYLKO ODCZYT. Baza w trybie readOnly.
 *
 * Kod wyjscia: 0 = mozna wdrazac, 1 = NIE wdrazac.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const BACKEND = __dirname;

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

console.log("=".repeat(68));
console.log(" LICZBA COINBASE W KAZDYM BLOKU");
console.log(" baza: " + BAZA);
console.log("=".repeat(68));

const db = new DatabaseSync(BAZA, { readOnly: true });

/* Genesis (wysokosc 0) ma transakcje typu "genesis", nie "coinbase" -
   wylaczamy go, tak samo jak robi to kod produkcyjny. */
const zle = db.prepare(
    "SELECT b.height AS h, COUNT(t.id) AS ile " +
    "FROM blocks b LEFT JOIN transactions t " +
    "  ON t.blockHeight = b.height AND t.type = 'coinbase' " +
    "WHERE b.height > 0 " +
    "GROUP BY b.height HAVING ile != 1 " +
    "ORDER BY b.height"
).all();

const wszystkie = db.prepare(
    "SELECT COUNT(*) AS n FROM blocks WHERE height > 0"
).get().n;

db.close();

console.log("");
console.log("blokow sprawdzonych  : " + wszystkie.toLocaleString("pl"));
console.log("z liczba coinbase !=1: " + zle.length.toLocaleString("pl"));
console.log("");

if (zle.length === 0) {
    console.log(">> KAZDY BLOK MA DOKLADNIE JEDNA COINBASE - mozna wdrazac.");
    console.log("=".repeat(68));
    process.exit(0);
}

console.log("!! SA BLOKI Z INNA LICZBA COINBASE - NIE WDRAZAJ");
console.log("");
console.log("   Pierwsze " + Math.min(20, zle.length) + ":");
for (const z of zle.slice(0, 20)) {
    console.log("   blok #" + z.h + "  ->  " + z.ile + " coinbase");
}
console.log("");
console.log("   Pokaz ten wynik przed dalszymi krokami.");
console.log("=".repeat(68));
process.exit(1);
