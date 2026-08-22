"use strict";

/*
 * BitBudCoin vMax LEGENDARY SOLO MINER
 *
 * Pełne solo PoW:
 * - liczy CAŁY blok, nie share
 * - 100% nagrody trafia do górnika
 * - wielowątkowe Web Workery
 * - każdy worker dostaje osobny zakres nonce
 * - brak sztucznego limitu prób
 * - automatyczne odświeżanie work po znalezieniu/stale block
 * - heartbeat dla aktywności solo minera
 * - szybkie zatrzymanie wszystkich workerów
 * - ochrona przed równoczesnymi sesjami
 * - obsługa rozłączenia API
 * - ASERT/vMax target dostarczany przez serwer
 *
 * WAŻNE:
 * Miner NIE wylicza trudności samodzielnie.
 * Consensus difficulty/target pochodzi z /solo/work.
 * Serwer pozostaje źródłem prawdy dla targetu.
 */

const SoloMiner = (() => {
    let mining = false;
    let sessionId = 0;

    let sessionStats = {
        attempts: 0,
        blocksFound: 0,
        staleBlocks: 0,
        rejectedBlocks: 0,
        startedAt: null
    };

    let onUpdate = () => {};
    let onLog = () => {};

    let workers = [];
    let workerCount = 1;

    let currentWork = null;
    let currentMinerAddress = null;
    let currentApiBase = "";

    let miningPromise = null;

    const HEARTBEAT_INTERVAL_MS = 15000;
    const WORK_RETRY_DELAY_MS = 3000;
    const SERVER_ERROR_DELAY_MS = 5000;

    let lastHeartbeatTime = null;
    let attemptsAtLastHeartbeat = 0;

    /*
     * --------------------------------------------------------
     * UTIL
     * --------------------------------------------------------
     */

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function normalizeApiBase(apiBase) {
        return String(apiBase || "").replace(/\/+$/, "");
    }

    function safeUpdate() {
        try {
            onUpdate({
                ...sessionStats,
                mining,
                workerCount,
                currentHeight:
                    currentWork &&
                    Number.isInteger(currentWork.height)
                        ? currentWork.height
                        : null
            });
        } catch (err) {
            // UI callback nie może zatrzymać kopania.
        }
    }

    function log(message, type = "info") {
        try {
            onLog(message, type);
        } catch (err) {
            // UI callback nie może zatrzymać kopania.
        }
    }

    /*
     * --------------------------------------------------------
     * HEARTBEAT
     * --------------------------------------------------------
     */

    function maybeSendHeartbeat() {
        if (!mining || !currentMinerAddress || !currentApiBase) {
            return;
        }

        const now = Date.now();

        if (lastHeartbeatTime === null) {
            lastHeartbeatTime = now;
            attemptsAtLastHeartbeat = sessionStats.attempts;
            return;
        }

        if (
            now - lastHeartbeatTime <
            HEARTBEAT_INTERVAL_MS
        ) {
            return;
        }

        const intervalSeconds =
            (now - lastHeartbeatTime) / 1000;

        const attemptsSinceLast =
            sessionStats.attempts -
            attemptsAtLastHeartbeat;

        lastHeartbeatTime = now;
        attemptsAtLastHeartbeat =
            sessionStats.attempts;

        fetch(`${currentApiBase}/solo/heartbeat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                minerAddress: currentMinerAddress,
                attempts: attemptsSinceLast,
                intervalSeconds
            })
        }).catch(() => {
            /*
             * Heartbeat jest informacyjny.
             * Brak API nie zatrzymuje PoW.
             */
        });
    }

    /*
     * --------------------------------------------------------
     * WORKERS
     * --------------------------------------------------------
     */

    function terminateWorkers() {
        for (const worker of workers) {
            try {
                worker.postMessage({
                    type: "stop"
                });
            } catch (err) {}

            try {
                worker.terminate();
            } catch (err) {}
        }

        workers = [];
    }

    function createWorkers(count) {
        terminateWorkers();

        workers = [];

        for (let i = 0; i < count; i++) {
            const worker =
                new Worker(
                    "assets/mining-worker.js"
                );

            workers.push(worker);
        }
    }

    function stopWorkers() {
        for (const worker of workers) {
            try {
                worker.postMessage({
                    type: "stop"
                });
            } catch (err) {}
        }
    }

    /*
     * --------------------------------------------------------
     * PARALLEL SOLO POW
     * --------------------------------------------------------
     *
     * Każdy worker dostaje:
     *
     * workerIndex
     * workerCount
     *
     * Dzięki temu mining-worker może rozdzielić nonce:
     *
     * worker 0: 0, N, 2N...
     * worker 1: 1, N+1, 2N+1...
     *
     * itd.
     */

    function mineOneBlockParallel(
        work,
        minerAddress,
        apiBase,
        mySession
    ) {
        return new Promise((resolve) => {
            if (
                !mining ||
                mySession !== sessionId
            ) {
                resolve(null);
                return;
            }

            let settled = false;
            let finishedCount = 0;

            const localWorkers = workers.slice();

            if (localWorkers.length === 0) {
                resolve(null);
                return;
            }

            function finish(candidate) {
                if (settled) return;

                settled = true;

                stopWorkers();

                resolve(candidate || null);
            }

            localWorkers.forEach((worker, index) => {
                worker.onmessage = (event) => {
                    if (
                        settled ||
                        !mining ||
                        mySession !== sessionId
                    ) {
                        return;
                    }

                    const msg = event.data;

                    if (!msg || !msg.type) {
                        return;
                    }

                    switch (msg.type) {
                        case "progress": {
                            const attempts =
                                Number(msg.attempts) || 0;

                            sessionStats.attempts +=
                                attempts;

                            maybeSendHeartbeat();
                            safeUpdate();

                            break;
                        }

                        case "found": {
                            const attempts =
                                Number(msg.attempts) || 0;

                            sessionStats.attempts +=
                                attempts;

                            finish(
                                msg.candidate
                            );

                            break;
                        }

                        case "stopped": {
                            const attempts =
                                Number(msg.attempts) || 0;

                            sessionStats.attempts +=
                                attempts;

                            finishedCount++;

                            if (
                                finishedCount >=
                                localWorkers.length
                            ) {
                                finish(null);
                            }

                            break;
                        }

                        case "error": {
                            log(
                                `⚠️ Worker #${index}: ${
                                    msg.error ||
                                    "nieznany błąd"
                                }`,
                                "warn"
                            );

                            finishedCount++;

                            if (
                                finishedCount >=
                                localWorkers.length
                            ) {
                                finish(null);
                            }

                            break;
                        }

                        default:
                            break;
                    }
                };

                worker.onerror = (err) => {
                    if (settled) return;

                    log(
                        `⚠️ Błąd Workera #${index}: ${
                            err.message ||
                            "nieznany błąd"
                        }`,
                        "warn"
                    );

                    finishedCount++;

                    if (
                        finishedCount >=
                        localWorkers.length
                    ) {
                        finish(null);
                    }
                };

                worker.postMessage({
                    type: "mine",

                    work,

                    targetField: "blockTarget",

                    workerIndex: index,

                    workerCount:
                        localWorkers.length,

                    /*
                     * SOLO:
                     * brak limitu prób.
                     */
                    maxAttemptsPerWorker: null,

                    /*
                     * Informacja dla nowszych
                     * mining-workerów.
                     */
                    mode: "SOLO",

                    minerAddress
                });
            });
        });
    }

    /*
     * --------------------------------------------------------
     * GET WORK
     * --------------------------------------------------------
     */

    async function getWork(
        minerAddress,
        apiBase,
        mySession
    ) {
        const url =
            `${apiBase}/solo/work?minerAddress=` +
            encodeURIComponent(
                minerAddress
            );

        const response =
            await fetch(url, {
                method: "GET",
                cache: "no-store",
                headers: {
                    "Cache-Control":
                        "no-cache"
                }
            });

        let data = null;

        try {
            data = await response.json();
        } catch (err) {
            throw new Error(
                "Serwer zwrócił nieprawidłowy JSON"
            );
        }

        if (
            mySession !== sessionId ||
            !mining
        ) {
            return null;
        }

        if (!response.ok) {
            throw new Error(
                data &&
                (
                    data.error ||
                    data.reason
                )
                    ? (
                        data.error ||
                        data.reason
                    )
                    : `HTTP ${response.status}`
            );
        }

        /*
         * vMax wymaga pełnego work.
         */
        if (
            !data ||
            !data.blockTarget
        ) {
            throw new Error(
                "Brak blockTarget w odpowiedzi /solo/work"
            );
        }

        if (
            !Number.isInteger(
                Number(data.height)
            )
        ) {
            throw new Error(
                "Nieprawidłowa wysokość bloku"
            );
        }

        if (
            !data.previousHash
        ) {
            throw new Error(
                "Brak previousHash"
            );
        }

        if (
            !Array.isArray(
                data.transactions
            )
        ) {
            throw new Error(
                "Brak transactions"
            );
        }

        return data;
    }

    /*
     * --------------------------------------------------------
     * SUBMIT BLOCK
     * --------------------------------------------------------
     */

    async function submitBlock(
        candidate,
        apiBase,
        mySession
    ) {
        if (
            !candidate ||
            !mining ||
            mySession !== sessionId
        ) {
            return {
                accepted: false,
                stale: true
            };
        }

        const response =
            await fetch(
                `${apiBase}/solo/submit`,
                {
                    method: "POST",
                    cache: "no-store",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Cache-Control":
                            "no-cache"
                    },
                    body: JSON.stringify({
                        candidate
                    })
                }
            );

        let result = null;

        try {
            result =
                await response.json();
        } catch (err) {
            result = {
                error:
                    `HTTP ${response.status}`
            };
        }

        return {
            httpOk: response.ok,
            ...result
        };
    }

    /*
     * --------------------------------------------------------
     * MAIN SOLO LOOP
     * --------------------------------------------------------
     */

    async function loop(
        minerAddress,
        apiBase,
        mySession
    ) {
        try {
            while (
                mining &&
                mySession === sessionId
            ) {
                /*
                 * 1. Pobierz aktualny blok pracy.
                 */
                let work;

                try {
                    work =
                        await getWork(
                            minerAddress,
                            apiBase,
                            mySession
                        );

                    if (!work) {
                        break;
                    }
                } catch (err) {
                    if (
                        !mining ||
                        mySession !== sessionId
                    ) {
                        break;
                    }

                    log(
                        `⚠️ Nie mogę pobrać work: ${err.message} — ponawiam za ${WORK_RETRY_DELAY_MS / 1000}s`,
                        "warn"
                    );

                    await sleep(
                        WORK_RETRY_DELAY_MS
                    );

                    continue;
                }

                currentWork = work;

                safeUpdate();

                log(
                    `⛏️ SOLO vMax: blok #${work.height} | ${workerCount} workerów | target=${work.blockTarget}`,
                    "info"
                );

                /*
                 * 2. Liczenie pełnego PoW.
                 */
                const candidate =
                    await mineOneBlockParallel(
                        work,
                        minerAddress,
                        apiBase,
                        mySession
                    );

                if (
                    !mining ||
                    mySession !== sessionId
                ) {
                    break;
                }

                if (!candidate) {
                    /*
                     * Wszystkie workery zatrzymały się
                     * bez znalezienia bloku.
                     */
                    continue;
                }

                /*
                 * 3. Zgłoś pełny blok.
                 */
                let result;

                try {
                    result =
                        await submitBlock(
                            candidate,
                            apiBase,
                            mySession
                        );
                } catch (err) {
                    log(
                        `⚠️ Błąd zgłaszania bloku: ${err.message} — pobieram work ponownie`,
                        "warn"
                    );

                    await sleep(
                        WORK_RETRY_DELAY_MS
                    );

                    continue;
                }

                /*
                 * 4. Sukces.
                 */
                if (
                    result.status ===
                    "mined"
                ) {
                    sessionStats.blocksFound++;

                    log(
                        `🎉🎉🎉 BLOK #${result.blockHeight} ZNALEZIONY SOLO! Nagroda: ${result.reward} BbC — CAŁA TWOJA!`,
                        "block"
                    );

                    safeUpdate();

                    /*
                     * Natychmiast pobierz następny
                     * blok. Nie używamy starego work.
                     */
                    currentWork = null;

                    continue;
                }

                /*
                 * 5. Stary blok / ktoś był szybszy.
                 */
                sessionStats.staleBlocks++;

                const reason =
                    result.reason ||
                    result.error ||
                    "blok odrzucony";

                log(
                    `⚠️ Aktualny blok stał się nieaktualny: ${reason} — pobieram nowe work`,
                    "warn"
                );

                currentWork = null;

                safeUpdate();

                /*
                 * Nie kopiemy starego nagłówka.
                 * vMax zawsze wraca po aktualny chain tip.
                 */
                await sleep(50);
            }
        } finally {
            if (
                mySession === sessionId
            ) {
                terminateWorkers();
                currentWork = null;
                miningPromise = null;
            }
        }
    }

    /*
     * --------------------------------------------------------
     * PUBLIC API
     * --------------------------------------------------------
     */

    return {
        start(
            minerAddress,
            apiBase,
            threads,
            callbacks = {}
        ) {
            if (mining) {
                return;
            }

            if (!minerAddress) {
                throw new Error(
                    "Brak adresu minera"
                );
            }

            mining = true;

            sessionId++;
            const mySession =
                sessionId;

            currentMinerAddress =
                String(minerAddress);

            currentApiBase =
                normalizeApiBase(
                    apiBase
                );

            workerCount =
                Math.max(
                    1,
                    Math.floor(
                        Number(threads) || 1
                    )
                );

            sessionStats = {
                attempts: 0,
                blocksFound: 0,
                staleBlocks: 0,
                rejectedBlocks: 0,
                startedAt: Date.now()
            };

            currentWork = null;

            lastHeartbeatTime = null;
            attemptsAtLastHeartbeat = 0;

            onUpdate =
                callbacks.onUpdate ||
                (() => {});

            onLog =
                callbacks.onLog ||
                (() => {});

            createWorkers(
                workerCount
            );

            log(
                `🚀 SOLO vMax LEGENDARY uruchomiony | ${workerCount} workerów`,
                "info"
            );

            safeUpdate();

            miningPromise =
                loop(
                    currentMinerAddress,
                    currentApiBase,
                    mySession
                );
        },

        stop() {
            if (!mining) {
                return;
            }

            mining = false;

            sessionId++;

            log(
                "🛑 SOLO mining zatrzymany",
                "info"
            );

            stopWorkers();
            terminateWorkers();

            currentWork = null;
            miningPromise = null;

            safeUpdate();
        },

        isMining() {
            return mining;
        },

        getStats() {
            return {
                ...sessionStats,
                mining,
                workerCount,
                currentHeight:
                    currentWork
                        ? currentWork.height
                        : null
            };
        },

        getCurrentWork() {
            return currentWork;
        }
    };
})();