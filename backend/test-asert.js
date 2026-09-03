'use strict';
const { asertNextTarget, asertNextDifficulty, difficultyToTarget, targetToDifficulty } = require('./asert-difficulty.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

// Wspólne parametry testowe: 8 min/blok, halflife 1h, maxTarget duży (np. 2^40)
const IDEAL = 480n; // 8 min w sekundach
const HALFLIFE_1H = 3600n;
const HALFLIFE_2H = 7200n;
const MAX_TARGET = 2n ** 40n;
const ANCHOR_TARGET = 2n ** 30n; // punkt startowy w środku zakresu
const ANCHOR_HEIGHT = 75000n;
const ANCHOR_PARENT_TIME = 1_800_000_000n; // dowolna referencyjna epoka

// TEST 1: dokładnie na czas -> target = target kotwicy (bez zmian)
{
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  // dokładnie na czas: (heightDelta+1) bloków po IDEAL sekund każdy, licząc od rodzica kotwicy
  const evalTime = ANCHOR_PARENT_TIME + IDEAL * (heightDelta + 1n);
  const result = asertNextTarget({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET,
  });
  check('dokładnie na czas -> target bez zmian', result === ANCHOR_TARGET, `oczekiwano ${ANCHOR_TARGET}, dostano ${result}`);
}

// TEST 2: bloki 2x szybsze niż powinny -> target MALEJE (trudniej)
{
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const onScheduleTime = ANCHOR_PARENT_TIME + IDEAL * (heightDelta + 1n);
  const evalTime = ANCHOR_PARENT_TIME + (onScheduleTime - ANCHOR_PARENT_TIME) / 2n; // 2x szybciej
  const result = asertNextTarget({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET,
  });
  check('2x szybciej niż powinno -> target mniejszy (trudniej)', result < ANCHOR_TARGET, `target=${result} vs anchor=${ANCHOR_TARGET}`);
}

// TEST 3: bloki 2x wolniejsze niż powinny -> target ROŚNIE (łatwiej)
{
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const onScheduleTime = ANCHOR_PARENT_TIME + IDEAL * (heightDelta + 1n);
  const evalTime = onScheduleTime + (onScheduleTime - ANCHOR_PARENT_TIME); // 2x wolniej = podwójny czas
  const result = asertNextTarget({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET,
  });
  check('2x wolniej niż powinno -> target większy (łatwiej)', result > ANCHOR_TARGET, `target=${result} vs anchor=${ANCHOR_TARGET}`);
}

// TEST 4: dokładnie jeden halflife opóźnienia -> target ~2x większy (z dokładnością aproksymacji)
{
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const onScheduleTime = ANCHOR_PARENT_TIME + IDEAL * (heightDelta + 1n);
  const evalTime = onScheduleTime + HALFLIFE_1H; // spóźnienie dokładnie o jeden halflife
  const result = asertNextTarget({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET,
  });
  const expected = ANCHOR_TARGET * 2n;
  const errPct = Number((result > expected ? result - expected : expected - result) * 10000n / expected) / 100;
  check('opóźnienie = 1 halflife -> target ~podwojony', errPct < 0.1, `błąd ${errPct}% (result=${result}, expected=${expected})`);
}

// TEST 5: krótszy halflife (2h vs 1h) mocniej reaguje na to samo odchylenie
{
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const onScheduleTime = ANCHOR_PARENT_TIME + IDEAL * (heightDelta + 1n);
  const evalTime = onScheduleTime + 1800n; // 30 min spóźnienia
  const r1h = asertNextTarget({ anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET, evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET });
  const r2h = asertNextTarget({ anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET, evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_2H, maxTarget: MAX_TARGET });
  check('halflife 1h reaguje mocniej niż 2h na to samo opóźnienie', r1h > r2h, `1h->${r1h}, 2h->${r2h}`);
}

// TEST 6: cross-check aproksymacji całkowitoliczbowej vs float Math.pow, dla wielu losowych exponentów
{
  let maxErrPct = 0;
  for (let i = 0; i < 2000; i++) {
    const exponent = BigInt(Math.floor(Math.random() * 65536)); // [0, 65536)
    const factor =
      ((195766423245049n * exponent +
        971821376n * exponent ** 2n +
        5127n * exponent ** 3n +
        2n ** 47n) >>
        48n) +
      65536n;
    const intResult = Number(factor) / 65536;
    const floatResult = Math.pow(2, Number(exponent) / 65536);
    const errPct = Math.abs(intResult - floatResult) / floatResult * 100;
    if (errPct > maxErrPct) maxErrPct = errPct;
  }
  // spec deklaruje błąd bezwzględny < 0.013% dla tej aproksymacji
  check('aproksymacja 2^x zgodna ze spec (błąd < 0.02%)', maxErrPct < 0.02, `max błąd zaobserwowany: ${maxErrPct.toFixed(5)}%`);
}

// TEST 7: f(0) == 1 i f(1) == 2 dokładnie (wymóg z uzasadnienia specyfikacji)
{
  const f = (exponent) =>
    Number(
      ((195766423245049n * exponent + 971821376n * exponent ** 2n + 5127n * exponent ** 3n + 2n ** 47n) >> 48n) +
        65536n
    ) / 65536;
  check('f(0) == 1 dokładnie', f(0n) === 1, `f(0)=${f(0n)}`);
  check('f(65535 jako granica) bliskie 2', Math.abs(f(65535n) - 2) < 0.001, `f(65535)=${f(65535n)}`);
}

// TEST 8: ekstremalne opóźnienie -> zwraca maxTarget, nie crashuje, nie przekracza limitu
{
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const evalTime = ANCHOR_PARENT_TIME + 999_999_999_999n; // absurdalnie odległe w przyszłość
  const result = asertNextTarget({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET,
  });
  check('ekstremalne opóźnienie -> target = maxTarget (nie więcej)', result === MAX_TARGET, `result=${result}`);
}

// TEST 9: ekstremalne przyspieszenie -> target >= 1, nie 0 ani ujemny
{
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const evalTime = ANCHOR_PARENT_TIME - 999_999_999n; // "przed" kotwicą -> ogromny ujemny drift
  const result = asertNextTarget({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET,
  });
  check('ekstremalne przyspieszenie -> target >= 1 (nie 0, nie ujemny)', result >= 1n, `result=${result}`);
}

// TEST 10: deterministyczność -> to samo wejście = to samo wyjście (kluczowe dla konsensusu)
{
  const params = { anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorTarget: ANCHOR_TARGET, evalHeight: ANCHOR_HEIGHT + 50n, evalTime: ANCHOR_PARENT_TIME + 25000n, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget: MAX_TARGET };
  const r1 = asertNextTarget(params);
  const r2 = asertNextTarget(params);
  const r3 = asertNextTarget({ ...params });
  check('deterministyczność: identyczne wejście -> identyczne wyjście', r1 === r2 && r2 === r3, `${r1}, ${r2}, ${r3}`);
}

// TEST 11: round-trip difficulty -> target -> difficulty (musi wrócić blisko oryginału)
{
  const maxTarget = 2n ** 64n;
  const originalDifficulty = 54993750; // Number, nie BigInt - targetToDifficulty zwraca Number, mieszanie typów w arytmetyce rzuca TypeError
  const target = difficultyToTarget(originalDifficulty, maxTarget);
  const roundTrip = targetToDifficulty(target, maxTarget);
  const errPct = Math.abs(roundTrip - originalDifficulty) / originalDifficulty * 100;
  check('round-trip difficulty->target->difficulty (54993750)', errPct < 0.01, `oryginał=${originalDifficulty}, po round-trip=${roundTrip}, błąd ${errPct}%`);
}

// TEST 12: wolniejsze bloki -> difficulty MALEJE (łatwiej) -- kierunek odwrotny niż dla target
{
  const maxTarget = 2n ** 64n;
  const anchorDifficulty = 54993750n;
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const onScheduleTime = ANCHOR_PARENT_TIME + IDEAL * (heightDelta + 1n);
  const evalTime = onScheduleTime + 1800n; // 30 min spóźnienia
  const result = asertNextDifficulty({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorDifficulty,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget,
  });
  check('wolniejsze bloki -> difficulty maleje (łatwiej)', result < anchorDifficulty, `anchor=${anchorDifficulty}, wynik=${result}`);
}

// TEST 13: szybsze bloki -> difficulty ROŚNIE (trudniej) -- zgodnie z realnym zachowaniem sieci
{
  const maxTarget = 2n ** 64n;
  const anchorDifficulty = 54993750n;
  const heightDelta = 10n;
  const evalHeight = ANCHOR_HEIGHT + heightDelta;
  const onScheduleTime = ANCHOR_PARENT_TIME + IDEAL * (heightDelta + 1n);
  const evalTime = ANCHOR_PARENT_TIME + (onScheduleTime - ANCHOR_PARENT_TIME) / 2n;
  const result = asertNextDifficulty({
    anchorHeight: ANCHOR_HEIGHT, anchorParentTime: ANCHOR_PARENT_TIME, anchorDifficulty,
    evalHeight, evalTime, idealBlockTime: IDEAL, halflife: HALFLIFE_1H, maxTarget,
  });
  check('szybsze bloki -> difficulty rośnie (trudniej)', result > anchorDifficulty, `anchor=${anchorDifficulty}, wynik=${result}`);
}

console.log(`\n${passed} OK, ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
