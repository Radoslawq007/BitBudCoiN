/*
 * =====================================================
 * BitBudCoin - generator kodow QR
 * =====================================================
 *
 * Zero zaleznosci zewnetrznych. Swiadomie: kod QR koduje adres
 * kryptowaluty. Gdyby biblioteka byla ladowana z CDN, a CDN zostal
 * podmieniony, kod QR moglby zakodowac CUDZY adres - a uzytkownik
 * zeskanowalby go bez mrugniecia. Przy portfelu to nie jest paranoja,
 * tylko podstawowa ostroznosc.
 *
 * Zakres: tryb bajtowy, poziom korekcji M, wersje 2-6.
 * Adres BbC ma 43 znaki (mainnet) albo 44 (testnet):
 *     4 bity trybu + 8 bitow dlugosci + 43*8 = 356 bitow
 * Wersja 3-M miesci 352 bity - za malo o 4. Uzywana jest wersja 4-M
 * (512 bitow), wybierana automatycznie.
 *
 * Poprawnosc zweryfikowana odczytem: wygenerowane kody sa renderowane
 * do PNG i dekodowane przez OpenCV QRCodeDetector, a wynik porownywany
 * ze zrodlowym adresem. Patrz test-qr.js.
 */

(function (root) {
    "use strict";

    /* ---------- Arytmetyka GF(256) dla Reeda-Solomona ---------- */
    const EXP = new Uint8Array(512);
    const LOG = new Uint8Array(256);
    (function () {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            EXP[i] = x;
            LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11d;
        }
        for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    })();

    const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

    function rsGenerator(stopien) {
        let g = [1];
        for (let i = 0; i < stopien; i++) {
            const n = new Array(g.length + 1).fill(0);
            for (let j = 0; j < g.length; j++) {
                n[j] ^= g[j];
                n[j + 1] ^= mul(g[j], EXP[i]);
            }
            g = n;
        }
        return g;
    }

    function rsKodyKorekcji(dane, ileEcc) {
        const gen = rsGenerator(ileEcc);
        const buf = dane.concat(new Array(ileEcc).fill(0));
        for (let i = 0; i < dane.length; i++) {
            const wiodacy = buf[i];
            if (wiodacy === 0) continue;
            for (let j = 0; j < gen.length; j++) {
                buf[i + j] ^= mul(gen[j], wiodacy);
            }
        }
        return buf.slice(dane.length);
    }

    /* ---------- Tablice wersji, poziom korekcji M ----------
       [pojemnosc danych w bajtach, ile blokow, ecc na blok,
        pozycje wzorcow wyrownania]                          */
    const WERSJE = {
        2: { dane: 28,  bloki: 1, ecc: 16, align: [6, 18] },
        3: { dane: 44,  bloki: 1, ecc: 26, align: [6, 22] },
        4: { dane: 64,  bloki: 2, ecc: 18, align: [6, 26] },
        5: { dane: 86,  bloki: 2, ecc: 24, align: [6, 30] },
        6: { dane: 108, bloki: 4, ecc: 16, align: [6, 34] }
    };

    /* Bity informacji o formacie: poziom M (01) + maska, z korekcja BCH.
       Wartosci z normy ISO/IEC 18004, tablica C.1. */
    const FORMAT_M = [
        0x5412, 0x5125, 0x5E7C, 0x5B4B,
        0x45F9, 0x40CE, 0x4F97, 0x4AA0
    ];

    function wybierzWersje(dlugoscBajtow) {
        for (const v of [2, 3, 4, 5, 6]) {
            const bity = 4 + 8 + dlugoscBajtow * 8;
            if (bity <= WERSJE[v].dane * 8) return v;
        }
        throw new Error("Tekst za dlugi dla wersji 2-6");
    }

    /* ---------- Strumien bitow ---------- */
    function zbudujBity(tekst, wersja) {
        const bajty = [];
        for (let i = 0; i < tekst.length; i++) {
            const c = tekst.charCodeAt(i);
            if (c > 255) throw new Error("Tylko znaki 0-255 (tryb bajtowy)");
            bajty.push(c);
        }

        const bity = [];
        const push = (wartosc, ile) => {
            for (let i = ile - 1; i >= 0; i--) bity.push((wartosc >> i) & 1);
        };

        push(0b0100, 4);            // tryb bajtowy
        push(bajty.length, 8);      // dlugosc (wersje 1-9: 8 bitow)
        for (const b of bajty) push(b, 8);

        const pojemnoscBitow = WERSJE[wersja].dane * 8;

        // terminator: do 4 zer
        for (let i = 0; i < 4 && bity.length < pojemnoscBitow; i++) bity.push(0);
        // dopelnienie do pelnego bajtu
        while (bity.length % 8 !== 0) bity.push(0);

        // bajty wypelniajace, naprzemiennie 0xEC / 0x11
        const wypelniacze = [0xEC, 0x11];
        let k = 0;
        while (bity.length < pojemnoscBitow) {
            push(wypelniacze[k++ % 2], 8);
        }

        // bity -> bajty
        const kody = [];
        for (let i = 0; i < bity.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) b = (b << 1) | bity[i + j];
            kody.push(b);
        }
        return kody;
    }

    /* ---------- Przeplot blokow danych i korekcji ---------- */
    function przeplot(kody, wersja) {
        const w = WERSJE[wersja];
        const naBlok = Math.floor(w.dane / w.bloki);
        const reszta = w.dane % w.bloki;

        const blokiDanych = [];
        const blokiEcc = [];
        let poz = 0;

        for (let i = 0; i < w.bloki; i++) {
            const ile = naBlok + (i >= w.bloki - reszta ? 1 : 0);
            const blok = kody.slice(poz, poz + ile);
            poz += ile;
            blokiDanych.push(blok);
            blokiEcc.push(rsKodyKorekcji(blok, w.ecc));
        }

        const wynik = [];
        const maxD = Math.max(...blokiDanych.map((b) => b.length));
        for (let i = 0; i < maxD; i++) {
            for (const b of blokiDanych) if (i < b.length) wynik.push(b[i]);
        }
        for (let i = 0; i < w.ecc; i++) {
            for (const b of blokiEcc) wynik.push(b[i]);
        }
        return wynik;
    }

    /* ---------- Budowa macierzy ---------- */
    function pustaMacierz(rozmiar) {
        const m = [];
        for (let i = 0; i < rozmiar; i++) m.push(new Array(rozmiar).fill(null));
        return m;
    }

    function wstawWzorzecSzukania(m, r, c) {
        for (let i = -1; i <= 7; i++) {
            for (let j = -1; j <= 7; j++) {
                const y = r + i, x = c + j;
                if (y < 0 || y >= m.length || x < 0 || x >= m.length) continue;
                const naRamce =
                    (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                    (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                    (i >= 2 && i <= 4 && j >= 2 && j <= 4);
                m[y][x] = naRamce ? 1 : 0;
            }
        }
    }

    function wstawWzorzecWyrownania(m, r, c) {
        for (let i = -2; i <= 2; i++) {
            for (let j = -2; j <= 2; j++) {
                m[r + i][c + j] =
                    (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
            }
        }
    }

    function szkielet(wersja) {
        const rozmiar = wersja * 4 + 17;
        const m = pustaMacierz(rozmiar);

        wstawWzorzecSzukania(m, 0, 0);
        wstawWzorzecSzukania(m, 0, rozmiar - 7);
        wstawWzorzecSzukania(m, rozmiar - 7, 0);

        // linie synchronizacji
        for (let i = 8; i < rozmiar - 8; i++) {
            const v = (i % 2 === 0) ? 1 : 0;
            if (m[6][i] === null) m[6][i] = v;
            if (m[i][6] === null) m[i][6] = v;
        }

        // wzorce wyrownania - pomijamy te kolidujace z wzorcami szukania
        const a = WERSJE[wersja].align;
        for (const r of a) {
            for (const c of a) {
                if ((r === 6 && c === 6) ||
                    (r === 6 && c === rozmiar - 7) ||
                    (r === rozmiar - 7 && c === 6)) continue;
                if (m[r][c] === null) wstawWzorzecWyrownania(m, r, c);
            }
        }

        // ciemny modul
        m[rozmiar - 8][8] = 1;

        return m;
    }

    function rezerwujFormat(m) {
        const rozmiar = m.length;
        const zarezerwowane = [];
        for (let i = 0; i < 9; i++) {
            if (m[8][i] === null) { m[8][i] = 0; zarezerwowane.push([8, i]); }
            if (m[i][8] === null) { m[i][8] = 0; zarezerwowane.push([i, 8]); }
        }
        for (let i = rozmiar - 8; i < rozmiar; i++) {
            if (m[8][i] === null) { m[8][i] = 0; zarezerwowane.push([8, i]); }
            if (m[i][8] === null) { m[i][8] = 0; zarezerwowane.push([i, 8]); }
        }
        return zarezerwowane;
    }

    function wstawDane(m, kody, zajete) {
        const rozmiar = m.length;
        const bity = [];
        for (const b of kody) {
            for (let i = 7; i >= 0; i--) bity.push((b >> i) & 1);
        }

        let idx = 0;
        let wGore = true;

        for (let prawa = rozmiar - 1; prawa > 0; prawa -= 2) {
            if (prawa === 6) prawa--;   // pomijamy kolumne synchronizacji

            for (let krok = 0; krok < rozmiar; krok++) {
                const r = wGore ? rozmiar - 1 - krok : krok;

                for (let k = 0; k < 2; k++) {
                    const c = prawa - k;
                    if (zajete[r][c]) continue;
                    m[r][c] = idx < bity.length ? bity[idx] : 0;
                    idx++;
                }
            }
            wGore = !wGore;
        }
    }

    function maska(nr, r, c) {
        switch (nr) {
            case 0: return (r + c) % 2 === 0;
            case 1: return r % 2 === 0;
            case 2: return c % 3 === 0;
            case 3: return (r + c) % 3 === 0;
            case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
            case 5: return (r * c) % 2 + (r * c) % 3 === 0;
            case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
            case 7: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
        }
    }

    function kara(m) {
        const n = m.length;
        let suma = 0;

        // seria 5+ tych samych modulow
        for (let i = 0; i < n; i++) {
            for (const poziomo of [true, false]) {
                let licz = 1;
                for (let j = 1; j < n; j++) {
                    const a = poziomo ? m[i][j] : m[j][i];
                    const b = poziomo ? m[i][j - 1] : m[j - 1][i];
                    if (a === b) licz++;
                    else { if (licz >= 5) suma += 3 + (licz - 5); licz = 1; }
                }
                if (licz >= 5) suma += 3 + (licz - 5);
            }
        }

        // bloki 2x2
        for (let i = 0; i < n - 1; i++) {
            for (let j = 0; j < n - 1; j++) {
                const v = m[i][j];
                if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) suma += 3;
            }
        }

        // proporcja ciemnych modulow
        let ciemne = 0;
        for (const w of m) for (const v of w) if (v) ciemne++;
        const proc = ciemne * 100 / (n * n);
        suma += Math.floor(Math.abs(proc - 50) / 5) * 10;

        return suma;
    }

    function wstawFormat(m, nrMaski) {
        const bity = FORMAT_M[nrMaski];
        const n = m.length;
        for (let i = 0; i < 15; i++) {
            const b = (bity >> i) & 1;
            if (i < 6)       m[i][8] = b;
            else if (i < 8)  m[i + 1][8] = b;
            else if (i === 8) m[8][7] = b;
            else             m[8][14 - i] = b;

            if (i < 8)       m[8][n - 1 - i] = b;
            else             m[n - 15 + i][8] = b;
        }
    }

    /* ---------- Wejscie publiczne ---------- */
    function generuj(tekst) {
        const wersja = wybierzWersje(tekst.length);
        const kody = przeplot(zbudujBity(tekst, wersja), wersja);

        const szkic = szkielet(wersja);
        rezerwujFormat(szkic);

        // mapa modulow funkcyjnych - te nie moga byc nadpisane ani maskowane
        const zajete = szkic.map((w) => w.map((v) => v !== null));

        const m = szkic.map((w) => w.slice());
        wstawDane(m, kody, zajete);

        let najlepsza = null, najlepszaKara = Infinity;
        for (let nr = 0; nr < 8; nr++) {
            const kandydat = m.map((w) => w.slice());
            for (let r = 0; r < kandydat.length; r++) {
                for (let c = 0; c < kandydat.length; c++) {
                    if (!zajete[r][c] && maska(nr, r, c)) kandydat[r][c] ^= 1;
                }
            }
            wstawFormat(kandydat, nr);
            const k = kara(kandydat);
            if (k < najlepszaKara) { najlepszaKara = k; najlepsza = kandydat; }
        }

        return najlepsza;
    }

    /* Zwraca gotowy SVG - bez canvas, wiec dziala tez przy CSP */
    function svg(tekst, opcje) {
        const o = opcje || {};
        const margines = o.margines === undefined ? 4 : o.margines;
        const rozmiar = o.rozmiar || 220;
        const ciemny = o.ciemny || "#04180b";
        const jasny = o.jasny || "#ffffff";

        const m = generuj(tekst);
        const n = m.length + margines * 2;

        let sciezka = "";
        for (let r = 0; r < m.length; r++) {
            for (let c = 0; c < m.length; c++) {
                if (m[r][c]) {
                    sciezka += "M" + (c + margines) + "," + (r + margines) + "h1v1h-1z";
                }
            }
        }

        return '<svg xmlns="http://www.w3.org/2000/svg" width="' + rozmiar +
            '" height="' + rozmiar + '" viewBox="0 0 ' + n + ' ' + n +
            '" shape-rendering="crispEdges">' +
            '<rect width="' + n + '" height="' + n + '" fill="' + jasny + '"/>' +
            '<path d="' + sciezka + '" fill="' + ciemny + '"/></svg>';
    }

    const api = { generuj, svg };

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) { root.bbcQR = api; }

})(typeof window !== "undefined" ? window : null);
