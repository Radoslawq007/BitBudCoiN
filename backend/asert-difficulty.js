"use strict";

/*
 * BitBudCoin vMax ASERT
 *
 * aserti3-2d adapted for BbC.
 *
 * IMPORTANT:
 * - consensus arithmetic uses BigInt
 * - exponent division uses truncation toward zero
 * - no floating point arithmetic is used inside the ASERT calculation
 * - target is calculated from the fixed vMax anchor
 */

const RADIX = 1n << 16n;

/*
 * Cubic approximation constants from aserti3-2d.
 */
const C1 = 195766423245049n;
const C2 = 971821376n;
const C3 = 5127n;
const C4 = 1n << 47n;

/*
 * BigInt division in JavaScript truncates toward zero.
 *
 * This is intentionally NOT floor division.
 *
 * ASERT specification requires:
 *
 * trunc_div(value, halflife)
 */
function truncDiv(a, b) {
    if (b <= 0n) {
        throw new Error("ASERT: divisor musi byc dodatni");
    }

    return a / b;
}

function difficultyToTarget(difficulty, maxTarget) {
    const d = BigInt(
        Math.max(1, Math.trunc(Number(difficulty)))
    );

    if (d <= 0n) {
        return maxTarget;
    }

    const target = maxTarget / d;

    return target > 0n ? target : 1n;
}

function targetToDifficulty(target, maxTarget) {
    if (target <= 0n) {
        return Number(maxTarget);
    }

    /*
     * Ceiling division:
     *
     * ceil(maxTarget / target)
     *
     * Dzięki temu wynik nie tworzy łatwiejszego targetu
     * niż target wyliczony przez ASERT.
     */
    const difficulty =
        (maxTarget + target - 1n) / target;

    return Number(
        difficulty > 0n ? difficulty : 1n
    );
}

/*
 * ============================================================
 * vMax ASERT
 * ============================================================
 *
 * anchorHeight
 *     wysokość bloku kotwicznego
 *
 * anchorParentTime
 *     timestamp rodzica kotwicy, sekundy
 *
 * anchorDifficulty
 *     difficulty bloku kotwicznego
 *
 * evalHeight
 *     wysokość aktualnego bloku
 *
 * evalTime
 *     timestamp aktualnego bloku, sekundy
 *
 * idealBlockTime
 *     480 sekund dla BbC
 *
 * halflife
 *     3600 sekund dla BbC
 *
 * maxTarget
 *     maksymalny target
 */
function asertNextDifficulty({
    anchorHeight,
    anchorParentTime,
    anchorDifficulty,
    evalHeight,
    evalTime,
    idealBlockTime,
    halflife,
    maxTarget
}) {
    anchorHeight = BigInt(anchorHeight);
    anchorParentTime = BigInt(anchorParentTime);

    anchorDifficulty = BigInt(
        Math.max(
            1,
            Math.trunc(Number(anchorDifficulty))
        )
    );

    evalHeight = BigInt(evalHeight);
    evalTime = BigInt(evalTime);

    idealBlockTime = BigInt(idealBlockTime);
    halflife = BigInt(halflife);
    maxTarget = BigInt(maxTarget);

    if (anchorHeight <= 0n) {
        throw new Error(
            "ASERT: anchorHeight musi byc > 0"
        );
    }

    if (anchorDifficulty <= 0n) {
        throw new Error(
            "ASERT: anchorDifficulty musi byc dodatnie"
        );
    }

    if (evalHeight < anchorHeight) {
        throw new Error(
            "ASERT: evalHeight nie moze byc mniejsze od anchorHeight"
        );
    }

    if (idealBlockTime <= 0n) {
        throw new Error(
            "ASERT: idealBlockTime musi byc dodatni"
        );
    }

    if (halflife <= 0n) {
        throw new Error(
            "ASERT: halflife musi byc dodatni"
        );
    }

    if (maxTarget <= 0n) {
        throw new Error(
            "ASERT: maxTarget musi byc dodatni"
        );
    }

    /*
     * Anchor target.
     */
    const anchorTarget =
        difficultyToTarget(
            anchorDifficulty,
            maxTarget
        );

    /*
     * ASERT:
     *
     * exponent =
     *
     * ((timeDelta -
     *   idealBlockTime * (heightDelta + 1))
     *   * RADIX)
     * / halflife
     *
     * Division = truncation toward zero.
     */
    const timeDelta =
        evalTime - anchorParentTime;

    const heightDelta =
        evalHeight - anchorHeight;

    const scheduleDelta =
        timeDelta -
        idealBlockTime * (heightDelta + 1n);

    const exponent =
        truncDiv(
            scheduleDelta * RADIX,
            halflife
        );

    /*
     * Arithmetic right shift.
     *
     * BigInt >> is arithmetic for signed BigInt.
     */
    const numShifts =
        exponent >> 16n;

    /*
     * Fractional part in [0, 65535].
     */
    const fractionalExponent =
        exponent -
        (numShifts << 16n);

    const x =
        fractionalExponent;

    /*
     * Cubic approximation of 2^x.
     */
    let factor =
        (
            C1 * x +
            C2 * x * x +
            C3 * x * x * x +
            C4
        ) >> 48n;

    factor += RADIX;

    /*
     * Multiply anchor target by fractional factor.
     */
    let nextTarget =
        anchorTarget * factor;

    /*
     * Apply integer power-of-two component.
     */
    if (numShifts < 0n) {
        nextTarget >>=
            -numShifts;
    } else {
        nextTarget <<=
            numShifts;
    }

    /*
     * Remove fixed-point fractional bits.
     */
    nextTarget >>= 16n;

    /*
     * Clamp.
     */
    if (nextTarget <= 0n) {
        nextTarget = 1n;
    }

    if (nextTarget > maxTarget) {
        nextTarget = maxTarget;
    }

    return targetToDifficulty(
        nextTarget,
        maxTarget
    );
}

module.exports = {
    asertNextDifficulty,
    difficultyToTarget,
    targetToDifficulty,
    truncDiv
};