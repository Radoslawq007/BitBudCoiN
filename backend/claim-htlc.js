// Odbiór BTC z zamka HTLC (P2WSH) po ujawnieniu sekretu na łańcuchu BbC.
// URUCHOM Z ~/backend/bch/ (wymaga tamtejszych plików: btc-htlc-compile,
// btc-htlc-script, btc-htlc-spend, secp256k1, segwit-tx, btc-sighash).
//
// NIE WYSYŁA nic do sieci automatycznie - tylko buduje, podpisuje i pokazuje
// gotową transakcję do sprawdzenia. Transmisja to osobny, świadomy krok.
//
// Uruchomienie: node claim-htlc.js

const { compileHtlcScript, deriveP2WSHAddress } = require("./btc-htlc-compile");
const { hash160 } = require("./btc-htlc-script");
const { signHtlcClaim, compressPubKey } = require("./btc-htlc-spend");
const { G, scalarMult } = require("./secp256k1");
const { serializeSegwitTransaction, computeTxid, computeWtxid } = require("./segwit-tx");
const { SIGHASH_ALL } = require("./btc-sighash");

// ==================== ZNANE WARTOŚCI (potwierdzone w tej rozmowie) ====================
const SELLER_PRIV_HEX = "2cebd56dcde25ad7c14f519f68ea993668ae2b4b064027ee0ac6897cb173f77d";
const SECRET_HEX = "f55c1f2a2324a26cd2d31ec9af87156404c7ad405ebdfb268e7c5a40defcc1e3";
const HASH_LOCK = "9a84910cb4556bfc4f946937bf005a197f48ce79c98725624c151701f438df03";
const TIMEOUT_HEIGHT_BTC = 3278;
const EXPECTED_LOCK_ADDRESS = "bc1qgr2fz2d4n3l7p0hywy7w9ddjs9a9vxvdetxqanhcl2tgrtp2fv9q2h9c49";
const DEST_ADDRESS = "bc1q2370ey6k5etlqf65zwuhngxl6y0t6lee9wt3vz";
// Klucz kupującego - TYLKO do zrekonstruowania skryptu (refundeePubKeyHash),
// nigdy do podpisywania niczego. Publiczny w praktyce, bo tylko wyprowadza hash.
const BUYER_PRIV_HEX = "8fbc4993fd186afcbee02a91cc65dde6ad2eb94460cbae8ac6c0f55b03375da9";
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
