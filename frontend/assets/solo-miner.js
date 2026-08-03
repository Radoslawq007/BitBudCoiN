// Bezpieczne solo kopanie - liczy CAŁY blok (nie tylko share) w przeglądarce,
// całą nagrodę bierze bezpośrednio górnik (bez dzielenia z pulą). Serwer
// tylko weryfikuje gotowy wynik (szybko, nie blokuje nikogo).
//
// WIELOWĄTKOWE (31.07.2026): tak jak BrowserMiner - N Web Workerów liczy
// równolegle, każdy inny zakres nonce. Bez limitu prób na worker (solo i tak
// czeka aż znajdzie albo dostanie stop, nie "wygasa" jak share).

const SoloMiner = (() => {
    let mining = false;
    let sessionStats = { attempts: 0, blocksFound: 0 };
    let onUpdate = () => {};
    let onLog = () => {};
    let workers = [];
    let workerCount = 1;

    // Solo nie wysyła "shares" jak pula - serwer inaczej nie wie, że ktoś w danej
    // chwili kopie. Heartbeat co ~15s, poza właściwym liczeniem hashy, bez
    // wpływu na tempo - nie blokujący (fire and forget) i nie krytyczny (brak
    // połączenia po prostu pomija ten heartbeat, kopanie leci dalej).
    const HEARTBEAT_INTERVAL_MS = 15000;
    let lastHeartbeatTime = null;
    let attemptsAtLastHeartbeat = 0;

    function maybeSendHeartbeat(minerAddress, apiBase) {
        const now = Date.now();
        if (lastHeartbeatTime === null) {
            lastHeartbeatTime = now;
            attemptsAtLastHeartbeat = sessionStats.attempts;
            return;
        }
        if (now - lastHeartbeatTime < HEARTBEAT_INTERVAL_MS) return;

        const intervalSeconds = (now - lastHeartbeatTime) / 1000;
        const attemptsSinceLast = sessionStats.attempts - attemptsAtLastHeartbeat;
        lastHeartbeatTime = now;
        attemptsAtLastHeartbeat = sessionStats.attempts;

        fetch(`${apiBase}/solo/heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ minerAddress, attempts: attemptsSinceLast, intervalSeconds })
        }).catch(() => {
            // heartbeat to tylko informacja o aktywności - brak połączenia nie powinien przerywać kopania
        });
    }

    function createWorkers(count) {
        terminateWorkers();
        workers = [];
        for (let i = 0; i < count; i++) workers.push(new Worker("assets/mining-worker.js"));
    }
    function terminateWorkers() {
        workers.forEach((w) => w.terminate());
        workers = [];
    }

    // Ten sam wzorzec koordynacji co w BrowserMiner - patrz komentarz tam.
    // Różnica: bez maxAttemptsPerWorker (null) - solo liczy dopóki nie
    // znajdzie albo nie dostanie stop, nigdy nie "wygasa" samo z siebie.
    function mineOneBlockParallel(work, minerAddress, apiBase) {
        return new Promise((resolve) => {
            let settled = false;
            let finishedCount = 0;
            workers.forEach((worker, i) => {
                worker.onmessage = (e) => {
                    const msg = e.data;
                    if (msg.type === "progress") {
                        sessionStats.attempts += msg.attempts;
                        onUpdate(sessionStats);
                        maybeSendHeartbeat(minerAddress, apiBase);
                    } else if (msg.type === "found" && !settled) {
                        settled = true;
                        sessionStats.attempts += msg.attempts;
                        workers.forEach((w) => w.postMessage({ type: "stop" }));
                        resolve(msg.candidate);
                    } else if (msg.type === "stopped" && !settled) {
                        if (msg.attempts) sessionStats.attempts += msg.attempts;
                        finishedCount++;
                        if (finishedCount === workers.length) { settled = true; resolve(null); }
                    }
                };
                worker.postMessage({
                    type: "mine", work, targetField: "blockTarget",
                    workerIndex: i, workerCount, maxAttemptsPerWorker: null
                });
            });
        });
    }

    async function loop(minerAddress, apiBase) {
        while (mining) {
            let work;
            try {
                const res = await fetch(`${apiBase}/solo/work?minerAddress=${encodeURIComponent(minerAddress)}`);
                work = await res.json();
                if (!res.ok || !work || !work.blockTarget) {
                    onLog(`⚠️ Serwer: ${(work && (work.error || work.reason)) || "nieprawidłowa odpowiedź"} — czekam 5s...`, "warn");
                    await new Promise((r) => setTimeout(r, 5000));
                    continue;
                }
            } catch (err) {
                onLog("⚠️ Brak połączenia, ponawiam za 3s...", "warn");
                await new Promise((r) => setTimeout(r, 3000));
                continue;
            }

            const candidate = await mineOneBlockParallel(work, minerAddress, apiBase);
            if (!mining || !candidate) break;

            try {
                const res = await fetch(`${apiBase}/solo/submit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ candidate })
                });
                const result = await res.json();

                if (result.status === "mined") {
                    sessionStats.blocksFound++;
                    onLog(`🎉🎉 BLOK #${result.blockHeight} ZNALEZIONY SOLO! Nagroda: ${result.reward} BbC — cała Twoja!`, "block");
                } else if (!res.ok && (result.error || "").toLowerCase().includes("zapyt")) {
                    onLog(`⚠️ Serwer: ${result.error} — czekam 3s...`, "warn");
                    await new Promise((r) => setTimeout(r, 3000));
                } else {
                    onLog(`Ktoś był szybszy o ten blok, próbuję dalej: ${result.reason || result.error}`, "warn");
                }
                onUpdate(sessionStats);
            } catch (err) {
                onLog("⚠️ Błąd zgłaszania, ponawiam za 3s...", "warn");
                await new Promise((r) => setTimeout(r, 3000));
            }
        }
        terminateWorkers();
    }

    return {
        start(minerAddress, apiBase, threads, callbacks = {}) {
            if (mining) return;
            mining = true;
            workerCount = Math.max(1, Number(threads) || 1);
            sessionStats = { attempts: 0, blocksFound: 0 };
            lastHeartbeatTime = null;
            attemptsAtLastHeartbeat = 0;
            onUpdate = callbacks.onUpdate || (() => {});
            onLog = callbacks.onLog || (() => {});
            createWorkers(workerCount);
            loop(minerAddress, apiBase);
        },
        stop() {
            mining = false;
            workers.forEach((w) => w.postMessage({ type: "stop" }));
        },
        isMining() { return mining; }
    };
})();
