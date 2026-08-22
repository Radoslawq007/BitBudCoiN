// =====================================================
// BitBudCoin Core
// transaction.js vMax
// =====================================================

"use strict";

const crypto = require("crypto");
const Wallet = require("./wallet");

class Transaction {

    constructor(
        from,
        to,
        amount,
        fee = 0,
        publicKey = null,
        signature = null,
        timestamp = Date.now()
    ) {
        this.from = from;
        this.to = to;
        this.amount = amount;
        this.fee = fee;
        this.timestamp = timestamp;

        // Zgodne z wallet.js
        this.publicKey = publicKey;
        this.signature = signature;

        this.txid = this.calculateId();
    }

    /*
     * =====================================================
     * TXID
     * =====================================================
     *
     * txid identyfikuje treść transakcji.
     *
     * Podpis NIE jest częścią txid.
     * Dzięki temu podpis nie zmienia identyfikatora.
     */

    calculateId() {
        const data = JSON.stringify({
            from: this.from,
            to: this.to,
            amount: this.amount,
            fee: this.fee,
            timestamp: this.timestamp
        });

        return crypto
            .createHash("sha256")
            .update(data)
            .digest("hex");
    }

    /*
     * =====================================================
     * PAYLOAD DO PODPISU
     * =====================================================
     *
     * Musi być identyczny po stronie portfela
     * i po stronie weryfikującej.
     */

    getPayload() {
        return {
            from: this.from,
            to: this.to,
            amount: this.amount,
            fee: this.fee,
            timestamp: this.timestamp
        };
    }

    /*
     * =====================================================
     * SIGNED TRANSACTION
     * =====================================================
     */

    static createSigned(
        fromWallet,
        to,
        amount,
        fee = 0
    ) {
        if (!fromWallet) {
            throw new Error(
                "Brak portfela nadawcy"
            );
        }

        if (!fromWallet.address) {
            throw new Error(
                "Portfel nie posiada adresu"
            );
        }

        if (!fromWallet.publicKey) {
            throw new Error(
                "Portfel nie posiada klucza publicznego"
            );
        }

        if (
            typeof fromWallet.signTransaction !==
                "function" &&
            typeof fromWallet.sign !==
                "function"
        ) {
            throw new Error(
                "Portfel nie posiada funkcji podpisywania"
            );
        }

        const tx =
            new Transaction(
                fromWallet.address,
                to,
                amount,
                fee,
                fromWallet.publicKey,
                null
            );

        const payload =
            tx.getPayload();

        /*
         * Obsługujemy zarówno:
         *
         * wallet.signTransaction(...)
         *
         * jak i starszy:
         *
         * wallet.sign(...)
         */

        if (
            typeof fromWallet.signTransaction ===
            "function"
        ) {
            tx.signature =
                fromWallet.signTransaction(
                    payload
                );
        } else {
            tx.signature =
                fromWallet.sign(
                    payload
                );
        }

        /*
         * TXID liczymy ponownie po przygotowaniu
         * całej treści transakcji.
         */
        tx.txid =
            tx.calculateId();

        return tx;
    }

    /*
     * =====================================================
     * SIGNATURE VALIDATION
     * =====================================================
     */

    isSignatureValid() {

        /*
         * Coinbase / genesis nie posiada podpisu
         * nadawcy.
         */
        if (this.from === null) {
            return true;
        }

        if (!this.from) {
            return false;
        }

        if (!this.publicKey) {
            return false;
        }

        if (!this.signature) {
            return false;
        }

        try {

            /*
             * Klucz publiczny musi wyprowadzać
             * dokładnie ten adres "from".
             */
            const expectedAddress =
                Wallet.deriveAddress(
                    this.publicKey
                );

            if (
                expectedAddress !==
                this.from
            ) {
                return false;
            }

            /*
             * Sprawdzenie podpisu.
             */
            if (
                typeof Wallet.verifyTransactionSignature ===
                "function"
            ) {
                return Wallet.verifyTransactionSignature({
                    from: this.from,
                    to: this.to,
                    amount: this.amount,
                    fee: this.fee,
                    timestamp: this.timestamp,
                    publicKey: this.publicKey,
                    signature: this.signature
                });
            }

            /*
             * Fallback dla Wallet.verifySignature()
             * jeżeli starsza wersja wallet.js go posiada.
             */
            if (
                typeof Wallet.verifySignature ===
                "function"
            ) {
                return Wallet.verifySignature(
                    this.publicKey,
                    this.getPayload(),
                    this.signature
                );
            }

            return false;

        } catch (err) {
            return false;
        }
    }

    /*
     * =====================================================
     * BASIC VALIDATION
     * =====================================================
     */

    isValid() {

        if (
            !this.to ||
            typeof this.to !==
                "string"
        ) {
            return false;
        }

        if (
            typeof this.amount !==
                "number" ||
            !Number.isFinite(
                this.amount
            ) ||
            this.amount <= 0
        ) {
            return false;
        }

        if (
            typeof this.fee !==
                "number" ||
            !Number.isFinite(
                this.fee
            ) ||
            this.fee < 0
        ) {
            return false;
        }

        if (
            typeof this.timestamp !==
                "number" ||
            !Number.isFinite(
                this.timestamp
            ) ||
            this.timestamp <= 0
        ) {
            return false;
        }

        /*
         * TXID musi odpowiadać treści.
         */
        if (
            this.txid !==
            this.calculateId()
        ) {
            return false;
        }

        /*
         * Coinbase nie wymaga podpisu.
         */
        if (
            this.from === null
        ) {
            return true;
        }

        return this.isSignatureValid();
    }

    /*
     * =====================================================
     * SERIALIZATION
     * =====================================================
     */

    toJSON() {
        return {
            from: this.from,
            to: this.to,
            amount: this.amount,
            fee: this.fee,
            timestamp: this.timestamp,
            publicKey: this.publicKey,
            signature: this.signature,
            txid: this.txid
        };
    }

    /*
     * =====================================================
     * DESERIALIZATION
     * =====================================================
     */

    static fromJSON(data) {

        if (!data) {
            throw new Error(
                "Brak danych transakcji"
            );
        }

        const tx =
            new Transaction(
                data.from ?? null,
                data.to,
                data.amount,
                data.fee ?? 0,
                data.publicKey ??
                    data.fromPublicKey ??
                    null,
                data.signature ??
                    null,
                data.timestamp
            );

        /*
         * Zachowujemy istniejący txid,
         * jeżeli został dostarczony.
         */
        if (data.txid) {
            tx.txid =
                data.txid;
        }

        return tx;
    }
}

module.exports =
    Transaction;