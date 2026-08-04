const crypto = require("crypto");
const CONFIG = require("./config");
const Storage = require("./storage");

const MAX_TARGET = (1n << 256n) - 1n;
const GENESIS_TIMESTAMP = Date.UTC(2026, 0, 1);

// Opłata protokołu - usztywniona w kodzie, nie w configu (patrz poprzednia
// zmiana). Bez ruszania tego dzisiaj.
const PROJECT_FEE_PERCENT = 0.005;

// Docelowy czas bloku - 8 minut, potwierdzone przez usera. Tak jak
// PROJECT_FEE_PERCENT powyżej - celowo NIE w config.js (którego prawdziwej,
// żywej treści nigdy nie widziałem w tej sesji - nie zgaduję nowego pola,
// które może tam nie istnieć). Jeśli kiedyś ma się to zmienić, zmienia się
// tutaj, jawnie, w jednym miejscu.
const TARGET_BLOCK_TIME_MS = 8 * 60 * 1000;
// Maksymalna zmiana trudności na JEDNO przeliczenie - w górę albo w dół.
// Zapobiega temu, żeby jeden nietypowy okres (albo ktoś próbujący
// manipulować czasem) wywrócił trudność w jednym skoku.
const MAX_RETARGET_FACTOR = 4;

function difficultyToTargetHex(difficulty) {
    const safe = BigInt(Math.max(1, Math.round(difficulty)));
    return (MAX_TARGET / safe).toString(16).padStart(64, "0");
}

function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
    return crypto.createHash("sha256")
        .update(height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce)
        .digest("hex");
}

function sha256Hex(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}

class Block {
    constructor({ height, timestamp, previousHash, transactions, difficulty, nonce = 0 }) {
        Object.assign(this, { height, timestamp, previousHash, transactions, difficulty, nonce });
        this.hash = this.calculateHash();
    }
    calculateHash() { return computeBlockHash(this); }
    mine(targetHex) {
        while (this.hash > targetHex) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        return this.hash;
    }
}

function isProjectFeeActive(height) {
    return !!(CONFIG.PROJECT_FEE_ADDRESS &&
        CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT !== undefined &&
        height >= CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT);
}

class Blockchain {
    constructor() {
        this.storage = new Storage(CONFIG.DATABASE);
        if (this.storage.hasBlocks()) {
            this.chain = this.storage.loadChain();
            this.difficulty = this.chain[this.chain.length - 1].difficulty;
            // Bezpiecznik przejściowy: w razie gdyby najnowszy blok w
            // łańcuchu jeszcze nie niósł ostatniej ręcznej korekty (03.08.2026,
            // moc sieci spadła) - dolna granica, żeby restart nie cofnął
            // trudności do starej wartości. Algorytm przeliczania (patrz
            // retargetIfDue) i tak przejmie naturalnie od pierwszego okna.
            if (this.difficulty < 178713018037) this.difficulty = 178713018037;
        } else {
            this.difficulty = Math.pow(16, CONFIG.DIFFICULTY);
            const transactions = CONFIG.GENESIS_TRANSACTIONS.map((tx) => ({
                from: CONFIG.GENESIS_ADDRESS, to: tx.to, amount: tx.amount, type: "genesis"
            }));
            const genesis = new Block({
                height: 0, timestamp: GENESIS_TIMESTAMP, previousHash: "0".repeat(64),
                transactions, difficulty: this.difficulty
            });
            this.chain = [genesis];
            this.storage.saveBlock(genesis);
        }
    }

    getLatestBlock() { return this.chain[this.chain.length - 1]; }

    getRewardForHeight(height) {
        return CONFIG.BLOCK_REWARD / Math.pow(2, Math.floor(height / CONFIG.HALVING_INTERVAL));
    }

    // Buduje listę transakcji do nowego bloku. HTLC_CREATE/CLAIM/REFUND
    // ZACHOWUJĄ swój prawdziwy typ i pola (poprzednio WSZYSTKO trafiało jako
    // "transfer", gubiąc htlcId/hashLock/claimant/itd. - to była realna luka,
    // przez którą /htlc/submit nie miałby jak w ogóle zadziałać, nawet gdyby
    // istniał).
    buildBlockTransactions(rewardRecipient, pendingTransactions = []) {
        const height = this.getLatestBlock().height + 1;
        const reward = this.getRewardForHeight(height);
        const transactions = [{ from: null, to: rewardRecipient, amount: reward, type: "coinbase" }];
        const feeActive = isProjectFeeActive(height);

        let totalMinerFees = 0;
        let totalProtocolCut = 0;
        for (const tx of pendingTransactions) {
            if (tx.type === "HTLC_CREATE") {
                transactions.push({
                    htlcId: tx.htlcId, from: tx.from, to: tx.claimant, amount: tx.amount, fee: tx.fee,
                    hashLock: tx.hashLock, timeoutHeight: tx.timeoutHeight,
                    claimant: tx.claimant, refundee: tx.refundee,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_CREATE"
                });
                totalMinerFees += (tx.fee || 0);
                if (feeActive) totalProtocolCut += tx.amount * PROJECT_FEE_PERCENT;
            } else if (tx.type === "HTLC_CLAIM") {
                // tx.to/tx.amount dopisane PRZEZ server.js z wyniku
                // validateHTLCClaim() PRZED trafieniem do mempoola - sam
                // podpisany payload (z portfela) tego nie zawiera.
                transactions.push({
                    htlcId: tx.htlcId, claimant: tx.claimant, secret: tx.secret,
                    to: tx.to, amount: tx.amount,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_CLAIM"
                });
            } else if (tx.type === "HTLC_REFUND") {
                transactions.push({
                    htlcId: tx.htlcId, refundee: tx.refundee,
                    to: tx.to, amount: tx.amount,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_REFUND"
                });
            } else {
                transactions.push({
                    from: tx.from, to: tx.to, amount: tx.amount, fee: tx.fee,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature, type: "transfer"
                });
                totalMinerFees += (tx.fee || 0);
                if (feeActive) totalProtocolCut += tx.amount * PROJECT_FEE_PERCENT;
            }
        }

        if (totalMinerFees > 0 && CONFIG.PROJECT_FEE_ADDRESS) {
            transactions.push({ from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: totalMinerFees, type: "fee" });
        }
        if (totalProtocolCut > 0) {
            transactions.push({ from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: totalProtocolCut, type: "protocol_fee" });
        }
        return transactions;
    }

    receiveBlock(candidate) {
        const latest = this.getLatestBlock();
        if (candidate.height !== latest.height + 1) return { accepted: false, reason: "wysokość nie pasuje" };
        if (candidate.previousHash !== latest.hash) return { accepted: false, reason: "previousHash nie pasuje" };
        if (computeBlockHash(candidate) !== candidate.hash) return { accepted: false, reason: "hash się nie zgadza" };
        if (candidate.hash > difficultyToTargetHex(this.difficulty)) return { accepted: false, reason: "nie spełnia trudności" };
        this.chain.push(candidate);
        this.storage.saveBlock(candidate);
        this.retargetIfDue(candidate);
        return { accepted: true, block: candidate };
    }

    // Wywoływane PO przyjęciu każdego bloku. Jeśli właśnie przyjęty blok
    // kończy okno przeliczania (jego wysokość jest wielokrotnością
    // CONFIG.DIFFICULTY_ADJUSTMENT), porównuje jak długo NAPRAWDĘ zajęło
    // wykopanie tych bloków względem tego, ile powinno (przy
    // TARGET_BLOCK_TIME_MS) - i proporcjonalnie dostosowuje this.difficulty
    // dla WSZYSTKICH kolejnych bloków. Blok #0 (genesis) nigdy nie wyzwala
    // przeliczenia - nie ma go z czym porównać.
    retargetIfDue(justAccepted) {
        const interval = CONFIG.DIFFICULTY_ADJUSTMENT;
        if (justAccepted.height === 0 || justAccepted.height % interval !== 0) return;

        const windowStart = this.chain.find((b) => b.height === justAccepted.height - interval);
        if (!windowStart) return; // za mało historii (np. tuż po starcie sieci) - nic nie rusza

        const actualSpanMs = justAccepted.timestamp - windowStart.timestamp;
        if (actualSpanMs <= 0) return; // zegar się cofnął albo dane są bez sensu - nie ufaj temu, pomiń

        const expectedSpanMs = interval * TARGET_BLOCK_TIME_MS;
        let factor = expectedSpanMs / actualSpanMs;
        factor = Math.min(MAX_RETARGET_FACTOR, Math.max(1 / MAX_RETARGET_FACTOR, factor));

        const oldDifficulty = this.difficulty;
        this.difficulty = Math.max(1, Math.round(oldDifficulty * factor));

        console.log(`🎯 Przeliczenie trudności przy bloku #${justAccepted.height}: ${oldDifficulty} → ${this.difficulty} (współczynnik ${factor.toFixed(3)}, rzeczywisty czas okna: ${(actualSpanMs / 60000).toFixed(1)} min, oczekiwany: ${(expectedSpanMs / 60000).toFixed(1)} min)`);
    }

    getChain() { return this.chain; }

    getRecentBlocks(limit = 20, beforeHeight = null) {
        let blocks = this.chain.slice().reverse();
        if (beforeHeight !== null) blocks = blocks.filter((b) => b.height < beforeHeight);
        return blocks.slice(0, limit);
    }

    // ============ HTLC (Hash Time-Locked Contracts) ============
    findHTLC(htlcId) {
        let created = null;
        let resolvedStatus = null;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "HTLC_CREATE" && tx.htlcId === htlcId) {
                    created = { ...tx, createdAtHeight: block.height };
                }
                if (tx.type === "HTLC_CLAIM" && tx.htlcId === htlcId) resolvedStatus = "claimed";
                if (tx.type === "HTLC_REFUND" && tx.htlcId === htlcId) resolvedStatus = "refunded";
            }
        }
        if (!created) return null;
        return { ...created, status: resolvedStatus || "locked" };
    }

    validateHTLCClaim({ htlcId, secret, claimant }) {
        const htlc = this.findHTLC(htlcId);
        if (!htlc) return { valid: false, reason: "HTLC nie istnieje" };
        if (htlc.status !== "locked") return { valid: false, reason: `HTLC ma status "${htlc.status}", nie można odebrać` };
        if (claimant !== htlc.claimant) return { valid: false, reason: "tylko wyznaczony odbiorca może odebrać" };
        const nextHeight = this.getLatestBlock().height + 1;
        if (nextHeight >= htlc.timeoutHeight) return { valid: false, reason: "termin już minął, odbiór niemożliwy - tylko zwrot" };
        if (sha256Hex(secret) !== htlc.hashLock) return { valid: false, reason: "zły sekret - hash się nie zgadza" };
        return { valid: true, amount: htlc.amount, to: htlc.claimant };
    }

    validateHTLCRefund({ htlcId, refundee }) {
        const htlc = this.findHTLC(htlcId);
        if (!htlc) return { valid: false, reason: "HTLC nie istnieje" };
        if (htlc.status !== "locked") return { valid: false, reason: `HTLC ma status "${htlc.status}", nie można zwrócić` };
        if (refundee !== htlc.refundee) return { valid: false, reason: "tylko oryginalny nadawca może dostać zwrot" };
        const nextHeight = this.getLatestBlock().height + 1;
        if (nextHeight < htlc.timeoutHeight) return { valid: false, reason: `termin jeszcze nie minął (blok ${nextHeight} < ${htlc.timeoutHeight})` };
        return { valid: true, amount: htlc.amount, to: htlc.refundee };
    }

    getBalance(address) {
        let balance = 0;
        for (const block of this.chain) {
            const feeActive = isProjectFeeActive(block.height);
            for (const tx of block.transactions) {
                if (tx.type === "transfer" && tx.to === address) {
                    balance += feeActive ? tx.amount * (1 - PROJECT_FEE_PERCENT) : tx.amount;
                } else if (tx.type === "transfer" && tx.from === address) {
                    balance -= (tx.amount + (tx.fee || 0));
                } else if (tx.type === "HTLC_CREATE" && tx.from === address) {
                    balance -= (tx.amount + (tx.fee || 0));
                } else if (tx.type === "HTLC_CLAIM" && tx.to === address) {
                    balance += tx.amount;
                } else if (tx.type === "HTLC_REFUND" && tx.to === address) {
                    balance += tx.amount;
                } else if (tx.to === address && tx.type !== "HTLC_CREATE") {
                    // Ta sama poprawka co w getAddressStats - HTLC_CREATE ma
                    // teraz "to" (=claimant) dla samego zapisu do bazy, ale
                    // środki są zablokowane, nie odebrane - to wykluczenie
                    // zapobiega przedwczesnemu doliczeniu ich do salda.
                    balance += tx.amount;
                }
            }
        }
        return balance;
    }

    getSoloMiners() {
        const seen = new Map();
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "coinbase" && tx.to !== CONFIG.POOL_ADDRESS) {
                    const existing = seen.get(tx.to) || { address: tx.to, totalEarned: 0, blocksFound: 0, lastBlockHeight: 0 };
                    existing.totalEarned += tx.amount;
                    existing.blocksFound += 1;
                    existing.lastBlockHeight = Math.max(existing.lastBlockHeight, block.height);
                    seen.set(tx.to, existing);
                }
            }
        }
        return Array.from(seen.values()).sort((a, b) => b.lastBlockHeight - a.lastBlockHeight);
    }

    getAddressStats(whaleLimit = 10, newestLimit = 10) {
        const balances = new Map();
        const firstSeen = new Map();

        for (const block of this.chain) {
            const feeActive = isProjectFeeActive(block.height);
            for (const tx of block.transactions) {
                if (tx.type === "transfer" && tx.to) {
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    const credited = feeActive ? tx.amount * (1 - PROJECT_FEE_PERCENT) : tx.amount;
                    balances.set(tx.to, (balances.get(tx.to) || 0) + credited);
                } else if (tx.type === "HTLC_CLAIM" && tx.to) {
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                } else if (tx.type === "HTLC_REFUND" && tx.to) {
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                } else if (tx.to && tx.type !== "HTLC_CREATE") {
                    // HTLC_CREATE MA teraz pole "to" (=claimant, dodane żeby
                    // zapis do bazy działał - patrz buildBlockTransactions),
                    // ale środki są ZABLOKOWANE, nie odebrane - to jawne
                    // wykluczenie zapobiega przedwczesnemu doliczeniu ich do
                    // salda claimanta zanim faktycznie odbierze (HTLC_CLAIM).
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                }

                if (tx.type === "transfer" && tx.from) {
                    if (!firstSeen.has(tx.from)) firstSeen.set(tx.from, block.height);
                    balances.set(tx.from, (balances.get(tx.from) || 0) - (tx.amount + (tx.fee || 0)));
                } else if (tx.type === "HTLC_CREATE" && tx.from) {
                    if (!firstSeen.has(tx.from)) firstSeen.set(tx.from, block.height);
                    balances.set(tx.from, (balances.get(tx.from) || 0) - (tx.amount + (tx.fee || 0)));
                }
            }
        }

        const addresses = Array.from(balances.keys());
        const whales = addresses
            .map((address) => ({ address, balance: balances.get(address) }))
            .sort((a, b) => b.balance - a.balance)
            .slice(0, whaleLimit);
        const newest = addresses
            .map((address) => ({ address, firstSeenHeight: firstSeen.get(address) }))
            .sort((a, b) => b.firstSeenHeight - a.firstSeenHeight)
            .slice(0, newestLimit);

        return { totalAddresses: addresses.length, whales, newest };
    }

    saveCredit(credit) {
        this.storage.saveCredit(credit);
    }

    getTransactionsForAddress(address) {
        const results = [];
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.to === address || tx.from === address) {
                    results.push({ ...tx, blockHeight: block.height });
                }
            }
        }
        return results.reverse();
    }

    getInfo() {
        const latest = this.getLatestBlock();
        const height = latest.height;
        let circulatingSupply = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "coinbase" || tx.type === "genesis") circulatingSupply += tx.amount;
            }
        }
        return {
            network: CONFIG.NETWORK_NAME, symbol: CONFIG.SYMBOL, version: CONFIG.VERSION,
            chainId: CONFIG.CHAIN_ID, height, latestHash: latest.hash,
            difficulty: Math.round(this.difficulty),
            difficultyLeadingZerosApprox: Math.floor(Math.log(this.difficulty) / Math.log(16)),
            totalBlocks: this.chain.length, currentBlockReward: this.getRewardForHeight(height + 1),
            circulatingSupply, maxSupply: CONFIG.MAX_SUPPLY, premine: CONFIG.PREMINE,
            blocksUntilHalving: CONFIG.HALVING_INTERVAL - (height % CONFIG.HALVING_INTERVAL),
            blocksUntilRetarget: CONFIG.DIFFICULTY_ADJUSTMENT - (height % CONFIG.DIFFICULTY_ADJUSTMENT),
            isValid: true
        };
    }

    // Typy transakcji, które oznaczają CZYJEŚ świadome działanie - nie coś,
    // co dzieje się samo z siebie (coinbase = nagroda za sam fakt kopania,
    // fee/protocol_fee = automatyczne rozliczenie, genesis = jednorazowy
    // premine). Bez tego rozróżnienia jedna aktywna pula potrafi wygenerować
    // tysiące "zdarzeń" dziennie, mimo że stoi za nią jedna osoba.
    static GENUINE_ACTIVITY_TYPES = new Set(["transfer", "HTLC_CREATE", "HTLC_CLAIM", "HTLC_REFUND"]);

    // Adresy z PRAWDZIWĄ aktywnością w ostatnim oknie czasowym (domyślnie
    // 24h) - nie licząc automatycznych nagród za kopanie.
    getActiveAddresses(windowMs = 24 * 60 * 60 * 1000) {
        const cutoff = Date.now() - windowMs;
        const events = new Map();
        for (let i = this.chain.length - 1; i >= 0; i--) {
            const block = this.chain[i];
            if (block.timestamp < cutoff) break;
            for (const tx of block.transactions) {
                if (!Blockchain.GENUINE_ACTIVITY_TYPES.has(tx.type)) continue;
                if (tx.from) events.set(tx.from, (events.get(tx.from) || 0) + 1);
                if (tx.to) events.set(tx.to, (events.get(tx.to) || 0) + 1);
            }
        }
        const top = Array.from(events.entries())
            .map(([address, count]) => ({ address, events: count }))
            .sort((a, b) => b.events - a.events)
            .slice(0, 10);
        return { totalActive: events.size, top };
    }

    // Ile adresów pojawiło się PIERWSZY RAZ w prawdziwej (nie-automatycznej)
    // transakcji, per dzień, w ostatnich `days` dniach. Ktoś kto tylko
    // wykopał blok i nigdy niczego nie wysłał/nie zrobił swapu nie liczy się
    // tutaj jako "nowy" - to celowe, licznik ma pokazywać ludzi, nie górników.
    getNewAddressesPerDay(days = 7) {
        const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
        const firstSeenDay = new Map();
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (!Blockchain.GENUINE_ACTIVITY_TYPES.has(tx.type)) continue;
                for (const addr of [tx.from, tx.to]) {
                    if (addr && !firstSeenDay.has(addr)) firstSeenDay.set(addr, dayKey(block.timestamp));
                }
            }
        }
        const counts = new Map();
        for (const day of firstSeenDay.values()) counts.set(day, (counts.get(day) || 0) + 1);

        const result = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
            const key = d.toISOString().slice(0, 10);
            result.push({ date: key, newAddresses: counts.get(key) || 0 });
        }
        return result;
    }

    close() { this.storage.close(); }
}

module.exports = Blockchain;
module.exports.difficultyToTargetHex = difficultyToTargetHex;
module.exports.computeBlockHash = computeBlockHash;
module.exports.sha256Hex = sha256Hex;
