"use strict";

const MAX_TARGET = (1n << 256n) - 1n;

// ASERT fixed-point radix: 2^16
const RADIX = 65536n;

// aserti3-2d parameters
const ASERT_RADIX_BITS = 16;
const IDEAL_BLOCK_TIME = 600n;

// 2 days.
// Dla BbC możemy później dobrać własny halflife,
// ale na tym etapie zostawiamy sprawdzony model ASERT.
const DEFAULT_HALFLIFE = 172800n;

// Cubic approximation constants z aserti3-2d.
// Celowo zostają jako BigInt.
// Żadnego Number / Math.pow() w konsensusie.
const C1 = 195766423245049n;
const C2 = 971821376n;
const C3 = 5127n;
const C4 = 1n << 47n;

/**
 * ASERT:
 *
 * nextTarget =
 *   anchorTarget *
 *   2^(
 *     (timeDelta - idealBlockTime * (heightDelta + 1))
 *     / halflife
 *   )
 *
 * Obliczenia wykonywane są wyłącznie integerowo.
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
        throw new Error("ASERT: idealBlockTime musi byc > 0");
    }

    if (halflife <= 0n) {
        throw new Error("ASERT: halflife musi byc > 0");
    }

    /*
     * timeDelta moze byc ujemne.
     */
    const timeDelta =
        evalTime - anchorParentTime;

    const heightDelta =
        evalHeight - anchorHeight;

    /*
     * Dokladnie jak w specyfikacji:
     *
     * exponent =
     *   trunc(
     *     ((timeDelta -
     *       idealBlockTime * (heightDelta + 1))
     *       * RADIX)
     *     / halflife
     *   )
     *
     * BigInt division w JS obcina w kierunku zera,
     * czyli odpowiada wymaganej trunc_div.
     */
    let exponent =
        (
            (
                timeDelta -
                idealBlockTime * (heightDelta + 1n)
            ) *
            RADIX
        ) / halflife;

    /*
     * Arithmetic shift.
     *
     * BigInt >> zachowuje znak, więc działa poprawnie
     * również dla ujemnego exponent.
     */
    const numShifts =
        exponent >> BigInt(ASERT_RADIX_BITS);

    exponent =
        exponent -
        numShifts * RADIX;

    /*
     * Polynomial approximation of 2^fraction.
     *
     * Wszystko na BigInt.
     */
    const exponentSquared =
        exponent * exponent;

    const exponentCubed =
        exponentSquared * exponent;

    let factor =
        (
            C1 * exponent +
            C2 * exponentSquared +
            C3 * exponentCubed +
            C4
        ) >> 48n;

    factor += RADIX;

    /*
     * targetRef * factor
     */
    let nextTarget =
        anchorTarget * factor;

    /*
     * 2^integerExponent
     */
    if (numShifts < 0n) {
        const shift = -numShifts;

        if (shift >= 256n) {
            return 1n;
        }

        nextTarget >>= shift;
    } else if (numShifts > 0n) {
        /*
         * Nie dopuszczamy do bezsensownego wzrostu.
         * Jeśli wynik przekroczy maxTarget, później zostanie
         * ograniczony do maxTarget.
         */
        nextTarget <<= numShifts;
    }

    /*
     * Usunięcie 16 bitów części ułamkowej.
     */
    nextTarget >>= 16n;

    /*
     * Granice konsensusu.
     */
    if (nextTarget <= 0n) {
        return 1n;
    }

    if (nextTarget > maxTarget) {
        return maxTarget;
    }

    return nextTarget;
}


/**
 * Wrapper zgodny z dotychczasowym API projektu.
 *
 * Zwraca BigInt target, a nie Number.
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
    /*
     * Stara wersja projektu przechowywała difficulty jako
     * abstrakcyjną liczbę.
     *
     * Na tym etapie traktujemy ją jako współczynnik względem
     * MAX_TARGET.
     *
     * Docelowo usuniemy całkowicie tę warstwę i wszystkie bloki
     * będą miały prawdziwy target/nBits.
     */
    const difficulty =
        BigInt(Math.max(1, Math.round(anchorDifficulty)));

    const anchorTarget =
        maxTarget / difficulty;

    return asertNextTarget({
        anchorHeight,
        anchorParentTime,
        anchorTarget,
        evalHeight,
        evalTime,
        idealBlockTime,
        halflife,
        maxTarget,
    });
}


/**
 * Konwersja target -> difficulty tylko do UI/statystyk.
 *
 * NIE używać do consensus.
 */
function targetToDifficulty(target, maxTarget = MAX_TARGET) {
    target = BigInt(target);
    maxTarget = BigInt(maxTarget);

    if (target <= 0n) {
        throw new Error("target musi byc > 0");
    }

    return Number(maxTarget / target);
}


/**
 * Sprawdzenie PoW.
 *
 * hashHex musi być 64-znakowym SHA-256.
 */
function hashMeetsTarget(hashHex, target) {
    if (
        typeof hashHex !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(hashHex)
    ) {
        return false;
    }

    target = BigInt(target);

    if (target <= 0n || target > MAX_TARGET) {
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

    targetToDifficulty,
    hashMeetsTarget,
};