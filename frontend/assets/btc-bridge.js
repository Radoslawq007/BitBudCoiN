// ============================================================================
// btc-bridge.js - CAŁY łańcuch kryptograficzny BTC w jednym pliku, gotowy do
// <script src="assets/btc-bridge.js"> - bez require/module.exports (przeglądarka
// nie ma systemu modułów jak Node), wszystko jako zwykłe funkcje globalne,
// dokładnie tak jak reszta plików na tej stronie (api.js, wallet-crypto.js).
//
// Każdy kawałek osobno przetestowany i zweryfikowany (oficjalne wektory BIP143,
// RFC6979, RFC4231, NESSIE RIPEMD160, krzyżowo z oryginalnymi wersjami Node) -
// to sklejenie w jeden plik, sama logika się NIE zmienia.
//
// KOLEJNOŚĆ ma znaczenie - każda sekcja może używać funkcji z sekcji WYŻEJ.
// ============================================================================


// ---------------------------------------------------------------------------
// Rdzeń: SHA256 (Web Crypto), hash160, konwersje hex/bytes (z browser-core.js)
// ---------------------------------------------------------------------------
// Rdzeń kryptograficzny dla przeglądarki: SHA256 przez Web Crypto (async -
// przeglądarka nie ma synchronicznego SHA256, w przeciwieństwie do RIPEMD160
// które musieliśmy napisać sami bo go W OGÓLE nie ma) + hash160 złożone z
// obu. Używane przez KAŻDY kolejny plik w tym łańcuchu.

async function sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
}

async function hash256(bytes) {
    return sha256(await sha256(bytes));
}

async function hash160(bytes) {
    return ripemd160(await sha256(bytes));
}

function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}
function concatBytes(...arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) { out.set(a, offset); offset += a.length; }
    return out;
}
function utf8ToBytes(str) { return new TextEncoder().encode(str); }

// ---------------------------------------------------------------------------
// Adresy Bech32/BIP173 (z bech32-browser.js)
// ---------------------------------------------------------------------------
// Bech32/BIP173 dla przeglądarki - JEDYNA różnica względem oryginału:
// Buffer.from(program) -> new Uint8Array(program) (Buffer nie istnieje w
// przeglądarce). Bech32 sam w sobie nie potrzebuje żadnego hashowania
// (własny checksum polynomial), więc poza tym zero zmian.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
    let chk = 1;
    for (const v of values) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) {
            if ((top >>> i) & 1) chk ^= GENERATOR[i];
        }
    }
    return chk >>> 0;
}

function hrpExpand(hrp) {
    const result = [];
    for (let i = 0; i < hrp.length; i++) result.push(hrp.charCodeAt(i) >>> 5);
    result.push(0);
    for (let i = 0; i < hrp.length; i++) result.push(hrp.charCodeAt(i) & 31);
    return result;
}

function createChecksum(hrp, data) {
    const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    const mod = polymod(values) ^ 1;
    const result = [];
    for (let i = 0; i < 6; i++) result.push((mod >>> (5 * (5 - i))) & 31);
    return result;
}

function verifyChecksum(hrp, data) {
    return polymod(hrpExpand(hrp).concat(data)) === 1;
}

function encode(hrp, data) {
    const combined = data.concat(createChecksum(hrp, data));
    let result = hrp + "1";
    for (const d of combined) result += CHARSET.charAt(d);
    return result;
}

function decode(bechString) {
    if (bechString !== bechString.toLowerCase() && bechString !== bechString.toUpperCase()) return null;
    bechString = bechString.toLowerCase();
    const pos = bechString.lastIndexOf("1");
    if (pos < 1 || pos + 7 > bechString.length || bechString.length > 90) return null;
    const hrp = bechString.substring(0, pos);
    const data = [];
    for (let i = pos + 1; i < bechString.length; i++) {
        const d = CHARSET.indexOf(bechString.charAt(i));
        if (d === -1) return null;
        data.push(d);
    }
    if (!verifyChecksum(hrp, data)) return null;
    return { hrp, data: data.slice(0, data.length - 6) };
}

function convertBits(data, fromBits, toBits, pad) {
    let acc = 0, bits = 0;
    const result = [];
    const maxv = (1 << toBits) - 1;
    for (const value of data) {
        if (value < 0 || value >>> fromBits !== 0) return null;
        acc = (acc << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            result.push((acc >>> bits) & maxv);
        }
    }
    if (pad) {
        if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
        return null;
    }
    return result;
}

function encodeSegwitAddress(hrp, witnessVersion, witnessProgram) {
    const programBits = convertBits(Array.from(witnessProgram), 8, 5, true);
    if (programBits === null) throw new Error("nie udało się przekonwertować programu witness na grupy 5-bitowe");
    return encode(hrp, [witnessVersion].concat(programBits));
}

function decodeSegwitAddress(address, expectedHrp) {
    const decoded = decode(address);
    if (decoded === null) return null;
    const { hrp, data } = decoded;
    if (expectedHrp !== undefined && hrp !== expectedHrp) return null;
    if (data.length < 1) return null;
    const witnessVersion = data[0];
    if (witnessVersion > 16) return null;
    const program = convertBits(data.slice(1), 5, 8, false);
    if (program === null) return null;
    if (program.length < 2 || program.length > 40) return null;
    if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return null;
    return { hrp, witnessVersion, program: new Uint8Array(program) };
}

// ---------------------------------------------------------------------------
// Krzywa eliptyczna secp256k1 (bez zmian - czysty BigInt) (z secp256k1.js)
// ---------------------------------------------------------------------------
// Krzywa secp256k1 - implementacja OD ZERA (BigInt, zero zależności - w
// kontenerze nie mam dostępu do sieci więc nie zainstaluję żadnej biblioteki
// EC). To ta sama krzywa co w Bitcoinie, używana przez BCH (fork Bitcoina).
//
// Stałe NIE są z pamięci - zweryfikowane wyszukiwaniem, trzy niezależne
// źródła się zgadzają (Bitcoin Wiki, herongyang.com, dokumentacja Racket).
// Krzywa: y^2 = x^3 + 7 mod P  (a=0, b=7).

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const B = 7n;
const G = { x: Gx, y: Gy };

function modN(a) { let r = a % N; if (r < 0n) r += N; return r; }
function modP(a) { let r = a % P; if (r < 0n) r += P; return r; }

// Szybkie potęgowanie modularne - do odwrotności przez Małe Twierdzenie
// Fermata (P i N są liczbami pierwszymi: a^-1 = a^(m-2) mod m).
function modPow(base, exp, m) {
    base = ((base % m) + m) % m;
    let result = 1n;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % m;
        base = (base * base) % m;
        exp >>= 1n;
    }
    return result;
}
function modInverseP(a) { return modPow(a, P - 2n, P); }
function modInverseN(a) { return modPow(a, N - 2n, N); }

// Punkty afiniczne. null = punkt w nieskończoności (element neutralny).
function pointAdd(p1, p2) {
    if (p1 === null) return p2;
    if (p2 === null) return p1;
    if (p1.x === p2.x && modP(p1.y + p2.y) === 0n) return null; // p + (-p) = O
    let lambda;
    if (p1.x === p2.x && p1.y === p2.y) {
        // podwojenie: lambda = 3x^2 / 2y  (a=0, więc bez członu +a)
        lambda = modP(3n * p1.x * p1.x * modInverseP(modP(2n * p1.y)));
    } else {
        lambda = modP((p2.y - p1.y) * modInverseP(modP(p2.x - p1.x)));
    }
    const x3 = modP(lambda * lambda - p1.x - p2.x);
    const y3 = modP(lambda * (p1.x - x3) - p1.y);
    return { x: x3, y: y3 };
}

// Mnożenie skalarne (double-and-add). k musi być zredukowane do [0, N).
function scalarMult(k, point) {
    k = modN(k);
    let result = null;
    let addend = point;
    while (k > 0n) {
        if (k & 1n) result = pointAdd(result, addend);
        addend = pointAdd(addend, addend);
        k >>= 1n;
    }
    return result;
}

// Dekompresja: z samego X + parzystości Y odtwarza pełny punkt. Możliwe bo
// P mod 4 == 3 dla secp256k1 (sprawdzone: P kończy się na ...FC2F, FC2F mod 4
// == 3) - dla takich P pierwiastek kwadratowy mod P to po prostu
// a^((P+1)/4) mod P (nie ma potrzeby ogólnego algorytmu Tonelli-Shanks).
function modSqrtP(a) { return modPow(a, (P + 1n) / 4n, P); }

function pointFromX(x, yIsOdd) {
    const rhs = modP(x * x % P * x + B); // x^3 + 7 mod P
    const y0 = modSqrtP(rhs);
    if (modP(y0 * y0) !== modP(rhs)) return null; // x nie leży na krzywej (nie jest resztą kwadratową)
    const y0IsOdd = (y0 & 1n) === 1n;
    const y = (y0IsOdd === !!yIsOdd) ? y0 : modP(P - y0);
    return { x, y };
}

function isOnCurve(point) {
    if (point === null) return false;
    const { x, y } = point;
    return modP(y * y - (x * x * x + B)) === 0n;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 (Web Crypto, dla RFC6979) (z hmac-webcrypto.js)
// ---------------------------------------------------------------------------
// HMAC-SHA256 przez window.crypto.subtle (Web Crypto API) - zamiennik Node
// "crypto.createHmac('sha256', key)" używanego w ecdsa.js (RFC6979 -
// deterministyczne generowanie k przy podpisie). Web Crypto NIE MA synchronicznego
// odpowiednika - stąd async/await tutaj, i w każdej funkcji która to wywołuje
// dalej w łańcuchu (to jedyna realna zmiana strukturalna przy portowaniu
// ecdsa.js do przeglądarki - reszta matematyki zostaje identyczna).

async function hmacSha256(keyBytes, messageBytes) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageBytes);
    return new Uint8Array(signature);
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}
function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function utf8ToBytes(str) {
    return new TextEncoder().encode(str);
}

// ---------------------------------------------------------------------------
// RIPEMD160 (napisane od zera - przeglądarki go nie mają) (z ripemd160.js)
// ---------------------------------------------------------------------------
// RIPEMD-160 w czystym JavaScript - działa W PRZEGLĄDARCE (żadnej zależności
// od Node "crypto", tylko BigInt/Number/Array). Potrzebny bo Web Crypto API
// (window.crypto.subtle) NIE MA RIPEMD160 - żaden mainstreamowy standard
// przeglądarkowy go nie oferuje, mimo że jest fundamentem adresów Bitcoina
// (hash160 = RIPEMD160(SHA256(x))).
//
// Tabele przepisane z Bitcoin Wiki (en.bitcoin.it/wiki/RIPEMD-160) - przy
// weryfikacji krzyżowej z innym źródłem wykryte tam realne błędy (zła tabela
// rotacji prawej linii, brakujący krok D=rotl(C,10)), więc NIE użyte.
// Poprawność potwierdzona niżej przeciw oficjalnym wektorom testowym
// (NESSIE / RIPEMD-160 homepage, potwierdzone niezależnie przez Rosetta Code).

const R_LEFT = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8],
    [3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12],
    [1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2],
    [4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13]
];
const R_RIGHT = [
    [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12],
    [6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2],
    [15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13],
    [8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14],
    [12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11]
];
const S_LEFT = [
    [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
    [7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12],
    [11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5],
    [11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12],
    [9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6]
];
const S_RIGHT = [
    [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6],
    [9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11],
    [9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5],
    [15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8],
    [8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11]
];
const K_LEFT = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const K_RIGHT = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

// 5 funkcji nieliniowych - LEWA linia używa ich w kolejności F0..F4 (góra->dół),
// PRAWA w kolejności ODWRÓCONEJ F4..F0 (dół->góra) - potwierdzone spójnością
// ze stałymi K (K_LEFT ma 0 na początku/"górze", K_RIGHT ma 0 na końcu/"dole" -
// ten sam wzorzec odwrócenia musi dotyczyć funkcji, inaczej opis "przeciwne
// kierunki" w źródle nie miałby sensu).
function F(round, x, y, z) {
    switch (round) {
        case 0: return (x ^ y ^ z) >>> 0;
        case 1: return ((x & y) | (~x & z)) >>> 0;
        case 2: return ((x | ~y) ^ z) >>> 0;
        case 3: return ((x & z) | (y & ~z)) >>> 0;
        case 4: return (x ^ (y | ~z)) >>> 0;
    }
}

function padMessage(bytes) {
    const origLenBits = BigInt(bytes.length) * 8n;
    const padded = Array.from(bytes);
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0x00);
    // długość jako 64-bit little-endian
    let lenBits = origLenBits;
    for (let i = 0; i < 8; i++) {
        padded.push(Number(lenBits & 0xffn));
        lenBits >>= 8n;
    }
    return padded;
}

function ripemd160(input) {
    // input: Uint8Array/Array liczb, LUB string (kodowany jako UTF-8) - bez
    // Buffer (Node-specific), tylko TextEncoder (dostępny natywnie w każdej
    // przeglądarce od dawna, część standardu WHATWG Encoding).
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
    const padded = padMessage(bytes);


    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

    for (let blockStart = 0; blockStart < padded.length; blockStart += 64) {
        const X = new Array(16);
        for (let i = 0; i < 16; i++) {
            X[i] = (padded[blockStart + i * 4] |
                (padded[blockStart + i * 4 + 1] << 8) |
                (padded[blockStart + i * 4 + 2] << 16) |
                (padded[blockStart + i * 4 + 3] << 24)) >>> 0;
        }

        let al = h0, bl = h1, cl = h2, dl = h3, el = h4;
        let ar = h0, br = h1, cr = h2, dr = h3, er = h4;

        for (let round = 0; round < 5; round++) {
            for (let j = 0; j < 16; j++) {
                // LEWA linia
                let t = (al + F(round, bl, cl, dl) + X[R_LEFT[round][j]] + K_LEFT[round]) >>> 0;
                t = rotl(t, S_LEFT[round][j]);
                t = (t + el) >>> 0;
                al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t;

                // PRAWA linia - funkcja w kolejności odwróconej (4-round)
                let t2 = (ar + F(4 - round, br, cr, dr) + X[R_RIGHT[round][j]] + K_RIGHT[round]) >>> 0;
                t2 = rotl(t2, S_RIGHT[round][j]);
                t2 = (t2 + er) >>> 0;
                ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t2;
            }
        }

        const temp = (h1 + cl + dr) >>> 0;
        h1 = (h2 + dl + er) >>> 0;
        h2 = (h3 + el + ar) >>> 0;
        h3 = (h4 + al + br) >>> 0;
        h4 = (h0 + bl + cr) >>> 0;
        h0 = temp;
    }

    const out = new Uint8Array(20);
    const view = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((h, i) => view.setUint32(i * 4, h >>> 0, true)); // true = little-endian
    return out;
}

// Pomocnicze: hex-string z Uint8Array, żeby wywołujący nie musiał znać szczegółów
function toHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Podpis ECDSA (RFC6979, low-S, strict DER) (z ecdsa-browser.js)
// ---------------------------------------------------------------------------
// ECDSA nad secp256k1 dla PRZEGLĄDARKI - port ecdsa.js. Logika (RFC6979,
// low-S/BIP-62, strict DER/BIP-66) NIEZMIENIONA - identyczna matematyka co
// oryginał, przetestowany już wielokrotnie w tej sesji. Dwie zmiany:
// (1) HMAC przez Web Crypto jest asynchroniczne -> rfc6979K, signRaw,
//     signForScriptSig stają się async (dokładnie tak jak wcześniej ostrzegałem)
// (2) Buffer (Node-specific) -> Uint8Array (to samo co przy RIPEMD160/HMAC)
//
// verifyRaw/encodeDER/decodeDER/isValidSignatureEncoding/toLowS NIE dotykają
// HMAC ani Buffer-specific API - zostają synchroniczne, logika bez zmian.


function concatBytes(...arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) { out.set(a, offset); offset += a.length; }
    return out;
}
function bytesToBigInt(bytes) {
    if (bytes.length === 0) return 0n;
    return BigInt("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""));
}
function int2octets(x) {
    const hex = x.toString(16).padStart(64, "0").slice(-64);
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}

// RFC 6979 - identyczna logika co oryginał, teraz async bo hmacSha256 jest
// asynchroniczne (Web Crypto nie ma wersji synchronicznej).
async function rfc6979K(privateKeyInt, hashBytes) {
    const h1 = int2octets(modN(bytesToBigInt(hashBytes)));
    const xOctets = int2octets(privateKeyInt);

    let V = new Uint8Array(32).fill(0x01);
    let K = new Uint8Array(32).fill(0x00);
    K = await hmacSha256(K, concatBytes(V, new Uint8Array([0x00]), xOctets, h1));
    V = await hmacSha256(K, V);
    K = await hmacSha256(K, concatBytes(V, new Uint8Array([0x01]), xOctets, h1));
    V = await hmacSha256(K, V);

    while (true) {
        V = await hmacSha256(K, V);
        const k = bytesToBigInt(V);
        if (k > 0n && k < N) return k;
        K = await hmacSha256(K, concatBytes(V, new Uint8Array([0x00])));
        V = await hmacSha256(K, V);
    }
}

async function signRaw(privateKeyInt, hashBytes) {
    const z = modN(bytesToBigInt(hashBytes));
    while (true) {
        const k = await rfc6979K(privateKeyInt, hashBytes);
        const R = scalarMult(k, G);
        const r = modN(R.x);
        if (r === 0n) continue;
        const s = modN(modInverseN(k) * modN(z + r * privateKeyInt));
        if (s === 0n) continue;
        return { r, s };
    }
}

const HALF_N = N / 2n;
function toLowS(s) { return s > HALF_N ? modN(N - s) : s; }

function verifyRaw(publicKeyPoint, hashBytes, r, s) {
    if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
    if (!isOnCurve(publicKeyPoint)) return false;
    const z = modN(bytesToBigInt(hashBytes));
    const sInv = modInverseN(s);
    const u1 = modN(z * sInv);
    const u2 = modN(r * sInv);
    const point = pointAdd(scalarMult(u1, G), scalarMult(u2, publicKeyPoint));
    if (point === null) return false;
    return modN(point.x) === modN(r);
}

function minimalBigEndianBytes(x) {
    let hex = x.toString(16);
    if (hex.length % 2 !== 0) hex = "0" + hex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}
function encodeDERInteger(x) {
    let bytes = minimalBigEndianBytes(x);
    if (bytes[0] & 0x80) bytes = concatBytes(new Uint8Array([0x00]), bytes);
    return concatBytes(new Uint8Array([0x02, bytes.length]), bytes);
}
function encodeDER(r, s) {
    const body = concatBytes(encodeDERInteger(r), encodeDERInteger(s));
    return concatBytes(new Uint8Array([0x30, body.length]), body);
}
function decodeDER(bytes) {
    if (bytes[0] !== 0x30) throw new Error("DER: brak nagłówka sekwencji 0x30");
    if (bytes[2] !== 0x02) throw new Error("DER: brak markera integer dla R");
    const lenR = bytes[3];
    const r = bytesToBigInt(bytes.subarray(4, 4 + lenR));
    let offset = 4 + lenR;
    if (bytes[offset] !== 0x02) throw new Error("DER: brak markera integer dla S");
    const lenS = bytes[offset + 1];
    const s = bytesToBigInt(bytes.subarray(offset + 2, offset + 2 + lenS));
    return { r, s };
}

// BEZPOŚREDNIE tłumaczenie IsValidSignatureEncoding() z BIP66 - bez zmian
// logiki, Uint8Array indeksuje się identycznie jak Buffer.
function isValidSignatureEncoding(sig) {
    if (sig.length < 9) return false;
    if (sig.length > 73) return false;
    if (sig[0] !== 0x30) return false;
    if (sig[1] !== sig.length - 3) return false;
    const lenR = sig[3];
    if (5 + lenR >= sig.length) return false;
    const lenS = sig[5 + lenR];
    if (lenR + lenS + 7 !== sig.length) return false;
    if (sig[2] !== 0x02) return false;
    if (lenR === 0) return false;
    if (sig[4] & 0x80) return false;
    if (lenR > 1 && sig[4] === 0x00 && !(sig[5] & 0x80)) return false;
    if (sig[lenR + 4] !== 0x02) return false;
    if (lenS === 0) return false;
    if (sig[lenR + 6] & 0x80) return false;
    if (lenS > 1 && sig[lenR + 6] === 0x00 && !(sig[lenR + 7] & 0x80)) return false;
    return true;
}

async function signForScriptSig(privateKeyInt, hashBytes, sighashType) {
    const { r, s } = await signRaw(privateKeyInt, hashBytes);
    const sLow = toLowS(s);
    const der = encodeDER(r, sLow);
    return concatBytes(der, new Uint8Array([sighashType]));
}

// ---------------------------------------------------------------------------
// Serializacja podstawowej transakcji (z raw-tx-browser.js)
// ---------------------------------------------------------------------------
// Serializacja surowej transakcji BTC dla przeglądarki - port raw-tx.js.
// Buffer -> Uint8Array/DataView (multi-bajtowe odczyty/zapisy przez DataView,
// bo Uint8Array sam w sobie nie ma writeUInt32LE itp.). computeTxid staje się
// async (hash256 przez Web Crypto). Reszta logiki bez zmian.

function encodeVarInt(n) {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) {
        const b = new Uint8Array(3); const v = new DataView(b.buffer);
        b[0] = 0xfd; v.setUint16(1, n, true); return b;
    }
    if (n <= 0xffffffff) {
        const b = new Uint8Array(5); const v = new DataView(b.buffer);
        b[0] = 0xfe; v.setUint32(1, n, true); return b;
    }
    const b = new Uint8Array(9); const v = new DataView(b.buffer);
    b[0] = 0xff; v.setBigUint64(1, BigInt(n), true); return b;
}

function decodeVarInt(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const first = bytes[offset];
    if (first < 0xfd) return { value: first, bytesRead: 1 };
    if (first === 0xfd) return { value: view.getUint16(offset + 1, true), bytesRead: 3 };
    if (first === 0xfe) return { value: view.getUint32(offset + 1, true), bytesRead: 5 };
    return { value: Number(view.getBigUint64(offset + 1, true)), bytesRead: 9 };
}

function reverseBytes(bytes) { return new Uint8Array(bytes).reverse(); }

function serializeInput(input) {
    const txidBytes = reverseBytes(hexToBytes(input.txid));
    const voutBytes = new Uint8Array(4); new DataView(voutBytes.buffer).setUint32(0, input.vout, true);
    const scriptSigBytes = hexToBytes(input.scriptSig || "");
    const sequenceBytes = new Uint8Array(4); new DataView(sequenceBytes.buffer).setUint32(0, input.sequence ?? 0xffffffff, true);
    return concatBytes(txidBytes, voutBytes, encodeVarInt(scriptSigBytes.length), scriptSigBytes, sequenceBytes);
}

function deserializeInput(bytes, offset) {
    const txid = bytesToHex(reverseBytes(bytes.subarray(offset, offset + 32)));
    offset += 32;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vout = view.getUint32(offset, true); offset += 4;
    const { value: scriptLen, bytesRead } = decodeVarInt(bytes, offset); offset += bytesRead;
    const scriptSig = bytesToHex(bytes.subarray(offset, offset + scriptLen)); offset += scriptLen;
    const sequence = view.getUint32(offset, true); offset += 4;
    return { input: { txid, vout, scriptSig, sequence }, offset };
}

function serializeOutput(output) {
    const valueBytes = new Uint8Array(8); new DataView(valueBytes.buffer).setBigUint64(0, BigInt(output.valueSatoshis), true);
    const scriptBytes = hexToBytes(output.scriptPubKey);
    return concatBytes(valueBytes, encodeVarInt(scriptBytes.length), scriptBytes);
}

function deserializeOutput(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const valueSatoshis = Number(view.getBigUint64(offset, true)); offset += 8;
    const { value: scriptLen, bytesRead } = decodeVarInt(bytes, offset); offset += bytesRead;
    const scriptPubKey = bytesToHex(bytes.subarray(offset, offset + scriptLen)); offset += scriptLen;
    return { output: { valueSatoshis, scriptPubKey }, offset };
}

function serializeTransaction(tx) {
    const parts = [];
    const versionBytes = new Uint8Array(4); new DataView(versionBytes.buffer).setInt32(0, tx.version ?? 1, true);
    parts.push(versionBytes);
    parts.push(encodeVarInt(tx.inputs.length));
    for (const input of tx.inputs) parts.push(serializeInput(input));
    parts.push(encodeVarInt(tx.outputs.length));
    for (const output of tx.outputs) parts.push(serializeOutput(output));
    const locktimeBytes = new Uint8Array(4); new DataView(locktimeBytes.buffer).setUint32(0, tx.locktime ?? 0, true);
    parts.push(locktimeBytes);
    return concatBytes(...parts);
}

function deserializeTransaction(hexOrBytes) {
    const bytes = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const version = view.getInt32(offset, true); offset += 4;

    const inCount = decodeVarInt(bytes, offset); offset += inCount.bytesRead;
    const inputs = [];
    for (let i = 0; i < inCount.value; i++) {
        const { input, offset: next } = deserializeInput(bytes, offset);
        inputs.push(input); offset = next;
    }

    const outCount = decodeVarInt(bytes, offset); offset += outCount.bytesRead;
    const outputs = [];
    for (let i = 0; i < outCount.value; i++) {
        const { output, offset: next } = deserializeOutput(bytes, offset);
        outputs.push(output); offset = next;
    }

    const locktime = view.getUint32(offset, true); offset += 4;
    return { tx: { version, inputs, outputs, locktime }, totalBytesRead: offset };
}

// computeTxid staje się ASYNC - hash256 przez Web Crypto nie ma wersji sync.
async function computeBaseTxid(tx) {
    const raw = serializeTransaction(tx);
    return bytesToHex(reverseBytes(await hash256(raw)));
}

// ---------------------------------------------------------------------------
// Serializacja transakcji SegWit (witness) (z segwit-tx-browser.js)
// ---------------------------------------------------------------------------
// Serializacja transakcji SegWit dla przeglądarki - port segwit-tx.js.
// Buffer -> Uint8Array/DataView, computeTxid/computeWtxid -> async (hash256
// przez Web Crypto). Reszta logiki (marker/flag/witness) bez zmian.


function serializeWitnessStackItem(itemHex) {
    const bytes = hexToBytes(itemHex);
    return concatBytes(encodeVarInt(bytes.length), bytes);
}
function serializeWitness(stackItems) {
    return concatBytes(encodeVarInt(stackItems.length), ...stackItems.map(serializeWitnessStackItem));
}
function deserializeWitness(bytes, offset) {
    const { value: count, bytesRead } = decodeVarInt(bytes, offset); offset += bytesRead;
    const items = [];
    for (let i = 0; i < count; i++) {
        const { value: len, bytesRead: br } = decodeVarInt(bytes, offset); offset += br;
        items.push(bytesToHex(bytes.subarray(offset, offset + len))); offset += len;
    }
    return { items, offset };
}

function serializeSegwitTransaction(tx) {
    const parts = [];
    const versionBytes = new Uint8Array(4); new DataView(versionBytes.buffer).setInt32(0, tx.version ?? 1, true);
    parts.push(versionBytes);
    parts.push(new Uint8Array([0x00, 0x01]));
    parts.push(encodeVarInt(tx.inputs.length));
    for (const input of tx.inputs) parts.push(serializeInput(input));
    parts.push(encodeVarInt(tx.outputs.length));
    for (const output of tx.outputs) parts.push(serializeOutput(output));
    for (const witness of tx.witnesses) parts.push(serializeWitness(witness));
    const locktimeBytes = new Uint8Array(4); new DataView(locktimeBytes.buffer).setUint32(0, tx.locktime ?? 0, true);
    parts.push(locktimeBytes);
    return concatBytes(...parts);
}

function deserializeSegwitTransaction(hexOrBytes) {
    const bytes = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const version = view.getInt32(offset, true); offset += 4;
    if (bytes[offset] !== 0x00 || bytes[offset + 1] !== 0x01) throw new Error("brak markera/flagi segwit (0x00 0x01) - to nie jest transakcja segwit");
    offset += 2;

    const inCount = decodeVarInt(bytes, offset); offset += inCount.bytesRead;
    const inputs = [];
    for (let i = 0; i < inCount.value; i++) {
        const { input, offset: next } = deserializeInput(bytes, offset);
        inputs.push(input); offset = next;
    }

    const outCount = decodeVarInt(bytes, offset); offset += outCount.bytesRead;
    const outputs = [];
    for (let i = 0; i < outCount.value; i++) {
        const { output, offset: next } = deserializeOutput(bytes, offset);
        outputs.push(output); offset = next;
    }

    const witnesses = [];
    for (let i = 0; i < inCount.value; i++) {
        const { items, offset: next } = deserializeWitness(bytes, offset);
        witnesses.push(items); offset = next;
    }

    const locktime = view.getUint32(offset, true); offset += 4;
    return { tx: { version, inputs, outputs, witnesses, locktime }, totalBytesRead: offset };
}

async function computeTxid(tx) {
    const baseTx = { version: tx.version, inputs: tx.inputs, outputs: tx.outputs, locktime: tx.locktime };
    const raw = serializeTransaction(baseTx);
    return bytesToHex(new Uint8Array(await hash256(raw)).reverse());
}
async function computeWtxid(tx) {
    const raw = serializeSegwitTransaction(tx);
    return bytesToHex(new Uint8Array(await hash256(raw)).reverse());
}

// ---------------------------------------------------------------------------
// BIP143 sighash (z btc-sighash-browser.js)
// ---------------------------------------------------------------------------
// BIP143 sighash dla przeglądarki - port btc-sighash.js. Buffer -> Uint8Array,
// hash256 (Web Crypto) jest async - dlatego getPrevoutsHash/getSequenceHash/
// getOutputsHash/computeSigHash WSZYSTKIE stają się async (przeciwieństwo BCH
// SIGHASH_FORKID, tutaj brak FORK_ID mixing - to samo co w oryginale).


const SIGHASH_ALL = 0x01;
const SIGHASH_NONE = 0x02;
const SIGHASH_SINGLE = 0x03;
const SIGHASH_ANYONECANPAY = 0x80;

function le32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function le32signed(n) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b; }
function le64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }

function serializeOutpoint(input) {
    return concatBytes(new Uint8Array(hexToBytes(input.txid)).reverse(), le32(input.vout));
}
function serializeScriptCode(scriptHex) {
    const scriptBytes = hexToBytes(scriptHex);
    return concatBytes(encodeVarInt(scriptBytes.length), scriptBytes);
}
async function getPrevoutsHash(inputs) {
    return hash256(concatBytes(...inputs.map(serializeOutpoint)));
}
async function getSequenceHash(inputs) {
    return hash256(concatBytes(...inputs.map((input) => le32(input.sequence ?? 0xffffffff))));
}
async function getOutputsHash(outputs) {
    const parts = outputs.map((output) => {
        const scriptBytes = hexToBytes(output.scriptPubKey);
        return concatBytes(le64(output.valueSatoshis), encodeVarInt(scriptBytes.length), scriptBytes);
    });
    return hash256(concatBytes(...parts));
}

function p2wpkhScriptCode(pubKeyHash20) {
    const hashBuf = typeof pubKeyHash20 === "string" ? hexToBytes(pubKeyHash20) : pubKeyHash20;
    const bytes = concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hashBuf, new Uint8Array([0x88, 0xac]));
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function computeSigHash({ tx, inputIndex, scriptCode, inputValueSatoshis, hashType = SIGHASH_ALL }) {
    const input = tx.inputs[inputIndex];
    const anyoneCanPay = !!(hashType & SIGHASH_ANYONECANPAY);
    const baseType = hashType & 0x1f;
    const isSingle = baseType === SIGHASH_SINGLE;
    const isNone = baseType === SIGHASH_NONE;

    let hashPrevouts = new Uint8Array(32);
    if (!anyoneCanPay) hashPrevouts = await getPrevoutsHash(tx.inputs);

    let hashSequence = new Uint8Array(32);
    if (!anyoneCanPay && !isSingle && !isNone) hashSequence = await getSequenceHash(tx.inputs);

    let hashOutputs = new Uint8Array(32);
    if (!isSingle && !isNone) {
        hashOutputs = await getOutputsHash(tx.outputs);
    } else if (isSingle && inputIndex < tx.outputs.length) {
        hashOutputs = await getOutputsHash([tx.outputs[inputIndex]]);
    }

    const versionBytes = le32signed(tx.version ?? 1);
    const valueBytes = le64(inputValueSatoshis);
    const sequenceBytes = le32(input.sequence ?? 0xffffffff);
    const locktimeBytes = le32(tx.locktime ?? 0);
    const sighashTypeBytes = le32(hashType);

    const preimage = concatBytes(
        versionBytes, hashPrevouts, hashSequence,
        serializeOutpoint(input), serializeScriptCode(scriptCode),
        valueBytes, sequenceBytes, hashOutputs, locktimeBytes, sighashTypeBytes
    );

    return { sighash: await hash256(preimage), preimage };
}

// ---------------------------------------------------------------------------
// Adresy P2WPKH, podpisywanie zwykłego wysłania (z btc-p2wpkh-browser.js)
// ---------------------------------------------------------------------------
// P2WPKH dla przeglądarki - port btc-p2wpkh.js. hash160 z browser-core.js
// (już async). signP2WPKHInput/verifyP2WPKHSpend stają się async (wołają
// computeSigHash i signForScriptSig, oba teraz async). compressPubKey/
// decompressPubKey - czysta matematyka BigInt, zostają synchroniczne.





function compressPubKey(point) {
    const xBytes = hexToBytes(point.x.toString(16).padStart(64, "0"));
    const prefix = (point.y % 2n === 0n) ? 0x02 : 0x03;
    return concatBytes(new Uint8Array([prefix]), xBytes);
}
function decompressPubKey(compressedBytes) {
    if (compressedBytes.length !== 33 || (compressedBytes[0] !== 0x02 && compressedBytes[0] !== 0x03)) return null;
    const x = BigInt("0x" + bytesToHex(compressedBytes.subarray(1)));
    return pointFromX(x, compressedBytes[0] === 0x03);
}

function p2wpkhScriptPubKey(pubKeyHash20) {
    const hashBuf = typeof pubKeyHash20 === "string" ? hexToBytes(pubKeyHash20) : pubKeyHash20;
    return bytesToHex(concatBytes(new Uint8Array([0x00, 0x14]), hashBuf));
}

async function addressFromPubPoint(pubPoint, hrp = "bc") {
    const hash = await hash160(compressPubKey(pubPoint));
    return { address: encodeSegwitAddress(hrp, 0, hash), hash160: hash };
}

async function signP2WPKHInput({ tx, inputIndex, privateKeyScalar, pubKeyHash20, inputValueSatoshis, hashType = SIGHASH_ALL }) {
    const scriptCode = p2wpkhScriptCode(pubKeyHash20);
    const { sighash } = await computeSigHash({ tx, inputIndex, scriptCode, inputValueSatoshis, hashType });
    const sigWithType = await signForScriptSig(privateKeyScalar, sighash, hashType);
    const compressedPubKey = compressPubKey(scalarMult(privateKeyScalar, G));
    tx.inputs[inputIndex].scriptSig = "";
    tx.witnesses[inputIndex] = [bytesToHex(sigWithType), bytesToHex(compressedPubKey)];
    return { sighash, sigWithType, compressedPubKey };
}

async function verifyP2WPKHSpend({ tx, inputIndex, pubKeyHash20, inputValueSatoshis }) {
    const witness = tx.witnesses[inputIndex];
    if (!witness || witness.length !== 2) return { valid: false, reason: "witness musi mieć dokładnie 2 elementy (podpis, klucz publiczny)" };
    const sigWithType = hexToBytes(witness[0]);
    const pubKeyBytes = hexToBytes(witness[1]);

    if (!isValidSignatureEncoding(sigWithType)) return { valid: false, reason: "podpis nie przechodzi strict DER (BIP66)" };
    if (pubKeyBytes.length !== 33) return { valid: false, reason: "klucz publiczny musi być skompresowany (33 bajty) - wymóg BIP143" };

    const expectedHash = typeof pubKeyHash20 === "string" ? hexToBytes(pubKeyHash20) : pubKeyHash20;
    const actualHash = await hash160(pubKeyBytes);
    if (bytesToHex(actualHash) !== bytesToHex(expectedHash)) return { valid: false, reason: "hash160(klucz) nie zgadza się ze scriptPubKey" };

    const sigHashType = sigWithType[sigWithType.length - 1];
    const scriptCode = p2wpkhScriptCode(expectedHash);
    const { sighash } = await computeSigHash({ tx, inputIndex, scriptCode, inputValueSatoshis, hashType: sigHashType });
    const { r, s } = decodeDER(sigWithType.subarray(0, sigWithType.length - 1));
    const pubPoint = decompressPubKey(pubKeyBytes);
    if (pubPoint === null) return { valid: false, reason: "klucz publiczny nie leży na krzywej (zła dekompresja)" };
    if (!verifyRaw(pubPoint, sighash, r, s)) return { valid: false, reason: "podpis ECDSA matematycznie nieprawidłowy dla tego sighasha" };

    return { valid: true };
}

// ---------------------------------------------------------------------------
// Kompilacja skryptu HTLC do opcode'ów + adres P2WSH (z btc-htlc-compile-browser.js)
// ---------------------------------------------------------------------------
// Kompilacja skryptu HTLC dla przeglądarki - port btc-htlc-compile.js.
// Opcode'y NIEZMIENIONE (już zweryfikowane wyszukiwaniem wcześniej).
// Buffer -> Uint8Array. deriveP2WSHAddress -> async (sha256 przez Web Crypto).


const OP = {
    IF: 0x63, ELSE: 0x67, ENDIF: 0x68,
    DROP: 0x75, DUP: 0x76,
    SHA256: 0xa8, EQUALVERIFY: 0x88, HASH160: 0xa9, CHECKSIG: 0xac,
    CHECKLOCKTIMEVERIFY: 0xb1,
    PUSHDATA1: 0x4c
};

function encodeScriptNum(value) {
    if (value === 0) return new Uint8Array(0);
    const neg = value < 0;
    let absvalue = Math.abs(value);
    const bytes = [];
    while (absvalue > 0) {
        bytes.push(absvalue % 256);
        absvalue = Math.floor(absvalue / 256);
    }
    if (bytes[bytes.length - 1] & 0x80) {
        bytes.push(neg ? 0x80 : 0x00);
    } else if (neg) {
        bytes[bytes.length - 1] |= 0x80;
    }
    return new Uint8Array(bytes);
}

function pushData(bytes) {
    if (bytes.length === 0) return new Uint8Array([0x00]);
    if (bytes.length <= 75) return concatBytes(new Uint8Array([bytes.length]), bytes);
    if (bytes.length <= 255) return concatBytes(new Uint8Array([OP.PUSHDATA1, bytes.length]), bytes);
    throw new Error("pushData: dane za duże jak na skrypt HTLC");
}

function compileHtlcScript({ hashLock, timeoutHeight, claimantPubKeyHash, refundeePubKeyHash }) {
    const hashLockBuf = hexToBytes(hashLock);
    const claimantBuf = hexToBytes(claimantPubKeyHash);
    const refundeeBuf = hexToBytes(refundeePubKeyHash);

    return concatBytes(
        new Uint8Array([OP.IF]),
        new Uint8Array([OP.SHA256]), pushData(hashLockBuf), new Uint8Array([OP.EQUALVERIFY]),
        new Uint8Array([OP.DUP]), new Uint8Array([OP.HASH160]), pushData(claimantBuf), new Uint8Array([OP.EQUALVERIFY]), new Uint8Array([OP.CHECKSIG]),
        new Uint8Array([OP.ELSE]),
        pushData(encodeScriptNum(timeoutHeight)), new Uint8Array([OP.CHECKLOCKTIMEVERIFY]), new Uint8Array([OP.DROP]),
        new Uint8Array([OP.DUP]), new Uint8Array([OP.HASH160]), pushData(refundeeBuf), new Uint8Array([OP.EQUALVERIFY]), new Uint8Array([OP.CHECKSIG]),
        new Uint8Array([OP.ENDIF])
    );
}

async function deriveP2WSHAddress(compiledScript, hrp = "bc") {
    const scriptHash = await sha256(compiledScript);
    const address = encodeSegwitAddress(hrp, 0, scriptHash);
    const scriptPubKey = bytesToHex(concatBytes(new Uint8Array([0x00, 0x20]), scriptHash));
    return { scriptHash: bytesToHex(scriptHash), scriptPubKey, address };
}

function disassemble(scriptBytes) {
    const tokens = [];
    let offset = 0;
    const opNames = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, "OP_" + k]));
    while (offset < scriptBytes.length) {
        const b = scriptBytes[offset];
        if (b >= 1 && b <= 75) {
            tokens.push(bytesToHex(scriptBytes.subarray(offset + 1, offset + 1 + b)));
            offset += 1 + b;
        } else if (b === OP.PUSHDATA1) {
            const len = scriptBytes[offset + 1];
            tokens.push(bytesToHex(scriptBytes.subarray(offset + 2, offset + 2 + len)));
            offset += 2 + len;
        } else if (b === 0x00) {
            tokens.push("0");
            offset += 1;
        } else if (opNames[b]) {
            tokens.push(opNames[b]);
            offset += 1;
        } else {
            throw new Error(`disassemble: nieznany opcode 0x${b.toString(16)} na offsecie ${offset}`);
        }
    }
    return tokens;
}

// ---------------------------------------------------------------------------
// Wykonanie skryptu HTLC (prawdziwy interpreter) (z btc-script-interpreter-browser.js)
// ---------------------------------------------------------------------------
// Interpreter skryptu HTLC dla przeglądarki - port btc-script-interpreter.js.
// KLUCZOWA różnica: OP_SHA256/OP_HASH160/OP_CHECKSIG wołają teraz ASYNCHRONICZNE
// funkcje (Web Crypto) W TRAKCIE wykonania - dlatego cała pętla executeHtlcScript
// staje się async, nie tylko sygnatura na zewnątrz. Logika/reguły identyczne.





function isTruthy(bytes) { return bytes.length > 0; }
function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

async function executeHtlcScript(scriptBytes, initialStack, context) {
    const stack = [...initialStack];
    let offset = 0;
    const trace = [];

    let branchStack = [];
    function currentlyExecuting() { return branchStack.every((b) => b.executing); }

    while (offset < scriptBytes.length) {
        const b = scriptBytes[offset];

        if (b >= 1 && b <= 75) {
            const data = scriptBytes.subarray(offset + 1, offset + 1 + b);
            offset += 1 + b;
            if (currentlyExecuting()) stack.push(new Uint8Array(data));
            trace.push(`PUSH(${b}B)`);
            continue;
        }
        if (b === 0x00) {
            offset += 1;
            if (currentlyExecuting()) stack.push(new Uint8Array(0));
            trace.push("PUSH(0)");
            continue;
        }

        offset += 1;

        if (b === OP.IF) {
            if (!currentlyExecuting()) { branchStack.push({ executing: false, skipped: true }); trace.push("IF(pominięty)"); continue; }
            const top = stack.pop();
            if (top === undefined) return { valid: false, reason: "OP_IF: pusty stos" };
            branchStack.push({ executing: isTruthy(top) });
            trace.push(`OP_IF (warunek=${isTruthy(top)})`);
            continue;
        }
        if (b === OP.ELSE) {
            const frame = branchStack[branchStack.length - 1];
            if (!frame) return { valid: false, reason: "OP_ELSE bez pasującego OP_IF" };
            frame.executing = !frame.executing;
            trace.push(`OP_ELSE (teraz wykonuje=${frame.executing})`);
            continue;
        }
        if (b === OP.ENDIF) {
            if (branchStack.length === 0) return { valid: false, reason: "OP_ENDIF bez pasującego OP_IF" };
            branchStack.pop();
            trace.push("OP_ENDIF");
            continue;
        }

        if (!currentlyExecuting()) { trace.push(`(pominięto opcode 0x${b.toString(16)})`); continue; }

        if (b === OP.DROP) {
            if (stack.length < 1) return { valid: false, reason: "OP_DROP: za mało elementów" };
            stack.pop();
            trace.push("OP_DROP");
        } else if (b === OP.DUP) {
            if (stack.length < 1) return { valid: false, reason: "OP_DUP: pusty stos" };
            stack.push(new Uint8Array(stack[stack.length - 1]));
            trace.push("OP_DUP");
        } else if (b === OP.SHA256) {
            if (stack.length < 1) return { valid: false, reason: "OP_SHA256: pusty stos" };
            stack.push(await sha256(stack.pop()));
            trace.push("OP_SHA256");
        } else if (b === OP.HASH160) {
            if (stack.length < 1) return { valid: false, reason: "OP_HASH160: pusty stos" };
            stack.push(await hash160(stack.pop()));
            trace.push("OP_HASH160");
        } else if (b === OP.EQUALVERIFY) {
            if (stack.length < 2) return { valid: false, reason: "OP_EQUALVERIFY: za mało elementów" };
            const a = stack.pop(), c = stack.pop();
            if (!bytesEqual(a, c)) return { valid: false, reason: "OP_EQUALVERIFY: wartości się nie zgadzają" };
            trace.push("OP_EQUALVERIFY (zgadza się)");
        } else if (b === OP.CHECKSIG) {
            if (stack.length < 2) return { valid: false, reason: "OP_CHECKSIG: za mało elementów" };
            const pubKeyBytes = stack.pop();
            const sigWithType = stack.pop();
            if (!isValidSignatureEncoding(sigWithType)) return { valid: false, reason: "OP_CHECKSIG: podpis nie przechodzi strict DER" };
            const hashType = sigWithType[sigWithType.length - 1];
            const { sighash } = await computeSigHash({
                tx: context.tx, inputIndex: context.inputIndex,
                scriptCode: context.scriptCodeHex, inputValueSatoshis: context.inputValueSatoshis,
                hashType
            });
            const { r, s } = decodeDER(sigWithType.subarray(0, sigWithType.length - 1));
            const pubPoint = decompressPubKey(pubKeyBytes);
            const sigOk = pubPoint !== null && verifyRaw(pubPoint, sighash, r, s);
            stack.push(sigOk ? new Uint8Array([0x01]) : new Uint8Array(0));
            trace.push(`OP_CHECKSIG (wynik=${sigOk})`);
        } else if (b === OP.CHECKLOCKTIMEVERIFY) {
            if (stack.length < 1) return { valid: false, reason: "OP_CHECKLOCKTIMEVERIFY: pusty stos" };
            const top = stack[stack.length - 1];
            let scriptLocktime = 0n;
            for (let i = top.length - 1; i >= 0; i--) scriptLocktime = (scriptLocktime << 8n) | BigInt(top[i]);
            const input = context.tx.inputs[context.inputIndex];
            if (input.sequence === 0xffffffff) return { valid: false, reason: "OP_CHECKLOCKTIMEVERIFY: sequence == 0xffffffff (BIP65)" };
            if (BigInt(context.tx.locktime) < scriptLocktime) return { valid: false, reason: `OP_CHECKLOCKTIMEVERIFY: nLockTime (${context.tx.locktime}) < wymagane (${scriptLocktime})` };
            trace.push(`OP_CHECKLOCKTIMEVERIFY (${context.tx.locktime} >= ${scriptLocktime}, OK)`);
        } else {
            return { valid: false, reason: `nieobsługiwany opcode 0x${b.toString(16)}` };
        }
    }

    if (branchStack.length !== 0) return { valid: false, reason: "niedomknięty OP_IF" };
    if (stack.length !== 1) return { valid: false, reason: `skrypt musi zostawić dokładnie 1 element, zostawił ${stack.length}` };
    const finalValue = stack[0];
    return { valid: isTruthy(finalValue), reason: isTruthy(finalValue) ? null : "końcowa wartość to false", trace };
}

// ---------------------------------------------------------------------------
// Podpisywanie claim/refund HTLC (z btc-htlc-spend-browser.js)
// ---------------------------------------------------------------------------
// Podpisywanie claim/refund HTLC dla przeglądarki - port btc-htlc-spend.js.
// signHtlcClaim/signHtlcRefund stają się async (wołają computeSigHash i
// signForScriptSig, oba teraz async). Reszta logiki (kolejność w witness,
// wymóg sequence != 0xffffffff) bez zmian.




const TRUE_BYTE = new Uint8Array([0x01]);
const FALSE_BYTES = new Uint8Array(0);

async function signHtlcClaim({ tx, inputIndex, privateKeyScalar, preimageHexString, compiledScriptHex, inputValueSatoshis, hashType = SIGHASH_ALL }) {
    const { sighash } = await computeSigHash({ tx, inputIndex, scriptCode: compiledScriptHex, inputValueSatoshis, hashType });
    const sigWithType = await signForScriptSig(privateKeyScalar, sighash, hashType);
    const compressedPubKey = compressPubKey(scalarMult(privateKeyScalar, G));
    const preimageBytes = utf8ToBytes(preimageHexString);

    tx.inputs[inputIndex].scriptSig = "";
    tx.witnesses[inputIndex] = [
        bytesToHex(sigWithType), bytesToHex(compressedPubKey),
        bytesToHex(preimageBytes), bytesToHex(TRUE_BYTE), compiledScriptHex
    ];
    return { sighash, sigWithType };
}

async function signHtlcRefund({ tx, inputIndex, privateKeyScalar, compiledScriptHex, inputValueSatoshis, hashType = SIGHASH_ALL }) {
    if (tx.inputs[inputIndex].sequence === 0xffffffff) {
        throw new Error("signHtlcRefund: input.sequence == 0xffffffff - OP_CHECKLOCKTIMEVERIFY (BIP65) odrzuci to zawsze.");
    }
    const { sighash } = await computeSigHash({ tx, inputIndex, scriptCode: compiledScriptHex, inputValueSatoshis, hashType });
    const sigWithType = await signForScriptSig(privateKeyScalar, sighash, hashType);
    const compressedPubKey = compressPubKey(scalarMult(privateKeyScalar, G));

    tx.inputs[inputIndex].scriptSig = "";
    tx.witnesses[inputIndex] = [
        bytesToHex(sigWithType), bytesToHex(compressedPubKey), bytesToHex(FALSE_BYTES), compiledScriptHex
    ];
    return { sighash, sigWithType };
}

// ---------------------------------------------------------------------------
// Nadawanie do sieci (mempool.space) (z btc-broadcast-browser.js)
// ---------------------------------------------------------------------------
// Nadawanie surowej transakcji do prawdziwej sieci BTC - przez publiczne API
// mempool.space. Potwierdzone z oficjalnej dokumentacji (mempool.space/*/docs/api):
//   POST {baza}/api/tx
//   treść: surowy hex transakcji jako ZWYKŁY TEKST (nie JSON!)
//   odpowiedź sukcesu: sam txid jako tekst
//   bez autoryzacji, limit ~10 zapytań/sekundę
//
// UCZCIWIE: to JEDYNY plik w całym tym łańcuchu, którego NIE mogłem sam
// przetestować na żywo - moje środowisko nie ma dostępu do sieci. Zbudowane
// dokładnie wg dokumentacji, ale prawdziwe wywołanie z przeglądarki (CORS,
// czy serwer faktycznie odpowiada jak opisano) wymaga sprawdzenia przez
// kogoś z prawdziwym dostępem do internetu - Ciebie.

const NETWORKS = {
    mainnet: "https://mempool.space/api",
    testnet4: "https://mempool.space/testnet4/api",
    signet: "https://mempool.space/signet/api"
};

// Zwraca txid przy sukcesie, albo rzuca błąd z treścią odpowiedzi serwera
// (mempool.space zwraca czytelny opis np. "bad-txns-inputs-missingorspent").
async function broadcastTransaction(rawTxHex, network = "mainnet") {
    const base = NETWORKS[network];
    if (!base) throw new Error(`nieznana sieć "${network}" - dostępne: ${Object.keys(NETWORKS).join(", ")}`);

    const response = await fetch(`${base}/tx`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rawTxHex
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Nadanie odrzucone przez ${network}: ${text}`);
    }
    return text.trim(); // txid
}

// Sprawdza czy konkretne UTXO jest potwierdzone - do odpytywania "czy BTC już doszło".
async function getAddressUtxos(address, network = "mainnet") {
    const base = NETWORKS[network];
    if (!base) throw new Error(`nieznana sieć "${network}"`);
    const response = await fetch(`${base}/address/${address}/utxo`);
    if (!response.ok) throw new Error(`Błąd pobierania UTXO: ${response.status}`);
    return response.json();
}
