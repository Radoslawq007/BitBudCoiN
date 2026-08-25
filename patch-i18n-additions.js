"use strict";

/*
 * ============================================================
 * PATCH: nowe klucze i18n dla widgetu gornikow + kamienia
 * milowego 100k (przeniesionego dzisiaj z widgetu w hero)
 * ============================================================
 *
 * Dodaje 5 kluczy, PL i EN, wstawione zaraz po istniejacym
 * bloku index_milestone1_* w obu sekcjach jezykowych - ten sam
 * wzorzec kluczy co reszta pliku, nic wymyslonego.
 *
 * Uzycie:
 *   node patch-i18n-additions.js
 *
 * Dziala na frontend/assets/i18n.js w miejscu (uruchamiaj z
 * katalogu ktory zawiera podkatalog frontend/, np. z korzenia
 * lokalnego checkoutu repo). Kazda zmiana weryfikuje ze stary
 * tekst istnieje DOKLADNIE RAZ przed zamiana.
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "frontend", "assets", "i18n.js");

let src = fs.readFileSync(TARGET, "utf8");

let changesApplied = 0;

function replaceOnce(label, oldStr, newStr) {
    const count = src.split(oldStr).length - 1;
    if (count === 0) {
        throw new Error(
            `[${label}] Nie znaleziono oczekiwanego tekstu w i18n.js. ` +
            `Plik rozni sie od zakladanego - STOP, nic nie zmieniam.`
        );
    }
    if (count > 1) {
        throw new Error(
            `[${label}] Ten tekst wystepuje ${count} razy, oczekiwano 1 - ` +
            `niejednoznaczne, STOP, nic nie zmieniam.`
        );
    }
    src = src.replace(oldStr, newStr);
    changesApplied++;
    console.log(`✓ [${label}] zastosowano`);
}

/*
 * PL
 */
replaceOnce(
    "PL: nowe klucze",
    `        index_milestone1_desc: "Pierwszy w pełni dokończony atomic swap BTC↔BbC — ten sam hashlock po obu stronach, do sprawdzenia samemu.",
        index_milestone1_btc_link: "Transakcja BTC →",
        index_milestone1_bbc_link: "Blok BbC #3071 →",`,
    `        index_milestone1_desc: "Pierwszy w pełni dokończony atomic swap BTC↔BbC — ten sam hashlock po obu stronach, do sprawdzenia samemu.",
        index_milestone1_btc_link: "Transakcja BTC →",
        index_milestone1_bbc_link: "Blok BbC #3071 →",

        index_milestone_next_title: "Następny wielki kamień milowy",
        index_milestone2_desc: "Sieć osiągnęła wysokość 100 000 bloków — aktywacja algorytmu trudności vMax (ASERT), który zastąpił dotychczasowy mechanizm dostosowania trudności.",
        index_milestone2_bbc_link: "Blok BbC #100 000 →",
        index_miners_remaining_label: "górników do",
        index_miners_achieved: "🎉 500 górników osiągnięte",`
);

/*
 * EN
 */
replaceOnce(
    "EN: nowe klucze",
    `        index_milestone1_desc: "First fully completed BTC↔BbC atomic swap — same hashlock on both sides, verifiable yourself.",
        index_milestone1_btc_link: "BTC transaction →",
        index_milestone1_bbc_link: "BbC block #3071 →",`,
    `        index_milestone1_desc: "First fully completed BTC↔BbC atomic swap — same hashlock on both sides, verifiable yourself.",
        index_milestone1_btc_link: "BTC transaction →",
        index_milestone1_bbc_link: "BbC block #3071 →",

        index_milestone_next_title: "Next big milestone",
        index_milestone2_desc: "The network reached a height of 100,000 blocks — activation of the vMax (ASERT) difficulty algorithm, which replaced the previous difficulty adjustment mechanism.",
        index_milestone2_bbc_link: "BbC block #100,000 →",
        index_miners_remaining_label: "miners to",
        index_miners_achieved: "🎉 500 miners reached",`
);

fs.writeFileSync(TARGET, src);

console.log(`\nGotowe: ${changesApplied}/2 zmian zastosowanych w ${TARGET}`);
console.log(`Teraz: node -c ${TARGET}`);
