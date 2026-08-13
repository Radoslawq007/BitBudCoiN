module.exports = {
    NETWORK_NAME: "BitBudCoin",
    SYMBOL: "BbC",
    VERSION: "1.0.0",
    CHAIN_ID: 28000000,
    MAX_SUPPLY: 28000000,
    PREMINE: 700,
    GENESIS_ADDRESS: "BbC694f9417395ed990fce2b3c3fe3d756959bf3b1e",
    GENESIS_TRANSACTIONS: [
        { to: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7", amount: 700 }
    ],
    BLOCK_TIME: 480,
    BLOCK_REWARD: 50,
    DIFFICULTY: 7,
    DIFFICULTY_ADJUSTMENT: 2028,
    TARGET_BLOCK_TIME_MS: 480000,
    HALVING_INTERVAL: 210000,
    POOL_ADDRESS: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
    POOL_FEE: 0.02,
    SHARE_DIFFICULTY: 2,
    DATABASE: process.env.DATABASE_PATH || "bbc.db",
    API_PORT: process.env.PORT || 5000,
    P2P_PORT: 6001,
    PEERS: ["145.241.218.97:6001"],
    MIN_FEE: 0.001,
    MAX_BLOCK_SIZE: 1000000,
    MAX_TRANSACTIONS_PER_BLOCK: 5000,
    PROJECT_FEE_ADDRESS: "BbCf4c7f835449ea7ffd9d4890b4c9fa2379166157c",
    PROJECT_FEE_PERCENT: 0.02,
    PROJECT_FEE_ACTIVATION_HEIGHT: 1716,

    // --- vMax: aktywacja ASERT ---
    // Kotwica = ASERT_ACTIVATION_HEIGHT - 1 (ostatni blok pod starymi zasadami).
    // Musi byc IDENTYCZNA u wszystkich wezlow P2P, tak jak reszta tego pliku.
    // #75000 minelo pod starymi zasadami (retarget okienny), zanim ten plik
    // zdazyl trafic na serwer - #80000 to nowy punkt, z realnym zapasem,
    // i pokrywa sie z Waszym wlasnym celem "80k blokow".
    ASERT_ACTIVATION_HEIGHT: 80000,
    // Punkt startowy do przetestowania na realnych danych, NIE finalna liczba -
    // patrz notatka w asert-difficulty.js.
    ASERT_HALFLIFE_SECONDS: 3600
};
