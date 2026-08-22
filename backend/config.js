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

    BLOCK_TIME: 480,
    BLOCK_REWARD: 50,

    DIFFICULTY: 7,
    DIFFICULTY_ADJUSTMENT: 2028,
    TARGET_BLOCK_TIME_MS: 480000,

    HALVING_INTERVAL: 210000,

    POOL_ADDRESS: "BbCcbc6f043ddb1f5ac83dd59feab439e192a1fb7",
    POOL_FEE: 0.02,
    SHARE_DIFFICULTY: 2,

    DATABASE: process.env.DATABASE_PATH || "bbc.db",

    API_PORT: process.env.PORT || 5000,
    P2P_PORT: 6001,

    PEERS: [
        "145.241.218.97:6001"
    ],

    MIN_FEE: 0.001,

    MAX_BLOCK_SIZE: 1000000,
    MAX_TRANSACTIONS_PER_BLOCK: 5000,

    PROJECT_FEE_ADDRESS: "BbCf4c7f835449ea7ffd9d4890b4c9fa2379166157c",
    PROJECT_FEE_PERCENT: 0.02,
    PROJECT_FEE_ACTIVATION_HEIGHT: 1716,

    /*
     * ============================================================
     * vMax MODE
     * ============================================================
     *
     * ASERT jest częścią CONSENSUS.
     *
     * Od bloku ASERT_ACTIVATION_HEIGHT następny difficulty
     * jest liczony wyłącznie przez ASERT.
     *
     * Przed aktywacją:
     *   - stary retargeting
     *   - DIFFICULTY_ADJUSTMENT
     *
     * Od aktywacji:
     *   - ASERT
     *   - co blok
     *   - deterministycznie
     *
     * Anchor:
     *   ASERT_ACTIVATION_HEIGHT - 1
     *
     * Jest to ostatni blok wykopany według starego DAA.
     *
     * Wszystkie węzły MUSZĄ mieć identyczne wartości poniżej.
     */

    ASERT_ENABLED: true,

    ASERT_ACTIVATION_HEIGHT: 100000,

    /*
     * BbC:
     *
     * 480 sekund = 8 minut
     */
    ASERT_IDEAL_BLOCK_TIME_SECONDS: 480,

    /*
     * vMax half-life:
     *
     * 3600 sekund = 1 godzina.
     *
     * Jest to parametr consensus i nie może być zmieniany
     * lokalnie przez pojedynczy węzeł.
     */
    ASERT_HALFLIFE_SECONDS: 3600,

    /*
     * Anchor jest wybierany deterministycznie:
     *
     * #99999 = ostatni blok starego DAA
     * #100000 = pierwszy blok ASERT
     */
    ASERT_ANCHOR_HEIGHT: 99999,

    /*
     * vMax nie używa ręcznego/awaryjnego retargetingu
     * po aktywacji ASERT.
     */
    ASERT_DISABLE_EMERGENCY_ADJUST: true,

    /*
     * Wymusza używanie integer-only ASERT.
     */
    ASERT_INTEGER_ONLY: true
};