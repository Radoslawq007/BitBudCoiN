const CONFIG = require("./config");
const { computeBlockHash, difficultyToTargetHex } = require("./bbcblockchain");

const MAX_SEEN_SHARE_HASHES = 20000;
const VARDIFF_TARGET_SECONDS = 12;
const VARDIFF_MAX_STEP = 4;
const VARDIFF_MIN_DIFFICULTY = 16;

class MiningPool {
    constructor(blockchain, { poolAddress, poolFee, shareDifficulty, mempool } = {}) {
        this.blockchain = blockchain;
        this.mempool = mempool ?? null;
        this.poolAddress = poolAddress ?? CONFIG.POOL_ADDRESS;
        this.poolFee = poolFee ?? CONFIG.POOL_FEE;
        this.shareDifficulty = Math.pow(16, shareDifficulty ?? CONFIG.SHARE_DIFFICULTY);
        this.roundShares = new Map();
        this.seenShareHashes = new Set();
        this.minerDifficulty = new Map();
        this.minerLastShareAt = new Map();
    }
    getWork(minerAddress) {
        const latest = this.blockchain.getLatestBlock();
        const height = latest.height + 1;
        const blockDifficulty = this.blockchain.difficulty;
        const personalDifficulty = minerAddress ? this.getMinerDifficulty(minerAddress) : this.shareDifficulty;
        const pendingTxs = this.mempool ? this.mempool.selectForBlock() : [];
        const transactions = this.blockchain.buildBlockTransactions(this.poolAddress, pendingTxs);
        return { height, previousHash: latest.hash, timestamp: Date.now(), transactions, difficulty: blockDifficulty, shareTarget: difficultyToTargetHex(personalDifficulty), blockTarget: difficultyToTargetHex(blockDifficulty), requestedBy: minerAddress ?? null };
    }
    submitShare(minerAddress, candidate) {
        if (!minerAddress) return { accepted: false, reason: "Brak adresu gornika" };
        if (!candidate || typeof candidate.hash !== "string") return { accepted: false, reason: "Nieprawidlowe zgloszenie" };
        if (computeBlockHash(candidate) !== candidate.hash) return { accepted: false, reason: "hash nie zgadza sie z trescia" };
        if (this.seenShareHashes.has(candidate.hash)) return { accepted: false, reason: "duplikat" };
        const shareTargetHex = difficultyToTargetHex(this.getMinerDifficulty(minerAddress));
        if (candidate.hash > shareTargetHex) return { accepted: false, reason: "nie spelnia trudnosci share" };
        const minerDiffAtSubmit = this.getMinerDifficulty(minerAddress);
        this._adjustMinerDifficulty(minerAddress);
        this._rememberShareHash(candidate.hash);
        this.roundShares.set(minerAddress, (this.roundShares.get(minerAddress) || 0) + 1);
        let paidNow = 0;
        if (minerAddress !== this.poolAddress) {
            const height = this.blockchain.getLatestBlock().height + 1;
            const reward = this.blockchain.getRewardForHeight(height);
            const maxShareValue = reward * (1 - this.poolFee);
            const effectiveMinerDiff = Math.min(minerDiffAtSubmit, this.blockchain.difficulty);
            const rawShareValue = maxShareValue * (effectiveMinerDiff / this.blockchain.difficulty);
            // NAPRAWA (2026-08-27, audyt VARDIFF): powyzsze dwa Math.min()
            // (na effectiveMinerDiff i przez konstrukcje samego stosunku)
            // matematycznie nie pozwalaja rawShareValue przekroczyc
            // maxShareValue - potwierdzone recznie, linia po linii, w tej
            // sesji. Mimo to w bazie znaleziono wiersze do 256x wyzsze niz
            // ten teoretyczny sufit (12544 zamiast max 49), z okresu
            // sprzed obecnej wersji tego pliku - dowod ze poleganie
            // WYLACZNIE na poprawnosci wzoru w gorze funkcji jest kruche:
            // jedna przyszla zmiana w ktoryms Math.min() wyzej, i sufit
            // znika bez ostrzezenia, znowu. Ten Math.min() tutaj jest
            // NIEZALEZNYM, jawnym gwarantem na WYJSCIU funkcji - nie
            // polega na tym ze reszta wzoru wyzej pozostanie poprawna
            // na zawsze, wymusza to bezposrednio na ostatecznej wartosci.
            const shareValue = Math.min(rawShareValue, maxShareValue);
            if (shareValue > 0) {
                this.blockchain.saveCredit({ minerAddress, blockHeight: height, shares: 1, amount: shareValue, timestamp: Date.now() });
                paidNow = shareValue;
            }
        }
        const blockTargetHex = difficultyToTargetHex(this.blockchain.difficulty);
        if (candidate.hash > blockTargetHex) return { accepted: true, share: true, blockFound: false, paidNow };
        const result = this.blockchain.receiveBlock(candidate);
        if (!result.accepted) console.error("BLOK ODRZUCONY przy wysokosci " + candidate.height + ": " + result.reason);
        if (!result.accepted) return { accepted: true, share: true, blockFound: false, note: result.reason, paidNow };
        this._finalizeRound();
        if (this.mempool) this.mempool.pruneConfirmed(result.block);
        return { accepted: true, share: true, blockFound: true, block: result.block, paidNow };
    }
    getMinerDifficulty(minerAddress) {
        if (!this.minerDifficulty.has(minerAddress)) this.minerDifficulty.set(minerAddress, this.shareDifficulty);
        return this.minerDifficulty.get(minerAddress);
    }
    _adjustMinerDifficulty(minerAddress) {
        const now = Date.now();
        const lastAt = this.minerLastShareAt.get(minerAddress);
        this.minerLastShareAt.set(minerAddress, now);
        if (!lastAt) return;
        const elapsedSeconds = Math.max((now - lastAt) / 1000, 0.001);
        const current = this.getMinerDifficulty(minerAddress);
        let ratio = VARDIFF_TARGET_SECONDS / elapsedSeconds;
        ratio = Math.max(1 / VARDIFF_MAX_STEP, Math.min(VARDIFF_MAX_STEP, ratio));
        const next = Math.min(this.blockchain.difficulty, Math.max(VARDIFF_MIN_DIFFICULTY, current * ratio));
        this.minerDifficulty.set(minerAddress, next);
    }
    _rememberShareHash(hash) {
        if (this.seenShareHashes.size > MAX_SEEN_SHARE_HASHES) this.seenShareHashes.clear();
        this.seenShareHashes.add(hash);
    }
    _finalizeRound() {
        this.roundShares = new Map();
    }
    getStatus() {
        const latest = this.blockchain.getLatestBlock();
        return { poolAddress: this.poolAddress, poolFee: this.poolFee, workingOnHeight: latest.height + 1, shareDifficulty: Math.round(this.shareDifficulty), blockDifficulty: Math.round(this.blockchain.difficulty), sharesThisRound: Object.fromEntries(this.roundShares), totalSharesThisRound: Array.from(this.roundShares.values()).reduce((a, b) => a + b, 0), minerDifficulties: Object.fromEntries(Array.from(this.minerDifficulty.entries()).map(([addr, d]) => [addr, Math.round(d)])) };
    }
    getCredits(minerAddress) { return this.blockchain.getCredits(minerAddress); }
}
module.exports = MiningPool;
