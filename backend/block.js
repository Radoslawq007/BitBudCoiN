// =====================================================
// BitBudCoin Core
// block.js
// =====================================================

const crypto = require("crypto");

class Block {

    constructor(
        height,
        previousHash,
        transactions,
        difficulty,
        miner,
        reward
    ) {

        this.height = height;

        this.timestamp = Date.now();

        this.previousHash = previousHash;

        this.transactions = transactions;

        this.difficulty = difficulty;

        this.miner = miner;

        this.reward = reward;

        this.nonce = 0;

        this.hash = this.calculateHash();

    }

    // -------------------------------------
    // HASH
    // -------------------------------------

    calculateHash() {

        return crypto
            .createHash("sha256")
            .update(

                this.height +

                this.previousHash +

                this.timestamp +

                JSON.stringify(this.transactions) +

                this.difficulty +

                this.miner +

                this.reward +

                this.nonce

            )

            .digest("hex");

    }

    // -------------------------------------
    // MINE
    // -------------------------------------

    mine() {

        const target = "0".repeat(this.difficulty);

        while (!this.hash.startsWith(target)) {

            this.nonce++;

            this.hash = this.calculateHash();

        }

        return this.hash;

    }

    // -------------------------------------
    // VERIFY
    // -------------------------------------

    isValid() {

        return this.hash === this.calculateHash();

    }

}

module.exports = Block;