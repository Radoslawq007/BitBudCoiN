'use strict';

/**
 * ASERT (Absolutely Scheduled Exponentially Rising Targets) difficulty algorithm.
 *
 * Implementacja algorytmu aserti3-2d wg oficjalnej specyfikacji Bitcoin Cash Node:
 * https://upgradespecs.bitcoincashnode.org/2020-11-15-asert/
 * (spec dual-licensed CC0 / GNU All-Permissive — algorytm publiczny, to jest
 * niezależna implementacja w JS, dopasowana pod parametry BitBudCoin).
 *
 * KLUCZOWE: cała matematyka na BigInt. Zero floatów w ścieżce konsensusu —
 * każdy node (Ty, kolega, kuzyn) MUSI policzyć identyczny wynik co do bita.
 *
 * DZIAŁA NA "TARGET", NIE NA "DIFFICULTY":
 *   niższy target = trudniej kopać (dokładnie jak w oryginalnej specyfikacji).
 *   To NIE jest jeszcze podłączone do Waszego blockchain.difficulty —
 *   patrz sekcja "DO ZROBIENIA PRZED WPIĘCIEM" na dole pliku.
 */

const RADIX = 65536n; // 2^16 — 16 bitów precyzji części ułamkowej

/**
 * Rdzeń algorytmu ASERT — liczy target następnego bloku.
 *
 * @param {bigint} anchorHeight       wysokość bloku-kotwicy (h_ref)
 * @param {bigint} anchorParentTime   timestamp RODZICA bloku-kotwicy (t_ref) — UWAGA: rodzica, nie samej kotwicy
 * @param {bigint} anchorTarget       target bloku-kotwicy
 * @param {bigint} evalHeight         wysokość bloku, dla którego liczymy (h_eval)
 * @param {bigint} evalTime           timestamp bloku, dla którego liczymy (t_eval)
 * @param {bigint} idealBlockTime     docelowy czas między blokami w sekundach (BitBudCoin: 480n = 8 min)
 * @param {bigint} halflife           sekundy — po ilu sekundach odchylenia od harmonogramu trudność się podwaja/połowi
 * @param {bigint} maxTarget          górny limit targetu (= najłatwiejsza dozwolona trudność)
 * @returns {bigint} nowy target
 */
function asertNextTarget({
  anchorHeight,
  anchorParentTime,
  anchorTarget,
  evalHeight,
  evalTime,
  idealBlockTime,
  halflife,
  maxTarget,
}) {
  if (anchorHeight <= 0n) throw new Error('anchorHeight musi być > 0');
  if (evalHeight < anchorHeight) throw new Error('evalHeight musi być >= anchorHeight');
  if (anchorTarget <= 0n || anchorTarget > maxTarget) throw new Error('anchorTarget poza zakresem');
  if (halflife <= 0n) throw new Error('halflife musi być > 0');

  const timeDelta = evalTime - anchorParentTime; // może być ujemne
  const heightDelta = evalHeight - anchorHeight;

  // exponent w jednostkach 1/65536, dzielenie obcinające do zera (WYMÓG specyfikacji — nie floor!)
  const numerator = (timeDelta - idealBlockTime * (heightDelta + 1n)) * RADIX;
  let exponent = numerator / halflife; // BigInt "/" w JS obcina do zera — zgodne ze spec

  // liczba pełnych podwojeń/połowień (arytmetyczne przesunięcie w prawo o 16 — BigInt ">>" w JS JEST arytmetyczne)
  const numShifts = exponent >> 16n;
  exponent = exponent - numShifts * RADIX; // reszta w [0, 65536)

  // aproksymacja wielomianowa 2^x dla x w [0,1) — DOKŁADNE stałe ze specyfikacji BCH
  const factor =
    ((195766423245049n * exponent +
      971821376n * exponent ** 2n +
      5127n * exponent ** 3n +
      2n ** 47n) >>
      48n) +
    65536n;

  let nextTarget = anchorTarget * factor;
  nextTarget = numShifts < 0n ? nextTarget >> -numShifts : nextTarget << numShifts;
  nextTarget = nextTarget >> 16n;

  if (nextTarget <= 0n) return 1n; // najtrudniejszy dozwolony
  if (nextTarget > maxTarget) return maxTarget; // najłatwiejszy dozwolony
  return nextTarget;
}

/**
 * Adapter target <-> difficulty, dopasowany 1:1 do Waszej realnej funkcji
 * difficultyToTargetHex() z bbcblockchain.js: target = MAX_TARGET / difficulty.
 * Zweryfikowane z wklejonego kodu — nie zgadywane.
 */
function difficultyToTarget(difficulty, maxTarget) {
  const safe = BigInt(Math.max(1, Math.round(Number(difficulty))));
  return maxTarget / safe;
}

function targetToDifficulty(target, maxTarget) {
  if (target <= 0n) return maxTarget;
  const diff = maxTarget / target;
  return diff < 1n ? 1n : diff;
}

/**
 * Wersja asertNextTarget działająca bezpośrednio na difficulty (jak w Waszym kodzie),
 * nie na target — to jest funkcja, która finalnie wpina się w bbcblockchain.js.
 */
function asertNextDifficulty({
  anchorHeight,
  anchorParentTime,
  anchorDifficulty,
  evalHeight,
  evalTime,
  idealBlockTime,
  halflife,
  maxTarget,
}) {
  const anchorTarget = difficultyToTarget(anchorDifficulty, maxTarget);
  const nextTarget = asertNextTarget({
    anchorHeight, anchorParentTime, anchorTarget, evalHeight, evalTime, idealBlockTime, halflife, maxTarget,
  });
  return targetToDifficulty(nextTarget, maxTarget);
}

module.exports = { asertNextTarget, asertNextDifficulty, difficultyToTarget, targetToDifficulty, RADIX };

/*
 * DO ZROBIENIA PRZED WPIĘCIEM DO bbcblockchain.js (nie zgaduję, bo nie widziałem kodu):
 *
 * 1. Sprawdź czy blockchain.difficulty w Waszym kodzie to TARGET (niżej = trudniej,
 *    jak tutaj) czy DIFFICULTY w stylu Bitcoina (wyżej = trudniej, odwrotnie).
 *    Zobacz jak difficulty jest używane przy weryfikacji hasha bloku:
 *      grep -n "difficulty" ~/backend/bbcblockchain.js | grep -i "hash\|verify\|proof"
 *    Jeśli hash MUSI BYĆ MNIEJSZY niż coś liczone z difficulty → to target-style, pasuje 1:1.
 *    Jeśli hash MUSI MIEĆ WIĘCEJ zer proporcjonalnie do difficulty → to Bitcoin-style,
 *    trzeba dodać konwersję (maxTarget / difficulty ↔ target).
 *
 * 2. anchorHeight/anchorParentTime/anchorTarget dla bloku #75000 nie istnieją jeszcze —
 *    łańcuch jest teraz na ~73 3xx. Podłączamy realne wartości dopiero jak blok #75000
 *    faktycznie padnie.
 *
 * 3. halflife = 3600-7200 (1-2h) to punkt startowy do przetestowania, nie finalna liczba —
 *    czeka na symulację na realnych danych z Waszych logów.
 */
