// =====================================================
// BitBudCoin Core
// transaction.js
// =====================================================

class Transaction {
    constructor(from, to, amount, fee) {
        this.from = from;
        this.to = to;
        this.amount = amount;
        this.fee = fee;
        this.timestamp = Date.now();
        this.txid = this.calculateId();
    }

    calculateId() {
        const crypto = require("crypto");
        const data =
            this.from +
            this.to +
            this.amount +
            this.fee +
            this.timestamp;

        return crypto.createHash("sha256").update(data).digest("hex");
    }
}

module.exports = Transaction;