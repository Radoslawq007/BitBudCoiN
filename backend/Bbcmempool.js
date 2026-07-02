// =====================================================
// BitBudCoin Core
// mempool.js
// =====================================================

class Mempool {
    constructor() {
        this.transactions = [];
    }

    addTransaction(tx) {
        // tu możesz dodać walidację (np. duplikaty, fee, itd.)
        this.transactions.push(tx);
    }

    removeTransaction(txid) {
        this.transactions = this.transactions.filter(
            (tx) => tx.txid !== txid
        );
    }

    clear() {
        this.transactions = [];
    }
}

module.exports = Mempool;