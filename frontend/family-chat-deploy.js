// "Rodzina BbC" - miejsce do rozmowy o sieci dla osób, które mają w niej
// realny udział (adres BbC). Logowanie działa DOKŁADNIE jak reszta strony -
// podpis Ed25519 kluczem portfela, nie hasło, nie osobne konto.
//
// UCZCIWIE O OGRANICZENIACH: wykrywanie scamów niżej to dopasowanie wzorców/
// słów kluczowych, NIE prawdziwe rozumienie kontekstu. Złapie oczywiste,
// częste sformułowania (proszenie o klucz prywatny, obietnice gwarantowanego
// zysku, itp.) - nie złapie wszystkiego, i może czasem błędnie oznaczyć coś
// niewinnego. To pierwsza warstwa, nie ostateczne rozwiązanie.

const crypto = require("crypto");
const { deriveAddress } = require("./wallet");

function messagePayload({ address, message, timestamp }) {
    return JSON.stringify({ address, message, timestamp });
}

function verifyMessageSignature(tx) {
    try {
        if (!tx || !tx.publicKey || !tx.signature || !tx.address) return false;
        if (deriveAddress(tx.publicKey) !== tx.address) return false;
        const payload = messagePayload(tx);
        const signature = Buffer.from(tx.signature, "base64");
        return crypto.verify(null, Buffer.from(payload), tx.publicKey, signature);
    } catch (err) {
        return false;
    }
}

// Wzorce scamowe - małymi literami, dopasowanie częściowe. Rozszerzalne w
// miarę potrzeby, bez zmiany reszty logiki.
const SCAM_PATTERNS = [
    /wy[śs]lij.{0,15}klucz.{0,10}prywatn/i,
    /send.{0,15}private.{0,10}key/i,
    /gwarantowan.{0,10}zysk/i,
    /guaranteed.{0,10}(profit|return)/i,
    /podwoj.{0,10}(swoje|twoje|swój)/i,
    /double.{0,10}your/i,
    /darmow.{0,10}(bbc|btc|bitcoin)/i,
    /free.{0,10}(bbc|btc|bitcoin)/i,
    /kliknij.{0,15}(link|tutaj)/i,
    /airdrop/i,
    /(https?:\/\/[^\s]+){3,}/i // trzy lub więcej linków w jednej wiadomości
];

function detectScam(message) {
    for (const pattern of SCAM_PATTERNS) {
        if (pattern.test(message)) return pattern.source;
    }
    return null;
}

function isLiveTimeError(message) {
    return /live.{0,3}time.{0,3}error/i.test(message);
}

// Minimalny odstęp między wiadomościami TEGO SAMEGO adresu - nie zatrzyma
// kogoś naprawdę zdeterminowanego (może użyć więcej niż jednego adresu),
// ale realnie utrudnia automatyczne zalewanie czatu wieloma próbami na
// sekundę w poszukiwaniu tej jednej, która ominie wzorce.
const MIN_SECONDS_BETWEEN_MESSAGES = 10;
const lastMessageAt = new Map(); // w pamięci - celowo proste, nie wymaga bazy

class FamilyChat {
    constructor(storage) {
        this.storage = storage;
    }

    getStrikes(address) {
        return this.storage.getFamilyStrikes(address);
    }

    isBlocked(address) {
        return this.getStrikes(address) >= 3;
    }

    // Zwraca { accepted, reason?, message?, pending? }
    postMessage(tx) {
        if (!tx || typeof tx.message !== "string" || !tx.message.trim()) {
            return { accepted: false, reason: "Pusta wiadomość" };
        }
        if (tx.message.length > 2000) {
            return { accepted: false, reason: "Wiadomość za długa (limit 2000 znaków)" };
        }
        if (!verifyMessageSignature(tx)) {
            return { accepted: false, reason: "Nieprawidłowy podpis - zaloguj się ponownie" };
        }
        if (this.isBlocked(tx.address)) {
            return { accepted: false, reason: "Ten adres jest zablokowany po 3 ostrzeżeniach" };
        }

        const lastAt = lastMessageAt.get(tx.address) || 0;
        const secondsSince = (Date.now() - lastAt) / 1000;
        if (secondsSince < MIN_SECONDS_BETWEEN_MESSAGES) {
            return { accepted: false, reason: `Poczekaj ${Math.ceil(MIN_SECONDS_BETWEEN_MESSAGES - secondsSince)}s przed kolejną wiadomością` };
        }

        const scamMatch = detectScam(tx.message);
        const liveError = isLiveTimeError(tx.message);
        const record = {
            address: tx.address, message: tx.message.trim(), timestamp: tx.timestamp || Date.now(),
            // Podejrzane wzorce NIE znikają automatycznie - trafiają do
            // kolejki, widoczne tylko dla admina, dopóki ktoś (człowiek, nie
            // algorytm) nie zdecyduje. To jedyna warstwa, której nie da się
            // ograć samą sprytną wiadomością - nie działa na dopasowaniu.
            flagged: scamMatch ? 1 : 0,
            isLiveError: liveError ? 1 : 0
        };
        this.storage.saveFamilyMessage(record);
        lastMessageAt.set(tx.address, Date.now());

        if (scamMatch) {
            return { accepted: true, pending: true, reason: "Wiadomość czeka na zatwierdzenie (wygląda podejrzanie)" };
        }
        return { accepted: true, message: record };
    }

    getMessages(limit = 50) {
        return this.storage.getFamilyMessages(limit);
    }

    getLiveErrors(limit = 20) {
        return this.storage.getFamilyLiveErrors(limit);
    }

    getPending(limit = 50) {
        return this.storage.getFamilyPending(limit);
    }

    // Wywoływane przez admina - zaakceptowana wiadomość staje się widoczna,
    // odrzucona zostaje ukryta NA STAŁE i dodaje ostrzeżenie autorowi.
    reviewPending(id, decision) {
        const msg = this.storage.getFamilyMessageById(id);
        if (!msg) return { accepted: false, reason: "Wiadomość nie znaleziona" };
        if (decision === "approve") {
            this.storage.setFamilyMessageFlag(id, 0);
            return { accepted: true };
        }
        if (decision === "reject") {
            this.storage.deleteFamilyMessage(id);
            const strikes = this.storage.addFamilyStrike(msg.address);
            return { accepted: true, strikes };
        }
        return { accepted: false, reason: "Nieznana decyzja" };
    }
}

module.exports = { FamilyChat, messagePayload, verifyMessageSignature, detectScam, isLiveTimeError };
