const fs = require("fs");
const path = require("path");
const Storage = require("./storage");
const CONFIG = require("./config");
const { deriveAddress, signTransaction } = require("./wallet");
const crypto = require("crypto");

// NAPRAWA (dzisiaj, PILNA): getUnpaidCreditIdsForAddress byla wolana tutaj
// z argumentem ktorego zadna wersja tej metody nigdy nie przyjmowala, i w
// ogole nigdzie nie byla zdefiniowana w storage.js. Kazda UDANA wyplata
// konczyla sie TypeError zlapanym przez try/catch PO wyslaniu prawdziwej
// transakcji, ale PRZED oznaczeniem kredytow jako oplacone - te same
// kredyty wygladaly na niezaplacone w kolejnym cyklu (5-30s pozniej,
// payout-watcher), wiec ten sam dlug bylby wyslany ZNOWU, bez konca, dopoki
// starczaloby salda. Metody uzywane ponizej (storage.js) istnieja i sa
// cutoff-aware (legacy/current).
const ADDRESS_FORMAT = /^BbC[0-9a-fA-F]{40}$/;

// NAPRAWA (dzisiaj, strategia dlugu wyplat - decyzja: B=10% nowych bloków,
// C=25% sufit trudnosci gornika w pool.js): caly dlug SPRZED wdrozenia tego
// pliku ("legacy", ~1.22M BbC/7 adresow w chwili tej decyzji) jest zbyt
// duzy zeby splacac w calosci na raz - nawet 100% przyszlych nagrod to
// ~5 miesiecy ZERA wyplat dla kogokolwiek. Wiec: current (kredyty OD
// momentu wdrozenia, generowane juz pod sufitem 25%) splacany w calosci
// jak dotychczas; legacy splacany stopniowo, z osobnego budzetu = 10%
// wartosci KAZDEGO nowego bloku od momentu wdrozenia, kumulowanego miedzy
// cyklami, wyplacany zawsze na NAJMNIEJSZY pozostaly dlug legacy na raz
// (kazdy w pelni splacony adres znika z kolejki najszybciej). Cutoff i
// budzet w LEGACY_STATE_PATH - prosty stan, przetrwa restarty, nie wymaga
// dotykania konsensusowego bbcblockchain.js/pool.js (tylko odczyt wysokosci
// bloków, liczac nagrode ta sama, czysta formula co getRewardForHeight).
// Budzet NIGDY nie schodzi ponizej zera - jesli nawet najstarszy wiersz
// legacy przekracza aktualny budzet, czeka na kolejny cykl akumulacji
// (patrz storage.js getUnpaidLegacyCreditIdsUpToAmount).
const LEGACY_STATE_PATH = path.join(__dirname, "legacy-debt-state.json");
const LEGACY_SHARE = 0.10;
const MIN_LEGACY_PAYOUT = 0.01; // ponizej tego nie oplaca sie wysylac (fee)

function loadOrInitLegacyState() {
    try {
        return JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, "utf8"));
    } catch {
        const initial = { cutoffTimestamp: Date.now(), lastCheckedHeight: -1, accruedBudget: 0 };
        fs.writeFileSync(LEGACY_STATE_PATH, JSON.stringify(initial, null, 2));
        console.log(`ℹ️   Pierwsze uruchomienie logiki długu legacy - cutoff: ${new Date(initial.cutoffTimestamp).toISOString()}`);
        return initial;
    }
}
function saveLegacyState(state) {
    fs.writeFileSync(LEGACY_STATE_PATH, JSON.stringify(state, null, 2));
}
function rewardForHeight(height) {
    return CONFIG.BLOCK_REWARD / Math.pow(2, Math.floor(height / CONFIG.HALVING_INTERVAL));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
const DELAY_BETWEEN_SENDS_MS = 1200;

async function main(privateKeyPath, serverUrl, minPayout) {
    const privateKey = fs.readFileSync(privateKeyPath, "utf8");
    const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
    const poolAddress = deriveAddress(publicKey);
    if (poolAddress !== CONFIG.POOL_ADDRESS) {
        console.error(`❌ Klucz nie pasuje do POOL_ADDRESS w config.js`);
        process.exitCode = 1;
        return;
    }

    async function sendPayout(minerAddress, amount) {
        const tx = { from: poolAddress, to: minerAddress, amount, fee: CONFIG.MIN_FEE, timestamp: Date.now() };
        const signature = signTransaction(tx, privateKey);
        const candidate = { ...tx, publicKey, signature };
        const res = await fetch(`${serverUrl}/transactions/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(candidate) });
        return res.json();
    }

    const storage = new Storage(CONFIG.DATABASE);
    const legacyState = loadOrInitLegacyState();

    // --- naliczenie budzetu legacy z nowych blokow od ostatniego sprawdzenia ---
    const newHeights = storage.getBlockHeightsSince(legacyState.lastCheckedHeight);
    if (newHeights.length > 0) {
        let added = 0;
        for (const h of newHeights) added += LEGACY_SHARE * rewardForHeight(h);
        legacyState.accruedBudget += added;
        legacyState.lastCheckedHeight = newHeights[newHeights.length - 1];
        saveLegacyState(legacyState);
        console.log(`ℹ️   ${newHeights.length} nowych bloków -> budżet legacy +${added.toFixed(4)} BbC (razem: ${legacyState.accruedBudget.toFixed(4)} BbC)`);
    }

    const split = storage.getUnpaidCreditsSummarySplitByCutoff(legacyState.cutoffTimestamp);
    if (split.length === 0) { console.log("Brak niewypłaconych należności."); storage.close(); return; }

    const pendingMempool = storage.loadMempool();
    const addressesWithPendingPayout = new Set(
        pendingMempool.filter((tx) => tx.from === poolAddress).map((tx) => tx.to)
    );

    // === 1) CURRENT: w całości, najmniejszy dług pierwszy - jak dotychczas ===
    const currentQueue = split
        .filter((s) => s.currentTotal > 0)
        .sort((a, b) => a.currentTotal - b.currentTotal);

    for (const { minerAddress, currentTotal, currentCount } of currentQueue) {
        if (minerAddress === poolAddress) continue;
        if (!ADDRESS_FORMAT.test(minerAddress)) {
            console.warn(`⚠️  Pomijam nieprawidłowy format adresu: "${minerAddress.slice(0, 60)}${minerAddress.length > 60 ? "..." : ""}" (current: ${currentTotal.toFixed(4)} BbC, ${currentCount} wpisów)`);
            continue;
        }
        if (currentTotal < minPayout) continue;
        if (addressesWithPendingPayout.has(minerAddress)) {
            console.log(`⏳   ${minerAddress} ma już oczekującą wypłatę, czekam (current: ${currentTotal.toFixed(4)} BbC)`);
            continue;
        }
        try {
            const result = await sendPayout(minerAddress, currentTotal);
            if (result.accepted) {
                const creditIds = storage.getUnpaidCreditIdsForAddressSince(minerAddress, legacyState.cutoffTimestamp);
                storage.markCreditsPaid(creditIds);
                console.log(`✅   [current] Wypłacono ${currentTotal.toFixed(4)} BbC dla ${minerAddress}`);
            } else {
                const reason = result.reason ?? result.error ?? JSON.stringify(result);
                console.warn(`⚠️  [current] Odrzucono (${minerAddress}, próba: ${currentTotal.toFixed(4)} BbC): ${reason}`);
                if (typeof reason === "string" && reason.includes("Niewystarczające saldo")) {
                    console.log("💤   [current] Reszta tej części jest równa lub większa - kończę, spróbuję ponownie za chwilę.");
                    break;
                }
            }
        } catch (err) { console.error(`❌   [current] ${err.message}`); }
        await sleep(DELAY_BETWEEN_SENDS_MS);
    }

    // === 2) LEGACY: częściowo, z budżetu, tylko najmniejszy dług na raz ===
    if (legacyState.accruedBudget >= MIN_LEGACY_PAYOUT) {
        const legacyQueue = split
            .filter((s) => s.legacyTotal > 0)
            .sort((a, b) => a.legacyTotal - b.legacyTotal);

        const target = legacyQueue[0];
        if (target && ADDRESS_FORMAT.test(target.minerAddress) && !addressesWithPendingPayout.has(target.minerAddress)) {
            const { creditIds, amount } = storage.getUnpaidLegacyCreditIdsUpToAmount(
                target.minerAddress, legacyState.cutoffTimestamp, legacyState.accruedBudget
            );
            if (amount > 0) {
                try {
                    const result = await sendPayout(target.minerAddress, amount);
                    if (result.accepted) {
                        storage.markCreditsPaid(creditIds);
                        legacyState.accruedBudget -= amount;
                        saveLegacyState(legacyState);
                        console.log(`✅   [legacy] Wypłacono ${amount.toFixed(4)} BbC dla ${target.minerAddress} (zostało z długu legacy tego adresu: ${(target.legacyTotal - amount).toFixed(4)} BbC, budżet: ${legacyState.accruedBudget.toFixed(4)} BbC)`);
                    } else {
                        const reason = result.reason ?? result.error ?? JSON.stringify(result);
                        console.warn(`⚠️  [legacy] Odrzucono (${target.minerAddress}, próba: ${amount.toFixed(4)} BbC): ${reason}`);
                    }
                } catch (err) { console.error(`❌   [legacy] ${err.message}`); }
            }
        }
    }

    storage.close();
}

if (require.main === module) {
    const privateKeyPath = process.argv[2];
    const serverUrl = process.argv[3] || `http://localhost:${CONFIG.API_PORT}`;
    const minPayoutArg = process.argv[4];
    let minPayout = 1;
    if (minPayoutArg !== undefined) {
        const parsed = Number(minPayoutArg);
        minPayout = Number.isNaN(parsed) ? 1 : parsed;
    }
    if (!privateKeyPath) { console.error("Użycie: node payout.js <klucz_puli.pem> [url] [min_wyplata]"); process.exit(1); }
    main(privateKeyPath, serverUrl, minPayout).catch((err) => { console.error("❌  ", err); process.exit(1); });
}

module.exports = { main };