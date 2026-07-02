// =====================================================
// BitBudCoin Core
// transaction.js vMax
// =====================================================

const crypto = require("crypto");
const Wallet = require("./wallet");

class Transaction {
    constructor(from, to, amount, fee, fromPublicKey = null, signature = null) {
        this.from = from;
        this.to = to;
        this.amount = amount;
        this.fee = fee;
        this.timestamp = Date.now();

        this.fromPublicKey = fromPublicKey;
        this.signature = signature;

        this.txid = this.calculateId();
    }

    calculateId() {
        const data =
            (this.from || "") +
            this.to +
            this.amount +
            this.fee +
            this.timestamp;

        return crypto.createHash("sha256").update(data).digest("hex");
    }

    getPayload() {
        return {
            from: this.from,
            to: this.to,
            amount: this.amount,
            fee: this.fee,
            timestamp: this.timestamp,
            txid: this.txid
        };
    }

    static createSigned(fromWallet, to, amount, fee) {
        const tx = new Transaction(
            fromWallet.address,
            to,
            amount,
            fee,
            fromWallet.publicKey,
            null
        );

        const payload = tx.getPayload();
        tx.signature = fromWallet.sign(payload);

        return tx;
    }

    isSignatureValid() {
        if (this.from === null) return true;
        if (!this.fromPublicKey || !this.signature) return false;

        const payload = this.getPayload();
        return Wallet.verifySignature(
            this.fromPublicKey,
            payload,
            this.signature
        );
    }
}

module.exports = Transaction;