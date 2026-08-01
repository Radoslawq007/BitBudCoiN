// Weryfikacja podpisów Ed25519 dla akcji na ofertach swapu (accept/reject).
// Ten sam mechanizm co zwykłe transakcje i HTLC (patrz htlc-wallet.js) -
// podpisujący musi mieć klucz prywatny pasujący do adresu docelowego oferty.
// Żaden współdzielony sekret nie jest już potrzebny i nie istnieje w kodzie.
const crypto = require("crypto");
const { deriveAddress } = require("./wallet");

function acceptOfferPayload({ offerId, sellerPubKeyHash, sellerBbcAddress, timestamp }) {
    return JSON.stringify({ offerId, sellerPubKeyHash, sellerBbcAddress, timestamp });
}
function rejectOfferPayload({ offerId, timestamp }) {
    return JSON.stringify({ offerId, timestamp });
}

// targetSellerAddress = adres zapisany na OFERCIE (ustalony przy tworzeniu).
// Sprawdzamy: (1) podpis jest kryptograficznie poprawny, (2) klucz publiczny
// faktycznie odpowiada temu adresowi, (3) pole sellerBbcAddress w treści
// podpisanej wiadomości też się zgadza - żeby nie dało się podpisać czegoś
// ważnego jednym adresem, a podać inny jako "sellerBbcAddress" do zapisania.
function verifyAcceptOfferSignature(tx, targetSellerAddress) {
    try {
        if (!tx || !tx.publicKey || !tx.signature || !tx.offerId || !tx.sellerBbcAddress) return false;
        if (deriveAddress(tx.publicKey) !== targetSellerAddress) return false;
        if (tx.sellerBbcAddress !== targetSellerAddress) return false;
        const payload = acceptOfferPayload(tx);
        const signature = Buffer.from(tx.signature, "base64");
        return crypto.verify(null, Buffer.from(payload), tx.publicKey, signature);
    } catch (e) { return false; }
}
function verifyRejectOfferSignature(tx, targetSellerAddress) {
    try {
        if (!tx || !tx.publicKey || !tx.signature || !tx.offerId) return false;
        if (deriveAddress(tx.publicKey) !== targetSellerAddress) return false;
        const payload = rejectOfferPayload(tx);
        const signature = Buffer.from(tx.signature, "base64");
        return crypto.verify(null, Buffer.from(payload), tx.publicKey, signature);
    } catch (e) { return false; }
}

module.exports = { acceptOfferPayload, rejectOfferPayload, verifyAcceptOfferSignature, verifyRejectOfferSignature };
