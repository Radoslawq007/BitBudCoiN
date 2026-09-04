"use strict";
// btc-htlc-script.js - prymitywy: hex/bajty, hashowanie, Bech32/BIP173,
// opcode'y skryptu HTLC.
//
// SHA256 przez Node crypto (sync, uniwersalnie wspierane).
// RIPEMD160: WŁASNA implementacja JS, celowo NIE crypto.createHash('ripemd160')
// - ten legacy algorytm bywa wyłączony w niektórych buildach OpenSSL 3.x,
// własna implementacja działa zawsze, niezależnie od buildu. Zweryfikowana
// przeciw oficjalnym wektorom testowym i krzyżowo z Node tam gdzie dostępne
// (7 wektorów w tym stress-test 1 mln znaków) - patrz test-bch.js.
//
// Bech32 decode() ma tu DODATKOWO sprawdzenie zakresu znaków HRP (33-126,
// wymóg BIP173) - w wersji przeglądarkowej btc-bridge.js tego brakowało
// (audyt to wykrył). Nieszkodliwe tam bo decodeSegwitAddress i tak sprawdza
// hrp=='bc'/'tb' osobno, ale tu robimy to poprawnie od razu.

const crypto = require("crypto");

function bytesToHex(buf) { return Buffer.from(buf).toString("hex"); }
function hexToBytes(hex) { return Buffer.from(hex, "hex"); }
function concatBytes(...arrays) { return Buffer.concat(arrays.map((a) => Buffer.from(a))); }
function utf8ToBytes(str) { return Buffer.from(str, "utf8"); }
function bytesToBigInt(buf) {
    buf = Buffer.from(buf);
    if (buf.length === 0) return 0n;
    return BigInt("0x" + buf.toString("hex"));
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest(); }
function hash256(buf) { return sha256(sha256(buf)); }

// ---------------------------------------------------------------------
// RIPEMD160 - czysty JS. Tabele z Bitcoin Wiki, logika identyczna jak w
// przetestowanym frontend/assets/btc-bridge.js.
// ---------------------------------------------------------------------
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
    let lenBits = origLenBits;
    for (let i = 0; i < 8; i++) { padded.push(Number(lenBits & 0xffn)); lenBits >>= 8n; }
    return padded;
}
function ripemd160(input) {
    const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
    const padded = padMessage(bytes);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    for (let blockStart = 0; blockStart < padded.length; blockStart += 64) {
        const X = new Array(16);
        for (let i = 0; i < 16; i++) {
            X[i] = (padded[blockStart + i * 4] | (padded[blockStart + i * 4 + 1] << 8) |
                (padded[blockStart + i * 4 + 2] << 16) | (padded[blockStart + i * 4 + 3] << 24)) >>> 0;
        }
        let al = h0, bl = h1, cl = h2, dl = h3, el = h4;
        let ar = h0, br = h1, cr = h2, dr = h3, er = h4;
        for (let round = 0; round < 5; round++) {
            for (let j = 0; j < 16; j++) {
                let t = (al + F(round, bl, cl, dl) + X[R_LEFT[round][j]] + K_LEFT[round]) >>> 0;
                t = rotl(t, S_LEFT[round][j]); t = (t + el) >>> 0;
                al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t;
                let t2 = (ar + F(4 - round, br, cr, dr) + X[R_RIGHT[round][j]] + K_RIGHT[round]) >>> 0;
                t2 = rotl(t2, S_RIGHT[round][j]); t2 = (t2 + er) >>> 0;
                ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t2;
            }
        }
        const temp = (h1 + cl + dr) >>> 0;
        h1 = (h2 + dl + er) >>> 0; h2 = (h3 + el + ar) >>> 0; h3 = (h4 + al + br) >>> 0; h4 = (h0 + bl + cr) >>> 0;
        h0 = temp;
    }
    const out = Buffer.alloc(20);
    [h0, h1, h2, h3, h4].forEach((h, i) => out.writeUInt32LE(h >>> 0, i * 4));
    return out;
}
function hash160(buf) { return ripemd160(sha256(buf)); }

// ---------------------------------------------------------------------
// Bech32 / BIP173
// ---------------------------------------------------------------------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
    let chk = 1;
    for (const v of values) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
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
function verifyChecksum(hrp, data) { return polymod(hrpExpand(hrp).concat(data)) === 1; }
function bech32Encode(hrp, data) {
    const combined = data.concat(createChecksum(hrp, data));
    let result = hrp + "1";
    for (const d of combined) result += CHARSET.charAt(d);
    return result;
}
function bech32Decode(bechString) {
    if (bechString !== bechString.toLowerCase() && bechString !== bechString.toUpperCase()) return null;
    bechString = bechString.toLowerCase();
    const pos = bechString.lastIndexOf("1");
    if (pos < 1 || pos + 7 > bechString.length || bechString.length > 90) return null;
    const hrp = bechString.substring(0, pos);
    for (let i = 0; i < hrp.length; i++) {
        const c = hrp.charCodeAt(i);
        if (c < 33 || c > 126) return null; // BIP173: HRP musi być w [33-126]
    }
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
        while (bits >= toBits) { bits -= toBits; result.push((acc >>> bits) & maxv); }
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
    return bech32Encode(hrp, [witnessVersion].concat(programBits));
}
function decodeSegwitAddress(address, expectedHrp) {
    const decoded = bech32Decode(address);
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
    return { hrp, witnessVersion, program: Buffer.from(program) };
}

// ---------------------------------------------------------------------
// Opcode'y skryptu HTLC
// ---------------------------------------------------------------------
const OP = {
    IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, DUP: 0x76,
    SHA256: 0xa8, EQUALVERIFY: 0x88, HASH160: 0xa9, CHECKSIG: 0xac,
    CHECKLOCKTIMEVERIFY: 0xb1, PUSHDATA1: 0x4c
};
function encodeScriptNum(value) {
    if (value === 0) return Buffer.alloc(0);
    const neg = value < 0;
    let absvalue = Math.abs(value);
    const bytes = [];
    while (absvalue > 0) { bytes.push(absvalue % 256); absvalue = Math.floor(absvalue / 256); }
    if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00);
    else if (neg) bytes[bytes.length - 1] |= 0x80;
    return Buffer.from(bytes);
}
function pushData(bytes) {
    bytes = Buffer.from(bytes);
    if (bytes.length === 0) return Buffer.from([0x00]);
    if (bytes.length <= 75) return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    if (bytes.length <= 255) return Buffer.concat([Buffer.from([OP.PUSHDATA1, bytes.length]), bytes]);
    throw new Error("pushData: dane za duże jak na skrypt HTLC");
}
function disassemble(scriptBytes) {
    const tokens = [];
    let offset = 0;
    const opNames = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, "OP_" + k]));
    while (offset < scriptBytes.length) {
        const b = scriptBytes[offset];
        if (b >= 1 && b <= 75) { tokens.push(bytesToHex(scriptBytes.subarray(offset + 1, offset + 1 + b))); offset += 1 + b; }
        else if (b === OP.PUSHDATA1) { const len = scriptBytes[offset + 1]; tokens.push(bytesToHex(scriptBytes.subarray(offset + 2, offset + 2 + len))); offset += 2 + len; }
        else if (b === 0x00) { tokens.push("0"); offset += 1; }
        else if (opNames[b]) { tokens.push(opNames[b]); offset += 1; }
        else throw new Error(`disassemble: nieznany opcode 0x${b.toString(16)} na offsecie ${offset}`);
    }
    return tokens;
}

module.exports = {
    bytesToHex, hexToBytes, concatBytes, utf8ToBytes, bytesToBigInt,
    sha256, hash256, ripemd160, hash160,
    encodeSegwitAddress, decodeSegwitAddress,
    OP, encodeScriptNum, pushData, disassemble
};