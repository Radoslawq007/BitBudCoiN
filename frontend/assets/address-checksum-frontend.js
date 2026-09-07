/*
 * =====================================================
 * BitBudCoin - suma kontrolna adresu (przegladarka)
 * =====================================================
 *
 * Ta sama logika co backend/address-checksum.js, ale na SubtleCrypto,
 * wiec funkcje sa asynchroniczne. Trzymaj OBIE wersje zgodne - jesli
 * kiedykolwiek sie rozjada, portfel bedzie pokazywal inny checksum niz
 * liczy wezel, co jest gorsze niz brak checksumu w ogole.
 *
 * Po co to w przegladarce: literowka powstaje przy WKLEJANIU adresu
 * w portfelu, nie na serwerze. Tutaj ja zatrzymujemy.
 *
 * Zmierzona wykrywalnosc literowki: 99.9% (3000 prob, test-address-checksum.js)
 */

const BBC_PREFIX = "BbC";
const BBC_HEX_LENGTH = 40;
const BBC_ADDRESS_RE = /^BbC[0-9a-fA-F]{40}$/;

function bbcIsWellFormed(address) {
    return typeof address === "string" && BBC_ADDRESS_RE.test(address);
}

async function bbcSha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function bbcToChecksumAddress(address) {
    if (!bbcIsWellFormed(address)) {
        throw new Error("Nieprawidlowy format adresu: " + address);
    }
    const hex = address.slice(BBC_PREFIX.length).toLowerCase();
    const hash = await bbcSha256Hex(hex);
    let out = "";
    for (let i = 0; i < BBC_HEX_LENGTH; i++) {
        const c = hex[i];
        if (c >= "a" && c <= "f") {
            out += parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c;
        } else {
            out += c;
        }
    }
    return BBC_PREFIX + out;
}

/*
 * "valid"     - checksum poprawny
 * "invalid"   - literowka, ZATRZYMAJ wysylke
 * "legacy"    - adres sprzed tej zmiany, brak informacji o wielkosci
 *               liter, przepuszczamy bez ochrony
 * "malformed" - zly format
 */
async function bbcCheckAddress(address) {
    if (!bbcIsWellFormed(address)) return "malformed";
    const hex = address.slice(BBC_PREFIX.length);
    const maLitery = /[a-fA-F]/.test(hex);
    if (!maLitery || hex === hex.toLowerCase() || hex === hex.toUpperCase()) {
        return "legacy";
    }
    return (await bbcToChecksumAddress(address)) === address ? "valid" : "invalid";
}

/*
 * KLUCZOWE: do sieci ZAWSZE idzie postac znormalizowana.
 * Salda sa kluczowane surowym stringiem adresu, wiec "BbCabc..." i
 * "BbCAbC..." bylyby dwoma roznymi kontami. Cala historia lancucha jest
 * w malych literach, wiec ta normalizacja jest zgodna wstecz.
 */
function bbcToNetworkForm(address) {
    if (!bbcIsWellFormed(address)) {
        throw new Error("Nieprawidlowy format adresu: " + address);
    }
    return BBC_PREFIX + address.slice(BBC_PREFIX.length).toLowerCase();
}

window.bbcIsWellFormed = bbcIsWellFormed;
window.bbcToChecksumAddress = bbcToChecksumAddress;
window.bbcCheckAddress = bbcCheckAddress;
window.bbcToNetworkForm = bbcToNetworkForm;
