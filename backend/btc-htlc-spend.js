"use strict";
// btc-htlc-spend.js - podpisywanie claim/refund HTLC (RFC6979, low-S, strict
// DER), kompresja/dekompresja klucza publicznego, interpreter skryptu HTLC
// (do własnej weryfikacji przed nadaniem). Podpis RFC6979 zweryfikowany
// bajt-w-bajt przeciw oficjalnemu podpisowi Bitcoin Core z bip-0143.mediawiki
// - patrz test-bch.js.
//
// SYNCHRONICZNE - Node crypto.createHmac jest sync, w odróżnieniu od Web
// Crypto w wersji przeglądarkowej. signHtlcClaim/signHtlcRefund też są
// sync - zgodnie z tym, jak claim-htlc.js je woła (bez await).

const crypto = require("crypto");
const { G, scalarMult, N, modN, modInverseN, pointAdd, isOnCurve, pointFromX } = require("./secp256k1");
const { concatBytes, utf8ToBytes, bytesToBigInt, hash160, sha256, OP } = require("./btc-htlc-script");
const { computeSigHash, SIGHASH_ALL } = require("./btc-sighash");

function hmacSha256(key, msg) { return crypto.createHmac("sha256", key).update(msg).digest(); }

function int2octets(x) {
    const hex = x.toString(16).padStart(64, "0").slice(-64);
    return Buffer.from(hex, "hex");
}

// RFC 6979 - deterministyczne k, żeby ten sam (klucz, hash) zawsze dawał
// ten sam podpis (bez zależności od losowego generatora).
function rfc6979K(privateKeyInt, hashBytes) {
    const h1 = int2octets(modN(bytesToBigInt(hashBytes)));
    const xOctets = int2octets(privateKeyInt);
    let V = Buffer.alloc(32, 0x01);
    let K = Buffer.alloc(32, 0x00);
    K = hmacSha256(K, concatBytes(V, Buffer.from([0x00]), xOctets, h1));
    V = hmacSha256(K, V);
    K = hmacSha256(K, concatBytes(V, Buffer.from([0x01]), xOctets, h1));
    V = hmacSha256(K, V);
    while (true) {
        V = hmacSha256(K, V);
        const k = bytesToBigInt(V);
        if (k > 0n && k < N) return k;
        K = hmacSha256(K, concatBytes(V, Buffer.from([0x00])));
        V = hmacSha256(K, V);
    }
}
function signRaw(privateKeyInt, hashBytes) {
    const z = modN(bytesToBigInt(hashBytes));
    while (true) {
        const k = rfc6979K(privateKeyInt, hashBytes);
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
    return Buffer.from(hex, "hex");
}
function encodeDERInteger(x) {
    let bytes = minimalBigEndianBytes(x);
    if (bytes[0] & 0x80) bytes = concatBytes(Buffer.from([0x00]), bytes);
    return concatBytes(Buffer.from([0x02, bytes.length]), bytes);
}
function encodeDER(r, s) {
    const body = concatBytes(encodeDERInteger(r), encodeDERInteger(s));
    return concatBytes(Buffer.from([0x30, body.length]), body);
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
function signForScriptSig(privateKeyInt, hashBytes, sighashType) {
    const { r, s } = signRaw(privateKeyInt, hashBytes);
    const sLow = toLowS(s);
    const der = encodeDER(r, sLow);
    return concatBytes(der, Buffer.from([sighashType]));
}

function compressPubKey(point) {
    const xBytes = Buffer.from(point.x.toString(16).padStart(64, "0"), "hex");
    const prefix = (point.y % 2n === 0n) ? 0x02 : 0x03;
    return concatBytes(Buffer.from([prefix]), xBytes);
}
function decompressPubKey(compressedBytes) {
    if (compressedBytes.length !== 33 || (compressedBytes[0] !== 0x02 && compressedBytes[0] !== 0x03)) return null;
    const x = BigInt("0x" + Buffer.from(compressedBytes.subarray(1)).toString("hex"));
    return pointFromX(x, compressedBytes[0] === 0x03);
}

const TRUE_BYTE = Buffer.from([0x01]);
const FALSE_BYTES = Buffer.alloc(0);

// UWAGA preimage: preimageHexString jest hashowany jako UTF8 (litery hex-stringa),
// NIE jako hexToBytes. To CELOWO zgodne z tym, jak HASH_LOCK w claim-htlc.js
// został faktycznie policzony (sha256(utf8ToBytes(SECRET_HEX)) == HASH_LOCK,
// zweryfikowane bezpośrednio na tych wartościach). Nazwa parametru jest myląca,
// ale zmiana zachowania TU rozwaliłaby zgodność z już policzonym HASH_LOCK.
function signHtlcClaim({ tx, inputIndex, privateKeyScalar, preimageHexString, compiledScriptHex, inputValueSatoshis, hashType = SIGHASH_ALL }) {
    const { sighash } = computeSigHash({ tx, inputIndex, scriptCode: compiledScriptHex, inputValueSatoshis, hashType });
    const sigWithType = signForScriptSig(privateKeyScalar, sighash, hashType);
    const compressedPubKey = compressPubKey(scalarMult(privateKeyScalar, G));
    const preimageBytes = utf8ToBytes(preimageHexString);
    tx.inputs[inputIndex].scriptSig = "";
    tx.witnesses[inputIndex] = [
        sigWithType.toString("hex"), compressedPubKey.toString("hex"),
        preimageBytes.toString("hex"), TRUE_BYTE.toString("hex"), compiledScriptHex
    ];
    return { sighash, sigWithType };
}
function signHtlcRefund({ tx, inputIndex, privateKeyScalar, compiledScriptHex, inputValueSatoshis, hashType = SIGHASH_ALL }) {
    if (tx.inputs[inputIndex].sequence === 0xffffffff) {
        throw new Error("signHtlcRefund: input.sequence == 0xffffffff - OP_CHECKLOCKTIMEVERIFY (BIP65) odrzuci to zawsze.");
    }
    const { sighash } = computeSigHash({ tx, inputIndex, scriptCode: compiledScriptHex, inputValueSatoshis, hashType });
    const sigWithType = signForScriptSig(privateKeyScalar, sighash, hashType);
    const compressedPubKey = compressPubKey(scalarMult(privateKeyScalar, G));
    tx.inputs[inputIndex].scriptSig = "";
    tx.witnesses[inputIndex] = [sigWithType.toString("hex"), compressedPubKey.toString("hex"), FALSE_BYTES.toString("hex"), compiledScriptHex];
    return { sighash, sigWithType };
}

// Interpreter skryptu HTLC - NIEUŻYWANY bezpośrednio przez claim-htlc.js,
// ale dostępny do własnej weryfikacji przed nadaniem prawdziwej tx.
function isTruthy(bytes) { return bytes.length > 0; }
function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function executeHtlcScript(scriptBytes, initialStack, context) {
    const stack = initialStack.map((x) => Buffer.from(x));
    let offset = 0;
    let branchStack = [];
    function currentlyExecuting() { return branchStack.every((b) => b.executing); }
    while (offset < scriptBytes.length) {
        const b = scriptBytes[offset];
        if (b >= 1 && b <= 75) {
            const data = scriptBytes.subarray(offset + 1, offset + 1 + b);
            offset += 1 + b;
            if (currentlyExecuting()) stack.push(Buffer.from(data));
            continue;
        }
        if (b === 0x00) { offset += 1; if (currentlyExecuting()) stack.push(Buffer.alloc(0)); continue; }
        offset += 1;
        if (b === OP.IF) {
            if (!currentlyExecuting()) { branchStack.push({ executing: false }); continue; }
            const top = stack.pop();
            if (top === undefined) return { valid: false, reason: "OP_IF: pusty stos" };
            branchStack.push({ executing: isTruthy(top) });
            continue;
        }
        if (b === OP.ELSE) {
            const frame = branchStack[branchStack.length - 1];
            if (!frame) return { valid: false, reason: "OP_ELSE bez pasującego OP_IF" };
            frame.executing = !frame.executing;
            continue;
        }
        if (b === OP.ENDIF) {
            if (branchStack.length === 0) return { valid: false, reason: "OP_ENDIF bez pasującego OP_IF" };
            branchStack.pop();
            continue;
        }
        if (!currentlyExecuting()) continue;
        if (b === OP.DROP) {
            if (stack.length < 1) return { valid: false, reason: "OP_DROP: za mało elementów" };
            stack.pop();
        } else if (b === OP.DUP) {
            if (stack.length < 1) return { valid: false, reason: "OP_DUP: pusty stos" };
            stack.push(Buffer.from(stack[stack.length - 1]));
        } else if (b === OP.SHA256) {
            if (stack.length < 1) return { valid: false, reason: "OP_SHA256: pusty stos" };
            stack.push(sha256(stack.pop()));
        } else if (b === OP.HASH160) {
            if (stack.length < 1) return { valid: false, reason: "OP_HASH160: pusty stos" };
            stack.push(hash160(stack.pop()));
        } else if (b === OP.EQUALVERIFY) {
            if (stack.length < 2) return { valid: false, reason: "OP_EQUALVERIFY: za mało elementów" };
            const a = stack.pop(), c = stack.pop();
            if (!bytesEqual(a, c)) return { valid: false, reason: "OP_EQUALVERIFY: wartości się nie zgadzają" };
        } else if (b === OP.CHECKSIG) {
            if (stack.length < 2) return { valid: false, reason: "OP_CHECKSIG: za mało elementów" };
            const pubKeyBytes = stack.pop();
            const sigWithType = stack.pop();
            if (!isValidSignatureEncoding(sigWithType)) return { valid: false, reason: "OP_CHECKSIG: podpis nie przechodzi strict DER" };
            const hashType = sigWithType[sigWithType.length - 1];
            const { sighash } = computeSigHash({ tx: context.tx, inputIndex: context.inputIndex, scriptCode: context.scriptCodeHex, inputValueSatoshis: context.inputValueSatoshis, hashType });
            const { r, s } = decodeDER(sigWithType.subarray(0, sigWithType.length - 1));
            const pubPoint = decompressPubKey(pubKeyBytes);
            const sigOk = pubPoint !== null && verifyRaw(pubPoint, sighash, r, s);
            stack.push(sigOk ? Buffer.from([0x01]) : Buffer.alloc(0));
        } else if (b === OP.CHECKLOCKTIMEVERIFY) {
            if (stack.length < 1) return { valid: false, reason: "OP_CHECKLOCKTIMEVERIFY: pusty stos" };
            const top = stack[stack.length - 1];
            let scriptLocktime = 0n;
            for (let i = top.length - 1; i >= 0; i--) scriptLocktime = (scriptLocktime << 8n) | BigInt(top[i]);
            const input = context.tx.inputs[context.inputIndex];
            if (input.sequence === 0xffffffff) return { valid: false, reason: "OP_CHECKLOCKTIMEVERIFY: sequence == 0xffffffff (BIP65)" };
            if (BigInt(context.tx.locktime) < scriptLocktime) return { valid: false, reason: `OP_CHECKLOCKTIMEVERIFY: nLockTime (${context.tx.locktime}) < wymagane (${scriptLocktime})` };
        } else {
            return { valid: false, reason: `nieobsługiwany opcode 0x${b.toString(16)}` };
        }
    }
    if (branchStack.length !== 0) return { valid: false, reason: "niedomknięty OP_IF" };
    if (stack.length !== 1) return { valid: false, reason: `skrypt musi zostawić dokładnie 1 element, zostawił ${stack.length}` };
    return { valid: isTruthy(stack[0]), reason: isTruthy(stack[0]) ? null : "końcowa wartość to false" };
}

module.exports = {
    signRaw, verifyRaw, toLowS, encodeDER, decodeDER, isValidSignatureEncoding, signForScriptSig,
    compressPubKey, decompressPubKey, signHtlcClaim, signHtlcRefund, executeHtlcScript
};