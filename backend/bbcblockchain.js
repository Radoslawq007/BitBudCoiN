const crypto = require("crypto");
const CONFIG = require("./config");
const Storage = require("./storage");
const MAX_TARGET = (1n << 256n) - 1n;
const GENESIS_TIMESTAMP = Date.UTC(2026, 0, 1);
// Opłata protokołu - usztywniona w kodzie, nie w configu (patrz poprzednia
// zmiana). Bez ruszania tego dzisiaj.
const PROJECT_FEE_PERCENT = 0.005;
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
        // BEZPIECZEŃSTWO (31.07.2026): trudność NIGDY nie jest wczytywana z
        // zapisanych bloków - to pole może być sfałszowane przez tego, kto
        // zgłasza blok (patrz poprawka w receiveBlock() niżej - realny
        // incydent, nie teoria: ktoś zgłaszał bloki z zaniżoną trudnością,
        // ~550x szybciej niż powinno wychodzić). W tym kodzie nie ma
        // mechanizmu przeliczania trudności (retarget), więc prawdziwa
        // trudność zawsze i tak pochodzi z tej samej stałej co przy
        // genesis - czytanie jej z łańcucha nie miało żadnej przewagi,
        // tylko otwierało furtkę: fałszywie niska wartość przemycona raz
        // mogłaby się utrwalić na stałe dla całej sieci przy restarcie.
        this.difficulty = Math.pow(16, CONFIG.DIFFICULTY);
        if (this.storage.hasBlocks()) {
            this.chain = this.storage.loadChain();
        } else {
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
        // BEZPIECZEŃSTWO (31.07.2026): candidate.difficulty pochodzi od tego,
        // kto ZGŁASZA blok - bez tego sprawdzenia dało się wpisać dowolnie
        // niską wartość, robiąc próg trudności absurdalnie łatwym, mimo że
        // /info dalej pokazywałoby prawdziwą, wysoką trudność sieci. Realny
        // incydent 31.07.2026 (~550x przyspieszenie kopania), nie teoria.
        if (candidate.difficulty !== this.difficulty) {
            return { accepted: false, reason: `nieprawidłowa trudność (oczekiwano ${this.difficulty}, otrzymano ${candidate.difficulty})` };
        }
        if (candidate.hash > difficultyToTargetHex(candidate.difficulty)) return { accepted: false, reason: "nie spełnia trudności" };
        this.chain.push(candidate);
        this.storage.saveBlock(candidate);
        return { accepted: true, block: candidate };
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
    close() { this.storage.close(); }
}
module.exports = Blockchain;
module.exports.difficultyToTargetHex = difficultyToTargetHex;
module.exports.computeBlockHash = computeBlockHash;
module.exports.sha256Hex = sha256Hex;
