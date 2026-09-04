"use strict";
// htlc-wallet.js - weryfikacja podpisów Ed25519 dla trzech akcji HTLC
// (create/claim/refund). Ten plik w ogóle nie istniał w repo - server.js
// robi "require('./htlc-wallet')" na starcie, więc bez niego serwer się
// w ogóle nie podnosi.
//
// Struktura skopiowana 1:1 z verifyTransactionSignature() w wallet.js
// (ten sam mechanizm co zwykłe transakcje - identyczny wzorzec jak w
// swap-offers-auth.js dla ofert swapu). Różnica: która transakcja
// "reprezentuje" ten podpis. Dla zwykłej transakcji to zawsze "from" -
// tutaj zależy od akcji:
//   HTLC_CREATE -> "from"       (kto zakłada blokadę)
//   HTLC_CLAIM  -> "claimant"   (kto odbiera)
//   HTLC_REFUND -> "refundee"   (kto dostaje zwrot)
//
// Payloady (htlcCreatePayload/htlcClaimPayload/htlcRefundPayload) importowane
// z wallet.js - TAM jest ich jedyne źródło prawdy (to samo co
// frontend/wallet.html oczekuje w komentarzu przy budowaniu payloadu),
// żeby nie było dwóch niezależnych kopii tej samej logiki podpisu.

const crypto = require("crypto");
const {
    deriveAddress,
    htlcCreatePayload,
    htlcClaimPayload,
    htlcRefundPayload
} = require("./wallet");

// identityField: nazwa pola w tx, które MUSI się zgadzać z adresem
// wyprowadzonym z tx.publicKey (np. "from", "claimant", "refundee").
// payloadFn: buduje canonical JSON.stringify z pól tx (z wallet.js).
function verifySigned(tx, identityField, payloadFn) {

    try {

        if (!tx || typeof tx !== "object") {
            return false;
        }

        if (
            typeof tx.publicKey !== "string" ||
            typeof tx.signature !== "string" ||
            typeof tx[identityField] !== "string"
        ) {
            return false;
        }

        const publicKey = crypto.createPublicKey(tx.publicKey);

        if (publicKey.asymmetricKeyType !== "ed25519") {
            return false;
        }

        const expectedAddress = deriveAddress(tx.publicKey);

        if (expectedAddress !== tx[identityField]) {
            return false;
        }

        const payload = payloadFn(tx);

        let signature;
        try {
            signature = Buffer.from(tx.signature, "base64");
        } catch (err) {
            return false;
        }

        if (signature.length === 0) {
            return false;
        }

        return crypto.verify(
            null,
            Buffer.from(payload, "utf8"),
            publicKey,
            signature
        );

    } catch (err) {
        return false;
    }
}

function verifyHtlcCreateSignature(tx) {
    return verifySigned(tx, "from", htlcCreatePayload);
}

function verifyHtlcClaimSignature(tx) {
    return verifySigned(tx, "claimant", htlcClaimPayload);
}

function verifyHtlcRefundSignature(tx) {
    return verifySigned(tx, "refundee", htlcRefundPayload);
}

module.exports = {
    verifyHtlcCreateSignature,
    verifyHtlcClaimSignature,
    verifyHtlcRefundSignature
};
