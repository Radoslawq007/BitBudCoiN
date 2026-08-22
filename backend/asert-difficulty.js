"use strict";

const MAX_TARGET = (1n << 256n) - 1n;

const RADIX = 65536n;
const RADIX_BITS = 16n;

const IDEAL_BLOCK_TIME = 600n;
const DEFAULT_HALFLIFE = 172800n;

// ASERT aserti3-2d polynomial constants.
const C1 = 195766423245049n;
const C2 = 971821376n;
const C3 = 5127n;
const C4 = 1n << 47n;


/*
 * BigInt division w JS obcina w kierunku zera.
 *
 * ASERT wymaga truncating division dla exponentu.
 */
function truncDiv(a, b) {
    if (b === 0n) {
        throw new Error("ASERT: dzielenie przez zero");
    }

    const negative = (a < 0n) !== (b < 0n);
    const aa = a < 0n ? -a : a;
    const bb = b < 0n ? -b : b;

    const result = aa / bb;

    return negative ? -result : result;
}


/*
 * ASERT liczy target następnego bloku bez floating point.
 *
 * anchorTarget:
 *   rzeczywisty 256-bitowy target kotwicy.
 *
 * evalHeight/evalTime:
 *   aktualnie zaakceptowany blok.
 */
function asertNextTarget({
    anchorHeight,
    anchorParentTime,
    anchorTarget,
    evalHeight,
    evalTime,
    idealBlockTime = IDEAL_BLOCK_TIME,
    halflife = DEFAULT_HALFLIFE,
    maxTarget = MAX_TARGET,
}) {
    anchorHeight = BigInt(anchorHeight);
    anchorParentTime = BigInt(anchorParentTime);
    anchorTarget = BigInt(anchorTarget);
    evalHeight = BigInt(evalHeight);
    evalTime = BigInt(evalTime);
    idealBlockTime = BigInt(idealBlockTime);
    halflife = BigInt(halflife);
    maxTarget = BigInt(maxTarget);

    if (anchorHeight <= 0n) {
        throw new Error("ASERT: anchorHeight musi byc > 0");
    }

    if (evalHeight < anchorHeight) {
        throw new Error("ASERT: evalHeight < anchorHeight");
    }

    if (anchorTarget <= 0n || anchorTarget > maxTarget) {
        throw new Error("ASERT: nieprawidlowy anchorTarget");
    }

    if (idealBlockTime <= 0n) {
        throw new Error("ASERT: nieprawidlowy idealBlockTime");
    }

    if (halflife <= 0n) {
        throw new Error("ASERT: nieprawidlowy halflife");
    }

    /*
     * timeDelta:
     *
     * czas aktualnego bloku
     * minus czas rodzica kotwicy.
     */
    const timeDelta =
        evalTime - anchorParentTime;

    /*
     * heightDelta:
     *
     * aktualna wysokosc
     * minus wysokosc kotwicy.
     */
    const heightDelta =
        evalHeight - anchorHeight;

    /*
     * KLUCZOWY WZÓR ASERT:
     *
     * exponent =
     *
     * ((timeDelta -
     *   idealBlockTime * (heightDelta + 1))
     *   * RADIX)
     * / halflife
     *
     * Całość musi być integerowa.
     */
    const scheduleError =
        timeDelta -
        idealBlockTime * (heightDelta + 1n);

    let exponent =
        truncDiv(
            scheduleError * RADIX,
            halflife
        );

    /*
     * exponent = integer part + fractional part.
     *
     * Arithmetic right shift jest wymagany dla liczb ujemnych.
     */
    const numShifts =
        exponent >> RADIX_BITS;

    exponent =
        exponent -
        numShifts * RADIX;


    /*
     * Polynomial approximation:
     *
     * 2^(fraction)
     */
    const exponentSquared =
        exponent * exponent;

    const exponentCubed =
        exponentSquared * exponent;

    const factor =
        (
            (
                C1 * exponent +
                C2 * exponentSquared +
                C3 * exponentCubed +
                C4
            ) >> 48n
        ) + RADIX;


    /*
     * anchorTarget * factor
     */
    let nextTarget =
        anchorTarget * factor;


    /*
     * Potega całkowita 2^numShifts.
     */
    if (numShifts < 0n) {
        const shift = -numShifts;

        /*
         * Jeżeli przesunięcie jest większe niż zakres
         * 256-bitowego targetu, wynik będzie 0.
         */
        if (shift >= 512n) {
            return 1n;
        }

        nextTarget >>= shift;
    } else if (numShifts > 0n) {
        /*
         * BigInt może rozszerzać się dowolnie,
         * więc nie ma overflow jak przy uint256.
         */
        nextTarget <<= numShifts;
    }

    /*
     * Usunięcie części fixed-point.
     */
    nextTarget >>= RADIX_BITS;


    /*
     * Konsensusowe granice.
     */
    if (nextTarget <= 0n) {
        return 1n;
    }

    if (nextTarget > maxTarget) {
        return maxTarget;
    }

    return nextTarget;
}


/*
 * Zamiana starego modelu difficulty -> target.
 *
 * Ta funkcja istnieje dla kompatybilności z obecnym
 * blockchainem.
 *
 * Docelowo consensus powinien przechowywać TARGET,
 * nie difficulty jako Number.
 */
function difficultyToTarget(difficulty, maxTarget = MAX_TARGET) {
    const d = BigInt(
        Math.max(
            1,
            Math.round(Number(difficulty))
        )
    );

    return maxTarget / d;
}


/*
 * Target -> difficulty.
 *
 * TYLKO UI / API / statystyki.
 *
 * Nie używać jako wartości konsensusowej.
 */
function targetToDifficulty(target, maxTarget = MAX_TARGET) {
    target = BigInt(target);
    maxTarget = BigInt(maxTarget);

    if (target <= 0n) {
        throw new Error("ASERT: target <= 0");
    }

    return Number(maxTarget / target);
}


/*
 * Wrapper zachowujący obecne API:
 *
 * asertNextDifficulty(...)
 *
 * Dzięki temu obecny bbcblockchain.js nie musi
 * zostać rozwalony jednym ruchem.
 */
function asertNextDifficulty({
    anchorHeight,
    anchorParentTime,
    anchorDifficulty,
    evalHeight,
    evalTime,
    idealBlockTime = IDEAL_BLOCK_TIME,
    halflife = DEFAULT_HALFLIFE,
    maxTarget = MAX_TARGET,
}) {
    const anchorTarget =
        difficultyToTarget(
            anchorDifficulty,
            maxTarget
        );

    const nextTarget =
        asertNextTarget({
            anchorHeight,
            anchorParentTime,
            anchorTarget,
            evalHeight,
            evalTime,
            idealBlockTime,
            halflife,
            maxTarget,
        });

    return targetToDifficulty(
        nextTarget,
        maxTarget
    );
}


/*
 * Bezpośredni test PoW:
 *
 * hash <= target
 */
function hashMeetsTarget(hashHex, target) {
    if (
        typeof hashHex !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(hashHex)
    ) {
        return false;
    }

    target = BigInt(target);

    if (
        target <= 0n ||
        target > MAX_TARGET
    ) {
        return false;
    }

    const hash =
        BigInt("0x" + hashHex);

    return hash <= target;
}


module.exports = {
    MAX_TARGET,
    RADIX,
    IDEAL_BLOCK_TIME,
    DEFAULT_HALFLIFE,

    asertNextTarget,
    asertNextDifficulty,

    difficultyToTarget,
    targetToDifficulty,

    hashMeetsTarget,
};