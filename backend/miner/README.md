# Koparka BitBudCoin (BbC)

Jeden plik, `bbc-miner.js`. Kopiesz do puli BitBudCoin swoim procesorem. Nie potrzebujesz klucza prywatnego, wystarczy adres portfela.

## Co potrzebujesz
1. **Node.js 18 lub nowszy** (https://nodejs.org). Na telefonie z Androidem: aplikacja Termux, potem `pkg install nodejs`.
2. **Adres portfela BbC** (zaczyna się od `BbC`). Zrobisz go w portfelu na stronie projektu.

## Uruchomienie
```
node bbc-miner.js BbCtwojadres
```

Dodatki:
- `--threads 2` ogranicza liczbę wątków (domyślnie rdzenie minus jeden)
- `--bench` sprawdza tylko szybkość Twojego procesora, bez sieci
- Ctrl+C kończy i pokazuje podsumowanie

## Jak to działa
- Pobiera pracę z puli, liczy SHA-256 i wysyła znalezione "udziały" z powrotem.
- Pula nalicza nagrody za udziały, a wypłaca je automatycznie. Nie dzieje się to od razu.
- Plik jest krótki i czytelny. Robi tylko pobieranie pracy i wysyłanie udziałów, nie czyta Twoich plików.

## Uczciwie o zarobku
Zarobek jest proporcjonalny do mocy Twojego procesora i wielkości sieci. Na zwykłym komputerze to niewielkie kwoty. Kopiesz po to, żeby sieć żyła.
