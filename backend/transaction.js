// =====================================================
// BitBudCoin Core
// transaction.js vMax
// =====================================================

const crypto = require("crypto");
const Wallet = require("./wallet");

class Transaction {
    constructor(from, to, amount, fee, fromPublicKey = null, signature = null) {
        this.from = from;                 // adres BbC...
        this.to = to;                     // adres BbC...
        this.amount = amount;
        this.fee = fee;
        this.timestamp = Date.now();

        this.fromPublicKey = fromPublicKey; // hex publicznego klucza
        this.signature = signature;         // hex DER

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

    // payload do podpisu (bez signature)
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

    // tworzenie transakcji podpisanej z walleta
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
        const signature = fromWallet.sign(payload);

        tx.signature = signature;

        return tx;
    }

    // weryfikacja podpisu
    isSignatureValid() {
        // coinbase (from = null) nie ma podpisu
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