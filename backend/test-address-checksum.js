"use strict";
const A = require("./address-checksum");
const crypto = require("crypto");
const Wallet = require("./wallet");

let ok = 0, fail = 0;
const T = (nazwa, warunek, detal) => {
    if (warunek) { ok++; console.log("OK   " + nazwa); }
    else { fail++; console.log("FAIL " + nazwa + (detal ? "  -> " + detal : "")); }
};

console.log("=".repeat(58));
console.log(" SUMA KONTROLNA ADRESU BbC");
console.log("=".repeat(58));

// 1. Determinizm
const w = Wallet.generateWallet();
const surowy = w.address;
const cs1 = A.toChecksumAddress(surowy);
const cs2 = A.toChecksumAddress(surowy.toUpperCase().replace(/^BBC/, "BbC"));
T("determinizm: wielkosc liter wejscia bez znaczenia", cs1 === cs2, cs1 + " vs " + cs2);

// 2. Ten sam adres, tylko inaczej zapisany
T("checksum nie zmienia znakow adresu",
  cs1.toLowerCase() === surowy.toLowerCase(), cs1);

// 3. Wlasny checksum jest poprawny
T("wygenerowany adres ma poprawny checksum", A.checkAddress(cs1) === "valid", A.checkAddress(cs1));

// 4. Stary adres (same male litery) = legacy, nie blad
T("adres sprzed zmiany rozpoznany jako legacy",
  A.checkAddress(surowy.toLowerCase().replace(/^bbc/, "BbC")) === "legacy");

// 5. Legacy nadal wolno wyslac
T("legacy przechodzi (nie blokujemy starych uzytkownikow)",
  A.isSafeToSend(surowy.toLowerCase().replace(/^bbc/, "BbC")));

// 6. NAJWAZNIEJSZE: czy literowka jest wykrywana?
//    Podmieniamy jeden znak w adresie z checksumem.
let wykryte = 0, zbadane = 0, pominiete = 0;
for (let próba = 0; próba < 3000; próba++) {
    const ww = Wallet.generateWallet();
    const cs = A.toChecksumAddress(ww.address);
    const hex = cs.slice(3);
    const poz = 3 + Math.floor(Math.random() * 40);
    const stary = cs[poz];
    const alfabet = "0123456789abcdefABCDEF";
    let nowy;
    do { nowy = alfabet[Math.floor(Math.random() * alfabet.length)]; }
    while (nowy.toLowerCase() === stary.toLowerCase());
    const zepsuty = cs.slice(0, poz) + nowy + cs.slice(poz + 1);
    if (!A.isWellFormed(zepsuty)) { pominiete++; continue; }
    zbadane++;
    if (A.checkAddress(zepsuty) === "invalid") wykryte++;
}
const proc = (wykryte / zbadane * 100);
console.log("");
console.log("   literowek zbadanych : " + zbadane);
console.log("   wykrytych           : " + wykryte + "  (" + proc.toFixed(1) + "%)");
console.log("   przepuszczonych     : " + (zbadane - wykryte));
console.log("");
T("wykrywalnosc literowki powyzej 90%", proc > 90, proc.toFixed(1) + "%");

// 7. Zly format nadal odrzucany
T("za krotki adres odrzucony", A.checkAddress("BbC123") === "malformed");
T("zly prefiks odrzucony", A.checkAddress("XyZ" + "a".repeat(40)) === "malformed");
T("znak spoza hex odrzucony", A.checkAddress("BbC" + "z".repeat(40)) === "malformed");

// 8. Zgodnosc z regexem sieci - kluczowe: adres z checksumem MUSI
//    przechodzic istniejaca walidacje we wszystkich komponentach
const REGEX_SIECI = /^BbC[0-9a-fA-F]{40}$/;
let zgodne = true;
for (let i = 0; i < 500; i++) {
    const a = A.toChecksumAddress(Wallet.generateWallet().address);
    if (!REGEX_SIECI.test(a)) { zgodne = false; break; }
}
T("adres z checksumem przechodzi regex sieci (500 prob)", zgodne);

console.log("");
console.log("=".repeat(58));
console.log(ok + " OK, " + fail + " FAIL");
console.log("=".repeat(58));

console.log("");
console.log("=".repeat(58));
console.log(" NORMALIZACJA - ochrona sald");
console.log("=".repeat(58));
let ok2 = 0, fail2 = 0;
const T2 = (n, w, d) => { if (w) { ok2++; console.log("OK   " + n); } else { fail2++; console.log("FAIL " + n + (d ? "  -> " + d : "")); } };

const wt = Wallet.generateWallet();
const cs = A.toChecksumAddress(wt.address);
const siec = A.toNetworkForm(cs);

T2("postac sieciowa = same male litery", siec === "BbC" + siec.slice(3).toLowerCase(), siec);
T2("postac sieciowa identyczna z oryginalem z portfela", siec === wt.address, siec + " vs " + wt.address);
T2("checksum -> siec -> checksum wraca do tego samego", A.toChecksumAddress(siec) === cs);

// najwazniejsze: kazda postac zapisu daje TEN SAM klucz sieciowy
let spojne = true;
for (let i = 0; i < 500; i++) {
    const a = Wallet.generateWallet().address;
    const formy = [a, a.toUpperCase().replace(/^BBC/, "BbC"), A.toChecksumAddress(a)];
    const klucze = new Set(formy.map(A.toNetworkForm));
    if (klucze.size !== 1) { spojne = false; break; }
}
T2("kazdy zapis adresu daje ten sam klucz sieciowy (500 prob)", spojne);

// zgodnosc wstecz z historia lancucha
const genesis = "BbC694f9417395ed990fce2b3c3fe3d756959bf3b1e";
const pula = "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7";
T2("adres genesis niezmieniony przez normalizacje", A.toNetworkForm(genesis) === genesis);
T2("adres puli niezmieniony przez normalizacje", A.toNetworkForm(pula) === pula);
T2("adres genesis rozpoznany jako legacy (nie blad)", A.checkAddress(genesis) === "legacy");

console.log("");
console.log(ok2 + " OK, " + fail2 + " FAIL");
console.log("=".repeat(58));