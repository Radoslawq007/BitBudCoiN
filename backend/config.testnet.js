/*
 * ============================================================
 * BitBudCoin - TESTNET
 * ============================================================
 *
 * Osobna siec do integracji i testow. Monety NIE MAJA WARTOSCI.
 *
 * Uruchomienie:
 *     BBC_NETWORK=testnet node server.js
 *
 * Mainnet zostaje nietkniety - inna baza, inne porty, inny genesis.
 *
 * DLACZEGO SIECI NIE DA SIE POMYLIC:
 * replaceChain() odrzuca lancuch o innym hashu genesis komunikatem
 * "inny genesis - inna siec". Genesis testnetu rozni sie transakcjami
 * (1 000 000 zamiast 700) i trudnoscia startowa, wiec hash jest inny
 * gwarantowanie. Wezel testnetu nigdy nie przyjmie lancucha mainnetu
 * i odwrotnie, nawet gdyby ktos je recznie polaczyl.
 *
 * ODIZOLOWANIE:
 *   baza    bbc-testnet.db   (mainnet: bbc.db)
 *   API     5001             (mainnet: 5000)
 *   P2P     6002             (mainnet: 6001)
 *   PEERS   puste            (mainnet: wezel kolegi)
 */

module.exports = {

    NETWORK_NAME: "BitBudCoin Testnet",

    /*
     * Inny prefiks niz mainnet. Adres to prefiks + hash klucza
     * publicznego, wiec ten sam klucz daje ten sam hex - zmienia sie
     * tylko przedrostek. Dzieki temu klucz puli (~/secrets/pool-key.pem)
     * dziala w obu sieciach bez zmian.
     */
    ADDRESS_PREFIX: "tBbC",
    SYMBOL: "tBbC",
    VERSION: "1.0.0-testnet",

    /* Inny CHAIN_ID niz mainnet (28000000) */
    CHAIN_ID: 28000001,

    /*
     * Realny sufit emisji, nie liczba z sufitu.
     *
     * Emisja PoW przy nagrodzie 50 i halvingu co 210 000 blokow sumuje
     * sie geometrycznie do 21 000 000. Plus premine 1 000 000 daje
     * 22 000 000. Mainnet deklaruje 28 000 000, czego nigdy nie
     * osiagnie - tutaj liczba jest zgodna z arytmetyka.
     */
    MAX_SUPPLY: 22000000,

    /*
     * Duzy premine, zeby bylo czym testowac od pierwszej minuty.
     * To monety testowe - nie maja i nie beda mialy wartosci.
     * Trafiaja na adres puli, do ktorego klucz juz istnieje
     * (~/secrets/pool-key.pem), wiec mozna od razu wysylac i swapowac.
     */
    PREMINE: 1000000,

    GENESIS_ADDRESS: "tBbC694f9417395ed990fce2b3c3fe3d756959bf3b1e",

    GENESIS_TRANSACTIONS: [
        {
            to: "tBbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
            amount: 1000000
        }
    ],

    /*
     * ============================================================
     * BLOCK / REWARD
     * ============================================================
     *
     * 60 s zamiast 480 s. Osiem minut na blok sprawia, ze przetestowanie
     * swapa z HTLC trwa pol dnia. Minuta pozwala przejsc cala sciezke
     * wplata -> potwierdzenia -> wyplata w kwadrans.
     */
    BLOCK_TIME: 60,
    BLOCK_REWARD: 50,
    HALVING_INTERVAL: 210000,

    /*
     * ============================================================
     * PRE-vMax DAA
     * ============================================================
     *
     * Trudnosc startowa dobrana pod kopanie CPU/przegladarka, nie ASIC.
     * ASERT przejmuje kontrole juz od bloku #10, wiec ta wartosc ma
     * znaczenie tylko przez pierwsze kilka minut zycia sieci.
     */
    DIFFICULTY: 100000,
    DIFFICULTY_ADJUSTMENT: 100,
    TARGET_BLOCK_TIME_MS: 60000,

    /*
     * ============================================================
     * vMax ASERT
     * ============================================================
     *
     * Aktywacja od #10, nie od #100000. Chodzi o to, zeby testnet
     * cwiczyl DOKLADNIE ta sama sciezke kodu, ktora mainnet uzywa dzis,
     * a nie stare DAA. Testnet, ktory testuje inna galaz niz produkcja,
     * jest gorszy niz brak testnetu.
     */
    ASERT_ENABLED: true,
    ASERT_MODE: "vMax",
    ASERT_ACTIVATION_HEIGHT: 10,
    ASERT_ANCHOR_HEIGHT: 9,

    ASERT_IDEAL_BLOCK_TIME_SECONDS: 60,

    /* 600 s zamiast 3600 - szybsza reakcja przy krotszym bloku */
    ASERT_HALFLIFE_SECONDS: 600,

    ASERT_DISABLE_LEGACY_DAA: true,
    ASERT_DISABLE_EMERGENCY_ADJUST: true,
    ASERT_INTEGER_ONLY: true,

    /*
     * ============================================================
     * POOL
     * ============================================================
     */
    POOL_ADDRESS: "tBbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
    POOL_FEE: 0.02,
    SHARE_DIFFICULTY: 2,

    /*
     * ============================================================
     * DATABASE / NETWORK
     * ============================================================
     *
     * Wszystko rozne od mainnetu. Dwa wezly moga chodzic na jednej
     * maszynie jednoczesnie i nie wejda sobie w droge.
     */
    DATABASE: process.env.DATABASE_PATH || "bbc-testnet.db",
    API_PORT: process.env.PORT || 5001,
    P2P_PORT: 6002,

    /*
     * Puste celowo. Testnet startuje jako odizolowana siec; peerow
     * dodaje sie przez POST /peers/connect, gdy jest do czego.
     */
    PEERS: [],

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
     *
     * Aktywna od #5, zeby integrator zderzyl sie z nia od razu.
     * Na mainnecie dziala od #1716 i jest najczestszym zrodlem
     * nieporozumien przy ksiegowaniu wplat: odbiorca 100 BbC dostaje
     * 98. Lepiej, zeby zobaczyl to w tescie niz na produkcji.
     */
    PROJECT_FEE_ADDRESS:
        "tBbCf4c7f835449ea7ffd9d4890b4c9fa2379166157c",
    PROJECT_FEE_PERCENT: 0.02,
    PROJECT_FEE_ACTIVATION_HEIGHT: 5
};
