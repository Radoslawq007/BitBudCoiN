"use strict";

/*
 * BitBudCoin ASERT difficulty
 *
 * ASERTI3-2D adapted for BbC.
 *
 * IMPORTANT:
 * - consensus arithmetic uses BigInt
 * - target is calculated as a 256-bit-style unsigned integer
 * - no floating point is used in the ASERT calculation itself
 * - the external BbC representation remains `difficulty`
 *
 * Reference:
 * Bitcoin Cash ASERTI3-2D specification.
 */

const RADIX = 1n << 16n;

// ASERTI3-2D cubic approximation constants.
const C1 = 195766423245049n;
const C2 = 971821376n;
const C3 = 5127n;
const C4 = 1n << 47n;

/*
 * Mathematical floor division.
 *
 * Used only where explicitly required by BbC's integer representation.
 */
function floorDiv(a, b) {
    if (b <= 0n) {
        throw new Error("floorDiv: divisor musi byc dodatni");
    }

    if (a >= 0n) {
        return a / b;
    }

    return -((-a + b - 1n) / b);
}

/*
 * Truncating division toward zero.
 *
 * ASERTI3-2D specifies trunc_div for the fixed-point exponent.
 */
function truncDiv(a, b) {
    if (b <= 0n) {
        throw new Error("truncDiv: divisor musi byc dodatni");
    }

    return a / b;
}

/*
 * Convert BbC difficulty -> target.
 *
 * BbC internally stores difficulty as:
 *
 *     difficulty = MAX_TARGET / target
 *
 * The Number conversion happens ONLY at the API boundary.
 * The resulting target is BigInt.
 */
function difficultyToTarget(difficulty, maxTarget) {
    maxTarget = BigInt(maxTarget);

    if (maxTarget <= 0n) {
        throw new Error("difficultyToTarget: maxTarget musi byc dodatni");
    }

    if (typeof difficulty === "bigint") {
        if (difficulty <= 0n) return maxTarget;

        const target = maxTarget / difficulty;
        return target > 0n ? target : 1n;
    }

    if (
        typeof difficulty !== "number" ||
        !Number.isFinite(difficulty) ||
        difficulty <= 0
    ) {
        throw new Error("difficultyToTarget: nieprawidlowa trudnosc");
    }

    const rounded = Math.max(1, Math.round(difficulty));
    const d = BigInt(rounded);

    const target = maxTarget / d;

    return target > 0n ? target : 1n;
}

/*
 * Convert target -> BbC difficulty.
 *
 * Ceiling division is intentional:
 *
 *     ceil(MAX_TARGET / target)
 *
 * This prevents returning a difficulty that would correspond to
 * an easier-than-calculated target.
 */
function targetToDifficulty(target, maxTarget) {
    target = BigInt(target);
    maxTarget = BigInt(maxTarget);

    if (maxTarget <= 0n) {
        throw new Error("targetToDifficulty: maxTarget musi byc dodatni");
    }

    if (target <= 0n) {
        return Number(maxTarget);
    }

    const difficulty =
        (maxTarget + target - 1n) / target;

    return Number(difficulty > 0n ? difficulty : 1n);
}

/*
 * Calculate ASERT target for the block AFTER eval block.
 *
 * Parameters:
 *
 * anchorHeight
 * anchorParentTime
 * anchorDifficulty
 * evalHeight
 * evalTime
 * idealBlockTime
 * halflife
 * maxTarget
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
    anchorHeight = BigInt(anchorHeight);
    anchorParentTime = BigInt(anchorParentTime);
    evalHeight = BigInt(evalHeight);
    evalTime = BigInt(evalTime);
    idealBlockTime = BigInt(idealBlockTime);
    halflife = BigInt(halflife);
    maxTarget = BigInt(maxTarget);

    if (anchorHeight <= 0n) {
        throw new Error(
            "ASERT: anchorHeight musi byc wieksza od zera"
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

    if (evalHeight < anchorHeight) {
        throw new Error(
            "ASERT: evalHeight nie moze byc mniejsza od anchorHeight"
        );
    }

    /*
     * Anchor target.
     *
     * BbC's anchor stores difficulty instead of compact nBits,
     * therefore convert it to the equivalent integer target.
     */
    const anchorTarget =
        difficultyToTarget(anchorDifficulty, maxTarget);

    /*
     * ASERT:
     *
     * exponent =
     *
     *   ((timeDelta -
     *     idealBlockTime * (heightDelta + 1))
     *    * RADIX)
     *   / halflife
     *
     * IMPORTANT:
     * This division is truncation toward zero, matching the
     * ASERTI3-2D specification.
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
     * Equivalent to arithmetic:
     *
     *     numShifts = exponent >> 16
     *
     * JavaScript BigInt >> performs arithmetic right shift
     * for signed BigInts.
     */
    const numShifts =
        exponent >> 16n;

    /*
     * Remaining fractional part.
     *
     * Must be in [0, 65535].
     */
    const fractionalExponent =
        exponent -
        (numShifts << 16n);

    const x = fractionalExponent;

    /*
     * Cubic approximation of 2^fraction.
     *
     * All operations remain BigInt.
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
     * nextTarget = anchorTarget * factor
     */
    let nextTarget =
        anchorTarget * factor;

    /*
     * Apply the integer power-of-two component.
     *
     * BigInt has arbitrary precision, so this avoids the overflow
     * problem that exists with fixed-width integer implementations.
     */
    if (numShifts < 0n) {
        nextTarget >>= -numShifts;
    } else if (numShifts > 0n) {
        nextTarget <<= numShifts;
    }

    /*
     * Remove the 16-bit fixed-point fractional component.
     */
    nextTarget >>= 16n;

    /*
     * Clamp to valid target range.
     */
    if (nextTarget <= 0n) {
        nextTarget = 1n;
    }

    if (nextTarget > maxTarget) {
        nextTarget = maxTarget;
    }

    /*
     * BbC blockchain currently exposes difficulty as Number,
     * so convert only at the final boundary.
     */
    return targetToDifficulty(
        nextTarget,
        maxTarget
    );
}

module.exports = {
    asertNextDifficulty,
    difficultyToTarget,
    targetToDifficulty,
    floorDiv,
    truncDiv,
};