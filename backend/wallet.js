// =====================================================
// BitBudCoin Wallet
// wallet.js
// vMax LEGENDARY MODE
// =====================================================
//
// Ed25519
// Zero zewnętrznych zależności.
// Prywatny klucz pozostaje lokalnie.
//
// Adres:
//   BbC + pierwsze 40 znaków SHA-256
//   klucza publicznego SPKI DER.
//
// Serwer:
//   - nie potrzebuje klucza prywatnego
//   - weryfikuje publicKey
//   - wyprowadza z niego adres
//   - weryfikuje podpis transakcji
// =====================================================

"use strict";

const crypto = require("crypto");

const ADDRESS_PREFIX = "BbC";
const ADDRESS_HASH_LENGTH = 40;


/*
 * =====================================================
 * PUBLIC KEY -> ADDRESS
 * =====================================================
 */

function deriveAddress(publicKeyPem) {

    const publicKey =
        crypto.createPublicKey(
            publicKeyPem
        );

    const der =
        publicKey.export({
            type: "spki",
            format: "der"
        });

    const hash =
        crypto
            .createHash("sha256")
            .update(der)
            .digest("hex");

    return (
        ADDRESS_PREFIX +
        hash.slice(
            0,
            ADDRESS_HASH_LENGTH
        )
    );
}


/*
 * =====================================================
 * WALLET GENERATION
 * =====================================================
 *
 * Ed25519 jest dostępne natywnie w Node.js.
 */

function generateWallet() {

    const {
        publicKey,
        privateKey
    } =
        crypto.generateKeyPairSync(
            "ed25519"
        );

    const publicKeyPem =
        publicKey.export({
            type: "spki",
            format: "pem"
        });

    const privateKeyPem =
        privateKey.export({
            type: "pkcs8",
            format: "pem"
        });

    return {

        address:
            deriveAddress(
                publicKeyPem
            ),

        publicKey:
            publicKeyPem,

        privateKey:
            privateKeyPem
    };
}


/*
 * =====================================================
 * CANONICAL TRANSACTION PAYLOAD
 * =====================================================
 *
 * UWAGA:
 *
 * To jest część konsensusu podpisów.
 *
 * Nie dodajemy tutaj:
 *   - publicKey
 *   - signature
 *   - type
 *
 * ponieważ istniejący format transakcji
 * podpisuje dokładnie te pola:
 *
 *   from
 *   to
 *   amount
 *   fee
 *   timestamp
 *
 * Kolejność pozostaje stała.
 */

function signingPayload({
    from,
    to,
    amount,
    fee,
    timestamp
}) {

    return JSON.stringify({
        from,
        to,
        amount,
        fee,
        timestamp
    });
}


/*
 * =====================================================
 * SIGN TRANSACTION
 * =====================================================
 */

function signTransaction(
    {
        from,
        to,
        amount,
        fee,
        timestamp
    },
    privateKeyPem
) {

    const payload =
        signingPayload({
            from,
            to,
            amount,
            fee,
            timestamp
        });

    const signature =
        crypto.sign(
            null,
            Buffer.from(
                payload,
                "utf8"
            ),
            privateKeyPem
        );

    return signature.toString(
        "base64"
    );
}


/*
 * =====================================================
 * VERIFY TRANSACTION SIGNATURE
 * =====================================================
 *
 * Zwraca wyłącznie true / false.
 *
 * Nie przepuszczamy wyjątków do API.
 */

function verifyTransactionSignature(
    tx
) {

    try {

        if (
            !tx ||
            typeof tx !== "object"
        ) {
            return false;
        }

        if (
            typeof tx.publicKey !==
                "string" ||
            typeof tx.signature !==
                "string" ||
            typeof tx.from !==
                "string"
        ) {
            return false;
        }


        /*
         * Public key musi być prawidłowym
         * kluczem Ed25519.
         */

        const publicKey =
            crypto.createPublicKey(
                tx.publicKey
            );

        if (
            publicKey.asymmetricKeyType !==
            "ed25519"
        ) {
            return false;
        }


        /*
         * Adres musi odpowiadać
         * dołączonemu kluczowi publicznemu.
         */

        const expectedAddress =
            deriveAddress(
                tx.publicKey
            );

        if (
            expectedAddress !==
            tx.from
        ) {
            return false;
        }


        /*
         * Odtwarzamy dokładnie ten sam
         * canonical payload.
         */

        const payload =
            signingPayload(tx);


        /*
         * Podpis musi być poprawnym Base64.
         */

        let signature;

        try {

            signature =
                Buffer.from(
                    tx.signature,
                    "base64"
                );

        } catch (err) {

            return false;
        }


        if (
            signature.length === 0
        ) {
            return false;
        }


        /*
         * Ed25519:
         *
         * crypto.verify(
         *     null,
         *     data,
         *     publicKey,
         *     signature
         * )
         */

        return crypto.verify(
            null,
            Buffer.from(
                payload,
                "utf8"
            ),
            publicKey,
            signature
        );

    } catch (err) {

        return false;
    }
}


/*
 * =====================================================
 * WALLET VALIDATION
 * =====================================================
 *
 * Pomocnicza funkcja dla klienta.
 */

function validateWallet(
    wallet
) {

    try {

        if (
            !wallet ||
            typeof wallet !== "object"
        ) {
            return false;
        }

        if (
            typeof wallet.address !==
                "string" ||
            typeof wallet.publicKey !==
                "string" ||
            typeof wallet.privateKey !==
                "string"
        ) {
            return false;
        }

        const derived =
            deriveAddress(
                wallet.publicKey
            );

        if (
            derived !==
            wallet.address
        ) {
            return false;
        }

        const publicKey =
            crypto.createPublicKey(
                wallet.publicKey
            );

        const privateKey =
            crypto.createPrivateKey(
                wallet.privateKey
            );

        if (
            publicKey.asymmetricKeyType !==
            "ed25519"
        ) {
            return false;
        }

        if (
            privateKey.asymmetricKeyType !==
            "ed25519"
        ) {
            return false;
        }

        return true;

    } catch (err) {

        return false;
    }
}


/*
 * =====================================================
 * EXPORTS
 * =====================================================
 */

module.exports = {

    generateWallet,

    deriveAddress,

    signTransaction,

    verifyTransactionSignature,

    signingPayload,

    validateWallet
};


/*
 * =====================================================
 * CLI
 * =====================================================
 *
 * node wallet.js
 *
 * Generuje nowy portfel lokalnie.
 */

if (
    require.main === module
) {

    const wallet =
        generateWallet();

    console.log(
        "=== Nowy portfel BitBudCoin vMax ==="
    );

    console.log(
        "\nAdres:"
    );

    console.log(
        wallet.address
    );

    console.log(
        "\nKlucz publiczny:"
    );

    console.log(
        wallet.publicKey
    );

    console.log(
        "\nKlucz PRYWATNY:"
    );

    console.log(
        wallet.privateKey
    );

    console.log(
        "\nWalidacja portfela:"
    );

    console.log(
        validateWallet(wallet)
            ? "OK"
            : "BŁĄD"
    );

    console.log(
        "\nNIE wysyłaj klucza prywatnego na serwer."
    );
}