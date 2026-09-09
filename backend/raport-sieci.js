#!/usr/bin/env node
/*
 * ============================================================
 *  BitBudCoin - DANE SIECIOWE DO WNIOSKU LISTINGOWEGO
 * ============================================================
 *
 * Odpowiada na punkt "Dane sieciowe" z listy wymagan giełdy:
 * liczba gornikow, rozklad mocy, transakcje w czasie, aktywne adresy,
 * czas dzialania mainnetu, wysokosc bloku.
 *
 * ZASADA: kazda liczba pochodzi z zapytania do bazy i jest podana
 * razem z definicja, wedlug ktorej powstala. Gielda policzy to
 * samodzielnie - jesli nasze liczby nie wytrzymaja jej weryfikacji,
 * stracimy wiarygodnosc na pierwszym sprawdzeniu.
 *
 * Dlatego rozdzielamy pojecia, ktore latwo pomylic:
 *   - adresy, ktore KIEDYKOLWIEK cos wykopaly  (liczba historyczna)
 *   - gornicy AKTYWNI w danym okresie          (liczba biezaca)
 * To NIE jest to samo i podanie pierwszej jako drugiej jest
 * najczestszym sposobem, w jaki maly projekt traci zaufanie.
 *
 * TYLKO ODCZYT. Baza otwierana w trybie readOnly.
 *
 * Uzycie:
 *     node raport-sieci.js
 *     node raport-sieci.js --json
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const BACKEND = __dirname;
const JSON_OUT = process.argv.includes("--json");

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

const db = new DatabaseSync(BAZA, { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);

const DZIEN = 86400000;
const teraz = Date.now();

/* ---------- LANCUCH ---------- */
const chain = q1(
    "SELECT COUNT(*) AS blokow, MIN(height) AS min_h, MAX(height) AS max_h, " +
    "MIN(timestamp) AS pierwszy, MAX(timestamp) AS ostatni FROM blocks"
);
const oczekiwane = chain.max_h - chain.min_h + 1;
const brakujace = oczekiwane - chain.blokow;
const wiekDni = (chain.ostatni - chain.pierwszy) / DZIEN;

/* ---------- GORNICY ---------- */
/* Coinbase trafia na adres tego, kto wykopal blok. Adres puli oznacza
   blok wykopany przez pule - stoi za nim wielu gornikow, wiec liczymy
   go osobno, zeby nie zawyzac ani nie zanizac wyniku. */
const POOL = "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7";

const gornicyKiedykolwiek = q1(
    "SELECT COUNT(DISTINCT to_address) AS n FROM transactions WHERE type='coinbase'"
).n;

const gornicySoloKiedykolwiek = q1(
    "SELECT COUNT(DISTINCT to_address) AS n FROM transactions WHERE type='coinbase' AND to_address != ?", POOL
).n;

function gornicyOkres(dni) {
    const od = teraz - dni * DZIEN;
    return q1(
        "SELECT COUNT(DISTINCT t.to_address) AS n FROM transactions t " +
        "JOIN blocks b ON b.height = t.blockHeight " +
        "WHERE t.type='coinbase' AND b.timestamp >= ?", od
    ).n;
}

const topGornicy = q(
    "SELECT t.to_address AS adres, COUNT(*) AS bloki FROM transactions t " +
    "JOIN blocks b ON b.height = t.blockHeight " +
    "WHERE t.type='coinbase' AND b.timestamp >= ? " +
    "GROUP BY t.to_address ORDER BY bloki DESC LIMIT 10", teraz - 30 * DZIEN
);
const blokiOstatnie30 = topGornicy.reduce((s, g) => s + g.bloki, 0);

/* ---------- TRANSAKCJE ---------- */
const typy = q("SELECT type, COUNT(*) AS n FROM transactions GROUP BY type ORDER BY n DESC");
const transferyLacznie = q1("SELECT COUNT(*) AS n FROM transactions WHERE type='transfer'").n;

function transferyOkres(dni) {
    const od = teraz - dni * DZIEN;
    return q1(
        "SELECT COUNT(*) AS n FROM transactions t JOIN blocks b ON b.height = t.blockHeight " +
        "WHERE t.type='transfer' AND b.timestamp >= ?", od
    ).n;
}

/* ---------- ADRESY ---------- */
const adresyKiedykolwiek = q1(
    "SELECT COUNT(*) AS n FROM (SELECT to_address AS a FROM transactions " +
    "UNION SELECT from_address FROM transactions WHERE from_address IS NOT NULL)"
).n;

function adresyAktywne(dni) {
    const od = teraz - dni * DZIEN;
    return q1(
        "SELECT COUNT(*) AS n FROM (" +
        "SELECT t.to_address AS a FROM transactions t JOIN blocks b ON b.height=t.blockHeight " +
        "WHERE t.type='transfer' AND b.timestamp >= ? " +
        "UNION SELECT t.from_address FROM transactions t JOIN blocks b ON b.height=t.blockHeight " +
        "WHERE t.type='transfer' AND t.from_address IS NOT NULL AND b.timestamp >= ?)", od, od
    ).n;
}

/* ---------- CZASY BLOKOW ---------- */
const ostatnie1000 = q(
    "SELECT timestamp FROM blocks ORDER BY height DESC LIMIT 1000"
).map((r) => r.timestamp).reverse();
let sredniCzas = null;
if (ostatnie1000.length > 1) {
    const roznice = [];
    for (let i = 1; i < ostatnie1000.length; i++) {
        const d = ostatnie1000[i] - ostatnie1000[i - 1];
        if (d > 0 && d < 6 * 3600000) roznice.push(d);
    }
    if (roznice.length) sredniCzas = roznice.reduce((a, b) => a + b, 0) / roznice.length / 1000;
}

/* BLAD, ktory to naprawia: db.close() stalo TUTAJ, a ponizej obiekt
   "dane" wola jeszcze gornicyOkres(), transferyOkres() i adresyAktywne().
   Baza byla juz zamknieta => "Error: database is not open".
   Zamykamy dopiero, gdy wszystkie zapytania sa policzone. */

const dane = {
    wygenerowano: new Date().toISOString(),
    baza: BAZA,
    lancuch: {
        wysokoscNajwyzsza: chain.max_h,
        blokowWBazie: chain.blokow,
        blokowBrakujacych: brakujace,
        pierwszyBlok: new Date(chain.pierwszy).toISOString(),
        ostatniBlok: new Date(chain.ostatni).toISOString(),
        mainnetDni: Math.round(wiekDni),
        sredniCzasBlokuS: sredniCzas ? Math.round(sredniCzas) : null
    },
    gornicy: {
        adresyKtoreKiedykolwiekWykopalyBlok: gornicyKiedykolwiek,
        wTymSolo: gornicySoloKiedykolwiek,
        aktywni7dni: gornicyOkres(7),
        aktywni30dni: gornicyOkres(30),
        top10Ostatnie30dni: topGornicy.map((g) => ({
            adres: g.adres,
            bloki: g.bloki,
            udzialProc: blokiOstatnie30 ? +(g.bloki / blokiOstatnie30 * 100).toFixed(1) : 0,
            pula: g.adres === POOL
        }))
    },
    transakcje: {
        wgTypu: Object.fromEntries(typy.map((t) => [t.type, t.n])),
        transferyLacznie,
        transfery7dni: transferyOkres(7),
        transfery30dni: transferyOkres(30)
    },
    adresy: {
        kiedykolwiekWystapily: adresyKiedykolwiek,
        aktywne7dni: adresyAktywne(7),
        aktywne30dni: adresyAktywne(30)
    }
};

db.close();

if (JSON_OUT) {
    console.log(JSON.stringify(dane, null, 2));
    process.exit(0);
}

const L = console.log;
const K = "=".repeat(70);
const n = (x) => (x === null || x === undefined) ? "?" : x.toLocaleString("pl");

L(K);
L(" BITBUDCOIN - DANE SIECIOWE");
L(" " + dane.wygenerowano);
L(" baza: " + BAZA);
L(K);

L("");
L("LANCUCH");
L("-".repeat(70));
L("  wysokosc najwyzszego bloku : " + n(dane.lancuch.wysokoscNajwyzsza));
L("  blokow w bazie             : " + n(dane.lancuch.blokowWBazie));
L("  blokow brakujacych         : " + n(dane.lancuch.blokowBrakujacych) +
  (brakujace > 0 ? "   (patrz sekcja 15 dokumentu integracyjnego)" : ""));
L("  mainnet dziala od          : " + dane.lancuch.pierwszyBlok.slice(0, 10) +
  "   (" + n(dane.lancuch.mainnetDni) + " dni)");
L("  sredni czas bloku          : " + n(dane.lancuch.sredniCzasBlokuS) + " s" +
  "   (cel: 480 s, z ostatnich 1000 blokow)");

L("");
L("GORNICY");
L("-".repeat(70));
L("  UWAGA: to sa DWIE ROZNE liczby i nie wolno ich mylic.");
L("");
L("  adresy, ktore kiedykolwiek wykopaly blok : " + n(dane.gornicy.adresyKtoreKiedykolwiekWykopalyBlok));
L("     w tym solo (poza pula)                : " + n(dane.gornicy.wTymSolo));
L("  gornicy aktywni w ostatnich 7 dniach     : " + n(dane.gornicy.aktywni7dni));
L("  gornicy aktywni w ostatnich 30 dniach    : " + n(dane.gornicy.aktywni30dni));
L("");
L("  Do wniosku listingowego podawaj liczbe AKTYWNYCH. Liczba");
L("  historyczna jest zawsze wyzsza i gielda to sprawdzi.");
L("");
L("  Rozklad mocy - ostatnie 30 dni:");
for (const g of dane.gornicy.top10Ostatnie30dni) {
    L("    " + String(g.udzialProc).padStart(5) + "%  " +
      String(g.bloki).padStart(6) + " blokow  " +
      g.adres.slice(0, 16) + "..." + (g.pula ? "  [PULA]" : ""));
}
if (dane.gornicy.top10Ostatnie30dni.length &&
    dane.gornicy.top10Ostatnie30dni[0].udzialProc > 50) {
    L("");
    L("  !! Jeden podmiot ma ponad 50% wykopanych blokow.");
    L("     Gielda to policzy. Lepiej opisac to samemu.");
}

L("");
L("TRANSAKCJE");
L("-".repeat(70));
for (const [typ, ile] of Object.entries(dane.transakcje.wgTypu)) {
    L("  " + typ.padEnd(16) + n(ile));
}
L("");
L("  przelewy lacznie           : " + n(dane.transakcje.transferyLacznie));
L("  przelewy ostatnie 7 dni    : " + n(dane.transakcje.transfery7dni));
L("  przelewy ostatnie 30 dni   : " + n(dane.transakcje.transfery30dni));

L("");
L("ADRESY");
L("-".repeat(70));
L("  wystapily kiedykolwiek     : " + n(dane.adresy.kiedykolwiekWystapily));
L("  aktywne (przelewy, 7 dni)  : " + n(dane.adresy.aktywne7dni));
L("  aktywne (przelewy, 30 dni) : " + n(dane.adresy.aktywne30dni));

L("");
L(K);
L(" Kazda liczba pochodzi z zapytania do bazy. Definicje podane wyzej,");
L(" zeby gielda mogla policzyc to samo i dostac ten sam wynik.");
L(K);
