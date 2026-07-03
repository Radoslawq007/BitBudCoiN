const crypto = require("crypto");
const CONFIG = require("./config");
const Storage = require("./storage");

// Maksymalna wartość 256-bitowego hasha - punkt odniesienia dla trudności/targetu
const MAX_TARGET = (1n << 256n) - 1n;

// Zamienia liczbę trudności na 64-znakowy hex target, do którego porównujemy hash.
// Im WYŻSZA trudność, tym MNIEJSZY target, tym trudniej go "trafić".
function difficultyToTargetHex(difficulty) {
    const safeDifficulty = BigInt(Math.max(1, Math.round(difficulty)));
    const target = MAX_TARGET / safeDifficulty;
    return target.toString(16).padStart(64, "0");
}

/**
 * Pojedynczy blok w łańcuchu. Zamiast pojedynczego "minerAddress" trzyma listę
 * transakcji - blok genesis niesie premine, każdy kolejny blok niesie transakcję
 * coinbase (nagrodę dla górnika).
 */
class Block {
    constructor({ height, timestamp, previousHash, transactions, difficulty }) {
        this.height = height;
        this.timestamp = timestamp;
        this.previousHash = previousHash;
        this.transactions = transactions;
        this.difficulty = difficulty;
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
                    JSON.stringify(this.transactions) +
                    this.difficulty +
                    this.nonce
            )
            .digest("hex");
    }

    // Proof-of-work: szukamy hasha <= target (porównanie stringów działa poprawnie,
    // bo digest("hex") zawsze zwraca 64-znakowy string z wiodącymi zerami)
    mine(targetHex) {
        while (this.hash > targetHex) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        return this.hash;
    }

    // Odtwarza blok 1:1 z rekordu bazy danych (gotowy nonce/hash, bez ponownego
    // kopania). Zachowuje prototyp Block, więc calculateHash()/mine() nadal działają.
    static fromRecord({ height, timestamp, previousHash, transactions, difficulty, nonce, hash }) {
        const block = Object.create(Block.prototype);
        block.height = height;
        block.timestamp = timestamp;
        block.previousHash = previousHash;
        block.transactions = transactions;
        block.difficulty = difficulty;
        block.nonce = nonce;
        block.hash = hash;
        return block;
    }
}

/**
 * Łańcuch bloków: premine z configu, halving nagrody, pułap podaży,
 * trudność jako ciągła liczba z okresowym retargetingiem (nie co blok!).
 */
class Blockchain {
    constructor(dbPath = CONFIG.DATABASE) {
        this.storage = new Storage(dbPath);

        if (this.storage.hasBlocks()) {
            // Łańcuch już istnieje na dysku - wczytujemy go 1:1, genesis traktujemy
            // jako historyczny fakt (nie przeliczamy go na nowo z aktualnego configu,
            // bo config mógł się zmienić już po utworzeniu łańcucha)
            this.chain = this.storage.loadChain().map((record) => Block.fromRecord(record));
            this.difficulty = this.getLatestBlock().difficulty;
            this.actualPremine = this.chain[0].transactions.reduce((sum, tx) => sum + tx.amount, 0);

            console.log(
                `📦 Wczytano istniejący łańcuch z "${dbPath}" - ${this.chain.length} bloków, ` +
                    `wysokość ${this.getLatestBlock().height}`
            );
        } else {
            // Świeża baza - budujemy genesis z configu i od razu go zapisujemy
            this.difficulty = Math.pow(16, CONFIG.DIFFICULTY);
            this.actualPremine = (CONFIG.GENESIS_TRANSACTIONS || []).reduce(
                (sum, tx) => sum + tx.amount,
                0
            );
            if (this.actualPremine !== CONFIG.PREMINE) {
                console.warn(
                    `⚠️  PREMINE w config.js (${CONFIG.PREMINE}) nie zgadza się z sumą ` +
                        `GENESIS_TRANSACTIONS (${this.actualPremine}). Traktuję sumę transakcji ` +
                        `jako faktyczny premine - zaktualizuj config albo listę transakcji.`
                );
            }

            const genesis = this.createGenesisBlock();
            this.chain = [genesis];
            this.storage.saveBlock(genesis);

            console.log(`🌱 Nowy łańcuch - zapisano genesis blok do "${dbPath}"`);
        }
    }

    createGenesisBlock() {
        const transactions = (CONFIG.GENESIS_TRANSACTIONS || []).map((tx) => ({
            from: CONFIG.GENESIS_ADDRESS,
            to: tx.to,
            amount: tx.amount,
            type: "genesis"
        }));

        return new Block({
            height: 0,
            timestamp: Date.now(),
            previousHash: "0".repeat(64),
            transactions,
            difficulty: this.difficulty
        });
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    // Nagroda za dany blok po uwzględnieniu halvingu i pułapu MAX_SUPPLY
    getRewardForHeight(height) {
        const halvings = Math.floor(height / CONFIG.HALVING_INTERVAL);
        const rawReward = CONFIG.BLOCK_REWARD / Math.pow(2, halvings);

        const remaining = CONFIG.MAX_SUPPLY - this.getCirculatingSupply();
        if (remaining <= 0) return 0;

        return Math.min(rawReward, remaining);
    }

    getCirculatingSupply() {
        let total = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                total += tx.amount;
            }
        }
        return total;
    }

    // Kopanie nowego bloku. Zwraca Promise, żeby dało się wywołać z `await`.
    // UWAGA: przy CONFIG.BLOCK_TIME rzędu minut i uczciwym retargetingu, kopanie
    // synchroniczne w handlerze requestu potrafi zablokować event loop na długo -
    // patrz komentarz przy maybeRetarget().
    async createNewBlock(minerAddress) {
        if (!minerAddress) {
            throw new Error("Brak adresu górnika");
        }

        const previousBlock = this.getLatestBlock();
        const height = previousBlock.height + 1;
        const reward = this.getRewardForHeight(height);

        const transactions = [
            { from: null, to: minerAddress, amount: reward, type: "coinbase" }
        ];

        const newBlock = new Block({
            height,
            timestamp: Date.now(),
            previousHash: previousBlock.hash,
            transactions,
            difficulty: this.difficulty
        });

        newBlock.mine(difficultyToTargetHex(this.difficulty));
        this.chain.push(newBlock);
        this.storage.saveBlock(newBlock);
        this.maybeRetarget();

        // wygodne skróty używane też przez server.js
        newBlock.reward = reward;
        newBlock.minerAddress = minerAddress;

        return newBlock;
    }

    // Retarguje trudność co CONFIG.DIFFICULTY_ADJUSTMENT bloków (nie co blok!),
    // na podstawie realnego czasu ostatniego okresu względem BLOCK_TIME.
    // Zmiana ograniczona do max 4x w górę / 4x w dół na raz (tak jak w Bitcoinie),
    // żeby jedno odchylenie nie wywindowało trudności do poziomu blokującego serwer.
    maybeRetarget() {
        const period = CONFIG.DIFFICULTY_ADJUSTMENT;
        const latest = this.getLatestBlock();
        if (latest.height === 0 || latest.height % period !== 0) return;

        const periodStart = this.chain[this.chain.length - 1 - period];
        if (!periodStart) return;

        const actualMs = latest.timestamp - periodStart.timestamp;
        const expectedMs = period * CONFIG.BLOCK_TIME * 1000;

        const ratio = Math.max(0.25, Math.min(4, expectedMs / actualMs));
        this.difficulty = Math.max(1, this.difficulty * ratio);
    }

    isChainValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const current = this.chain[i];
            const previous = this.chain[i - 1];

            if (current.previousHash !== previous.hash) return false;
            if (current.hash !== current.calculateHash()) return false;
            if (current.hash > difficultyToTargetHex(current.difficulty)) return false;
        }
        return true;
    }

    // Saldo liczone z transakcji: genesis/coinbase tylko dopisują, "transfer"
    // (gdy powstanie mempool) będzie też odejmować z adresu nadawcy
    getBalance(address) {
        let balance = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.to === address) balance += tx.amount;
                if (tx.type === "transfer" && tx.from === address) balance -= tx.amount;
            }
        }
        return balance;
    }

    getChain() {
        return this.chain;
    }

    // Bezpiecznie zamyka połączenie z bazą - wołać przy zamykaniu serwera (SIGINT/SIGTERM)
    close() {
        this.storage.close();
    }

    getInfo() {
        const latest = this.getLatestBlock();
        const period = CONFIG.DIFFICULTY_ADJUSTMENT;

        return {
            network: CONFIG.NETWORK_NAME,
            symbol: CONFIG.SYMBOL,
            version: CONFIG.VERSION,
            chainId: CONFIG.CHAIN_ID,
            height: latest.height,
            latestHash: latest.hash,
            difficulty: Math.round(this.difficulty),
            difficultyLeadingZerosApprox: Number((Math.log2(this.difficulty) / 4).toFixed(2)),
            totalBlocks: this.chain.length,
            currentBlockReward: this.getRewardForHeight(latest.height + 1),
            circulatingSupply: this.getCirculatingSupply(),
            maxSupply: CONFIG.MAX_SUPPLY,
            premine: this.actualPremine,
            blocksUntilHalving: CONFIG.HALVING_INTERVAL - (latest.height % CONFIG.HALVING_INTERVAL),
            blocksUntilRetarget: period - (latest.height % period),
            isValid: this.isChainValid()
        };
    }
}

module.exports = Blockchain;
module.exports.Block = Block;
module.exports.difficultyToTargetHex = difficultyToTargetHex;
