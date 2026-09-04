// Oferty swapu BbC<->BTC/BCH. Sprzedający tworzy ofertę RAZ, zawiera
// WSZYSTKO co kupujący potrzebuje (hash klucza, kwoty, timeout jako CZAS
// TRWANIA nie sztywna wysokość - patrz niżej) - kupujący dostaje link,
// klika, gotowe, nic nie przepisuje ręcznie.
//
// timeoutHours (nie timeoutHeight!) - świadomy wybór: oferta może leżeć
// nieużyta godzinami/dniami, sztywna wysokość bloku ustalona przy tworzeniu
// byłaby przeterminowana zanim ktoś ją przyjmie. Prawdziwą wysokość liczymy
// dopiero w momencie AKCEPTACJI (aktualna wysokość + timeoutHours), nie tutaj.
//
// AUTORYZACJA (od 01.08.2026): zamiast wspólnego hasła administratora,
// każda oferta ma "targetSellerAddress" ustalony PRZY TWORZENIU - tylko
// właściciel tego adresu (podpis Ed25519 kluczem pasującym do adresu) może
// ją zaakceptować albo odrzucić. Weryfikacja podpisu dzieje się w server.js
// (patrz swap-offer-auth.js), PRZED wywołaniem funkcji stąd - ten plik
// dodatkowo sprawdza że przekazany adres zgadza się z targetSellerAddress,
// jako drugą, niezależną linię obrony na wypadek błędu w kodzie wywołującym.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FILE_PATH = path.join(__dirname, "swap-offers.json");

function load() {
    try { return JSON.parse(fs.readFileSync(FILE_PATH, "utf8")); }
    catch (err) { return {}; }
}
function save(offers) {
    fs.writeFileSync(FILE_PATH, JSON.stringify(offers, null, 2));
}
function getAll() {
    return load();
}
function getOffer(offerId) {
    const offers = load();
    return offers[offerId] || null;
}
// info = { chain: "BTC"|"BCH", bbcAmount, expectedAmount, timeoutHours, note,
//          targetSellerAddress }
// targetSellerAddress: adres BbC osoby, która MA zaakceptować tę ofertę -
// tylko podpis pasujący do tego adresu przejdzie przez accept/reject.
function createOffer(info) {
    const required = ["chain", "bbcAmount", "expectedAmount", "timeoutHours", "targetSellerAddress"];
    for (const field of required) {
        if (info[field] === undefined || info[field] === null || info[field] === "") {
            throw new Error(`createOffer: brak pola "${field}"`);
        }
    }
    // NAPRAWA (dzisiaj, PILNA): ten sam problem co tx.to/coinbase/claimant/
    // refundee dzisiaj wczesniej - targetSellerAddress mial tylko check "nie
    // puste". Literowka przy tworzeniu oferty = oferta ktorej NIKT nigdy nie
    // bedzie w stanie zaakceptowac ani odrzucic (podpis nigdy nie wyprowadzi
    // sie do smiecia) - cicho zawieszona na zawsze, mylaca dla drugiej strony
    // proby prawdziwego swapa.
    if (!/^BbC[0-9a-fA-F]{40}$/.test(info.targetSellerAddress)) {
        throw new Error(`createOffer: nieprawidlowy format targetSellerAddress`);
    }
    // NAPRAWA (dzisiaj, PILNA): bbcAmount/expectedAmount/timeoutHours mialy
    // tylko check obecnosci (required), nie ze to sensowne, dodatnie liczby.
    // Ujemna albo NaN kwota przechodzila i ladowala sie jako "pending"
    // oferta - myląca (albo gorzej) dla kazdego kto pozniej probowalby ja
    // zaakceptowac.
    for (const field of ["bbcAmount", "expectedAmount", "timeoutHours"]) {
        if (typeof info[field] !== "number" || !Number.isFinite(info[field]) || !(info[field] > 0)) {
            throw new Error(`createOffer: "${field}" musi byc dodatnia, skonczona liczba`);
        }
    }
    const offerId = crypto.randomBytes(8).toString("hex");
    const offer = { offerId, ...info, status: "pending", createdAt: Date.now() };
    const offers = load();
    offers[offerId] = offer;
    save(offers);
    return offer;
}
// sellerBbcAddress MUSI być adresem już zweryfikowanym podpisem w server.js
// przed wywołaniem tej funkcji - nie ufamy mu tutaj ślepo, dodatkowo
// sprawdzamy zgodność z targetSellerAddress zapisanym na ofercie.
function acceptOffer(offerId, { sellerPubKeyHash, sellerBbcAddress }) {
    const offers = load();
    if (!offers[offerId]) throw new Error("oferta nie istnieje");
    if (offers[offerId].status !== "pending") throw new Error(`oferta ma status "${offers[offerId].status}", nie można zaakceptować`);
    if (sellerBbcAddress !== offers[offerId].targetSellerAddress) {
        throw new Error("adres nie zgadza się z adresem docelowym tej oferty");
    }
    offers[offerId].status = "open";
    offers[offerId].sellerPubKeyHash = sellerPubKeyHash;
    offers[offerId].sellerBbcAddress = sellerBbcAddress;
    save(offers);
    return offers[offerId];
}
// rejectedByAddress - jak wyżej, adres już zweryfikowany podpisem w server.js.
function rejectOffer(offerId, rejectedByAddress) {
    const offers = load();
    if (!offers[offerId]) throw new Error("oferta nie istnieje");
    if (rejectedByAddress !== offers[offerId].targetSellerAddress) {
        throw new Error("adres nie zgadza się z adresem docelowym tej oferty");
    }
    offers[offerId].status = "rejected";
    save(offers);
    return offers[offerId];
}
function setOfferStatus(offerId, status) {
    const offers = load();
    if (!offers[offerId]) throw new Error("oferta nie istnieje");
    offers[offerId].status = status;
    save(offers);
    return offers[offerId];
}
if (typeof module !== "undefined") module.exports = { getAll, getOffer, createOffer, acceptOffer, rejectOffer, setOfferStatus };
