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
    // WYPLATY (06.08.2026): przywrocone Pay Per Share po tym jak odkrylismy,
    // ze wersja "dziel nagrode po znalezieniu bloku" trzymala roundShares
    // WYLACZNIE w pamieci - restart procesu przed znalezieniem bloku kasowal
    // prace gornikow bez zadnego zapisu, bez sladu. PPS placi za KAZDY
    // zaakceptowany share od razu, wiec kazda wyplata jest juz bezpiecznie
    // w bazie (saveCredit) w momencie share'a - restart moze najwyzej
    // przerwac PRZYSZLE shares, nigdy nie kasuje juz przyznanych.
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

        // Natychmiastowa wyplata za KAZDY zaakceptowany share (Pay Per Share) -
        // pula placi z wlasnego, juz zgromadzonego salda, wazone trudnoscia
        // (trudniejszy share = wiecej realnej pracy = wiecej BbC), niezaleznie
        // od tego czy TA runda akurat trafi caly blok. Adres puli sam siebie
        // nie placi (self-credit). Liczone z minerDiffAtSubmit i
        // this.blockchain.difficulty - obie wartosci serwerowe/zaufane,
        // candidate.difficulty (od zglaszajacego) nigdy tu nie wchodzi do gry.
        let paidNow = 0;
        if (minerAddress !== this.poolAddress) {
            const height = this.blockchain.getLatestBlock().height + 1;
            const reward = this.blockchain.getRewardForHeight(height);
            const shareValue = reward * (1 - this.poolFee) * (minerDiffAtSubmit / this.blockchain.difficulty);
            if (shareValue > 0) {
                this.blockchain.saveCredit({ minerAddress, blockHeight: height, shares: 1, amount: shareValue, timestamp: Date.now() });
                paidNow = shareValue;
            }
        }

        // BEZPIECZENSTWO: target liczony z this.blockchain.difficulty
        // (zaufana, serwerowa), NIE z candidate.difficulty - to zglasza ten
        // kto submituje. receiveBlock() i tak by odrzucil zly blok, ale bez
        // tego pre-check sam fakt "czy w ogole probowac zglosic jako blok"
        // zalezal od tej samej niezaufanej wartosci.
        const blockTargetHex = difficultyToTargetHex(this.blockchain.difficulty);
        if (candidate.hash > blockTargetHex) return { accepted: true, share: true, blockFound: false, paidNow };
        const result = this.blockchain.receiveBlock(candidate);
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
    // Placi juz nie tutaj (patrz submitShare) - tu tylko zerujemy licznik
    // rundy, uzywany WYLACZNIE do wyswietlania w UI ("sharesThisRound" w
    // getStatus), nie do liczenia wyplat.
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
