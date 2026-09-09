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

/*
 * OKNA LICZYMY PO WYSOKOSCI BLOKU, NIE PO ZNACZNIKACH CZASU.
 *
 * Powod znaleziony w zywej bazie: 4 sierpnia 2026 powstalo 18 496 blokow
 * w jedna dobe - blok co 4.7 sekundy przy celu 480 s. Podobnie 23 i 9
 * sierpnia. To okres sprzed aktywacji ASERT (blok 100 000), gdy stary DAA
 * z retargetem co 2028 blokow nie nadazal za moca.
 *
 * Skutek dla raportu: okno "ostatnie 30 dni" liczone po czasie siegalo
 * w sierpien i lapalo 39 365 blokow zamiast okolo 5 400. Udzialy gornikow
 * wychodzily z tego okresu, nie z biezacego - a gielda policzylaby wlasne
 * liczby i dostala co innego.
 *
 * Po wysokosci: przy dzisiejszym tempie okolo 180 blokow dziennie
 * (zmierzone: 176-212 przez ostatnie 14 dni) 30 dni to 5400 blokow,
 * 7 dni to 1260.
 */
const BLOKOW_NA_DZIEN = 180;
const OKNO_7 = 7 * BLOKOW_NA_DZIEN;
const OKNO_30 = 30 * BLOKOW_NA_DZIEN;
const H_MAX = q1("SELECT MAX(height) AS h FROM blocks").h;

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

function gornicyOkres(blokow) {
    return q1(
        "SELECT COUNT(DISTINCT to_address) AS n FROM transactions " +
        "WHERE type='coinbase' AND blockHeight >= ?", H_MAX - blokow
    ).n;
}

const topGornicy = q(
    "SELECT to_address AS adres, COUNT(*) AS bloki FROM transactions " +
    "WHERE type='coinbase' AND blockHeight >= ? " +
    "GROUP BY to_address ORDER BY bloki DESC LIMIT 10", H_MAX - OKNO_30
);
const blokiOstatnie30 = topGornicy.reduce((s, g) => s + g.bloki, 0);

/* ---------- TRANSAKCJE ---------- */
const typy = q("SELECT type, COUNT(*) AS n FROM transactions GROUP BY type ORDER BY n DESC");
const transferyLacznie = q1("SELECT COUNT(*) AS n FROM transactions WHERE type='transfer'").n;

function transferyOkres(blokow) {
    return q1(
        "SELECT COUNT(*) AS n FROM transactions " +
        "WHERE type='transfer' AND blockHeight >= ?", H_MAX - blokow
    ).n;
}

/* ---------- ADRESY ---------- */
const adresyKiedykolwiek = q1(
    "SELECT COUNT(*) AS n FROM (SELECT to_address AS a FROM transactions " +
    "UNION SELECT from_address FROM transactions WHERE from_address IS NOT NULL)"
).n;

function adresyAktywne(blokow) {
    const od = H_MAX - blokow;
    return q1(
        "SELECT COUNT(*) AS n FROM (" +
        "SELECT to_address AS a FROM transactions WHERE type='transfer' AND blockHeight >= ? " +
        "UNION SELECT from_address FROM transactions " +
        "WHERE type='transfer' AND from_address IS NOT NULL AND blockHeight >= ?)", od, od
    ).n;
}

/* ---------- TEMPO EMISJI ----------
   Agent CMC pyta wprost o emisje i halvingi. Deklaracja "halving co
   210 000 blokow = ok. 3.19 roku" zaklada blok co 480 s. Realne tempo
   bylo inne, wiec podajemy oba. */
const dniPoDacie = q(
    "SELECT date(timestamp/1000,'unixepoch') AS d, COUNT(*) AS n " +
    "FROM blocks GROUP BY d ORDER BY n DESC LIMIT 5"
);
const ostatnie14 = q(
    "SELECT date(timestamp/1000,'unixepoch') AS d, COUNT(*) AS n " +
    "FROM blocks WHERE height >= ? GROUP BY d ORDER BY d DESC LIMIT 14",
    H_MAX - 14 * BLOKOW_NA_DZIEN * 2
);
const sredniaOstatnie14 = ostatnie14.length
    ? Math.round(ostatnie14.slice(1).reduce((a, r) => a + r.n, 0) / Math.max(1, ostatnie14.length - 1))
    : null;

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
        aktywni7dni: gornicyOkres(OKNO_7),
        aktywni30dni: gornicyOkres(OKNO_30),
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
        transfery7dni: transferyOkres(OKNO_7),
        transfery30dni: transferyOkres(OKNO_30)
    },
    emisja: {
        blokowNaDzienTeraz: sredniaOstatnie14,
        blokowNaDzienCel: Math.round(86400 / 480),
        najintensywniejszeDni: dniPoDacie.map((r) => ({ dzien: r.d, blokow: r.n })),
        halvingCoBlokow: 210000,
        halvingPrzyObecnymTempieDni: sredniaOstatnie14
            ? Math.round(210000 / sredniaOstatnie14) : null,
        halvingPrzyCeluDni: Math.round(210000 / (86400 / 480))
    },
    adresy: {
        kiedykolwiekWystapily: adresyKiedykolwiek,
        aktywne7dni: adresyAktywne(OKNO_7),
        aktywne30dni: adresyAktywne(OKNO_30)
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
L("TEMPO EMISJI");
L("-".repeat(70));
L("  blokow dziennie teraz      : " + n(dane.emisja.blokowNaDzienTeraz) +
  "   (cel: " + n(dane.emisja.blokowNaDzienCel) + ")");
L("  halving co                 : " + n(dane.emisja.halvingCoBlokow) + " blokow");
L("     przy obecnym tempie     : ~" + n(dane.emisja.halvingPrzyObecnymTempieDni) + " dni");
L("     przy celu 480 s         : ~" + n(dane.emisja.halvingPrzyCeluDni) + " dni");
L("");
L("  Najintensywniejsze doby w historii lancucha:");
for (const d of dane.emisja.najintensywniejszeDni) {
    const naBlok = Math.round(86400 / d.blokow);
    L("    " + d.dzien + "   " + String(d.blokow).padStart(6) + " blokow" +
      "   (blok co ~" + naBlok + " s)");
}
L("");
L("  Te doby to okres sprzed aktywacji ASERT (blok 100 000).");
L("  Dlatego okna 7/30 dni w tym raporcie liczone sa PO WYSOKOSCI");
L("  bloku, nie po znacznikach czasu - inaczej lapalyby sierpien.");

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
