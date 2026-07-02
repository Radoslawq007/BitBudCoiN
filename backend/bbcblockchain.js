const crypto = require("crypto");
const CONFIG = require("./config");

/**
 * Pojedynczy blok w łańcuchu.
 */
class Block {
    constructor(height, timestamp, previousHash, minerAddress, difficulty) {
        this.height = height;
        this.timestamp = timestamp;
        this.previousHash = previousHash;
        this.minerAddress = minerAddress;
        this.difficulty = difficulty;
        this.reward = CONFIG.BLOCK_REWARD;
        this.nonce = 0;
        this.hash = this.calculateHash();
    }

    calculateHash() {
        return crypto
            .createHash("sha256")
            .update(
                this.height +
                    this.previousHash +
                    this.timestamp +
                    this.minerAddress +
                    this.difficulty +
                    this.nonce
            )
            .digest("hex");
    }

    // Proof-of-work: szukamy hasha zaczynającego się od `difficulty` zer
    mine() {
        const target = "0".repeat(this.difficulty);
        while (this.hash.substring(0, this.difficulty) !== target) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        return this.hash;
    }
}

/**
 * Łańcuch bloków wraz z logiką kopania i walidacji.
 */
class Blockchain {
    constructor() {
        this.chain = [this.createGenesisBlock()];
    }

    createGenesisBlock() {
        const genesis = new Block(0, Date.now(), "0".repeat(64), "genesis", CONFIG.DIFFICULTY);
        genesis.hash = genesis.calculateHash();
        return genesis;
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    // Kopanie nowego bloku. Zwraca Promise, żeby dało się wywołać z `await`
    // (docelowo tę pętlę można przenieść do worker threada, by nie blokować event loopa
    // przy wyższej trudności)
    async createNewBlock(minerAddress) {
        if (!minerAddress) {
            throw new Error("Brak adresu górnika");
        }

        const previousBlock = this.getLatestBlock();
        const newBlock = new Block(
            previousBlock.height + 1,
            Date.now(),
            previousBlock.hash,
            minerAddress,
            CONFIG.DIFFICULTY
        );

        newBlock.mine();
        this.chain.push(newBlock);

        return newBlock;
    }

    isChainValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const current = this.chain[i];
            const previous = this.chain[i - 1];

            if (current.previousHash !== previous.hash) return false;
            if (current.hash !== current.calculateHash()) return false;
        }
        return true;
    }

    // Suma nagród wykopanych przez dany adres
    getBalance(address) {
        return this.chain
            .filter((block) => block.minerAddress === address)
            .reduce((sum, block) => sum + block.reward, 0);
    }

    getChain() {
        return this.chain;
    }

    getInfo() {
        const latest = this.getLatestBlock();
        return {
            height: latest.height,
            latestHash: latest.hash,
            difficulty: CONFIG.DIFFICULTY,
            totalBlocks: this.chain.length,
            totalSupply: this.chain.length * CONFIG.BLOCK_REWARD,
            blockReward: CONFIG.BLOCK_REWARD,
            isValid: this.isChainValid()
        };
    }
}

module.exports = Blockchain;
module.exports.Block = Block;
