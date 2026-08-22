"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONFIG = require("./config");
const Storage = require("./storage");
const { asertNextDifficulty } = require("./asert-difficulty");

const MAX_TARGET = (1n << 256n) - 1n;
const GENESIS_TIMESTAMP = Date.UTC(2026, 0, 1);

// Oplata protokolu - usztywniona w kodzie.
const PROJECT_FEE_PERCENT = 0.005;

function difficultyToTargetHex(difficulty) {
    const safe = BigInt(Math.max(1, Math.round(difficulty)));
    return (MAX_TARGET / safe)
        .toString(16)
        .padStart(64, "0");
}

function computeBlockHash({
    height,
    previousHash,
    timestamp,
    transactions,
    difficulty,
    nonce
}) {
    return crypto
        .createHash("sha256")
        .update(
            height +
            previousHash +
            timestamp +
            JSON.stringify(transactions) +
            difficulty +
            nonce
        )
        .digest("hex");
}

function sha256Hex(input) {
    return crypto
        .createHash("sha256")
        .update(input)
        .digest("hex");
}

class Block {
    constructor({
        height,
        timestamp,
        previousHash,
        transactions,
        difficulty,
        nonce = 0
    }) {
        Object.assign(this, {
            height,
            timestamp,
            previousHash,
            transactions,
            difficulty,
            nonce
        });

        this.hash = this.calculateHash();
    }

    calculateHash() {
        return computeBlockHash(this);
    }

    mine(targetHex) {
        while (this.hash > targetHex) {
            this.nonce++;
            this.hash = this.calculateHash();
        }

        return this.hash;
    }
}

function emergencyStatePath() {
    return path.join(
        path.dirname(CONFIG.DATABASE),
        ".difficulty-emergency-state.json"
    );
}

function loadEmergencyDifficultyState() {
    try {
        const raw = fs.readFileSync(
            emergencyStatePath(),
            "utf8"
        );

        const state = JSON.parse(raw);

        if (
            typeof state.difficulty === "number" &&
            state.difficulty > 0
        ) {
            return state;
        }
    } catch (e) {}

    return null;
}

function saveEmergencyDifficultyState(
    difficulty,
    height
) {
    try {
        fs.writeFileSync(
            emergencyStatePath(),
            JSON.stringify({
                difficulty,
                height,
                savedAt: Date.now()
            })
        );
    } catch (e) {
        console.error(
            "Nie udalo sie zapisac stanu awaryjnej trudnosci: " +
            e.message
        );
    }
}

function isProjectFeeActive(height) {
    return !!(
        CONFIG.PROJECT_FEE_ADDRESS &&
        CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT !== undefined &&
        height >= CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT
    );
}

/*
 * ASERT aktywny dla bloku:
 *
 *     height >= ASERT_ACTIVATION_HEIGHT
 *
 * Kotwica:
 *
 *     ASERT_ACTIVATION_HEIGHT - 1
 *
 * Jest to ostatni blok wykopany wedlug starego DAA.
 */
function isAsertActive(height) {
    return !!(
        CONFIG.ASERT_ACTIVATION_HEIGHT !== undefined &&
        height >= CONFIG.ASERT_ACTIVATION_HEIGHT
    );
}

class Blockchain {
    constructor() {
        this.storage = new Storage(CONFIG.DATABASE);

        /*
         * Startowa trudnosc.
         *
         * Przed ASERT jest to wartosc bazowa.
         * Po zaladowaniu lancucha zostanie odtworzona z historii.
         */
        this.difficulty =
            Math.pow(16, CONFIG.DIFFICULTY);

        this._asertAnchor = null;

        if (this.storage.hasBlocks()) {
            this.chain = this.storage.loadChain();

            this._warnIfChainHasGaps();

            this._recomputeDifficultyFromHistory();

            /*
             * Awaryjny stan trudnosci dotyczy WYŁĄCZNIE starego
             * systemu windowowego.
             *
             * Po aktywacji ASERT nie mozemy go uzyc, poniewaz
             * ASERT musi byc deterministyczny na podstawie lancucha.
             */
            if (
                !isAsertActive(
                    this.getLatestBlock().height + 1
                )
            ) {
                const emergencyState =
                    loadEmergencyDifficultyState();

                if (emergencyState) {
                    console.error(
                        "Uzywam zapisanego stanu trudnosci (" +
                        emergencyState.difficulty +
                        ") zamiast przeliczonej z historii (" +
                        this.difficulty +
                        ")."
                    );

                    this.difficulty =
                        emergencyState.difficulty;
                }
            }
        } else {
            const transactions =
                CONFIG.GENESIS_TRANSACTIONS.map((tx) => ({
                    from: CONFIG.GENESIS_ADDRESS,
                    to: tx.to,
                    amount: tx.amount,
                    type: "genesis"
                }));

            const genesis = new Block({
                height: 0,
                timestamp: GENESIS_TIMESTAMP,
                previousHash: "0".repeat(64),
                transactions,
                difficulty: this.difficulty
            });

            this.chain = [genesis];

            this.storage.saveBlock(genesis);
        }

        this._rebuildIndexes();
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    getRewardForHeight(height) {
        return CONFIG.BLOCK_REWARD /
            Math.pow(
                2,
                Math.floor(
                    height / CONFIG.HALVING_INTERVAL
                )
            );
    }

    buildBlockTransactions(
        rewardRecipient,
        pendingTransactions = []
    ) {
        const height =
            this.getLatestBlock().height + 1;

        const reward =
            this.getRewardForHeight(height);

        const transactions = [
            {
                from: null,
                to: rewardRecipient,
                amount: reward,
                type: "coinbase"
            }
        ];

        const feeActive =
            isProjectFeeActive(height);

        let totalMinerFees = 0;
        let totalProtocolCut = 0;

        for (const tx of pendingTransactions) {
            if (tx.type === "HTLC_CREATE") {
                transactions.push({
                    htlcId: tx.htlcId,
                    from: tx.from,
                    to: tx.claimant,
                    amount: tx.amount,
                    fee: tx.fee,
                    hashLock: tx.hashLock,
                    timeoutHeight: tx.timeoutHeight,
                    claimant: tx.claimant,
                    refundee: tx.refundee,
                    timestamp: tx.timestamp,
                    publicKey: tx.publicKey,
                    signature: tx.signature,
                    type: "HTLC_CREATE"
                });

                totalMinerFees +=
                    tx.fee || 0;

                if (feeActive) {
                    totalProtocolCut +=
                        tx.amount *
                        PROJECT_FEE_PERCENT;
                }
            } else if (tx.type === "HTLC_CLAIM") {
                transactions.push({
                    htlcId: tx.htlcId,
                    claimant: tx.claimant,
                    secret: tx.secret,
                    to: tx.to,
                    amount: tx.amount,
                    timestamp: tx.timestamp,
                    publicKey: tx.publicKey,
                    signature: tx.signature,
                    type: "HTLC_CLAIM"
                });
            } else if (tx.type === "HTLC_REFUND") {
                transactions.push({
                    htlcId: tx.htlcId,
                    refundee: tx.refundee,
                    to: tx.to,
                    amount: tx.amount,
                    timestamp: tx.timestamp,
                    publicKey: tx.publicKey,
                    signature: tx.signature,
                    type: "HTLC_REFUND"
                });
            } else {
                transactions.push({
                    from: tx.from,
                    to: tx.to,
                    amount: tx.amount,
                    fee: tx.fee,
                    timestamp: tx.timestamp,
                    publicKey: tx.publicKey,
                    signature: tx.signature,
                    type: "transfer"
                });

                totalMinerFees +=
                    tx.fee || 0;

                if (feeActive) {
                    totalProtocolCut +=
                        tx.amount *
                        PROJECT_FEE_PERCENT;
                }
            }
        }

        if (
            totalMinerFees > 0 &&
            CONFIG.PROJECT_FEE_ADDRESS
        ) {
            transactions.push({
                from: null,
                to: CONFIG.PROJECT_FEE_ADDRESS,
                amount: totalMinerFees,
                type: "fee"
            });
        }

        if (totalProtocolCut > 0) {
            transactions.push({
                from: null,
                to: CONFIG.PROJECT_FEE_ADDRESS,
                amount: totalProtocolCut,
                type: "protocol_fee"
            });
        }

        return transactions;
    }

    receiveBlock(candidate) {
        const latest =
            this.getLatestBlock();

        if (
            candidate.height !==
            latest.height + 1
        ) {
            return {
                accepted: false,
                reason: "wysokosc nie pasuje"
            };
        }

        if (
            candidate.previousHash !==
            latest.hash
        ) {
            return {
                accepted: false,
                reason: "previousHash nie pasuje"
            };
        }

        if (
            computeBlockHash(candidate) !==
            candidate.hash
        ) {
            return {
                accepted: false,
                reason: "hash sie nie zgadza"
            };
        }

        /*
         * Blok musi uzywac lokalnie oczekiwanej trudnosci.
         *
         * To jest szczegolnie wazne po aktywacji ASERT:
         * kazdy wezel MUSI dojsc do identycznej wartosci.
         */
        if (
            candidate.difficulty !==
            this.difficulty
        ) {
            return {
                accepted: false,
                reason:
                    `nieprawidlowa trudnosc (oczekiwano ${this.difficulty}, otrzymano ${candidate.difficulty})`
            };
        }

        if (
            candidate.hash >
            difficultyToTargetHex(
                candidate.difficulty
            )
        ) {
            return {
                accepted: false,
                reason: "nie spelnia trudnosci"
            };
        }

        /*
         * Ochrona przed podwojnym rozwiazaniem HTLC.
         */
        const seenHtlcResolutions =
            new Set();

        for (
            const tx of candidate.transactions
        ) {
            if (
                tx.type === "HTLC_CLAIM" ||
                tx.type === "HTLC_REFUND"
            ) {
                const existing =
                    this.findHTLC(
                        tx.htlcId
                    );

                if (!existing) {
                    return {
                        accepted: false,
                        reason:
                            `${tx.type} dla nieistniejacego HTLC ${tx.htlcId}`
                    };
                }

                if (
                    existing.status !==
                    "locked"
                ) {
                    return {
                        accepted: false,
                        reason:
                            `HTLC ${tx.htlcId} juz ma status "${existing.status}" - podwojne rozwiazanie odrzucone`
                    };
                }

                if (
                    seenHtlcResolutions.has(
                        tx.htlcId
                    )
                ) {
                    return {
                        accepted: false,
                        reason:
                            `blok zawiera dwa rozwiazania tego samego HTLC ${tx.htlcId} naraz`
                    };
                }

                seenHtlcResolutions.add(
                    tx.htlcId
                );
            }
        }

        /*
         * Najpierw zapis do bazy.
         * Dopiero potem chain.push().
         */
        try {
            this.storage.saveBlock(
                candidate
            );
        } catch (err) {
            return {
                accepted: false,
                reason:
                    "blad zapisu do bazy: " +
                    err.message
            };
        }

        this.chain.push(candidate);

        this._applyBlockToIndexes(
            candidate
        );

        /*
         * ============================================================
         * DAA
         * ============================================================
         *
         * Stary retarget dziala tylko przed ASERT.
         *
         * Od momentu, kiedy nastepny blok jest ASERT,
         * trudnosc nastepnego bloku jest wyliczana BEZPOSREDNIO
         * z kotwicy.
         */
        if (
            isAsertActive(
                candidate.height + 1
            )
        ) {
            this._applyAsertDifficulty(
                candidate
            );
        } else {
            this.retargetIfDue(
                candidate
            );
        }

        return {
            accepted: true,
            block: candidate
        };
    }

    retargetIfDue(
        justAccepted,
        persist = true
    ) {
        /*
         * Po ASERT ta funkcja nie jest juz uzywana.
         */
        if (
            isAsertActive(
                justAccepted.height + 1
            )
        ) {
            return;
        }

        const interval =
            CONFIG.DIFFICULTY_ADJUSTMENT;

        if (
            justAccepted.height === 0 ||
            justAccepted.height %
                interval !== 0
        ) {
            return;
        }

        const windowStart =
            this.chain.find(
                (b) =>
                    b.height ===
                    justAccepted.height -
                    interval
            );

        if (!windowStart) {
            return;
        }

        const actualMs =
            Math.max(
                1,
                justAccepted.timestamp -
                    windowStart.timestamp
            );

        const expectedMs =
            interval *
            CONFIG.TARGET_BLOCK_TIME_MS;

        let ratio =
            expectedMs / actualMs;

        ratio =
            Math.max(
                0.25,
                Math.min(4, ratio)
            );

        this.difficulty =
            Math.max(
                1,
                this.difficulty * ratio
            );

        if (persist) {
            saveEmergencyDifficultyState(
                this.difficulty,
                justAccepted.height
            );
        }
    }

    /*
     * ============================================================
     * ASERT ANCHOR
     * ============================================================
     *
     * Anchor:
     *
     *     ASERT_ACTIVATION_HEIGHT - 1
     *
     * Timestamp referencyjny:
     *
     *     timestamp rodzica anchor block
     *
     * Dokladnie taki uklad opisuje specyfikacja ASERTI3-2D.
     */
    _getAsertAnchor() {
        if (this._asertAnchor) {
            return this._asertAnchor;
        }

        const activationHeight =
            Number(
                CONFIG.ASERT_ACTIVATION_HEIGHT
            );

        if (
            !Number.isInteger(
                activationHeight
            ) ||
            activationHeight <= 1
        ) {
            return null;
        }

        const anchorHeight =
            activationHeight - 1;

        const anchorBlock =
            this.chain[anchorHeight];

        const anchorParentBlock =
            this.chain[
                anchorHeight - 1
            ];

        if (
            !anchorBlock ||
            !anchorParentBlock ||
            anchorBlock.height !==
                anchorHeight
        ) {
            return null;
        }

        /*
         * W tym projekcie timestamp bloku jest
         * przechowywany w milisekundach.
         *
         * ASERT wymaga sekund.
         */
        const anchorParentTime =
            BigInt(
                Math.floor(
                    anchorParentBlock.timestamp /
                        1000
                )
            );

        /*
         * Difficulty jest obecnie Number w formacie
         * wewnetrznym BbC.
         *
         * ASERT konwertuje je do BigInt dopiero
         * w asert-difficulty.js.
         */
        const anchorDifficulty =
            Math.max(
                1,
                Math.round(
                    Number(
                        anchorBlock.difficulty
                    )
                )
            );

        this._asertAnchor = {
            anchorHeight:
                BigInt(anchorHeight),

            anchorParentTime,

            anchorDifficulty:
                BigInt(anchorDifficulty)
        };

        return this._asertAnchor;
    }

    /*
     * ============================================================
     * ASERT NEXT DIFFICULTY
     * ============================================================
     */
    _applyAsertDifficulty(
        latestBlock
    ) {
        const anchor =
            this._getAsertAnchor();

        if (!anchor) {
            console.error(
                "ASERT aktywny, ale kotwica nie zostala znaleziona. " +
                "Trudnosc pozostaje bez zmian."
            );

            return;
        }

        const idealBlockTime =
            BigInt(
                CONFIG.BLOCK_TIME
            );

        const halflife =
            BigInt(
                CONFIG.ASERT_HALFLIFE_SECONDS
            );

        const nextDifficulty =
            asertNextDifficulty({
                anchorHeight:
                    anchor.anchorHeight,

                anchorParentTime:
                    anchor.anchorParentTime,

                anchorDifficulty:
                    anchor.anchorDifficulty,

                evalHeight:
                    BigInt(
                        latestBlock.height
                    ),

                evalTime:
                    BigInt(
                        Math.floor(
                            latestBlock.timestamp /
                                1000
                        )
                    ),

                idealBlockTime,

                halflife,

                maxTarget:
                    MAX_TARGET
            });

        /*
         * ASERT zwraca juz BbC difficulty jako Number.
         *
         * Walidacja dodatkowa, zeby przypadkowy NaN/Infinity
         * nigdy nie trafil do stanu konsensusu.
         */
        if (
            !Number.isFinite(
                nextDifficulty
            ) ||
            nextDifficulty <= 0
        ) {
            throw new Error(
                "ASERT zwrocil nieprawidlowa trudnosc"
            );
        }

        this.difficulty =
            Math.max(
                1,
                Math.round(
                    nextDifficulty
                )
            );
    }

    /*
     * ============================================================
     * RECOMPUTE DIFFICULTY
     * ============================================================
     */
    _recomputeDifficultyFromHistory() {
        const latestHeight =
            this.getLatestBlock().height;

        const activationHeight =
            CONFIG.ASERT_ACTIVATION_HEIGHT;

        const anchorHeight =
            activationHeight !== undefined
                ? activationHeight - 1
                : undefined;

        /*
         * Stare okna przeliczamy tylko do anchor block.
         */
        const preAsertCeiling =
            (
                anchorHeight !== undefined &&
                anchorHeight < latestHeight
            )
                ? anchorHeight
                : latestHeight;

        const interval =
            CONFIG.DIFFICULTY_ADJUSTMENT;

        for (
            let h = interval;
            h <= preAsertCeiling;
            h += interval
        ) {
            const block =
                this.chain.find(
                    (b) =>
                        b.height === h
                );

            if (block) {
                this.retargetIfDue(
                    block,
                    false
                );
            }
        }

        /*
         * Jesli lancuch doszedl do ASERT,
         * odtworz trudnosc z kotwicy.
         */
        if (
            anchorHeight !== undefined &&
            latestHeight >= anchorHeight
        ) {
            this._asertAnchor = null;

            this._applyAsertDifficulty(
                this.getLatestBlock()
            );
        }
    }

    /*
     * ============================================================
     * CHAIN GAP WARNING
     * ============================================================
     */
    _warnIfChainHasGaps() {
        for (
            let i = 1;
            i < this.chain.length;
            i++
        ) {
            const expected =
                this.chain[i - 1].height +
                1;

            if (
                this.chain[i].height !==
                expected
            ) {
                const missingEnd =
                    this.chain[i].height - 1;

                const label =
                    expected === missingEnd
                        ? `${expected}`
                        : `${expected}-${missingEnd}`;

                console.error(
                    `  DZIURA W LANCUCHU: brakuje bloku/blokow ${label} ` +
                    `(baza przeskakuje z wysokosci ` +
                    `${this.chain[i - 1].height} na ` +
                    `${this.chain[i].height})`
                );
            }
        }
    }

    /*
     * ============================================================
     * CHAIN REPLACEMENT / P2P SYNC
     * ============================================================
     */
    replaceChain(
        candidateChain
    ) {
        if (
            !Array.isArray(
                candidateChain
            ) ||
            candidateChain.length === 0
        ) {
            return {
                accepted: false,
                reason:
                    "pusty lub nieprawidlowy lancuch"
            };
        }

        if (
            candidateChain[0].hash !==
            this.chain[0].hash
        ) {
            return {
                accepted: false,
                reason:
                    "inny genesis - inna siec"
            };
        }

        if (
            candidateChain.length <=
            this.chain.length
        ) {
            return {
                accepted: false,
                reason:
                    `krotszy lub rowny (${candidateChain.length} <= ${this.chain.length}) - odrzucony, nie ma powodu podmieniac`
            };
        }

        for (
            let i = 0;
            i < candidateChain.length;
            i++
        ) {
            const block =
                candidateChain[i];

            if (
                block.height !== i
            ) {
                return {
                    accepted: false,
                    reason:
                        `blok #${i}: wysokosc ${block.height} nie pasuje do pozycji`
                };
            }

            if (
                i > 0 &&
                block.previousHash !==
                    candidateChain[
                        i - 1
                    ].hash
            ) {
                return {
                    accepted: false,
                    reason:
                        `blok #${i}: previousHash nie pasuje do bloku #${i - 1}`
                };
            }

            if (
                computeBlockHash(
                    block
                ) !== block.hash
            ) {
                return {
                    accepted: false,
                    reason:
                        `blok #${i}: hash nie zgadza sie z trescia`
                };
            }

            if (
                i > 0 &&
                block.hash >
                    difficultyToTargetHex(
                        block.difficulty
                    )
            ) {
                return {
                    accepted: false,
                    reason:
                        `blok #${i}: nie spelnia deklarowanej trudnosci`
                };
            }
        }

        try {
            this.storage.replaceAllBlocks(
                candidateChain
            );
        } catch (err) {
            return {
                accepted: false,
                reason:
                    "blad zapisu do bazy: " +
                    err.message
            };
        }

        this.chain =
            candidateChain;

        this._warnIfChainHasGaps();

        this._rebuildIndexes();

        this.difficulty =
            Math.pow(
                16,
                CONFIG.DIFFICULTY
            );

        this._asertAnchor = null;

        this._recomputeDifficultyFromHistory();

        return {
            accepted: true,
            height:
                this.getLatestBlock()
                    .height
        };
    }

    getChain() {
        return this.chain;
    }

    getRecentBlocks(
        limit = 20,
        beforeHeight = null
    ) {
        let blocks =
            this.chain
                .slice()
                .reverse();

        if (
            beforeHeight !== null
        ) {
            blocks =
                blocks.filter(
                    (b) =>
                        b.height <
                        beforeHeight
                );
        }

        return blocks.slice(
            0,
            limit
        );
    }

    /*
     * ============================================================
     * HTLC
     * ============================================================
     */

    findHTLC(htlcId) {
        let created = null;
        let resolvedStatus = null;

        for (
            const block of this.chain
        ) {
            for (
                const tx of block.transactions
            ) {
                if (
                    tx.type ===
                        "HTLC_CREATE" &&
                    tx.htlcId ===
                        htlcId
                ) {
                    created = {
                        ...tx,
                        createdAtHeight:
                            block.height
                    };
                }

                if (
                    tx.type ===
                        "HTLC_CLAIM" &&
                    tx.htlcId ===
                        htlcId
                ) {
                    resolvedStatus =
                        "claimed";
                }

                if (
                    tx.type ===
                        "HTLC_REFUND" &&
                    tx.htlcId ===
                        htlcId
                ) {
                    resolvedStatus =
                        "refunded";
                }
            }
        }

        if (!created) {
            return null;
        }

        return {
            ...created,
            status:
                resolvedStatus ||
                "locked"
        };
    }

    validateHTLCClaim({
        htlcId,
        secret,
        claimant
    }) {
        const htlc =
            this.findHTLC(
                htlcId
            );

        if (!htlc) {
            return {
                valid: false,
                reason:
                    "HTLC nie istnieje"
            };
        }

        if (
            htlc.status !==
            "locked"
        ) {
            return {
                valid: false,
                reason:
                    `HTLC ma status "${htlc.status}", nie mozna odebrac`
            };
        }

        if (
            claimant !==
            htlc.claimant
        ) {
            return {
                valid: false,
                reason:
                    "tylko wyznaczony odbiorca moze odebrac"
            };
        }

        const nextHeight =
            this.getLatestBlock()
                .height + 1;

        if (
            nextHeight >=
            htlc.timeoutHeight
        ) {
            return {
                valid: false,
                reason:
                    "termin juz minal, odbior niemozliwy - tylko zwrot"
            };
        }

        if (
            sha256Hex(secret) !==
            htlc.hashLock
        ) {
            return {
                valid: false,
                reason:
                    "zly sekret - hash sie nie zgadza"
            };
        }

        return {
            valid: true,
            amount:
                htlc.amount,
            to:
                htlc.claimant
        };
    }

    validateHTLCRefund({
        htlcId,
        refundee
    }) {
        const htlc =
            this.findHTLC(
                htlcId
            );

        if (!htlc) {
            return {
                valid: false,
                reason:
                    "HTLC nie istnieje"
            };
        }

        if (
            htlc.status !==
            "locked"
        ) {
            return {
                valid: false,
                reason:
                    `HTLC ma status "${htlc.status}", nie mozna zwrocic`
            };
        }

        if (
            refundee !==
            htlc.refundee
        ) {
            return {
                valid: false,
                reason:
                    "tylko oryginalny nadawca moze dostac zwrot"
            };
        }

        const nextHeight =
            this.getLatestBlock()
                .height + 1;

        if (
            nextHeight <
            htlc.timeoutHeight
        ) {
            return {
                valid: false,
                reason:
                    `termin jeszcze nie minal (blok ${nextHeight} < ${htlc.timeoutHeight})`
            };
        }

        return {
            valid: true,
            amount:
                htlc.amount,
            to:
                htlc.refundee
        };
    }

    /*
     * ============================================================
     * INDEXES
     * ============================================================
     */

    _rebuildIndexes() {
        this.balances =
            new Map();

        this.firstSeenHeight =
            new Map();

        this.addressTransactions =
            new Map();

        this.circulatingSupply =
            0;

        for (
            const block of this.chain
        ) {
            this._applyBlockToIndexes(
                block
            );
        }
    }

    _addBalance(
        address,
        delta
    ) {
        this.balances.set(
            address,
            (
                this.balances.get(
                    address
                ) || 0
            ) + delta
        );
    }

    _touchFirstSeen(
        address,
        height
    ) {
        if (
            !this.firstSeenHeight.has(
                address
            )
        ) {
            this.firstSeenHeight.set(
                address,
                height
            );
        }
    }

    _applyBlockToIndexes(
        block
    ) {
        const feeActive =
            isProjectFeeActive(
                block.height
            );

        for (
            const tx of block.transactions
        ) {
            if (
                tx.type === "coinbase" ||
                tx.type === "genesis"
            ) {
                this.circulatingSupply +=
                    tx.amount;
            }

            const involved =
                new Set(
                    [
                        tx.to,
                        tx.from
                    ].filter(Boolean)
                );

            for (
                const addr of involved
            ) {
                if (
                    !this.addressTransactions.has(
                        addr
                    )
                ) {
                    this.addressTransactions.set(
                        addr,
                        []
                    );
                }

                this.addressTransactions
                    .get(addr)
                    .push({
                        ...tx,
                        blockHeight:
                            block.height
                    });
            }

            if (
                tx.type === "transfer" &&
                tx.to
            ) {
                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                const credited =
                    feeActive
                        ? tx.amount *
                            (
                                1 -
                                PROJECT_FEE_PERCENT
                            )
                        : tx.amount;

                this._addBalance(
                    tx.to,
                    credited
                );
            } else if (
                tx.type ===
                    "HTLC_CLAIM" &&
                tx.to
            ) {
                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                this._addBalance(
                    tx.to,
                    tx.amount
                );
            } else if (
                tx.type ===
                    "HTLC_REFUND" &&
                tx.to
            ) {
                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                this._addBalance(
                    tx.to,
                    tx.amount
                );
            } else if (
                tx.to &&
                tx.type !==
                    "HTLC_CREATE"
            ) {
                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                this._addBalance(
                    tx.to,
                    tx.amount
                );
            }

            if (
                tx.type === "transfer" &&
                tx.from
            ) {
                this._touchFirstSeen(
                    tx.from,
                    block.height
                );

                this._addBalance(
                    tx.from,
                    -(
                        tx.amount +
                        (tx.fee || 0)
                    )
                );
            } else if (
                tx.type ===
                    "HTLC_CREATE" &&
                tx.from
            ) {
                this._touchFirstSeen(
                    tx.from,
                    block.height
                );

                this._addBalance(
                    tx.from,
                    -(
                        tx.amount +
                        (tx.fee || 0)
                    )
                );
            }
        }
    }

    getBalance(address) {
        return (
            this.balances.get(
                address
            ) || 0
        );
    }

    getSoloMiners() {
        const seen =
            new Map();

        for (
            const block of this.chain
        ) {
            for (
                const tx of block.transactions
            ) {
                if (
                    tx.type === "coinbase" &&
                    tx.to !==
                        CONFIG.POOL_ADDRESS
                ) {
                    const existing =
                        seen.get(
                            tx.to
                        ) || {
                            address:
                                tx.to,
                            totalEarned:
                                0,
                            blocksFound:
                                0,
                            lastBlockHeight:
                                0
                        };

                    existing.totalEarned +=
                        tx.amount;

                    existing.blocksFound +=
                        1;

                    existing.lastBlockHeight =
                        Math.max(
                            existing.lastBlockHeight,
                            block.height
                        );

                    seen.set(
                        tx.to,
                        existing
                    );
                }
            }
        }

        return Array.from(
            seen.values()
        ).sort(
            (a, b) =>
                b.lastBlockHeight -
                a.lastBlockHeight
        );
    }

    getAddressStats(
        whaleLimit = 10,
        newestLimit = 10
    ) {
        const addresses =
            Array.from(
                this.balances.keys()
            );

        const whales =
            addresses
                .map(
                    (address) => ({
                        address,
                        balance:
                            this.balances.get(
                                address
                            )
                    })
                )
                .sort(
                    (a, b) =>
                        b.balance -
                        a.balance
                )
                .slice(
                    0,
                    whaleLimit
                );

        const newest =
            Array.from(
                this.firstSeenHeight.entries()
            )
                .map(
                    ([
                        address,
                        firstSeenHeight
                    ]) => ({
                        address,
                        firstSeenHeight
                    })
                )
                .sort(
                    (a, b) =>
                        b.firstSeenHeight -
                        a.firstSeenHeight
                )
                .slice(
                    0,
                    newestLimit
                );

        return {
            totalAddresses:
                addresses.length,
            whales,
            newest
        };
    }

    saveCredit(credit) {
        this.storage.saveCredit(
            credit
        );
    }

    getTransactionsForAddress(
        address,
        limit = 200
    ) {
        const all =
            this.addressTransactions
                .get(address) || [];

        const requested =
            Number.isFinite(limit) &&
            limit > 0
                ? Math.floor(limit)
                : 200;

        const safeLimit =
            Math.min(
                requested,
                all.length
            );

        const result =
            new Array(safeLimit);

        for (
            let i = 0;
            i < safeLimit;
            i++
        ) {
            result[i] =
                all[
                    all.length -
                    1 -
                    i
                ];
        }

        return result;
    }

    /*
     * ============================================================
     * MANUAL / EMERGENCY DIFFICULTY
     * ============================================================
     *
     * Te mechanizmy sa calkowicie wylaczaja po ASERT.
     */
    setDifficultyManually(
        newDifficulty
    ) {
        if (
            isAsertActive(
                this.getLatestBlock()
                    .height + 1
            )
        ) {
            throw new Error(
                "Reczna zmiana trudnosci zablokowana - ASERT aktywny od bloku " +
                CONFIG.ASERT_ACTIVATION_HEIGHT
            );
        }

        if (
            typeof newDifficulty !==
                "number" ||
            !Number.isFinite(
                newDifficulty
            ) ||
            !(newDifficulty > 0)
        ) {
            throw new Error(
                "Nieprawidlowa wartosc trudnosci - musi byc liczba dodatnia"
            );
        }

        const old =
            this.difficulty;

        this.difficulty =
            newDifficulty;

        saveEmergencyDifficultyState(
            newDifficulty,
            this.getLatestBlock()
                .height
        );

        console.error(
            "RECZNA KOREKTA TRUDNOSCI: " +
            old +
            " -> " +
            newDifficulty
        );

        return {
            old,
            new: newDifficulty
        };
    }

    maybeEmergencyAdjust() {
        const latest =
            this.getLatestBlock();

        if (
            latest.height === 0
        ) {
            return;
        }

        if (
            isAsertActive(
                latest.height + 1
            )
        ) {
            return;
        }

        const msSinceLastBlock =
            Date.now() -
            latest.timestamp;

        const target =
            CONFIG.TARGET_BLOCK_TIME_MS;

        if (
            msSinceLastBlock <
            target * 15
        ) {
            return;
        }

        const cooldownMs =
            target * 3;

        if (
            this._lastEmergencyAdjustAt &&
            Date.now() -
                this._lastEmergencyAdjustAt <
                cooldownMs
        ) {
            return;
        }

        const overshoot =
            msSinceLastBlock /
            target;

        const cuts =
            Math.min(
                10,
                Math.max(
                    1,
                    Math.floor(
                        Math.log2(
                            overshoot
                        )
                    )
                )
            );

        const divisor =
            Math.pow(
                2,
                cuts
            );

        const old =
            this.difficulty;

        this.difficulty =
            Math.max(
                1,
                this.difficulty /
                    divisor
            );

        this._lastEmergencyAdjustAt =
            Date.now();

        saveEmergencyDifficultyState(
            this.difficulty,
            latest.height
        );

        console.error(
            "AWARYJNE OBNIZENIE TRUDNOSCI: " +
            Math.round(
                msSinceLastBlock /
                    60000
            ) +
            "min bez bloku (oczekiwano " +
            Math.round(
                target /
                    60000
            ) +
            "min) - dzielone przez " +
            divisor +
            ": " +
            old +
            " -> " +
            this.difficulty
        );
    }

    getInfo() {
        this.maybeEmergencyAdjust();

        const latest =
            this.getLatestBlock();

        const height =
            latest.height;

        return {
            network:
                CONFIG.NETWORK_NAME,

            symbol:
                CONFIG.SYMBOL,

            version:
                CONFIG.VERSION,

            chainId:
                CONFIG.CHAIN_ID,

            height,

            latestHash:
                latest.hash,

            difficulty:
                Math.round(
                    this.difficulty
                ),

            difficultyLeadingZerosApprox:
                Math.floor(
                    Math.log(
                        this.difficulty
                    ) /
                    Math.log(16)
                ),

            totalBlocks:
                this.chain.length,

            currentBlockReward:
                this.getRewardForHeight(
                    height + 1
                ),

            circulatingSupply:
                this.circulatingSupply,

            maxSupply:
                CONFIG.MAX_SUPPLY,

            premine:
                CONFIG.PREMINE,

            blocksUntilHalving:
                CONFIG.HALVING_INTERVAL -
                (
                    height %
                    CONFIG.HALVING_INTERVAL
                ),

            blocksUntilRetarget:
                CONFIG.DIFFICULTY_ADJUSTMENT -
                (
                    height %
                    CONFIG.DIFFICULTY_ADJUSTMENT
                ),

            isValid: true
        };
    }

    close() {
        this.storage.close();
    }
}

module.exports = Blockchain;

module.exports.difficultyToTargetHex =
    difficultyToTargetHex;

module.exports.computeBlockHash =
    computeBlockHash;

module.exports.sha256Hex =
    sha256Hex;

module.exports.isAsertActive =
    isAsertActive;