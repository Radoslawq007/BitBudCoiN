const CONFIG = require("./config");
const { verifyTransactionSignature } = require("./wallet");

/**
 * Pula oczekujących, jeszcze niewykopanych transakcji. Trzymana w pamięci +
 * lustrzanie w bazie (przeżywa restart). Identyfikator transakcji = jej podpis
 * (unikalny per treść+klucz, stabilny niezależnie od tego, w jakim kształcie
 * obiekt akurat krąży - w mempoolu, w bloku, w wiadomości P2P).
 */
class Mempool {
    constructor(blockchain, storage) {
        this.blockchain = blockchain;
        this.storage = storage;
        this.pending = new Map(); // signature -> transakcja

        for (const tx of this.storage.loadMempool()) {
            this.pending.set(tx.signature, tx);
        }
        if (this.pending.size > 0) {
            console.log(`📥 Wczytano ${this.pending.size} oczekujących transakcji z bazy`);
        }
    }

    // Potwierdzone saldo pomniejszone o WŁASNE oczekujące transakcje nadawcy -
    // żeby nie dało się wysłać dwóch przelewów, które razem przekraczają saldo.
    // HTLC_CLAIM/HTLC_REFUND nie mają .from (nie tworzą nowego wydatku z
    // bieżącego salda - zwalniają środki zablokowane wcześniej przy
    // HTLC_CREATE), więc naturalnie nie wchodzą w ten warunek.
    getPendingAwareBalance(address) {
        let balance = this.blockchain.getBalance(address);
        for (const tx of this.pending.values()) {
            if (tx.from === address) balance -= tx.amount + (tx.fee || 0);
        }
        return balance;
    }

    addTransaction(tx) {
        if (!tx || typeof tx.amount !== "number" || !(tx.amount > 0)) {
            return { accepted: false, reason: "Nieprawidłowa kwota" };
        }
        const fee = typeof tx.fee === "number" ? tx.fee : 0;
        if (fee < CONFIG.MIN_FEE) {
            return { accepted: false, reason: `Opłata poniżej minimalnej (${CONFIG.MIN_FEE})` };
        }
        if (!tx.from || !tx.to) {
            return { accepted: false, reason: "Brak adresu nadawcy/odbiorcy" };
        }
        if (tx.from === tx.to) {
            return { accepted: false, reason: "Nadawca i odbiorca są tacy sami" };
        }
        if (!verifyTransactionSignature(tx)) {
            return { accepted: false, reason: "Nieprawidłowy podpis - transakcja odrzucona" };
        }
        if (this.pending.has(tx.signature)) {
            return { accepted: false, reason: "Ta transakcja już jest w mempoolu" };
        }

        const available = this.getPendingAwareBalance(tx.from);
        if (available < tx.amount + fee) {
            return {
                accepted: false,
                reason: `Niewystarczające saldo (dostępne z uwzględnieniem oczekujących: ${available})`
            };
        }

        const record = {
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
            fee,
            timestamp: tx.timestamp,
            publicKey: tx.publicKey,
            signature: tx.signature,
            receivedAt: Date.now()
        };

        this.pending.set(record.signature, record);
        this.storage.saveMempoolTx(record);
        return { accepted: true, signature: record.signature };
    }

    // DODANE (06.08.2026): server.js wolal to od dawna (/htlc/submit dla
    // HTLC_CREATE/CLAIM/REFUND) ale metoda nigdy nie istniala - kazda proba
    // swapa konczyla sie TypeError na serwerze. Analogiczne do
    // addTransaction(), ale dla trzech ksztaltow transakcji HTLC. Zaklada, ze
    // server.js JUZ wykonal wlasciwa walidacje przed wywolaniem (podpis,
    // istnienie HTLC, sekret, terminy - patrz /htlc/submit) - ta metoda
    // tylko zapisuje juz zweryfikowana transakcje do mempoola, tak samo jak
    // addTransaction() robi to dla zwyklych transferow.
    addHtlcTransaction(tx) {
        if (!tx || !tx.signature) {
            return { accepted: false, reason: "Brak podpisu transakcji" };
        }
        if (this.pending.has(tx.signature)) {
            return { accepted: false, reason: "Ta transakcja już jest w mempoolu" };
        }
        const record = {
            type: tx.type,
            htlcId: tx.htlcId,
            from: tx.from,
            claimant: tx.claimant,
            refundee: tx.refundee,
            secret: tx.secret,
            to: tx.to,
            amount: tx.amount,
            fee: tx.fee,
            hashLock: tx.hashLock,
            timeoutHeight: tx.timeoutHeight,
            timestamp: tx.timestamp,
            publicKey: tx.publicKey,
            signature: tx.signature,
            receivedAt: Date.now()
        };
        this.pending.set(record.signature, record);
        this.storage.saveMempoolTx(record);
        return { accepted: true, signature: record.signature };
    }

    // Wybiera transakcje do bloku: najwyższa opłata pierwsza, do limitu z configu,
    // pomijając te, które by się już nie zbilansowały względem POTWIERDZONEGO salda
    // (np. nadawca ma kilka transakcji w mempoolu, ale nie starcza na wszystkie naraz).
    // HTLC_CLAIM/HTLC_REFUND pomijają ten bilans celowo - zwalniają środki już
    // zablokowane przy HTLC_CREATE, nie tworzą nowego wydatku z bieżącego salda,
    // a ich uprawnienie (sekret/termin) zostało już zweryfikowane przed
    // trafieniem do mempoola (patrz /htlc/submit w server.js).
    selectForBlock() {
        const candidates = Array.from(this.pending.values()).sort((a, b) => (b.fee || 0) - (a.fee || 0));
        const selected = [];
        const spentSoFar = new Map();

        for (const tx of candidates) {
            if (selected.length >= CONFIG.MAX_TRANSACTIONS_PER_BLOCK) break;

            if (tx.type === "HTLC_CLAIM" || tx.type === "HTLC_REFUND") {
                selected.push(tx);
                continue;
            }

            const confirmed = this.blockchain.getBalance(tx.from);
            const already = spentSoFar.get(tx.from) || 0;
            const need = tx.amount + (tx.fee || 0);
            if (confirmed - already < need) continue;

            spentSoFar.set(tx.from, already + need);
            selected.push(tx);
        }

        return selected;
    }

    // Usuwa z mempoola transakcje, które właśnie trafiły do potwierdzonego bloku
    // (dowolne źródło: solo mining, pula, P2P) - dopasowanie po podpisie.
    // POPRAWKA (06.08.2026): wcześniej sprawdzało wyłącznie type==="transfer" -
    // transakcje HTLC nigdy nie były usuwane z mempoola po potwierdzeniu,
    // więc zostawałyby tam trwale i mogłyby zostać wybrane ponownie przez
    // selectForBlock() do kolejnego bloku (podwójne policzenie tej samej
    // operacji HTLC).
    pruneConfirmed(block) {
        const prunableTypes = new Set(["transfer", "HTLC_CREATE", "HTLC_CLAIM", "HTLC_REFUND"]);
        for (const tx of block.transactions) {
            if (prunableTypes.has(tx.type) && tx.signature && this.pending.has(tx.signature)) {
                this.pending.delete(tx.signature);
                this.storage.deleteMempoolTx(tx.signature);
            }
        }
    }

    // Po większej reorganizacji łańcucha (replaceChain) - usuwa transakcje, które
    // już się nie bilansują względem NOWEGO potwierdzonego salda. Uproszczenie:
    // transakcje z odrzuconej gałęzi nie wracają automatycznie do mempoola,
    // nadawca musiałby wysłać ponownie. HTLC_CLAIM/HTLC_REFUND pomijane z tego
    // samego powodu co w selectForBlock() - nie mają sensownego .from do
    // rewalidacji względem salda.
    revalidateAll() {
        for (const [signature, tx] of Array.from(this.pending.entries())) {
            if (tx.type === "HTLC_CLAIM" || tx.type === "HTLC_REFUND") continue;
            if (this.blockchain.getBalance(tx.from) < tx.amount + (tx.fee || 0)) {
                this.pending.delete(signature);
                this.storage.deleteMempoolTx(signature);
            }
        }
    }

    getPending() {
        return Array.from(this.pending.values());
    }
}

module.exports = Mempool;
