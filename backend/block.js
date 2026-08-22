// =====================================================
// BitBudCoin Core
// block.js
// vMax LEGENDARY MODE
// =====================================================

"use strict";

const crypto = require("crypto");

const MAX_TARGET =
    (1n << 256n) - 1n;


/*
 * =====================================================
 * TARGET
 * =====================================================
 *
 * difficulty = dodatnia liczba całkowita
 *
 * target = MAX_TARGET / difficulty
 *
 * Im większa difficulty,
 * tym mniejszy target,
 * czyli tym trudniejszy PoW.
 */

function difficultyToTargetHex(difficulty) {

    const safe =
        BigInt(
            Math.max(
                1,
                Math.round(
                    Number(difficulty)
                )
            )
        );

    return (
        MAX_TARGET / safe
    )
        .toString(16)
        .padStart(64, "0");
}


/*
 * =====================================================
 * HASH
 * =====================================================
 *
 * MUSI być identyczny z funkcją
 * computeBlockHash() używaną przez
 * bbcblockchain.js.
 *
 * Nie dodajemy tutaj żadnych dodatkowych pól.
 */

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
            JSON.stringify(
                transactions
            ) +
            difficulty +
            nonce
        )
        .digest("hex");
}


/*
 * =====================================================
 * POW CHECK
 * =====================================================
 *
 * Hash traktujemy jako 256-bitową liczbę.
 *
 * Poprawny blok:
 *
 *      hash <= target
 *
 * Dzięki BigInt nie ma tutaj problemu
 * z precyzją JavaScript Number.
 */

function checkProofOfWork(
    hash,
    difficulty
) {

    if (
        typeof hash !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(hash)
    ) {
        return false;
    }

    const hashValue =
        BigInt(
            "0x" + hash
        );

    const target =
        BigInt(
            "0x" +
            difficultyToTargetHex(
                difficulty
            )
        );

    return (
        hashValue <=
        target
    );
}


/*
 * =====================================================
 * BLOCK
 * =====================================================
 */

class Block {

    constructor({
        height,
        timestamp,
        previousHash,
        transactions,
        difficulty,
        nonce = 0
    }) {

        this.height =
            height;

        this.timestamp =
            timestamp;

        this.previousHash =
            previousHash;

        this.transactions =
            transactions;

        this.difficulty =
            difficulty;

        this.nonce =
            nonce;

        this.hash =
            this.calculateHash();
    }


    /*
     * =================================================
     * HASH
     * =================================================
     */

    calculateHash() {

        return computeBlockHash({
            height:
                this.height,

            previousHash:
                this.previousHash,

            timestamp:
                this.timestamp,

            transactions:
                this.transactions,

            difficulty:
                this.difficulty,

            nonce:
                this.nonce
        });
    }


    /*
     * =================================================
     * POW VALIDATION
     * =================================================
     */

    hasValidProofOfWork() {

        return checkProofOfWork(
            this.hash,
            this.difficulty
        );
    }


    /*
     * =================================================
     * MINE
     * =================================================
     *
     * Szuka nonce aż hash znajdzie się
     * poniżej targetu.
     *
     * To jest zgodne z mechanizmem używanym
     * przez bbcblockchain.js.
     */

    mine(
        targetHex = null
    ) {

        const target =
            targetHex ||
            difficultyToTargetHex(
                this.difficulty
            );

        const targetValue =
            BigInt(
                "0x" + target
            );

        while (true) {

            this.hash =
                this.calculateHash();

            const hashValue =
                BigInt(
                    "0x" +
                    this.hash
                );

            if (
                hashValue <=
                targetValue
            ) {
                break;
            }

            this.nonce++;
        }

        return this.hash;
    }


    /*
     * =================================================
     * LEGACY COMPATIBILITY
     * =================================================
     *
     * Część starego kodu mogła używać
     * mineBlock().
     *
     * Nie usuwamy API.
     */

    mineBlock() {

        return this.mine();
    }


    /*
     * =================================================
     * STATIC HASH
     * =================================================
     */

    static calculateHash(data) {

        return computeBlockHash(
            data
        );
    }


    /*
     * =================================================
     * STATIC PoW CHECK
     * =================================================
     */

    static checkProofOfWork(
        hash,
        difficulty
    ) {

        return checkProofOfWork(
            hash,
            difficulty
        );
    }


    /*
     * =================================================
     * STATIC TARGET
     * =================================================
     */

    static difficultyToTargetHex(
        difficulty
    ) {

        return difficultyToTargetHex(
            difficulty
        );
    }
}


/*
 * =====================================================
 * EXPORTS
 * =====================================================
 */

module.exports =
    Block;

module.exports.Block =
    Block;

module.exports
    .difficultyToTargetHex =
    difficultyToTargetHex;

module.exports
    .computeBlockHash =
    computeBlockHash;

module.exports
    .checkProofOfWork =
    checkProofOfWork;