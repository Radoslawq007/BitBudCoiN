"use strict";
// btc-htlc-compile.js - kompilacja skryptu HTLC do opcode'ów + adres P2WSH.
// deriveP2WSHAddress zostaje async (mimo że sha256 jest tu sync) wyłącznie
// po to, żeby pasować do "await deriveP2WSHAddress(...)" w claim-htlc.js.

const { hexToBytes, concatBytes, sha256, encodeSegwitAddress, OP, encodeScriptNum, pushData } = require("./btc-htlc-script");

function compileHtlcScript({ hashLock, timeoutHeight, claimantPubKeyHash, refundeePubKeyHash }) {
    const hashLockBuf = hexToBytes(hashLock);
    const claimantBuf = hexToBytes(claimantPubKeyHash);
    const refundeeBuf = hexToBytes(refundeePubKeyHash);
    return concatBytes(
        Buffer.from([OP.IF]),
        Buffer.from([OP.SHA256]), pushData(hashLockBuf), Buffer.from([OP.EQUALVERIFY]),
        Buffer.from([OP.DUP]), Buffer.from([OP.HASH160]), pushData(claimantBuf), Buffer.from([OP.EQUALVERIFY]), Buffer.from([OP.CHECKSIG]),
        Buffer.from([OP.ELSE]),
        pushData(encodeScriptNum(timeoutHeight)), Buffer.from([OP.CHECKLOCKTIMEVERIFY]), Buffer.from([OP.DROP]),
        Buffer.from([OP.DUP]), Buffer.from([OP.HASH160]), pushData(refundeeBuf), Buffer.from([OP.EQUALVERIFY]), Buffer.from([OP.CHECKSIG]),
        Buffer.from([OP.ENDIF])
    );
}

async function deriveP2WSHAddress(compiledScript, hrp = "bc") {
    const scriptHash = sha256(compiledScript);
    const address = encodeSegwitAddress(hrp, 0, scriptHash);
    const scriptPubKey = concatBytes(Buffer.from([0x00, 0x20]), scriptHash).toString("hex");
    return { scriptHash: scriptHash.toString("hex"), scriptPubKey, address };
}

module.exports = { compileHtlcScript, deriveP2WSHAddress };
