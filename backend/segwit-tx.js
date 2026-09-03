"use strict";
// segwit-tx.js - (de)serializacja transakcji BTC (base + segwit), txid/wtxid.
// Zweryfikowane: round-trip bajt-w-bajt na oficjalnej surowej tx z
// bip-0143.mediawiki (Native P2WPKH) - patrz test-bch.js.

const { concatBytes, hash256 } = require("./btc-htlc-script");

function encodeVarInt(n) {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
    if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
    const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}
function decodeVarInt(bytes, offset) {
    const first = bytes[offset];
    if (first < 0xfd) return { value: first, bytesRead: 1 };
    if (first === 0xfd) return { value: bytes.readUInt16LE(offset + 1), bytesRead: 3 };
    if (first === 0xfe) return { value: bytes.readUInt32LE(offset + 1), bytesRead: 5 };
    return { value: Number(bytes.readBigUInt64LE(offset + 1)), bytesRead: 9 };
}
function reverseBytes(bytes) { return Buffer.from(bytes).reverse(); }

function serializeInput(input) {
    const txidBytes = reverseBytes(Buffer.from(input.txid, "hex"));
    const voutBytes = Buffer.alloc(4); voutBytes.writeUInt32LE(input.vout, 0);
    const scriptSigBytes = Buffer.from(input.scriptSig || "", "hex");
    const sequenceBytes = Buffer.alloc(4); sequenceBytes.writeUInt32LE(input.sequence ?? 0xffffffff, 0);
    return concatBytes(txidBytes, voutBytes, encodeVarInt(scriptSigBytes.length), scriptSigBytes, sequenceBytes);
}
function deserializeInput(bytes, offset) {
    const txid = reverseBytes(bytes.subarray(offset, offset + 32)).toString("hex");
    offset += 32;
    const vout = bytes.readUInt32LE(offset); offset += 4;
    const { value: scriptLen, bytesRead } = decodeVarInt(bytes, offset); offset += bytesRead;
    const scriptSig = bytes.subarray(offset, offset + scriptLen).toString("hex"); offset += scriptLen;
    const sequence = bytes.readUInt32LE(offset); offset += 4;
    return { input: { txid, vout, scriptSig, sequence }, offset };
}
function serializeOutput(output) {
    const valueBytes = Buffer.alloc(8); valueBytes.writeBigUInt64LE(BigInt(output.valueSatoshis), 0);
    const scriptBytes = Buffer.from(output.scriptPubKey, "hex");
    return concatBytes(valueBytes, encodeVarInt(scriptBytes.length), scriptBytes);
}
function deserializeOutput(bytes, offset) {
    const valueSatoshis = Number(bytes.readBigUInt64LE(offset)); offset += 8;
    const { value: scriptLen, bytesRead } = decodeVarInt(bytes, offset); offset += bytesRead;
    const scriptPubKey = bytes.subarray(offset, offset + scriptLen).toString("hex"); offset += scriptLen;
    return { output: { valueSatoshis, scriptPubKey }, offset };
}
function serializeTransaction(tx) {
    const parts = [];
    const versionBytes = Buffer.alloc(4); versionBytes.writeInt32LE(tx.version ?? 1, 0);
    parts.push(versionBytes);
    parts.push(encodeVarInt(tx.inputs.length));
    for (const input of tx.inputs) parts.push(serializeInput(input));
    parts.push(encodeVarInt(tx.outputs.length));
    for (const output of tx.outputs) parts.push(serializeOutput(output));
    const locktimeBytes = Buffer.alloc(4); locktimeBytes.writeUInt32LE(tx.locktime ?? 0, 0);
    parts.push(locktimeBytes);
    return concatBytes(...parts);
}
function deserializeTransaction(hexOrBytes) {
    const bytes = typeof hexOrBytes === "string" ? Buffer.from(hexOrBytes, "hex") : Buffer.from(hexOrBytes);
    let offset = 0;
    const version = bytes.readInt32LE(offset); offset += 4;
    const inCount = decodeVarInt(bytes, offset); offset += inCount.bytesRead;
    const inputs = [];
    for (let i = 0; i < inCount.value; i++) { const { input, offset: next } = deserializeInput(bytes, offset); inputs.push(input); offset = next; }
    const outCount = decodeVarInt(bytes, offset); offset += outCount.bytesRead;
    const outputs = [];
    for (let i = 0; i < outCount.value; i++) { const { output, offset: next } = deserializeOutput(bytes, offset); outputs.push(output); offset = next; }
    const locktime = bytes.readUInt32LE(offset); offset += 4;
    return { tx: { version, inputs, outputs, locktime }, totalBytesRead: offset };
}
function serializeWitnessStackItem(itemHex) { const bytes = Buffer.from(itemHex, "hex"); return concatBytes(encodeVarInt(bytes.length), bytes); }
function serializeWitness(stackItems) { return concatBytes(encodeVarInt(stackItems.length), ...stackItems.map(serializeWitnessStackItem)); }
function deserializeWitness(bytes, offset) {
    const { value: count, bytesRead } = decodeVarInt(bytes, offset); offset += bytesRead;
    const items = [];
    for (let i = 0; i < count; i++) {
        const { value: len, bytesRead: br } = decodeVarInt(bytes, offset); offset += br;
        items.push(bytes.subarray(offset, offset + len).toString("hex")); offset += len;
    }
    return { items, offset };
}
function serializeSegwitTransaction(tx) {
    const parts = [];
    const versionBytes = Buffer.alloc(4); versionBytes.writeInt32LE(tx.version ?? 1, 0);
    parts.push(versionBytes);
    parts.push(Buffer.from([0x00, 0x01]));
    parts.push(encodeVarInt(tx.inputs.length));
    for (const input of tx.inputs) parts.push(serializeInput(input));
    parts.push(encodeVarInt(tx.outputs.length));
    for (const output of tx.outputs) parts.push(serializeOutput(output));
    for (const witness of tx.witnesses) parts.push(serializeWitness(witness));
    const locktimeBytes = Buffer.alloc(4); locktimeBytes.writeUInt32LE(tx.locktime ?? 0, 0);
    parts.push(locktimeBytes);
    return concatBytes(...parts);
}
function deserializeSegwitTransaction(hexOrBytes) {
    const bytes = typeof hexOrBytes === "string" ? Buffer.from(hexOrBytes, "hex") : Buffer.from(hexOrBytes);
    let offset = 0;
    const version = bytes.readInt32LE(offset); offset += 4;
    if (bytes[offset] !== 0x00 || bytes[offset + 1] !== 0x01) throw new Error("brak markera/flagi segwit (0x00 0x01) - to nie jest transakcja segwit");
    offset += 2;
    const inCount = decodeVarInt(bytes, offset); offset += inCount.bytesRead;
    const inputs = [];
    for (let i = 0; i < inCount.value; i++) { const { input, offset: next } = deserializeInput(bytes, offset); inputs.push(input); offset = next; }
    const outCount = decodeVarInt(bytes, offset); offset += outCount.bytesRead;
    const outputs = [];
    for (let i = 0; i < outCount.value; i++) { const { output, offset: next } = deserializeOutput(bytes, offset); outputs.push(output); offset = next; }
    const witnesses = [];
    for (let i = 0; i < inCount.value; i++) { const { items, offset: next } = deserializeWitness(bytes, offset); witnesses.push(items); offset = next; }
    const locktime = bytes.readUInt32LE(offset); offset += 4;
    return { tx: { version, inputs, outputs, witnesses, locktime }, totalBytesRead: offset };
}
function computeTxid(tx) {
    const baseTx = { version: tx.version, inputs: tx.inputs, outputs: tx.outputs, locktime: tx.locktime };
    const raw = serializeTransaction(baseTx);
    return reverseBytes(hash256(raw)).toString("hex");
}
function computeWtxid(tx) {
    const raw = serializeSegwitTransaction(tx);
    return reverseBytes(hash256(raw)).toString("hex");
}

module.exports = {
    encodeVarInt, decodeVarInt, serializeInput, deserializeInput, serializeOutput, deserializeOutput,
    serializeTransaction, deserializeTransaction, serializeSegwitTransaction, deserializeSegwitTransaction,
    computeTxid, computeWtxid
};
