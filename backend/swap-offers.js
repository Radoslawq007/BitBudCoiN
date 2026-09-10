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
    if (!/^t?BbC[0-9a-fA-F]{40}$/.test(info.targetSellerAddress)) {
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
    // NAPRAWA: "chain" nie mial listy dozwolonych - komentarz mowil
    // BTC|BCH, ale przejsc mogло cokolwiek, lacznie z obiektem.
    const DOZWOLONE_CHAIN = ["BTC", "BCH"];
    if (!DOZWOLONE_CHAIN.includes(info.chain)) {
        throw new Error(
            `createOffer: "chain" musi byc jednym z: ${DOZWOLONE_CHAIN.join(", ")}`
        );
    }

    // NAPRAWA: timeoutHours mial tylko dolna granice (> 0). Bez gornej
    // oferta z timeoutHours = 1e9 nigdy by nie wygasla i zostawala w
    // pliku na zawsze. Tydzien to gora tego, co ma sens dla swapa.
    if (info.timeoutHours > 168) {
        throw new Error('createOffer: "timeoutHours" nie moze przekraczac 168 (tydzien)');
    }

    // NAPRAWA: "note" nie mial ANI kontroli typu, ANI limitu dlugosci.
    // Limit ciala zadania to 1 MB, wiec pojedyncza notatka mogla miec
    // megabajt - a kazda operacja na ofertach czyta i zapisuje CALY plik.
    let note = "";
    if (info.note !== undefined && info.note !== null) {
        if (typeof info.note !== "string") {
            throw new Error('createOffer: "note" musi byc tekstem');
        }
        note = info.note.slice(0, 500);
    }

    const offers = load();

    // NAPRAWA: nie bylo ZADNEGO limitu liczby ofert. Przy 60 zadaniach
    // na minute (strictLimiter) to 86 400 ofert dziennie w pliku, ktory
    // przy kazdym odczycie jest w calosci parsowany.
    //
    // Najpierw sprzatamy wygasle, dopiero potem sprawdzamy limit - zeby
    // naturalny obrot nie blokowal nowych ofert.
    const teraz = Date.now();
    for (const [id, o] of Object.entries(offers)) {
        const wygasa = (o.createdAt || 0) + (o.timeoutHours || 0) * 3600000;
        if (o.status === "pending" && teraz > wygasa) {
            delete offers[id];
        }
    }

    const MAX_OFERT = 1000;
    if (Object.keys(offers).length >= MAX_OFERT) {
        throw new Error(
            `createOffer: osiagnieto limit ${MAX_OFERT} ofert - sprobuj pozniej`
        );
    }

    const offerId = crypto.randomBytes(8).toString("hex");

    /*
     * NAPRAWA: bylo { offerId, ...info, ... }.
     *
     * Rozsypanie "...info" wstawialo do zapisanego obiektu DOWOLNE pola
     * przyslane przez uzytkownika - a poniewaz stalo PO "offerId",
     * pozwalalo je nadpisac. Klucz w pliku byl losowy, ale pole offerId
     * w srodku mogl ustawic atakujacy, wiec jedno i drugie przestawalo
     * sie zgadzac.
     *
     * Budujemy obiekt z JAWNIE wymienionych pol. Cokolwiek innego
     * przyjdzie w zadaniu, zostaje odrzucone.
     */
    const offer = {
        offerId,
        chain: info.chain,
        bbcAmount: info.bbcAmount,
        expectedAmount: info.expectedAmount,
        timeoutHours: info.timeoutHours,
        targetSellerAddress: info.targetSellerAddress,
        note,
        status: "pending",
        createdAt: teraz
    };

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
