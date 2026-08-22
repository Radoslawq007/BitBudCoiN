"use strict";

/*
 * BitBudCoin ASERT difficulty
 *
 * ASERTI3-2D adapted for BbC's internal representation:
 *
 *   difficulty = MAX_TARGET / target
 *
 * Consensus calculation itself uses BigInt only.
 * No floating-point arithmetic is used inside ASERT.
 *
 * The anchor is the LAST block mined under the old DAA.
 * Its parent timestamp is used as ASERT's reference timestamp.
 */

const RADIX = 1n << 16n;

// Cubic approximation constants from aserti3-2d.
const C1 = 195766423245049n;
const C2 = 971821376n;
const C3 = 5127n;
const C4 = 1n << 47n;

function floorDiv(a, b) {
    if (b <= 0n) {
        throw new Error("floorDiv: divisor musi byc dodatni");
    }

    if (a >= 0n) {
        return a / b;
    }

    return -((-a + b - 1n) / b);
}

function difficultyToTarget(difficulty, maxTarget) {
    const d = BigInt(Math.max(1, Math.round(Number(difficulty))));

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
     * BbC internally represents difficulty as a Number.
     * The consensus target calculation remains BigInt.
     *
     * Ceiling is important here: using floor could make the resulting
     * difficulty slightly easier than the calculated target.
     */
    const difficulty = (maxTarget + target - 1n) / target;

    return Number(difficulty > 0n ? difficulty : 1n);
}

/*
 * Calculate ASERT target for the block AFTER currentBlock.
 *
 * Parameters:
 *
 * anchorHeight       = height of ASERT anchor block
 * anchorParentTime   = timestamp of anchor's parent, seconds
 * anchorDifficulty   = difficulty of anchor block
 * evalHeight         = current block height
 * evalTime           = current block timestamp, seconds
 * idealBlockTime     = target interval, seconds
 * halflife           = ASERT half-life, seconds
 * maxTarget           = maximum allowed target
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
    anchorDifficulty = BigInt(
        Math.max(1, Math.round(Number(anchorDifficulty)))
    );
    evalHeight = BigInt(evalHeight);
    evalTime = BigInt(evalTime);
    idealBlockTime = BigInt(idealBlockTime);
    halflife = BigInt(halflife);
    maxTarget = BigInt(maxTarget);

    if (anchorDifficulty <= 0n) {
        throw new Error("ASERT: anchorDifficulty musi byc dodatnie");
    }

    if (idealBlockTime <= 0n) {
        throw new Error("ASERT: idealBlockTime musi byc dodatni");
    }

    if (halflife <= 0n) {
        throw new Error("ASERT: halflife musi byc dodatni");
    }

    if (maxTarget <= 0n) {
        throw new Error("ASERT: maxTarget musi byc dodatni");
    }

    const anchorTarget = difficultyToTarget(
        anchorDifficulty,
        maxTarget
    );

    /*
     * ASERT:
     *
     * exponent =
     *   (timeDelta - idealBlockTime * (heightDelta + 1))
     *   / halflife
     *
     * The division MUST be mathematical floor division.
     */
    const timeDelta = evalTime - anchorParentTime;
    const heightDelta = evalHeight - anchorHeight;

    const rawExponent =
        timeDelta -
        idealBlockTime * (heightDelta + 1n);

    const exponent =
        floorDiv(rawExponent << 16n, halflife);

    /*
     * Separate integer shift and fractional 16-bit part.
     *
     * Arithmetic shift is required for negative values.
     */
    const numShifts = exponent >> 16n;

    const fractionalExponent =
        exponent - (numShifts << 16n);

    /*
     * Cubic approximation of 2^x for x in [0,1).
     */
    const x = fractionalExponent;

    let factor =
        (
            C1 * x +
            C2 * x * x +
            C3 * x * x * x +
            C4
        ) >> 48n;

    factor += RADIX;

    let nextTarget = anchorTarget * factor;

    /*
     * Apply integer power-of-two shift.
     */
    if (numShifts < 0n) {
        nextTarget >>= -numShifts;
    } else {
        nextTarget <<= numShifts;
    }

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

    return targetToDifficulty(nextTarget, maxTarget);
}

module.exports = {
    asertNextDifficulty,
    difficultyToTarget,
    targetToDifficulty,
    floorDiv,
};