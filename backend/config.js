"use strict";

module.exports = {
    NETWORK_NAME: "BitBudCoin",
    SYMBOL: "BbC",
    VERSION: "1.0.0",

    CHAIN_ID: 28000000,

    MAX_SUPPLY: 28000000,
    PREMINE: 700,

    GENESIS_ADDRESS: "BbC694f9417395ed990fce2b3c3fe3d756959bf3b1e",

    GENESIS_TRANSACTIONS: [
        {
            to: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
            amount: 700
        }
    ],

    /*
     * ============================================================
     * BLOCK / REWARD
     * ============================================================
     */

    BLOCK_TIME: 480,
    BLOCK_REWARD: 50,

    HALVING_INTERVAL: 210000,

    /*
     * ============================================================
     * PRE-vMax DAA
     * ============================================================
     *
     * Do bloku #99999 włącznie.
     *
     * Od #100000 kontrolę przejmuje vMax ASERT.
     */

    DIFFICULTY: 7,
    DIFFICULTY_ADJUSTMENT: 2028,
    TARGET_BLOCK_TIME_MS: 480000,

    /*
     * ============================================================
     * vMax ASERT
     * ============================================================
     *
     * #99999 = ostatni blok starego DAA
     * #100000 = pierwszy blok vMax
     *
     * Anchor = #99999
     */

    ASERT_ENABLED: true,

    ASERT_MODE: "vMax",

    ASERT_ACTIVATION_HEIGHT: 100000,

    ASERT_ANCHOR_HEIGHT: 99999,

    /*
     * Docelowy czas bloku BbC:
     * 480 sekund = 8 minut
     */
    ASERT_IDEAL_BLOCK_TIME_SECONDS: 480,

    /*
     * vMax half-life:
     * 3600 sekund = 1 godzina
     */
    ASERT_HALFLIFE_SECONDS: 3600,

    /*
     * Po aktywacji vMax:
     *
     * - brak retargetIfDue()
     * - brak EDA
     * - brak ręcznego difficulty adjustment
     * - brak emergency difficulty adjustment
     *
     * Difficulty jest wyłącznie wynikiem deterministycznego ASERT.
     */

    ASERT_DISABLE_LEGACY_DAA: true,
    ASERT_DISABLE_EMERGENCY_ADJUST: true,
    ASERT_INTEGER_ONLY: true,

    /*
     * ============================================================
     * POOL
     * ============================================================
     */

    POOL_ADDRESS: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
    POOL_FEE: 0.02,
    SHARE_DIFFICULTY: 2,

    /*
     * ============================================================
     * DATABASE / NETWORK
     * ============================================================
     */

    DATABASE: process.env.DATABASE_PATH || "bbc.db",

    API_PORT: process.env.PORT || 5000,

    P2P_PORT: 6001,

    PEERS: [
        // NAPRAWA (2026-08-24): przywrocone. Wylaczone tymczasowo 23.08
        // przy podejrzeniu o crash przy sync - realna przyczyna byla
        // brakujacy prog CHAIN_SYNC_MIN_LEAD w p2p.js (naprawiony tej
        // nocy) plus BigInt/Number w ASERT-owej walidacji replaceChain()
        // (naprawiony w tej samej sesji). Realne polaczenie z peerem
        // kolegi jeszcze nie przetestowane po tych poprawkach.
        "145.241.218.97:6001"
    ],

    /*
     * ============================================================
     * TRANSACTIONS
     * ============================================================
     */

    MIN_FEE: 0.001,

    MAX_BLOCK_SIZE: 1000000,

    MAX_TRANSACTIONS_PER_BLOCK: 5000,

    /*
     * ============================================================
     * PROJECT FEE
     * ============================================================
     */

    PROJECT_FEE_ADDRESS:
        "BbCf4c7f835449ea7ffd9d4890b4c9fa2379166157c",

    PROJECT_FEE_PERCENT: 0.02,

    PROJECT_FEE_ACTIVATION_HEIGHT: 1716
};
