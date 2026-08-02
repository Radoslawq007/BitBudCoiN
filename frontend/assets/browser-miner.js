// Kopanie w przeglądarce - działa dopóki karta jest otwarta, bez instalowania
// niczego. Liczy hashe tym samym algorytmem co backend/bbcblockchain.js,
// żeby zgłoszone shares były akceptowane, nie odrzucane.

const BrowserMiner = (() => {
    let mining = false;
    let sessionStats = { shares: 0, blocksFound: 0, attempts: 0 };
    let onUpdate = () => {};
    let onLog = () => {};

    async function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
        const str = height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce;
        const bytes = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function mineOneShare(work, apiBase) {
        const candidate = {
            height: work.height,
            previousHash: work.previousHash,
            timestamp: work.timestamp,
            transactions: work.transactions,
            difficulty: work.difficulty,
            nonce: 0
        };
        let hash = await computeBlockHash(candidate);
        const maxAttempts = 300000;

        while (hash > work.shareTarget) {
            if (!mining) return null;
            candidate.nonce++;
            sessionStats.attempts++;
            if (candidate.nonce % 200 === 0) onUpdate(sessionStats);
            if (candidate.nonce % 500 === 0) await new Promise((r) => setTimeout(r, 0));
            if (candidate.nonce >= maxAttempts) return "expired";
            hash = await computeBlockHash(candidate);
        }
        candidate.hash = hash;
        return candidate;
    }

    async function loop(minerAddress, apiBase) {
        while (mining) {
            let work;
            try {
                const res = await fetch(`${apiBase}/pool/work?minerAddress=${encodeURIComponent(minerAddress)}`);
                work = await res.json();
                // Tak samo jak w SoloMiner: jeśli serwer odpowiedział błędem (np.
                // limit zapytań), "work" nie ma oczekiwanych pól - kopanie na takich
                // danych kończyło się natychmiastowym, fałszywym wynikiem i pętlą
                // bez przerwy, która dobijała serwer jeszcze bardziej.
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

            const candidate = await mineOneShare(work, apiBase);
            if (!mining) break;
            if (candidate === "expired") continue;
            if (!candidate) continue;

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
    }

    return {
        start(minerAddress, apiBase, callbacks = {}) {
            if (mining) return;
            mining = true;
            sessionStats = { shares: 0, blocksFound: 0, attempts: 0 };
            onUpdate = callbacks.onUpdate || (() => {});
            onLog = callbacks.onLog || (() => {});
            loop(minerAddress, apiBase);
        },
        stop() {
            mining = false;
        },
        isMining() {
            return mining;
        },
        getStats() {
            return sessionStats;
        }
    };
})();
