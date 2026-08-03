// Kopanie w przeglądarce - działa dopóki karta jest otwarta, bez instalowania
// niczego. Liczy hashe tym samym algorytmem co backend/bbcblockchain.js,
// żeby zgłoszone shares były akceptowane, nie odrzucane.
//
// WIELOWĄTKOWE (31.07.2026): zamiast jednej pętli na głównym wątku, teraz
// N Web Workerów liczy równolegle, każdy inny zakres nonce - realnie
// wykorzystuje wiele rdzeni CPU. Liczba wątków wybierana przez użytkownika
// w miner.html.

const BrowserMiner = (() => {
    let mining = false;
    let sessionStats = { shares: 0, blocksFound: 0, attempts: 0 };
    let onUpdate = () => {};
    let onLog = () => {};
    let workers = [];
    let workerCount = 1;

    function createWorkers(count) {
        terminateWorkers();
        workers = [];
        for (let i = 0; i < count; i++) workers.push(new Worker("assets/mining-worker.js"));
    }
    function terminateWorkers() {
        workers.forEach((w) => w.terminate());
        workers = [];
    }

    // Rozdziela JEDNĄ rundę (szukanie jednego share'a) między wszystkich
    // workerów naraz. Pierwszy komunikat "found" wygrywa wyścig, reszta
    // dostaje "stop". Rozwiązuje się DOKŁADNIE RAZ, niezależnie od tego czy
    // ktoś znalazł, wszyscy wyczerpali limit, czy użytkownik zatrzymał
    // kopanie w trakcie (inaczej pętla główna zawiesiłaby się bez końca).
    function mineOneShareParallel(work) {
        const maxAttemptsPerWorker = Math.ceil(300000 / workerCount);
        return new Promise((resolve) => {
            let settled = false;
            let finishedCount = 0;
            workers.forEach((worker, i) => {
                worker.onmessage = (e) => {
                    const msg = e.data;
                    if (msg.type === "progress") {
                        sessionStats.attempts += msg.attempts;
                        onUpdate(sessionStats);
                    } else if (msg.type === "found" && !settled) {
                        settled = true;
                        sessionStats.attempts += msg.attempts;
                        workers.forEach((w) => w.postMessage({ type: "stop" }));
                        resolve(msg.candidate);
                    } else if ((msg.type === "expired" || msg.type === "stopped") && !settled) {
                        if (msg.attempts) sessionStats.attempts += msg.attempts;
                        finishedCount++;
                        if (finishedCount === workers.length) {
                            settled = true;
                            resolve(mining ? "expired" : "stopped");
                        }
                    }
                };
                worker.postMessage({
                    type: "mine", work, targetField: "shareTarget",
                    workerIndex: i, workerCount, maxAttemptsPerWorker
                });
            });
        });
    }

    async function loop(minerAddress, apiBase) {
        while (mining) {
            let work;
            try {
                const res = await fetch(`${apiBase}/pool/work?minerAddress=${encodeURIComponent(minerAddress)}`);
                work = await res.json();
                // Jeśli serwer odpowiedział błędem (np. limit zapytań), "work" nie
                // ma oczekiwanych pól - kopanie na takich danych kończyło się
                // wcześniej natychmiastowym, fałszywym wynikiem i pętlą bez
                // przerwy, która dobijała serwer jeszcze bardziej.
                if (!res.ok || !work || !work.shareTarget) {
                    onLog(`⚠️ Serwer: ${(work && (work.error || work.reason)) || "nieprawidłowa odpowiedź"} — czekam 5s...`, "warn");
                    await new Promise((r) => setTimeout(r, 5000));
                    continue;
                }
            } catch (err) {
                onLog("⚠️ Brak połączenia z serwerem, ponawiam za 3s...", "warn");
                await new Promise((r) => setTimeout(r, 3000));
                continue;
            }

            const candidate = await mineOneShareParallel(work);
            if (!mining || candidate === "stopped") break;
            if (candidate === "expired") continue;

            try {
                const res = await fetch(`${apiBase}/pool/submit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ minerAddress, candidate })
                });
                const result = await res.json();

                if (result.blockFound) {
                    sessionStats.blocksFound++;
                    onLog(`🎉 Blok #${result.block.height} znaleziony!`, "block");
                } else if (result.accepted) {
                    sessionStats.shares++;
                    onLog(`Share zaakceptowany (#${sessionStats.shares})`, "share");
                } else if (!res.ok && (result.error || "").toLowerCase().includes("zapyt")) {
                    onLog(`⚠️ Serwer: ${result.error} — czekam 3s...`, "warn");
                    await new Promise((r) => setTimeout(r, 3000));
                } else {
                    onLog(`Odrzucone: ${result.reason}`, "warn");
                }
                onUpdate(sessionStats);
            } catch (err) {
                onLog("⚠️ Błąd zgłaszania share, ponawiam za 3s...", "warn");
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
            sessionStats = { shares: 0, blocksFound: 0, attempts: 0 };
            onUpdate = callbacks.onUpdate || (() => {});
            onLog = callbacks.onLog || (() => {});
            createWorkers(workerCount);
            loop(minerAddress, apiBase);
        },
        stop() {
            mining = false;
            workers.forEach((w) => w.postMessage({ type: "stop" }));
        },
        isMining() {
            return mining;
        },
        getStats() {
            return sessionStats;
        }
    };
})();
