// Bezpieczne solo kopanie - liczy CAŁY blok (nie tylko share) w przeglądarce,
// całą nagrodę bierze bezpośrednio górnik (bez dzielenia z pulą). Serwer
// tylko weryfikuje gotowy wynik (szybko, nie blokuje nikogo) - dokładnie
// tym samym bezpiecznym wzorcem co kopanie przez pulę w BrowserMiner.

const SoloMiner = (() => {
    let mining = false;
    let sessionStats = { attempts: 0, blocksFound: 0 };
    let onUpdate = () => {};
    let onLog = () => {};

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

    async function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
        const str = height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce;
        const bytes = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function mineOneBlock(work, minerAddress, apiBase) {
        const candidate = {
            height: work.height, previousHash: work.previousHash, timestamp: work.timestamp,
            transactions: work.transactions, difficulty: work.difficulty, nonce: 0
        };
        let hash = await computeBlockHash(candidate);

        while (hash > work.blockTarget) {
            if (!mining) return null;
            candidate.nonce++;
            sessionStats.attempts++;
            if (candidate.nonce % 300 === 0) onUpdate(sessionStats);
            if (candidate.nonce % 300 === 0) maybeSendHeartbeat(minerAddress, apiBase);
            if (candidate.nonce % 500 === 0) await new Promise((r) => setTimeout(r, 0));
            hash = await computeBlockHash(candidate);
        }
        candidate.hash = hash;
        return candidate;
    }

    async function loop(minerAddress, apiBase) {
        while (mining) {
            let work;
            try {
                const res = await fetch(`${apiBase}/solo/work?minerAddress=${encodeURIComponent(minerAddress)}`);
                work = await res.json();
                // KRYTYCZNE: jeśli serwer odpowiedział błędem (np. limit zapytań),
                // "work" nie ma oczekiwanych pól (blockTarget itd.) - kopanie na
                // takich danych kończyło się natychmiastowym, fałszywym "znalezieniem"
                // bloku i pętlą bez przerwy, która dobijała serwer jeszcze bardziej.
                // Teraz: sprawdzamy że dane są prawdziwe, zanim cokolwiek policzymy.
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

            const candidate = await mineOneBlock(work, minerAddress, apiBase);
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
                    // Odrzucone przez limit zapytań, nie przez przegraną o blok -
                    // to rozróżnienie jest ważne, żeby nie hamować dalej bez przerwy.
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
    }

    return {
        start(minerAddress, apiBase, callbacks = {}) {
            if (mining) return;
            mining = true;
            sessionStats = { attempts: 0, blocksFound: 0 };
            lastHeartbeatTime = null;
            attemptsAtLastHeartbeat = 0;
            onUpdate = callbacks.onUpdate || (() => {});
            onLog = callbacks.onLog || (() => {});
            loop(minerAddress, apiBase);
        },
        stop() { mining = false; },
        isMining() { return mining; }
    };
})();
