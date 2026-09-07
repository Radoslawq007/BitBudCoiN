#!/usr/bin/env node
/*
 * =====================================================
 * BitBudCoin - EXCHANGE READINESS PASS
 * =====================================================
 *
 * Automatyczny audyt gotowosci do integracji z gielda.
 *
 * TYLKO ODCZYT. Skrypt nie zapisuje niczego: nie dotyka bazy w trybie
 * zapisu, nie wysyla transakcji, nie restartuje procesow, nie zmienia
 * konfiguracji. Mozna go bezpiecznie uruchomic na produkcji.
 *
 * ZASADA: kazda kontrola MIERZY stan, a nie powtarza czyjes wnioski.
 * Jesli czegos nie da sie zmierzyc, wynik to SKIP z podanym powodem -
 * nigdy zgadywanie w jedna albo druga strone.
 *
 * Uzycie:
 *     node exchange-readiness.js
 *     node exchange-readiness.js --json     (wynik maszynowy)
 *
 * Kody wyjscia:
 *     0  brak bledow krytycznych
 *     1  co najmniej jeden BLOCKER
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const http = require("http");

const BACKEND = __dirname;
const API = "http://127.0.0.1:5000";
const JSON_OUT = process.argv.includes("--json");

const WAGI = {
    BLOCKER: "blokuje integracje na wiekszosci gield",
    MAJOR: "powazne, ale do obejscia przy wspolpracy",
    MINOR: "kosmetyka albo wygoda integratora"
};

const wyniki = [];

function zapisz(id, waga, nazwa, stan, zmierzone, komentarz) {
    wyniki.push({ id, waga, nazwa, stan, zmierzone, komentarz });
}

/* ---------- pomocnicy ---------- */

function czytajZrodlo(plik) {
    try {
        return fs.readFileSync(path.join(BACKEND, plik), "utf8");
    } catch (e) {
        return null;
    }
}

function sqlite(zapytanie) {
    // Sciezka bazy: bierzemy pierwszy .db w katalogu backendu.
    const bazy = fs.readdirSync(BACKEND).filter((f) => f.endsWith(".db"));
    if (!bazy.length) return null;
    try {
        return execFileSync(
            "sqlite3",
            ["-readonly", path.join(BACKEND, bazy[0]), zapytanie],
            { encoding: "utf8", timeout: 30000 }
        ).trim();
    } catch (e) {
        return null;
    }
}

function pobierzInfo() {
    return new Promise((resolve) => {
        const req = http.get(API + "/info", { timeout: 5000 }, (res) => {
            let dane = "";
            res.on("data", (c) => (dane += c));
            res.on("end", () => {
                try { resolve(JSON.parse(dane)); } catch { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}


/* =====================================================
   KONTROLE
   ===================================================== */

async function uruchom() {

    const info = await pobierzInfo();
    let CONFIG = null;
    try { CONFIG = require(path.join(BACKEND, "config.js")); } catch {}

    /* ---- 1. Ciaglosc lancucha ---- */
    const braki = sqlite(
        "SELECT (MAX(height)-MIN(height)+1) - COUNT(*) FROM blocks;"
    );
    if (braki === null) {
        zapisz("chain.contiguous", "BLOCKER", "Lancuch bez luk", "SKIP",
            "brak dostepu do bazy",
            "Uruchom na maszynie z baza, inaczej tej kontroli nie da sie wykonac.");
    } else {
        const n = Number(braki);
        zapisz("chain.contiguous", "BLOCKER", "Lancuch bez luk",
            n === 0 ? "PASS" : "FAIL",
            n + " brakujacych blokow",
            n === 0
                ? "Wysokosci ciagle. Wezel moze zsynchronizowac sie od genesis."
                : "replaceChain() wymaga ciaglych wysokosci. Nowy wezel NIE zsynchronizuje sie od genesis - konieczny snapshot bazy.");
    }

    /* ---- 2. Wybor lancucha: dlugosc czy praca ---- */
    const bbc = czytajZrodlo("bbcblockchain.js");
    if (!bbc) {
        zapisz("consensus.work", "MAJOR", "Wybor lancucha po sumie pracy", "SKIP",
            "nie znaleziono bbcblockchain.js", "");
    } else {
        const maPrace = /totalWork|cumulativeWork|chainWork/.test(bbc);
        zapisz("consensus.work", "MAJOR", "Wybor lancucha po sumie pracy",
            maPrace ? "PASS" : "FAIL",
            maPrace ? "znaleziono liczenie pracy" : "wybor po dlugosci lancucha",
            maPrace ? "" : "Bitcoin wybiera po skumulowanej pracy wlasnie dlatego, ze dlugosc jest podatna przy zmiennej trudnosci.");
    }

    /* ---- 3. Walidacja czasu w OBU sciezkach ---- */
    if (bbc) {
        const idxReplace = bbc.indexOf("replaceChain(candidateChain)");
        const ciałoReplace = idxReplace >= 0 ? bbc.slice(idxReplace, idxReplace + 14000) : "";
        const wReplace =
            /MAX_FUTURE_DRIFT_MS/.test(ciałoReplace) &&
            /timestamp\s*<=/.test(ciałoReplace);
        const wReceive = /MAX_FUTURE_DRIFT_MS/.test(bbc);
        zapisz("consensus.timestamp", "BLOCKER", "Walidacja czasu w obu sciezkach",
            (wReplace && wReceive) ? "PASS" : "FAIL",
            "receiveBlock: " + (wReceive ? "tak" : "nie") +
            ", replaceChain: " + (wReplace ? "tak" : "nie"),
            (wReplace && wReceive)
                ? "Obie sciezki egzekwuja monotonicznosc i limit wyprzedzenia zegara."
                : "Asymetria pozwala ominac obrone, wysylajac bloki jako caly lancuch zamiast pojedynczo.");
    }

    /* ---- 4. Ochrona przed powtorzeniem transakcji ---- */
    const mem = czytajZrodlo("mempool.js");
    if (bbc && mem) {
        const wMempool = /hasSignature/.test(mem);
        const wLancuchu = /seenSignatures/.test(bbc);
        zapisz("consensus.replay", "BLOCKER", "Ochrona przed replay",
            (wMempool && wLancuchu) ? "PASS" : "FAIL",
            "mempool: " + (wMempool ? "tak" : "nie") +
            ", lancuch: " + (wLancuchu ? "tak" : "nie"),
            (wMempool && wLancuchu)
                ? "Podpis juz obecny w lancuchu jest odrzucany na wszystkich wejsciach."
                : "Podpisana transakcja moze zostac odtworzona i przeniesc srodki ponownie.");
    }

    /* ---- 5. Duplikaty podpisow w historii ---- */
    const dup = sqlite(
        "SELECT COUNT(*) FROM (SELECT signature FROM transactions WHERE signature IS NOT NULL GROUP BY signature HAVING COUNT(*) > 1);"
    );
    if (dup !== null) {
        const n = Number(dup);
        zapisz("chain.no_duplicates", "BLOCKER", "Brak powielonych podpisow w historii",
            n === 0 ? "PASS" : "FAIL",
            n + " powielonych podpisow",
            n === 0
                ? "Historia czysta - luka replay nie zostala wykorzystana."
                : "W lancuchu sa transakcje odtworzone. Wymaga recznej analizy.");
    }

    /* ---- 6. Suma kontrolna adresu ---- */
    const maModul = fs.existsSync(path.join(BACKEND, "address-checksum.js"));
    let wykrywalnosc = null;
    if (maModul) {
        try {
            const A = require(path.join(BACKEND, "address-checksum.js"));
            const W = require(path.join(BACKEND, "wallet.js"));
            let wykryte = 0, zbadane = 0;
            const alfabet = "0123456789abcdefABCDEF";
            for (let i = 0; i < 1000; i++) {
                const cs = A.toChecksumAddress(W.generateWallet().address);
                const poz = 3 + Math.floor(Math.random() * 40);
                let nowy;
                do { nowy = alfabet[Math.floor(Math.random() * alfabet.length)]; }
                while (nowy.toLowerCase() === cs[poz].toLowerCase());
                const zly = cs.slice(0, poz) + nowy + cs.slice(poz + 1);
                if (!A.isWellFormed(zly)) continue;
                zbadane++;
                if (A.checkAddress(zly) === "invalid") wykryte++;
            }
            wykrywalnosc = (wykryte / zbadane * 100);
        } catch (e) { wykrywalnosc = null; }
    }
    zapisz("address.checksum", "BLOCKER", "Suma kontrolna adresu",
        maModul ? "PASS" : "FAIL",
        maModul
            ? (wykrywalnosc !== null
                ? "wykrywalnosc literowki " + wykrywalnosc.toFixed(1) + "% (1000 prob)"
                : "modul obecny, pomiaru nie wykonano")
            : "brak",
        maModul
            ? "Egzekwowane przez portfel referencyjny, NIE przez konsensus. Integrator musi sprawdzac po swojej stronie."
            : "Literowka daje inny poprawny adres. Srodki nie do odzyskania i nie do namierzenia.");

    /* ---- 7. Checksum na poziomie konsensusu ---- */
    if (mem) {
        const egzekwuje = /checkAddress|isSafeToSend/.test(mem);
        zapisz("address.checksum_consensus", "MAJOR", "Checksum egzekwowany przez wezel",
            egzekwuje ? "PASS" : "FAIL",
            egzekwuje ? "tak" : "nie",
            egzekwuje ? "" : "Wezel przyjmie transakcje na adres ze zlym checksumem. Ochrona istnieje tylko w portfelu.");
    }

    /* ---- 8. Deklarowana podaz vs realna emisja ---- */
    if (CONFIG && info) {
        let r = CONFIG.BLOCK_REWARD, h = CONFIG.HALVING_INTERVAL, suma = 0;
        while (r > 1e-9) { suma += r * h; r /= 2; }
        const premine = info.premine || 0;
        const realny = Math.round(suma + premine);
        const deklarowany = CONFIG.MAX_SUPPLY;
        const zgodne = Math.abs(realny - deklarowany) < 1;
        zapisz("supply.honest", "MAJOR", "Deklarowana podaz = realna emisja",
            zgodne ? "PASS" : "FAIL",
            "deklarowana " + deklarowany.toLocaleString("pl") +
            ", realna " + realny.toLocaleString("pl"),
            zgodne ? "" : "Roznica " + (deklarowany - realny).toLocaleString("pl") +
                " BbC nigdy nie powstanie. /info podaje wartosc, ktorej nie da sie osiagnac.");
    }

    /* ---- 9. Uczciwosc pola isValid ---- */
    if (bbc) {
        const naSztywno = /isValid:\s*\n?\s*true/.test(bbc);
        zapisz("api.isvalid_honest", "MAJOR", "Pole isValid cos realnie sprawdza",
            naSztywno ? "FAIL" : "PASS",
            naSztywno ? "literal true" : "wartosc liczona",
            naSztywno ? "/info zwraca isValid: true bezwarunkowo. Zglosiloby true takze przy uszkodzonym lancuchu." : "");
    }

    /* ---- 10. Glebokosc reorganizacji ---- */
    if (bbc) {
        const maLimit = /MAX_REORG_DEPTH/.test(bbc);
        zapisz("consensus.reorg_limit", "MAJOR", "Zdefiniowany limit reorganizacji",
            maLimit ? "PASS" : "FAIL",
            maLimit ? "zdefiniowany" : "brak",
            maLimit ? "" : "Brak reguly finalnosci. Gielda musi wybrac wlasny prog potwierdzen bez wsparcia protokolu.");
    }

    /* ---- 11. Srodowisko testowe ---- */
    const maTestnet =
        (CONFIG && /testnet|signet|regtest/i.test(JSON.stringify(CONFIG))) ||
        fs.existsSync(path.join(BACKEND, "config.testnet.js"));
    zapisz("env.testnet", "BLOCKER", "Dostepne srodowisko testowe",
        maTestnet ? "PASS" : "FAIL",
        maTestnet ? "wykryte" : "brak",
        maTestnet ? "" : "Integrator nie moze przecwiczyc wplat i wyplat bez uzycia prawdziwych srodkow na mainnecie.");

    /* ---- 12. Moc obliczeniowa sieci ---- */
    if (info && CONFIG) {
        const hs = info.difficulty / CONFIG.BLOCK_TIME;
        const asic = 100e12;
        zapisz("security.hashrate", "MAJOR", "Moc obliczeniowa sieci", "INFO",
            (hs / 1e6).toFixed(2) + " MH/s",
            "Jeden ASIC ~100 TH/s to ok. " +
            Math.round(asic / hs).toLocaleString("pl") +
            " x cala siec. Wiekszosc mocy jest do wynajecia trywialnie.");
    }

    /* ---- 13. Komunikaty bledow ---- */
    if (mem) {
        const poPolsku = /juz jest w mempoolu|Nieprawidłowy|Opłata/.test(mem);
        zapisz("api.error_codes", "MINOR", "Maszynowe kody bledow",
            poPolsku ? "FAIL" : "PASS",
            poPolsku ? "komunikaty tekstowe po polsku" : "kody obecne",
            poPolsku ? "Integrator musi parsowac polskie napisy zamiast stabilnych kodow." : "");
    }

    /* ---- 14. Spojnosc regexu adresu ---- */
    const pliki = ["mempool.js", "server.js", "wallet.js", "payout.js"];
    const znalezione = [];
    for (const f of pliki) {
        const tresc = czytajZrodlo(f);
        if (!tresc) continue;
        const m = tresc.match(/\/\^BbC\[0-9a-fA-F\]\{40\}\$\//g);
        if (m) znalezione.push(f);
    }
    zapisz("address.regex_consistent", "MINOR", "Spojna walidacja formatu adresu",
        znalezione.length > 0 ? "PASS" : "SKIP",
        znalezione.length + " plikow z tym samym wzorcem",
        znalezione.length ? "Wzorzec: " + znalezione.join(", ") : "");

    /* ---- 15. Audyt zewnetrzny ---- */
    zapisz("security.external_audit", "MAJOR", "Audyt zewnetrznej firmy", "FAIL",
        "brak",
        "Prymitywy kryptograficzne przeszly oficjalne wektory testowe, ale to pokrycie testami wlasnymi, nie audyt niezalezny.");

    /* ---- 16. Liczba wezlow ---- */
    if (info && info.p2p) {
        const n = (info.p2p.connected || []).length + 1;
        zapisz("ops.node_count", "MAJOR", "Redundancja infrastruktury", "INFO",
            n + " wezlow",
            "API, pula i wezel zarodkowy dziala na jednej maszynie jednego operatora.");
    }

    raport();
}


/* =====================================================
   RAPORT
   ===================================================== */

function raport() {

    if (JSON_OUT) {
        console.log(JSON.stringify({ generated: new Date().toISOString(), results: wyniki }, null, 2));
    } else {
        const L = console.log;
        const kreska = "=".repeat(72);

        L(kreska);
        L(" BITBUDCOIN - EXCHANGE READINESS PASS");
        L(" " + new Date().toISOString());
        L(kreska);

        for (const w of ["BLOCKER", "MAJOR", "MINOR"]) {
            const grupa = wyniki.filter((r) => r.waga === w);
            if (!grupa.length) continue;
            L("");
            L(w + "  (" + WAGI[w] + ")");
            L("-".repeat(72));
            for (const r of grupa) {
                const znak =
                    r.stan === "PASS" ? "[ OK ]" :
                    r.stan === "FAIL" ? "[FAIL]" :
                    r.stan === "INFO" ? "[INFO]" : "[SKIP]";
                L(znak + "  " + r.nazwa);
                L("        zmierzone: " + r.zmierzone);
                if (r.komentarz) {
                    // zawijanie do 62 znakow
                    const slowa = r.komentarz.split(" ");
                    let linia = "        ";
                    for (const s of slowa) {
                        if ((linia + s).length > 70) { L(linia); linia = "        " + s + " "; }
                        else linia += s + " ";
                    }
                    if (linia.trim()) L(linia);
                }
                L("");
            }
        }

        const blockery = wyniki.filter((r) => r.waga === "BLOCKER");
        const zdane = blockery.filter((r) => r.stan === "PASS").length;
        const oblane = blockery.filter((r) => r.stan === "FAIL");

        L(kreska);
        L(" BLOCKERY: " + zdane + " / " + blockery.length + " zdanych");
        if (oblane.length) {
            L("");
            L(" Pozostale do zamkniecia:");
            for (const r of oblane) L("   - " + r.nazwa + "  (" + r.zmierzone + ")");
        }
        L(kreska);
    }

    process.exit(
        wyniki.some((r) => r.waga === "BLOCKER" && r.stan === "FAIL") ? 1 : 0
    );
}

uruchom().catch((e) => {
    console.error("Blad audytu:", e.message);
    process.exit(2);
});
