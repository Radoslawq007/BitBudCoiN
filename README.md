🌿 BitBudCoiN (BbC)

# BitBudCoin (BbC)

Własny blockchain proof-of-work, zbudowany od zera. Bez frameworków blockchainowych, bez kopiowania cudzego kodu — każda linijka (kryptografia, sieć P2P, kopanie, portfel) napisana i przetestowana osobno.

**Zasada nadrzędna: uczciwość zamiast hype'u.** Ten dokument nie ma niczego upiększać — jeśli coś jest eksperymentalne albo niedokończone, jest tak opisane wprost.

## Czym to jest

- Proof-of-work, SHA-256, dostosowywalna trudność
- Kryptografia podpisów: Ed25519
- Portfel działający w całości w przeglądarce — klucz prywatny nigdy nie dotyka serwera
- Kopanie: solo albo przez pulę (z automatycznymi wypłatami)
- Prawdziwa sieć P2P między niezależnymi węzłami
- Eksplorator łańcucha (bloki, transakcje, adresy)
- Kapsuła czasu (zbudowana, jeszcze nie wdrożona)

## Most do BTC/BCH — swap bez zaufania

BitBudCoin umożliwia wymianę BbC za prawdziwe BTC przez **HTLC (Hash Time-Locked Contracts)** — ten sam mechanizm co w prawdziwych, produkcyjnych atomic swapach. Ani sprzedający, ani kupujący nie muszą ufać drugiej stronie ani żadnemu pośrednikowi — bezpieczeństwo wynika z matematyki, nie z zaufania.

**Co to naprawdę oznacza:**
- Cała kryptografia BTC (adresy, podpisy, budowa i wykonanie skryptu HTLC) działa **w przeglądarce kupującego**, nie na serwerze
- Nadawanie transakcji do prawdziwej sieci Bitcoin — bezpośrednio z przeglądarki, przez publiczne API
- Sprawdzone na prawdziwej sieci Bitcoin (mainnet) — nie tylko w symulacji

**Uczciwie o stanie dzisiejszym:**
- Mechanizm HTLC po stronie BTC wymaga portfela, który pozwala samodzielnie skonstruować i podpisać niestandardową transakcję — większość popularnych portfeli mobilnych (custodialne, jak Wallet of Satoshi) tego nie potrafi. To realne ograniczenie, nie błąd w kodzie.
- System ofert (`create-offer.html` → akceptacja → `swap.html`) jest nowy i przeszedł jeden prawdziwy test z realnymi pieniędzmi, nie setki.
- Strona BCH mostu (poza BTC) jest mniej dojrzała niż strona BTC.

## Struktura repo

- Frontend (ta strona): GitHub Pages
- Backend: Oracle Cloud, Node.js/Express, SQLite
- `assets/btc-bridge.js` — cała kryptografia BTC, samodzielna, bez zależności od Node.js

## Kluczowe strony

| Strona | Do czego |
|---|---|
| `wallet.html` | Portfel — tworzenie, logowanie, wysyłanie, HTLC |
| `explorer.html` | Eksplorator łańcucha |
| `create-offer.html` | Zaproponuj zakup BbC za BTC |
| `swap.html` | Dokończenie zaakceptowanej oferty (kupujący) |
| `address.html` | Historia transakcji dla adresu |
| `miner.html` | Kopanie (solo/pula) |

## Dla deweloperów

Backend na serwerze **nie synchronizuje się automatycznie** z tym repo — każda zmiana wdrażana jest ręcznie. Jeśli coś w kodzie wygląda inaczej niż na żywo działającej stronie, żywa strona jest źródłem prawdy.

---

*Ostatnia aktualizacja: 28.07.2026*
