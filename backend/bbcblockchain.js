const crypto = require("crypto");
const CONFIG = require("./config");
const Storage = require("./storage");

const MAX_TARGET = (1n << 256n) - 1n;
const GENESIS_TIMESTAMP = Date.UTC(2026, 0, 1);

function difficultyToTargetHex(difficulty) {
    const safe = BigInt(Math.max(1, Math.round(difficulty)));
    return (MAX_TARGET / safe).toString(16).padStart(64, "0");
}

function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
    return crypto.createHash("sha256")
        .update(height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce)
        .digest("hex");
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

class Blockchain {
    constructor() {
        this.storage = new Storage(CONFIG.DATABASE);
        if (this.storage.hasBlocks()) {
            this.chain = this.storage.loadChain();
            this.difficulty = this.chain[this.chain.length - 1].difficulty;
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

    buildBlockTransactions(rewardRecipient, pendingTransactions = []) {
        const height = this.getLatestBlock().height + 1;
        const reward = this.getRewardForHeight(height);
        const transactions = [{ from: null, to: rewardRecipient, amount: reward, type: "coinbase" }];
        let totalFees = 0;
        for (const tx of pendingTransactions) {
            transactions.push({
                from: tx.from, to: tx.to, amount: tx.amount, fee: tx.fee,
                timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature, type: "transfer"
            });
            totalFees += (tx.fee || 0);
        }
        // Opłaty transakcyjne trafiają do adresu projektu przy budowaniu TEGO
        // bloku - dotyczy tylko transakcji, które faktycznie w nim wylądowały.
        // Wcześniej te środki po prostu znikały (odejmowane nadawcy, nigdzie
        // nie doliczane). Nie zmienia to znaczenia żadnego starego bloku -
        // wpływa tylko na bloki wykopane od teraz.
        if (totalFees > 0 && CONFIG.PROJECT_FEE_ADDRESS) {
            transactions.push({ from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: totalFees, type: "fee" });
        }
        return transactions;
    }

    receiveBlock(candidate) {
        const latest = this.getLatestBlock();
        if (candidate.height !== latest.height + 1) return { accepted: false, reason: "wysokość nie pasuje" };
        if (candidate.previousHash !== latest.hash) return { accepted: false, reason: "previousHash nie pasuje" };
        if (computeBlockHash(candidate) !== candidate.hash) return { accepted: false, reason: "hash się nie zgadza" };
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

    getBalance(address) {
        let balance = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.to === address) balance += tx.amount;
                if (tx.type === "transfer" && tx.from === address) balance -= (tx.amount + (tx.fee || 0));
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
            for (const tx of block.transactions) {
                if (tx.to) {
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                }
                if (tx.type === "transfer" && tx.from) {
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
