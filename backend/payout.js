const fs = require("fs");
const Storage = require("./storage");
const CONFIG = require("./config");
const { deriveAddress, signTransaction } = require("./wallet");
const crypto = require("crypto");
const privateKeyPath = process.argv[2];
const serverUrl = process.argv[3] || `http://localhost:${CONFIG.API_PORT}`;
const minPayoutArg = process.argv[4];
let minPayout = 1;
if (minPayoutArg !== undefined) {
    const parsed = Number(minPayoutArg);
    minPayout = Number.isNaN(parsed) ? 1 : parsed;
}
if (!privateKeyPath) { console.error("Użycie: node payout.js <klucz_puli.pem> [url] [min_wyplata]"); process.exit(1); }
const privateKey = fs.readFileSync(privateKeyPath, "utf8");
const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
const poolAddress = deriveAddress(publicKey);
if (poolAddress !== CONFIG.POOL_ADDRESS) { console.error(`❌ Klucz nie pasuje do POOL_ADDRESS w config.js`); process.exit(1); }

// NAPRAWA (dzisiaj, poprawiona wersja - patrz komentarz w storage.js
// getUnpaidCreditsSummary): filtr po kwocie był błędny. Prawdziwy sygnał to
// wysokość bloku - podczas zastoju tysiące kredytów dzieli tę samą wysokość
// (łańcuch stał, share'y i tak wpływały). storage.js wyklucza takie wysokości
// automatycznie, tutaj tylko domyślny próg jest jawny dla czytelności.
const PATHOLOGICAL_HEIGHT_THRESHOLD = 1000;

// NAPRAWA (dzisiaj): jeden wpis w bazie miał jako "adres górnika" fragment
// logu diagnostycznego telefonu zamiast prawdziwego adresu - realny,
// zaobserwowany wpis, nie teoria. Bez tej walidacji próba wypłaty na taki
// "adres" kończyła się niejasnym odrzuceniem ("Odrzucono: undefined") zamiast
// czytelnego pominięcia. Format zgodny ze wszystkimi prawdziwymi adresami
// widzianymi w tym projekcie: "BbC" + 40 znaków hex.
const ADDRESS_FORMAT = /^BbC[0-9a-fA-F]{40}$/;

// NAPRAWA (dzisiaj): "Odrzucono: undefined" nie bylo prawdziwym odrzuceniem
// transakcji - to byl limiter zapytan (/transactions/send go nie omija,
// w przeciwienstwie do /pool/submit). Przy zbyt szybkich zadaniach zwraca
// inny ksztalt odpowiedzi ({error:"..."}, bez pola reason), ktory ten kod
// odczytywal jako "undefined". Teraz: (1) odczyt pokazuje prawdziwy powod
// niezaleznie od ksztaltu odpowiedzi, (2) odstep miedzy wysylkami, zeby
// w ogole rzadziej trafiac w ten limit - filtr wysokosci nareszcie odkryl
// kilka adresow na raz zamiast jednego, a petla wysylala je wszystkie pod rzad.
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
const DELAY_BETWEEN_SENDS_MS = 1200;

async function main() {
    const storage = new Storage(CONFIG.DATABASE);
    const unpaid = storage.getUnpaidCreditsSummary(5000, PATHOLOGICAL_HEIGHT_THRESHOLD);
    if (unpaid.length === 0) { console.log("Brak niewypłaconych należności (w bezpiecznym zakresie kwot)."); storage.close(); return; }
    const pendingMempool = storage.loadMempool();
    const addressesWithPendingPayout = new Set(
        pendingMempool.filter((tx) => tx.from === poolAddress).map((tx) => tx.to)
    );
    for (const { minerAddress, total, creditIds } of unpaid) {
        if (minerAddress === poolAddress) continue;
        if (!ADDRESS_FORMAT.test(minerAddress)) {
            console.warn(`⚠️  Pomijam nieprawidłowy format adresu (nie wypłacam, nie usuwam z bazy): "${minerAddress.slice(0, 60)}${minerAddress.length > 60 ? "..." : ""}" (zaległe: ${total.toFixed(4)} BbC, ${creditIds.length} wpisów)`);
            continue;
        }
        if (total < minPayout) continue;
        if (addressesWithPendingPayout.has(minerAddress)) {
            console.log(`⏳   ${minerAddress} ma już oczekującą wypłatę w mempoolu, czekam aż się potwierdzi (zaległe: ${total.toFixed(4)} BbC)`);
            continue;
        }
        const tx = { from: poolAddress, to: minerAddress, amount: total, fee: CONFIG.MIN_FEE, timestamp: Date.now() };
        const signature = signTransaction(tx, privateKey);
        const candidate = { ...tx, publicKey, signature };
        try {
            const res = await fetch(`${serverUrl}/transactions/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(candidate) });
            const result = await res.json();
            if (result.accepted) { storage.markCreditsPaid(creditIds); console.log(`✅   Wypłacono ${total.toFixed(4)} BbC dla ${minerAddress}`); }
            else console.warn(`⚠️  Odrzucono (${minerAddress}, próba: ${total.toFixed(4)} BbC): ${result.reason ?? result.error ?? JSON.stringify(result)}`);
        } catch (err) { console.error(`❌   ${err.message}`); }
        await sleep(DELAY_BETWEEN_SENDS_MS);
    }
    storage.close();
}
main().catch((err) => { console.error("❌  ", err); process.exit(1); });
