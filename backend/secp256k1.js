"use strict";
// secp256k1.js - krzywa eliptyczna Bitcoina, czysty BigInt, zero zależności.
// Identyczna matematyka co w przetestowanym frontend/assets/btc-bridge.js.
// Mnożenie punktu zweryfikowane krzyżowo z Node OpenSSL
// (crypto.createECDH('secp256k1')) na 7 kluczach, w tym realnych kluczach
// z tego repo - patrz test-bch.js.
//
// Krzywa: y^2 = x^3 + 7 mod P (a=0, b=7). Stałe potwierdzone wyszukiwaniem,
// zgodne z Bitcoin Wiki / SEC2.

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const B = 7n;
const G = { x: Gx, y: Gy };

function modN(a) { let r = a % N; if (r < 0n) r += N; return r; }
function modP(a) { let r = a % P; if (r < 0n) r += P; return r; }

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
        lambda = modP(3n * p1.x * p1.x * modInverseP(modP(2n * p1.y)));
    } else {
        lambda = modP((p2.y - p1.y) * modInverseP(modP(p2.x - p1.x)));
    }
    const x3 = modP(lambda * lambda - p1.x - p2.x);
    const y3 = modP(lambda * (p1.x - x3) - p1.y);
    return { x: x3, y: y3 };
}

// Mnożenie skalarne (double-and-add). k redukowane do [0, N).
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

// Dekompresja: z samego X + parzystości Y odtwarza pełny punkt (P mod 4 == 3
// dla secp256k1, więc pierwiastek kwadratowy mod P to a^((P+1)/4) mod P).
function modSqrtP(a) { return modPow(a, (P + 1n) / 4n, P); }

function pointFromX(x, yIsOdd) {
    const rhs = modP(x * x % P * x + B);
    const y0 = modSqrtP(rhs);
    if (modP(y0 * y0) !== modP(rhs)) return null; // x nie leży na krzywej
    const y0IsOdd = (y0 & 1n) === 1n;
    const y = (y0IsOdd === !!yIsOdd) ? y0 : modP(P - y0);
    return { x, y };
}

function isOnCurve(point) {
    if (point === null) return false;
    const { x, y } = point;
    return modP(y * y - (x * x * x + B)) === 0n;
}

module.exports = {
    P, N, G, modN, modP, modPow, modInverseP, modInverseN,
    pointAdd, scalarMult, modSqrtP, pointFromX, isOnCurve
};
