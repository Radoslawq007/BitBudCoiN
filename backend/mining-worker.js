// Worker liczący hashe w osobnym wątku przeglądarki - dzięki temu kopanie
// faktycznie wykorzystuje wiele rdzeni CPU, nie tylko jeden wątek główny.
//
// Każdy worker dostaje inny punkt startowy nonce (workerIndex) i ten sam
// krok (workerCount) - worker i sprawdza i, i+N, i+2N... - żaden nie liczy
// tego samego co inny, razem pokrywają całą przestrzeń tak jak jeden wątek.
//
// NAPRAWA (20.09.2026): dodane opcjonalne sprawdzanie "share" - lżejszy,
// łatwiejszy próg niż prawdziwy blok (work.shareTarget, patrz /solo/work).
// To NIE jest dodatkowe hashowanie - to jedno porównanie stringów na hash,
// który i tak już liczymy próbując znaleźć prawdziwy blok. Share'y lecą
// do /solo/share (patrz solo-miner.js), gdzie serwer je realnie
// weryfikuje - to zastępuje stary, niczym niezweryfikowany heartbeat.

async function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
    const str = height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce;
    const bytes = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let shouldStop = false;
const PROGRESS_EVERY = 200;

self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === "stop") { shouldStop = true; return; }
    if (msg.type !== "mine") return;

    shouldStop = false;
    const { work, targetField, workerIndex, workerCount, maxAttemptsPerWorker } = msg;
    const targetHex = work[targetField];

    // Opcjonalny, lzejszy prog - brak pola (starszy /solo/work bez
    // aktualizacji) po prostu wylacza sprawdzanie share'ow, reszta
    // dziala dokladnie jak wczesniej.
    const shareTargetHex = work.shareTarget || null;

    const candidate = {
        height: work.height, previousHash: work.previousHash, timestamp: work.timestamp,
        transactions: work.transactions, difficulty: work.difficulty, nonce: workerIndex
    };

    let localAttempts = 0;
    let sinceLastReport = 0;

    for (;;) {
        const hash = await computeBlockHash(candidate);

        if (shareTargetHex && hash <= shareTargetHex) {
            self.postMessage({
                type: "share",
                candidate: { ...candidate, hash },
                attempts: sinceLastReport
            });
            sinceLastReport = 0;
        }

        if (hash <= targetHex) {
            self.postMessage({
                type: "found",
                candidate: { ...candidate, hash },
                attempts: sinceLastReport
            });
            return;
        }

        if (shouldStop) {
            self.postMessage({ type: "stopped", attempts: sinceLastReport });
            return;
        }

        candidate.nonce += workerCount;
        localAttempts++;
        sinceLastReport++;

        if (sinceLastReport >= PROGRESS_EVERY) {
            self.postMessage({ type: "progress", attempts: sinceLastReport });
            sinceLastReport = 0;
        }

        if (maxAttemptsPerWorker && localAttempts >= maxAttemptsPerWorker) {
            self.postMessage({ type: "expired", attempts: sinceLastReport });
            return;
        }
    }
};
