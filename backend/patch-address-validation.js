"use strict";

/*
 * ============================================================
 * PATCH: walidacja formatu minerAddress
 * ============================================================
 *
 * Powod: /network/miners pokazywal wpisy takie jak "AbC", "test",
 * sklejony status urzadzenia Android, a nawet fraze 12 slow -
 * bo zaden z 4 punktow przyjmujacych minerAddress w server.js
 * nie sprawdzal formatu przed uzyciem. payout.js juz ma dokladnie
 * ten regex i dziala poprawnie - ten patch dodaje TEN SAM check
 * na granicy API, zanim smiec w ogole trafi do bazy albo (w
 * przypadku /solo/work) na stale do coinbase w prawdziwym bloku.
 *
 * Uzycie:
 *   node patch-address-validation.js
 *
 * Dziala na ~/backend/server.js w miejscu. Kazda z 5 zmian
 * weryfikuje ze stary tekst istnieje DOKLADNIE RAZ przed zamiana -
 * jesli plik na serwerze rozjechal sie od tego co widzialem,
 * skrypt PRZERYWA z jasnym bledem zamiast ryzykowac zle podmienienie.
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "server.js");

let src = fs.readFileSync(TARGET, "utf8");

let changesApplied = 0;

function replaceOnce(label, oldStr, newStr) {
    const count = src.split(oldStr).length - 1;
    if (count === 0) {
        throw new Error(
            `[${label}] Nie znaleziono oczekiwanego tekstu w server.js. ` +
            `Plik na serwerze rozni sie od zakladanego - STOP, nic nie zmieniam. ` +
            `Wklej realna tresc tego fragmentu do Claude zamiast uruchamiac patch ponownie.`
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
 * 1) Wspolna stala walidacji, raz, zaraz po importach.
 *    Ten sam regex co payout.js: "BbC" + 40 znakow hex.
 */
replaceOnce(
    "dodanie ADDRESS_FORMAT",
    `const {
    verifyHtlcCreateSignature,
    verifyHtlcClaimSignature,
    verifyHtlcRefundSignature
} = require("./htlc-wallet");`,
    `const {
    verifyHtlcCreateSignature,
    verifyHtlcClaimSignature,
    verifyHtlcRefundSignature
} = require("./htlc-wallet");


/*
 * NAPRAWA (dzisiaj): 821 wierszy w pool_credits mialo jako
 * "minerAddress" smieci ("AbC", "test", sklejony status urzadzenia,
 * a raz nawet fraze 12 slow portfela) - zaden z punktow przyjmowania
 * minerAddress ponizej nie sprawdzal formatu. payout.js juz mial ten
 * regex i dzieki temu nigdy nic z tego nie wyplacil - ten sam check
 * teraz na granicy API, zanim smiec w ogole trafi do bazy albo (w
 * /solo/work) na stale do coinbase w prawdziwym bloku.
 */
const ADDRESS_FORMAT = /^BbC[0-9a-fA-F]{40}$/;`
);

/*
 * 2) /pool/work
 */
replaceOnce(
    "/pool/work",
    `app.get(
    "/pool/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        res.json(
            pool.getWork(
                minerAddress
            )
        );
    }
);`,
    `app.get(
    "/pool/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        res.json(
            pool.getWork(
                minerAddress
            )
        );
    }
);`
);

/*
 * 3) /pool/submit
 */
replaceOnce(
    "/pool/submit",
    `        if (
            typeof minerAddress !== "string" ||
            !minerAddress
        ) {

            return res.status(400).json({
                error:
                    "Brak adresu minera"
            });
        }

        if (
            !candidate ||
            typeof candidate !== "object"
        ) {`,
    `        if (
            typeof minerAddress !== "string" ||
            !minerAddress
        ) {

            return res.status(400).json({
                error:
                    "Brak adresu minera"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        if (
            !candidate ||
            typeof candidate !== "object"
        ) {`
);

/*
 * 4) /solo/work — najwazniejsze: to tu smieci trafialy na stale
 *    do coinbase w realnych blokach (buildBlockTransactions).
 */
replaceOnce(
    "/solo/work",
    `app.get(
    "/solo/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        const latest =
            blockchain.getLatestBlock();`,
    `app.get(
    "/solo/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        const latest =
            blockchain.getLatestBlock();`
);

/*
 * 5) /solo/heartbeat
 */
replaceOnce(
    "/solo/heartbeat",
    `        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        soloTracker.heartbeat(
            minerAddress,
            attempts,
            intervalSeconds
        );`,
    `        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        soloTracker.heartbeat(
            minerAddress,
            attempts,
            intervalSeconds
        );`
);

fs.writeFileSync(TARGET, src);

console.log(`\nGotowe: ${changesApplied}/5 zmian zastosowanych w ${TARGET}`);
console.log(`Teraz: node -c ${TARGET}`);
