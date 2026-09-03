"use strict";
// btc-sighash.js - BIP143 sighash dla transakcji SegWit v0. Zweryfikowane
// bajt-w-bajt przeciw oficjalnemu wektorowi testowemu z bip-0143.mediawiki
// (Native P2WPKH) - patrz test-bch.js.

const { concatBytes, hash256 } = require("./btc-htlc-script");
const { encodeVarInt } = require("./segwit-tx");

const SIGHASH_ALL = 0x01;
const SIGHASH_NONE = 0x02;
const SIGHASH_SINGLE = 0x03;
const SIGHASH_ANYONECANPAY = 0x80;

function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function le32signed(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }
function le64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; }

function serializeOutpoint(input) {
    return concatBytes(Buffer.from(input.txid, "hex").reverse(), le32(input.vout));
}
function serializeScriptCode(scriptHex) {
    const scriptBytes = Buffer.from(scriptHex, "hex");
    return concatBytes(encodeVarInt(scriptBytes.length), scriptBytes);
}
function getPrevoutsHash(inputs) { return hash256(concatBytes(...inputs.map(serializeOutpoint))); }
function getSequenceHash(inputs) { return hash256(concatBytes(...inputs.map((i) => le32(i.sequence ?? 0xffffffff)))); }
function getOutputsHash(outputs) {
    const parts = outputs.map((o) => {
        const scriptBytes = Buffer.from(o.scriptPubKey, "hex");
        return concatBytes(le64(o.valueSatoshis), encodeVarInt(scriptBytes.length), scriptBytes);
    });
    return hash256(concatBytes(...parts));
}

// SYNCHRONICZNE (Node crypto jest sync) - w odróżnieniu od wersji
// przeglądarkowej, która musi być async przez Web Crypto.
function computeSigHash({ tx, inputIndex, scriptCode, inputValueSatoshis, hashType = SIGHASH_ALL }) {
    const input = tx.inputs[inputIndex];
    const anyoneCanPay = !!(hashType & SIGHASH_ANYONECANPAY);
    const baseType = hashType & 0x1f;
    const isSingle = baseType === SIGHASH_SINGLE;
    const isNone = baseType === SIGHASH_NONE;

    let hashPrevouts = Buffer.alloc(32);
    if (!anyoneCanPay) hashPrevouts = getPrevoutsHash(tx.inputs);

    let hashSequence = Buffer.alloc(32);
    if (!anyoneCanPay && !isSingle && !isNone) hashSequence = getSequenceHash(tx.inputs);

    let hashOutputs = Buffer.alloc(32);
    if (!isSingle && !isNone) hashOutputs = getOutputsHash(tx.outputs);
    else if (isSingle && inputIndex < tx.outputs.length) hashOutputs = getOutputsHash([tx.outputs[inputIndex]]);

    const preimage = concatBytes(
        le32signed(tx.version ?? 1), hashPrevouts, hashSequence,
        serializeOutpoint(input), serializeScriptCode(scriptCode),
        le64(inputValueSatoshis), le32(input.sequence ?? 0xffffffff),
        hashOutputs, le32(tx.locktime ?? 0), le32(hashType)
    );
    return { sighash: hash256(preimage), preimage };
}

module.exports = { SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY, computeSigHash };
