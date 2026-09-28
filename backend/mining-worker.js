// Worker liczący hashe w osobnym wątku przeglądarki - dzięki temu kopanie
// faktycznie wykorzystuje wiele rdzeni CPU, nie tylko jeden wątek główny
// (poprzednia wersja nie miała żadnego mechanizmu wielowątkowości - to jest
// dokładnie ta funkcja, którą wcześniej obiecano na forum).
//
// Każdy worker dostaje inny punkt startowy nonce (workerIndex) i ten sam
// krok (workerCount) - worker i sprawdza i, i+N, i+2N... - żaden nie liczy
// tego samego co inny, razem pokrywają całą przestrzeń tak jak jeden wątek.

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

    // NAPRAWA (24.09.2026): SOLO "Live" H/s bazuje od 20.09 wylacznie na
    // /solo/share (patrz server.js, SOLO_SHARE_DIFFICULTY_DIVISOR) - ten
    // worker nigdy nie zglaszal share'ow, tylko pelne bloki ("found"),
    // wiec Live zawsze pokazywalo 0. Dodatkowy, LZEJSZY prog obok
    // istniejacego blockTarget - nie zatrzymuje petli, szuka dalej
    // pelnego bloku.
    // POOL: tam work TEZ ma pole shareTarget, ale to jest wtedy glowny
    // prog petli (targetField === "shareTarget", "found" = share dla
    // puli) - dodatkowa kontrola jest jawnie wylaczona, zero zmiany
    // zachowania dla POOL.
    const shareTargetHex =
        targetField !== "shareTarget" &&
        typeof work.shareTarget === "string"
            ? work.shareTarget
            : null;

    const candidate = {
        height: work.height, previousHash: work.previousHash, timestamp: work.timestamp,
        transactions: work.transactions, difficulty: work.difficulty, nonce: workerIndex
    };
    let hash = await computeBlockHash(candidate);
    let localAttempts = 0;
    let sinceLastReport = 0;

    while (hash > targetHex) {
        if (shouldStop) {
            self.postMessage({ type: "stopped", attempts: sinceLastReport });
            return;
        }
        if (shareTargetHex !== null && hash <= shareTargetHex) {
            self.postMessage({ type: "share", candidate: { ...candidate, hash } });
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
        hash = await computeBlockHash(candidate);
    }
    candidate.hash = hash;
    self.postMessage({ type: "found", candidate, attempts: sinceLastReport });
};
