// =====================================================
// BitBudCoin Core
// address-checksum.js
// =====================================================
//
// SUMA KONTROLNA ADRESU - kodowana w WIELKOSCI LITER.
//
// Problem: adres BbC to "BbC" + 40 znakow hex z SHA-256 klucza
// publicznego. Zadnej sumy kontrolnej. Jedna literowka daje INNY,
// poprawnie wygladajacy adres - srodki znikaja bez sladu i bez
// mozliwosci wykrycia bledu przez portfel, wezel czy gielde.
//
// Rozwiazanie: dokladnie to, co Ethereum zrobil w EIP-55, gdy stanal
// przed tym samym problemem po fakcie. Checksum siedzi w tym, ktore
// litery a-f sa duze, a ktore male. Same znaki adresu sie NIE zmieniaja.
//
// Dlaczego to dziala bez rozbijania niczego:
//   - regex sieci to /^t?BbC[0-9a-fA-F]{40}$/ - JUZ akceptuje obie
//     wielkosci liter, wiec zaden istniejacy adres nie przestaje byc
//     poprawny
//   - konsensus sie nie zmienia, wiec nie ma ryzyka rozjazdu sieci
//   - stare adresy (same male litery) rozpoznajemy jako "legacy"
//     i przepuszczamy, tylko bez ochrony
//
// Ograniczenie, ktore trzeba znac: checksum niosa TYLKO litery a-f.
// Adres zlozony glownie z cyfr ma slabsza ochrone. Ethereum ma
// dokladnie to samo ograniczenie. Srednio ok. 15 z 40 znakow to litery,
// co daje ok. 15 bitow - czyli mniej wiecej 1 literowka na 32 tysiace
// przechodzi niezauwazona. To nie jest doskonale. Jest nieskonczenie
// lepsze niz zero.

"use strict";

const crypto = require("crypto");

const CFG = (() => { try { return require("./config"); } catch (e) { return {}; } })();

/* Prefiks TEJ sieci - uzywany tylko przy tworzeniu nowych adresow. */
const PREFIX = CFG.ADDRESS_PREFIX || "BbC";

/*
 * Przy SPRAWDZANIU adresu prefiks czytamy z samego adresu, nie z
 * konfiguracji. Powod: "BbC" ma 3 znaki, "tBbC" ma 4. Ciecie stalym
 * PREFIX.length pokroiloby adres z drugiej sieci w srodku hexa i dalo
 * bledny checksum - a wezel testnetu musi umiec zwalidowac adres
 * mainnetowy choćby po to, zeby go poprawnie ODRZUCIC.
 */
function rozbij(address) {
    const m = /^(t?BbC)([0-9a-fA-F]{40})$/.exec(address || "");
    return m ? { prefix: m[1], hex: m[2] } : null;
}
const HEX_LENGTH = 40;

const ADDRESS_RE = /^t?BbC[0-9a-fA-F]{40}$/;


/*
 * Czy to w ogole poprawny adres pod wzgledem formatu?
 * Ta sama regula, co w mempool.js, payout.js, server.js.
 */
function isWellFormed(address) {

    return (
        typeof address === "string" &&
        ADDRESS_RE.test(address)
    );
}


/*
 * Zamienia adres na postac z suma kontrolna.
 * Wejscie moze byc w dowolnej wielkosci liter - liczy sie tresc.
 */
function toChecksumAddress(address) {

    if (!isWellFormed(address)) {
        throw new Error(
            "Nieprawidlowy format adresu: " + address
        );
    }

    const cz = rozbij(address);
    const hex = cz.hex.toLowerCase();

    // Hash liczony z MALYCH liter, zeby wynik nie zalezal od tego,
    // w jakiej postaci adres przyszedl.
    const hash =
        crypto
            .createHash("sha256")
            .update(hex, "utf8")
            .digest("hex");

    let out = "";

    for (let i = 0; i < HEX_LENGTH; i++) {

        const c = hex[i];

        if (c >= "a" && c <= "f") {

            out +=
                parseInt(hash[i], 16) >= 8
                    ? c.toUpperCase()
                    : c;

        } else {

            // cyfry nie niosa informacji o wielkosci liter
            out += c;
        }
    }

    return cz.prefix + out;
}


/*
 * Trzy stany, nie dwa - bo "brak checksumu" to co innego niz
 * "checksum sie nie zgadza":
 *
 *   "valid"    - checksum poprawny, adres bezpieczny
 *   "invalid"  - checksum NIE pasuje => literowka, ZATRZYMAJ
 *   "legacy"   - same male albo same duze litery, czyli adres sprzed
 *                tej zmiany. Brak informacji o wielkosci liter =>
 *                nie da sie sprawdzic. Przepuszczamy, ale bez ochrony.
 */
function checkAddress(address) {

    if (!isWellFormed(address)) {
        return "malformed";
    }

    const hex = rozbij(address).hex;

    const maLitery = /[a-fA-F]/.test(hex);

    if (
        !maLitery ||
        hex === hex.toLowerCase() ||
        hex === hex.toUpperCase()
    ) {

        return "legacy";
    }

    return (
        toChecksumAddress(address) === address
            ? "valid"
            : "invalid"
    );
}


/*
 * Wygodny skrot dla portfela i formularzy: czy wolno wyslac na ten
 * adres? Blokujemy WYLACZNIE jawnie zly checksum - bo to zawsze jest
 * blad, nigdy zamiar. Adresow legacy nie blokujemy, bo unieruchomiloby
 * to wszystkich dotychczasowych uzytkownikow.
 */
function isSafeToSend(address) {

    const stan = checkAddress(address);

    return (
        stan === "valid" ||
        stan === "legacy"
    );
}


/*
 * KLUCZOWE - postac wysylana do sieci.
 *
 * Salda siedza w Map kluczowanej surowym stringiem adresu:
 *     this.balances.set(address, ...)
 * czyli "BbCabc..." i "BbCAbC..." to DWA ROZNE konta.
 *
 * Gdyby adres z checksumem trafil do lancucha, uzytkownik odzyskujacy
 * portfel z frazy zobaczylby zero, bo jego adres bylby zapisany inaczej
 * niz go pyta. Dlatego do sieci ZAWSZE idzie postac znormalizowana,
 * a checksum sluzy wylacznie do wpisywania i wyswietlania.
 *
 * Cala historia lancucha jest w malych literach (genesis, adres puli,
 * wszystkie 27884 transferow), wiec normalizacja do malych liter jest
 * zgodna wstecz z kazdym istniejacym rekordem.
 */
function toNetworkForm(address) {

    if (!isWellFormed(address)) {
        throw new Error(
            "Nieprawidlowy format adresu: " + address
        );
    }

    const cz = rozbij(address);

    return cz.prefix + cz.hex.toLowerCase();
}


module.exports = {
    ADDRESS_RE,
    toNetworkForm,
    isWellFormed,
    toChecksumAddress,
    checkAddress,
    isSafeToSend
};
