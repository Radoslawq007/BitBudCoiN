# BitBudCoin (BbC) — Whitepaper

*Wersja 1.0 · 28.07.2026*

## 1. Wprowadzenie

BitBudCoin (BbC) to niezależny, proof-of-work blockchain zbudowany od zera — bez forkowania istniejącego kodu, bez frameworka blockchainowego. Każdy element (silnik łańcucha, kryptografia, sieć P2P, portfel, most do BTC) jest własnym kodem, napisanym i przetestowanym niezależnie.

**Zasada nadrzędna projektu: uczciwość zamiast hype'u.** Ten dokument opisuje wyłącznie to, co faktycznie działa i da się zweryfikować — nie prognozy ani obietnice.

## 2. Architektura techniczna

| Parametr | Wartość |
|---|---|
| Konsensus | Proof-of-Work, SHA-256 |
| Podpisy transakcji | Ed25519 |
| Sieć | P2P, niezależne węzły |
| Persystencja | SQLite |
| Backend | Node.js / Express |

Trudność kopania dostosowuje się okresowo do rzeczywistego tempa wydobycia sieci. Kopanie odbywa się solo albo przez pulę (z proporcjonalnym udziałem w nagrodzie wg zgłoszonych shares i automatycznymi wypłatami).

Portfel działa w całości w przeglądarce — klucz prywatny nigdy nie opuszcza urządzenia użytkownika i nigdy nie trafia na serwer.

## 3. Tokenomika

Dane poniżej pochodzą bezpośrednio z żywego węzła sieci (`/info`), zweryfikowane 28.07.2026:

| Parametr | Wartość |
|---|---|
| Symbol | BbC |
| Maksymalna podaż | 28 000 000 BbC |
| Premine | 700 BbC |
| Aktualna nagroda za blok | 50 BbC |
| Interwał halvingu | co 210 000 bloków |
| Podaż w obiegu (28.07.2026, blok ~2700) | 135 900 BbC |
| Opłata protokołu | 0,5% od przelewu (aktywowana od zadanej wysokości bloku) |

**Premine — pełna przejrzystość:** 700 BbC z premine jest zapisane w bloku genesis (#0), jawnie oznaczone typem `genesis`, z publicznie widocznymi adresami odbiorców. Każdy może to zweryfikować samodzielnie w explorerze, otwierając blok #0 — nic nie jest ukryte poza kodem.

**Metodologia podaży w obiegu:** suma wszystkich transakcji typu `coinbase` (nagrody za wykopane bloki) i `genesis` (premine) na całym łańcuchu. Liczona na żywo przez węzeł, nie ręcznie.

## 4. Most do BTC — atomic swap przez HTLC

BitBudCoin umożliwia wymianę BbC za BTC bez zaufanej trzeciej strony, przez Hash Time-Locked Contracts (HTLC) — ten sam mechanizm co w produkcyjnych atomic swapach.

- Cała kryptografia BTC (adresy, podpisy, budowa i wykonanie skryptu) działa w przeglądarce kupującego, nie na serwerze
- Transakcje nadawane bezpośrednio do prawdziwej sieci Bitcoin
- Sprawdzone na mainnet, nie tylko w symulacji

**Status: eksperymentalny.** Mechanizm jest technicznie kompletny i przeszedł pierwszą, prawdziwą wymianę z realnymi środkami — ale to wciąż pojedynczy przypadek, nie ugruntowana ścieżka. Wymaga to jawnego stwierdzenia, zgodnie z zasadą nadrzędną tego dokumentu.

## 5. Weryfikowalność

Nic w tym dokumencie nie wymaga zaufania na słowo:

- **Explorer** — każdy blok i każda transakcja, publicznie
- **Kod źródłowy** — repozytorium publiczne
- **Blok genesis** — dowód premine, do sprawdzenia przez każdego

## 6. Status i dalsze kroki

Zgodnie z tym, co widać na stronie głównej projektu:

- ✅ Mainnet, portfel, explorer, kopanie — działają, sprawdzone
- 🧪 Atomic swap BTC↔BbC — działa technicznie, wciąż budowana historia prawdziwych transakcji
- 🚧 Kolejne etapy — kapsuła czasu, rozbudowa mostu BCH, dalsze narzędzia dla adresu/portfela

---

*Ten dokument opisuje stan projektu na dzień publikacji. Jeśli coś tu nie zgadza się z tym, co realnie pokazuje sieć — zaufaj sieci, nie temu dokumentowi.*
