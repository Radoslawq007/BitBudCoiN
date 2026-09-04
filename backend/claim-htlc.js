// Odbiór BTC z zamka HTLC (P2WSH) po ujawnieniu sekretu na łańcuchu BbC.
// URUCHOM Z ~/backend/bch/ (wymaga tamtejszych plików: btc-htlc-compile,
// btc-htlc-script, btc-htlc-spend, secp256k1, segwit-tx, btc-sighash).
//
// NIE WYSYŁA nic do sieci automatycznie - tylko buduje, podpisuje i pokazuje
// gotową transakcję do sprawdzenia. Transmisja to osobny, świadomy krok.
//
// NAPRAWA (dzisiaj, PILNA - klucz prywatny znaleziony w publicznym repo):
// wszystkie parametry (klucze, sekret, adresy, timeout) NIE są już wpisane
// w kod. Ten plik jest w publicznym repo - żaden sekret nie może tu lądować,
// niezależnie od tego czy dotyczy już-zakończonego swapu czy nie. Parametry
// czytane są z lokalnego pliku claim-htlc-params.json (patrz PARAMS_PATH
// niżej), który NIGDY nie jest commitowany - dopisz go do .gitignore:
//   echo "backend/claim-htlc-params.json" >> .gitignore
//
// Przy pierwszym uruchomieniu bez tego pliku dostaniesz gotowy szablon do
// wypełnienia (patrz niżej) zamiast krachu bez wyjaśnienia.
//
// Ten sam plik służy teraz do KAŻDEGO przyszłego claimu HTLC - wystarczy
// podmienić zawartość claim-htlc-params.json, kod się nie zmienia.
//
// Uruchomienie: node claim-htlc.js

const fs = require("fs");
const path = require("path");

const { compileHtlcScript, deriveP2WSHAddress } = require("./btc-htlc-compile");
const { hash160 } = require("./btc-htlc-script");
const { signHtlcClaim, compressPubKey } = require("./btc-htlc-spend");
const { G, scalarMult } = require("./secp256k1");
const { serializeSegwitTransaction, computeTxid, computeWtxid } = require("./segwit-tx");
const { SIGHASH_ALL } = require("./btc-sighash");

// ==================== PARAMETRY - z lokalnego, niecommitowanego pliku ====================
const PARAMS_PATH = path.join(__dirname, "claim-htlc-params.json");

const PARAMS_TEMPLATE = {
    sellerPrivHex: "TWOJ_PRYWATNY_KLUCZ_HEX_64_ZNAKI",
    buyerPrivHex: "KLUCZ_KUPUJACEGO_HEX_64_ZNAKI_tylko_do_wyprowadzenia_hasha",
    secretHex: "PREIMAGE_HEX_ktory_odblokowuje_HASH_LOCK",
    hashLock: "SHA256_PREIMAGE_HEX",
    timeoutHeightBtc: 0,
    expectedLockAddress: "bc1q...adres_zamka_ktory_ma_wyjsc_z_rekonstrukcji",
    destAddress: "bc1q...gdzie_wyslac_odebrane_BTC"
};

function loadParams() {
    if (!fs.existsSync(PARAMS_PATH)) {
        fs.writeFileSync(PARAMS_PATH, JSON.stringify(PARAMS_TEMPLATE, null, 2));
        console.error(
            "Brak " + PARAMS_PATH + " - utworzyłem szablon pod tą ścieżką.\n" +
            "Wypełnij prawdziwymi wartościami i uruchom ponownie.\n" +
            "PRZED pierwszym uruchomieniem sprawdź, że ten plik jest w .gitignore:\n" +
            "  echo \"backend/claim-htlc-params.json\" >> .gitignore"
        );
        process.exit(1);
    }

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(PARAMS_PATH, "utf8"));
    } catch (err) {
        console.error("Nie udało się sparsować " + PARAMS_PATH + " jako JSON: " + err.message);
        process.exit(1);
    }

    const required = ["sellerPrivHex", "buyerPrivHex", "secretHex", "hashLock", "timeoutHeightBtc", "expectedLockAddress", "destAddress"];
    const missing = required.filter((k) => raw[k] === undefined || raw[k] === null || raw[k] === "");
    if (missing.length > 0) {
        console.error("Brakuje pól w " + PARAMS_PATH + ": " + missing.join(", "));
        process.exit(1);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw.sellerPrivHex)) {
        console.error("sellerPrivHex musi być dokładnie 64 znakami hex (32 bajty).");
        process.exit(1);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw.buyerPrivHex)) {
        console.error("buyerPrivHex musi być dokładnie 64 znakami hex (32 bajty).");
        process.exit(1);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw.hashLock)) {
        console.error("hashLock musi być dokładnie 64 znakami hex (wynik SHA256).");
        process.exit(1);
    }
    if (typeof raw.timeoutHeightBtc !== "number" || !Number.isFinite(raw.timeoutHeightBtc)) {
        console.error("timeoutHeightBtc musi być liczbą.");
        process.exit(1);
    }
    if (typeof raw.expectedLockAddress !== "string" || !raw.expectedLockAddress.startsWith("bc1")) {
        console.error("expectedLockAddress musi być adresem segwit zaczynającym się od 'bc1'.");
        process.exit(1);
    }
    if (typeof raw.destAddress !== "string" || !raw.destAddress.startsWith("bc1")) {
        console.error("destAddress musi być adresem segwit zaczynającym się od 'bc1'.");
        process.exit(1);
    }

    return raw;
}

const PARAMS = loadParams();
const SELLER_PRIV_HEX = PARAMS.sellerPrivHex;
const SECRET_HEX = PARAMS.secretHex;
const HASH_LOCK = PARAMS.hashLock;
const TIMEOUT_HEIGHT_BTC = PARAMS.timeoutHeightBtc;
const EXPECTED_LOCK_ADDRESS = PARAMS.expectedLockAddress;
const DEST_ADDRESS = PARAMS.destAddress;
// Klucz kupującego - TYLKO do zrekonstruowania skryptu (refundeePubKeyHash),
// nigdy do podpisywania niczego.
const BUYER_PRIV_HEX = PARAMS.buyerPrivHex;
// =======================================================================

function decodeBech32Address(addr) {
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    function polymod(values) {
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;
        for (const v of values) {
            const top = chk >>> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ v;
            for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
        }
        return chk >>> 0;
    }
    function hrpExpand(hrp) {
        const ret = [];
        for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
        ret.push(0);
        for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
        return ret;
    }
    function convertBits(data, fromBits, toBits) {
        let acc = 0, bits = 0; const ret = []; const maxv = (1 << toBits) - 1;
        for (const value of data) {
            acc = (acc << fromBits) | value; bits += fromBits;
            while (bits >= toBits) { bits -= toBits; ret.push((acc >> bits) & maxv); }
        }
        return ret;
    }
    const lower = addr.toLowerCase();
    const pos = lower.lastIndexOf("1");
    const hrp = lower.slice(0, pos);
    const data = [...lower.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
    if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error("zła checksuma bech32 adresu docelowego");
    const program = Buffer.from(convertBits(data.slice(1, -6), 5, 8));
    return { hrp, program };
}

async function main() {
    console.log("=== KROK 1: rekonstrukcja i weryfikacja skryptu HTLC ===");
    const sellerPriv = BigInt("0x" + SELLER_PRIV_HEX);
    const buyerPriv = BigInt("0x" + BUYER_PRIV_HEX);
    const claimantPubKeyHash = hash160(compressPubKey(scalarMult(sellerPriv, G))).toString("hex");
    const refundeePubKeyHash = hash160(compressPubKey(scalarMult(buyerPriv, G))).toString("hex");
    console.log("claimantPubKeyHash (Ty):", claimantPubKeyHash);
    console.log("refundeePubKeyHash (kupujący):", refundeePubKeyHash);

    const compiledScript = compileHtlcScript({
        hashLock: HASH_LOCK, timeoutHeight: TIMEOUT_HEIGHT_BTC,
        claimantPubKeyHash, refundeePubKeyHash
    });
    const compiledScriptHex = compiledScript.toString("hex");
    const { address: reconstructedAddress } = await deriveP2WSHAddress(compiledScript, "bc");

    console.log("Zrekonstruowany adres zamka:", reconstructedAddress);
    console.log("Prawdziwy adres zamka:     ", EXPECTED_LOCK_ADDRESS);
    if (reconstructedAddress !== EXPECTED_LOCK_ADDRESS) {
        console.error("\n❌ STOP: adresy się NIE zgadzają. Nie kontynuuję - błędne parametry skryptu.");
        process.exit(1);
    }
    console.log("✅ Zgadza się - skrypt zrekonstruowany poprawnie.\n");

    console.log("=== KROK 2: szukam wpłaty na tym adresie (mempool.space) ===");
    const utxoRes = await fetch(`https://mempool.space/api/address/${reconstructedAddress}/utxo`);
    const utxos = await utxoRes.json();
    const confirmed = utxos.filter((u) => u.status && u.status.confirmed);
    if (confirmed.length === 0) {
        console.error("❌ Brak potwierdzonych wpłat na tym adresie. Nic do odebrania.");
        process.exit(1);
    }
    console.log(`Znaleziono ${confirmed.length} potwierdzoną(-ych) wpłatę/wpłat:`);
    confirmed.forEach((u) => console.log(`  ${u.txid}:${u.vout} = ${u.value} sat`));
    const totalInput = confirmed.reduce((s, u) => s + u.value, 0);
    console.log("Suma:", totalInput, "sat\n");

    console.log("=== KROK 3: sprawdzam aktualną opłatę sieciową ===");
    let feeRate = 3; // sat/vB, bezpieczny domyślny jeśli fetch się nie uda
    try {
        const feeRes = await fetch("https://mempool.space/api/v1/fees/recommended");
        const fees = await feeRes.json();
        feeRate = fees.hourFee || fees.halfHourFee || 3;
        console.log("Realna opłata teraz (~1h potwierdzenie):", feeRate, "sat/vB");
    } catch (e) {
        console.log("Nie udało się pobrać opłaty, używam bezpiecznego domyślnego:", feeRate, "sat/vB");
    }
    console.log("");

    console.log("=== KROK 4: budowa i podpisanie transakcji ===");
    const { program: destProgram } = decodeBech32Address(DEST_ADDRESS);
    const destScriptPubKey = Buffer.concat([Buffer.from([0x00, 0x14]), destProgram]).toString("hex");

    // Pierwsze przejście: szacunkowa opłata na bazie znanej struktury,
    // żeby wyliczyć wartość wyjścia PRZED podpisaniem (sighash obejmuje
    // wartość wyjścia, więc nie da się podpisać przed jej ustaleniem).
    const estimatedVsize = 40 + Math.ceil((compiledScriptHex.length / 2 + 170) / 4);
    const estimatedFee = Math.ceil(estimatedVsize * feeRate);
    const outputValue = totalInput - estimatedFee;
    if (outputValue <= 0) {
        console.error(`❌ STOP: opłata (${estimatedFee} sat) >= wpłata (${totalInput} sat). Nie ma sensu wysyłać.`);
        process.exit(1);
    }

    const tx = {
        version: 2,
        inputs: confirmed.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xffffffff })),
        outputs: [{ valueSatoshis: outputValue, scriptPubKey: destScriptPubKey }],
        witnesses: confirmed.map(() => []),
        locktime: 0
    };

    confirmed.forEach((u, i) => {
        signHtlcClaim({
            tx, inputIndex: i, privateKeyScalar: sellerPriv,
            preimageHexString: SECRET_HEX, compiledScriptHex,
            inputValueSatoshis: u.value, hashType: SIGHASH_ALL
        });
    });

    const rawHex = serializeSegwitTransaction(tx).toString("hex");
    const realVsize = (() => {
        const totalBytes = rawHex.length / 2;
        const witnessBytes = tx.witnesses.reduce((s, w) => s + 3 + w.reduce((s2, item) => s2 + 1 + item.length / 2, 0), 0);
        const baseBytes = totalBytes - witnessBytes;
        return Math.ceil((baseBytes * 4 + witnessBytes) / 4);
    })();
    const realFee = totalInput - outputValue;

    console.log("");
    console.log("=== GOTOWA TRANSAKCJA (jeszcze NIE wysłana) ===");
    console.log("Wejście (wpłata):", totalInput, "sat");
    console.log("Opłata:", realFee, "sat (", (realFee / realVsize).toFixed(2), "sat/vB przy", realVsize, "vB)");
    console.log("Wyjście (na Twój adres):", outputValue, "sat  ≈", (outputValue / 100000000).toFixed(8), "BTC");
    console.log("Adres docelowy:", DEST_ADDRESS);
    console.log("");
    console.log("txid:", computeTxid(tx));
    console.log("wtxid:", computeWtxid(tx));
    console.log("");
    console.log("RAW HEX (do transmisji, gdy potwierdzisz że wygląda dobrze):");
    console.log(rawHex);
    console.log("");
    console.log("NIC nie zostało wysłane do sieci. Transmisja to osobny krok.");
}

main().catch((err) => { console.error("BŁĄD:", err.message); process.exit(1); });
