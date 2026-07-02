// =====================================================
// BitBudCoin Core
// bbcblockchain.js
// =====================================================

const crypto = require("crypto");
const CONFIG = require("../config");
const Block = require("./block");
const Transaction = require("./transaction");

class BBCBlockchain {
    constructor() {
        this.chain = [];
        this.difficulty = CONFIG.DIFFICULTY;
        this.blockReward = CONFIG.BLOCK_REWARD;
        this.genesisAddress = CONFIG.GENESIS_ADDRESS;

        this.createGenesisBlock();
    }

    // -----------------------------
    // GENESIS
    // -----------------------------
    createGenesisBlock() {
        const genesisTxs = CONFIG.GENESIS_TRANSACTIONS.map(
            (t) => new Transaction(CONFIG.GENESIS_ADDRESS, t.to, t.amount, 0)
        );

        const genesisBlock = new Block(
            0,
            Date.now(),
            genesisTxs,
            "0",
            this.difficulty
        );

        this.chain.push(genesisBlock);
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    getHeight() {
        return this.chain.length - 1;
    }

    // -----------------------------
    // VALIDATION
    // -----------------------------
    isValidNewBlock(newBlock, previousBlock) {
        if (previousBlock.index + 1 !== newBlock.index) return false;
        if (previousBlock.hash !== newBlock.previousHash) return false;
        if (newBlock.calculateHash() !== newBlock.hash) return false;

        const target = "0".repeat(newBlock.difficulty);
        if (!newBlock.hash.startsWith(target)) return false;

        return true;
    }

    isValidChain(chain) {
        if (chain.length === 0) return false;

        // sprawdź genesis
        const genesis = chain[0];
        if (genesis.index !== 0) return false;

        for (let i = 1; i < chain.length; i++) {
            if (!this.isValidNewBlock(chain[i], chain[i - 1])) {
                return false;
            }
        }

        return true;
    }

    replaceChain(newChain) {
        if (
            newChain.length > this.chain.length &&
            this.isValidChain(newChain)
        ) {
            console.log("[CHAIN] Replacing chain with received chain");
            this.chain = newChain;
        } else {
            console.log("[CHAIN] Received chain invalid or shorter");
        }
    }

    // -----------------------------
    // MINING
    // -----------------------------
    mineBlock(mempoolTransactions) {
        const previousBlock = this.getLatestBlock();
        const index = previousBlock.index + 1;
        const timestamp = Date.now();

        // nagroda za blok
        const coinbaseTx = new Transaction(
            null,
            this.genesisAddress,
            this.blockReward,
            0
        );

        const blockTxs = [coinbaseTx, ...mempoolTransactions];

        const newBlock = new Block(
            index,
            timestamp,
            blockTxs,
            previousBlock.hash,
            this.difficulty
        );

        newBlock.mineBlock();

        if (!this.isValidNewBlock(newBlock, previousBlock)) {
            throw new Error("Invalid mined block");
        }

        this.chain.push(newBlock);

        console.log(
            `[MINING] New block #${newBlock.index} mined: ${newBlock.hash}`
        );

        return newBlock;
    }

    // -----------------------------
    // NETWORK BLOCKS
    // -----------------------------
    addBlockFromNetwork(blockData) {
        const previousBlock = this.getLatestBlock();

        const block = new Block(
            blockData.index,
            blockData.timestamp,
            blockData.transactions,
            blockData.previousHash,
            blockData.difficulty,
            blockData.nonce
        );
        block.hash = blockData.hash; // zachowaj hash z sieci

        if (!this.isValidNewBlock(block, previousBlock)) {
            console.log("[CHAIN] Received block invalid");
            return false;
        }

        this.chain.push(block);
        console.log(`[CHAIN] Block #${block.index} added from network`);
        return true;
    }

    // -----------------------------
    // UTILS
    // -----------------------------
    getBlock(id) {
        // id może być indexem lub hashem
        const byIndex = this.chain.find((b) => b.index == id);
        if (byIndex) return byIndex;

        const byHash = this.chain.find((b) => b.hash === id);
        return byHash || null;
    }
}

module.exports = BBCBlockchain;