/*
 * Copyright (C) Zenju
 * Copyright (C) 2026 Klaus Reimer
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * xBRZ pixel scaling algorithm implemented in AssemblyScript.
 *
 * This module operates on packed `0xAABBGGRR` pixels and analyzes a 4x4 neighborhood around each source
 * pixel to decide how the enlarged output block should be blended.
 *
 * This file avoids AssemblyScript container allocations in the hot path. Small fixed-size work buffers are
 * stored in static linear memory, while per-scaler source, target, pre-processing, and lookup-table areas
 * are managed explicitly through raw pointers.
 */

/** Maximum alpha-aware color distance still treated as equal. */
const EQUAL_COLOR_TOLERANCE: f32 = 30.0;

/** Bias factor favoring the center direction when comparing edge gradients. */
const CENTER_DIRECTION_BIAS: f32 = 4.0;

/** Threshold for upgrading a normal blend hint to a dominant gradient. */
const DOMINANT_DIRECTION_THRESHOLD: f32 = 3.6;

/** Threshold separating shallow and steep line directions. */
const STEEP_DIRECTION_THRESHOLD: f32 = 2.4;

/** No blend required for the analyzed corner. */
const BLEND_NONE: i32 = 0;

/** Normal-strength indication that the corner should be blended. */
const BLEND_NORMAL: i32 = 1;

/** Strong indication that the corner should be blended. */
const BLEND_DOMINANT: i32 = 2;

/** Packed blend bits for corner `E` in the center 2x2 source block. */
const BLEND_E_MASK: i32 = 0x03;

/** Packed blend bits for corner `F` in the center 2x2 source block. */
const BLEND_F_MASK: i32 = 0x0c;

/** Packed blend bits for corner `H` in the center 2x2 source block. */
const BLEND_H_MASK: i32 = 0x30;

/** Packed blend bits for corner `I` in the center 2x2 source block. */
const BLEND_I_MASK: i32 = 0xc0;

/*
 * 4x4 input kernel used by the preprocessing step:
 *
 * -----------------
 * | A | B | C | P |
 * | D | E | F | O |   evaluate the four corners between E, F, H, I
 * | G | H | I | N |   input pixel is at position E
 * | J | K | L | M |
 * -----------------
 */
const A: i32 = 0;
const B: i32 = 1;
const C: i32 = 2;
const P: i32 = 3;
const D: i32 = 4;
const E: i32 = 5;
const F: i32 = 6;
const O: i32 = 7;
const G: i32 = 8;
const H: i32 = 9;
const I: i32 = 10;
const N: i32 = 11;
const J: i32 = 12;
const K: i32 = 13;
const L: i32 = 14;
const M: i32 = 15;

/** BT.2020 blue luma coefficient used for the analog Y'CbCr distance. */
const kB: f64 = 0.0593;

/** BT.2020 red luma coefficient used for the analog Y'CbCr distance. */
const kR: f64 = 0.2627;

/** Green luma coefficient derived from `kB` and `kR`. */
const kG: f64 = 1.0 - kB - kR;

/** Scale factor converting the blue difference into the Cb axis. */
const scaleB: f64 = 0.5 / (1.0 - kB);

/** Scale factor converting the red difference into the Cr axis. */
const scaleR: f64 = 0.5 / (1.0 - kR);

/** Static 4x4 kernel storage encoded with the `A..P` constants. */
const kernelPtr = memory.data(16 * sizeof<u32>(), alignof<u32>());

/** Rotation offsets for the unrotated output block orientation. */
const rot0OffsetsPtr = memory.data(36 * sizeof<i32>(), alignof<i32>());

/** Rotation offsets for the 90 degree clockwise output block orientation. */
const rot90OffsetsPtr = memory.data(36 * sizeof<i32>(), alignof<i32>());

/** Rotation offsets for the 180 degree clockwise output block orientation. */
const rot180OffsetsPtr = memory.data(36 * sizeof<i32>(), alignof<i32>());

/** Rotation offsets for the 270 degree clockwise output block orientation. */
const rot270OffsetsPtr = memory.data(36 * sizeof<i32>(), alignof<i32>());

/** Bump-pointer allocation top used for per-instance and lookup-table data. */
let allocatorTop: usize = 0;

/** Pointer to the configured source image buffer. */
let configuredSourcePtr: usize = 0;

/** Pointer to the configured target image buffer. */
let configuredTargetPtr: usize = 0;

/** Pointer to the configured pre-processing buffer. */
let configuredPreProcPtr: usize = 0;

/** Configured source image width. */
let configuredSourceWidth: i32 = 0;

/** Configured source image height. */
let configuredSourceHeight: i32 = 0;

/** Configured xBRZ scale factor. */
let configuredScaleFactor: i32 = 0;

/** Whether the configured scaler should use the full 8-bit Y'CbCr lookup table. */
let configuredLargeLut = false;

/** Pointer to the lazily created Y'CbCr distance lookup table. */
let distYCbCrLookupTablePtr: usize = 0;

/**
 * Round a pointer up to the next multiple of the requested alignment.
 *
 * @param value     - The unaligned pointer value.
 * @param alignment - The required power-of-two alignment.
 * @returns The aligned pointer value.
 */
@inline
function alignUp(value: usize, alignment: usize): usize {
    return (value + alignment - 1) & ~(alignment - 1);
}

/**
 * Reserve a chunk of linear memory from the module-local bump allocator.
 *
 * The allocator only grows and never frees, which matches the lifetime of one WASM scaler instance and
 * the lazily initialized lookup table.
 *
 * @param bytes     - The number of bytes to reserve.
 * @param alignment - The required alignment of the returned pointer.
 * @returns The aligned pointer to the reserved memory block, or `0` for empty allocations.
 */
function alloc(bytes: i32, alignment: usize = 16): usize {
    if (bytes <= 0) {
        return 0;
    }
    if (allocatorTop == 0) {
        allocatorTop = alignUp(__heap_base, alignment);
    }

    const ptr = alignUp(allocatorTop, alignment);
    const end = ptr + <usize>bytes;
    const currentSize = <usize>memory.size() << 16;
    if (end > currentSize) {
        const additionalPages = <i32>((end - currentSize + 0xffff) >>> 16);
        if (memory.grow(additionalPages) < 0) {
            unreachable();
        }
    }
    allocatorTop = end;
    return ptr;
}

/**
 * Compute the byte pointer to a packed pixel inside a linear ARGB buffer.
 *
 * @param base  - Pointer to the first pixel.
 * @param index - Pixel index relative to `base`.
 * @returns The byte pointer to the indexed pixel.
 */
@inline
function pixelPtr(base: usize, index: i32): usize {
    return base + (<usize>index << 2);
}

/**
 * Load a packed `0xAABBGGRR` pixel from linear memory.
 *
 * @param base  - Pointer to the first pixel.
 * @param index - Pixel index relative to `base`.
 * @returns The packed pixel value.
 */
@inline
function readPixel(base: usize, index: i32): u32 {
    return load<u32>(pixelPtr(base, index));
}

/**
 * Extract the alpha channel from a packed `0xAABBGGRR` pixel.
 *
 * @param pixel - The packed pixel value.
 * @returns The alpha channel in the range `0..255`.
 */
@inline
function getAlpha(pixel: u32): i32 {
    return <i32>(pixel >>> 24);
}

/**
 * Extract the red channel from a packed `0xAABBGGRR` pixel.
 *
 * @param pixel - The packed pixel value.
 * @returns The red channel in the range `0..255`.
 */
@inline
function getRed(pixel: u32): i32 {
    return <i32>(pixel & 0xff);
}

/**
 * Extract the green channel from a packed `0xAABBGGRR` pixel.
 *
 * @param pixel - The packed pixel value.
 * @returns The green channel in the range `0..255`.
 */
@inline
function getGreen(pixel: u32): i32 {
    return <i32>((pixel >>> 8) & 0xff);
}

/**
 * Extract the blue channel from a packed `0xAABBGGRR` pixel.
 *
 * @param pixel - The packed pixel value.
 * @returns The blue channel in the range `0..255`.
 */
@inline
function getBlue(pixel: u32): i32 {
    return <i32>((pixel >>> 16) & 0xff);
}

/**
 * Pack separate channels into a `0xAABBGGRR` pixel.
 *
 * @param alpha - Alpha channel in the range `0..255`.
 * @param blue  - Blue channel in the range `0..255`.
 * @param green - Green channel in the range `0..255`.
 * @param red   - Red channel in the range `0..255`.
 * @returns The packed pixel value.
 */
@inline
function makePixel(alpha: i32, blue: i32, green: i32, red: i32): u32 {
    return <u32>(((alpha & 0xff) << 24) | ((blue & 0xff) << 16) | ((green & 0xff) << 8) | (red & 0xff));
}

/**
 * Read one byte from the pre-processing blend buffer.
 *
 * @param base  - Pointer to the first blend byte.
 * @param index - Blend entry index.
 * @returns The packed blend byte.
 */
@inline
function preProcGet(base: usize, index: i32): i32 {
    return <i32>load<u8>(base + <usize>index);
}

/**
 * Write one byte into the pre-processing blend buffer.
 *
 * @param base  - Pointer to the first blend byte.
 * @param index - Blend entry index.
 * @param value - The packed blend byte to store.
 */
@inline
function preProcSet(base: usize, index: i32, value: i32): void {
    store<u8>(base + <usize>index, <u8>value);
}

/**
 * Read one packed kernel pixel from the static 4x4 kernel storage.
 *
 * @param index - The `A..P` kernel index.
 * @returns The packed pixel value.
 */
@inline
function kernelGet(index: i32): u32 {
    return load<u32>(kernelPtr + (<usize>index << 2));
}

/**
 * Write one packed kernel pixel into the static 4x4 kernel storage.
 *
 * @param index - The `A..P` kernel index.
 * @param value - The packed pixel value.
 */
@inline
function kernelSet(index: i32, value: u32): void {
    store<u32>(kernelPtr + (<usize>index << 2), value);
}

/**
 * Read one rotation offset from linear memory.
 *
 * @param offsetsPtr - Pointer to the flattened rotation offset table.
 * @param index      - The flattened entry index.
 * @returns The stored linear output offset.
 */
@inline
function offsetGet(offsetsPtr: usize, index: i32): i32 {
    return load<i32>(offsetsPtr + (<usize>index << 2));
}

/**
 * Write one rotation offset into linear memory.
 *
 * @param offsetsPtr - Pointer to the flattened rotation offset table.
 * @param index      - The flattened entry index.
 * @param value      - The linear output offset to store.
 */
@inline
function offsetSet(offsetsPtr: usize, index: i32, value: i32): void {
    store<i32>(offsetsPtr + (<usize>index << 2), value);
}

/**
 * Create the buffered analog Y'CbCr distance lookup table in linear memory.
 *
 * @returns The pointer to the first `f32` distance entry.
 */
function createSmallDistYCbCrLookupTable(): usize {
    const tablePtr = alloc(32 * 32 * 32 * sizeof<f32>(), alignof<f32>());
    for (let rIndex = 0; rIndex < 32; rIndex++) {
        const rDiff = (((rIndex << 3) << 24) >> 24) * 2;
        const rBase = kR * <f64>rDiff;
        for (let gIndex = 0; gIndex < 32; gIndex++) {
            const gDiff = (((gIndex << 3) << 24) >> 24) * 2;
            const gBase = kG * <f64>gDiff;
            for (let bIndex = 0; bIndex < 32; bIndex++) {
                const bDiff = (((bIndex << 3) << 24) >> 24) * 2;
                const y = rBase + gBase + kB * <f64>bDiff;
                const cb = scaleB * (<f64>bDiff - y);
                const cr = scaleR * (<f64>rDiff - y);
                const tableIndex = (rIndex << 10) | (gIndex << 5) | bIndex;
                const distance = Math.sqrt((y * y) + (cb * cb) + (cr * cr));
                store<f32>(tablePtr + (<usize>tableIndex << 2), <f32>distance);
            }
        }
    }
    return tablePtr;
}

/**
 * Create the full 8-bit analog Y'CbCr distance lookup table in linear memory.
 *
 * @returns The pointer to the first `f32` distance entry.
 */
function createLargeDistYCbCrLookupTable(): usize {
    const tablePtr = alloc(256 * 256 * 256 * sizeof<f32>(), alignof<f32>());
    for (let rIndex = 0; rIndex < 256; rIndex++) {
        const rDiff = ((rIndex << 24) >> 24) * 2;
        const rBase = kR * <f64>rDiff;
        for (let gIndex = 0; gIndex < 256; gIndex++) {
            const gDiff = ((gIndex << 24) >> 24) * 2;
            const gBase = kG * <f64>gDiff;
            for (let bIndex = 0; bIndex < 256; bIndex++) {
                const bDiff = ((bIndex << 24) >> 24) * 2;
                const y = rBase + gBase + kB * <f64>bDiff;
                const cb = scaleB * (<f64>bDiff - y);
                const cr = scaleR * (<f64>rDiff - y);
                const tableIndex = (rIndex << 16) | (gIndex << 8) | bIndex;
                const distance = Math.sqrt((y * y) + (cb * cb) + (cr * cr));
                store<f32>(tablePtr + (<usize>tableIndex << 2), <f32>distance);
            }
        }
    }
    return tablePtr;
}

/**
 * Compute the buffered analog Y'CbCr distance for the RGB channels only.
 *
 * This helper is used for the opaque fast path where alpha coverage is known to be irrelevant.
 *
 * @param pixel1 - The first packed pixel.
 * @param pixel2 - The second packed pixel.
 * @returns The RGB/Y'CbCr distance between both pixels.
 */
@inline
function colorDistanceRGB(pixel1: u32, pixel2: u32): f32 {
    if (pixel1 == pixel2) {
        return 0.0;
    }

    const rIndex = (((getRed(pixel1) - getRed(pixel2)) / 2) | 0) & 0xff;
    const gIndex = (((getGreen(pixel1) - getGreen(pixel2)) / 2) | 0) & 0xff;
    const bIndex = (((getBlue(pixel1) - getBlue(pixel2)) / 2) | 0) & 0xff;
    const tableIndex = configuredLargeLut
        ? (rIndex << 16) | (gIndex << 8) | bIndex
        : ((rIndex >> 3) << 10) | ((gIndex >> 3) << 5) | (bIndex >> 3);
    return load<f32>(distYCbCrLookupTablePtr + (<usize>tableIndex << 2));
}

/**
 * Compute the color distance including alpha coverage.
 *
 * Transparent pixels contribute less of their chroma distance and more of the pure alpha difference.
 * The chroma term uses the buffered Y'CbCr lookup directly to avoid another helper call in the hot path.
 *
 * @param pixel1 - The first packed pixel.
 * @param pixel2 - The second packed pixel.
 * @returns The alpha-aware distance between both pixels.
 */
function colorDistanceARGB(pixel1: u32, pixel2: u32): f32 {
    const rgbDistance = colorDistanceRGB(pixel1, pixel2);
    if (getAlpha(pixel1 & pixel2) == 255) {
        return rgbDistance;
    }

    const a1 = getAlpha(pixel1);
    const a2 = getAlpha(pixel2);
    if (a1 == 0) {
        return <f32>a2;
    }
    if (a2 == 0) {
        return <f32>a1;
    }

    return a1 < a2
        ? ((<f32>a1 * rgbDistance) / <f32>255.0) + <f32>(a2 - a1)
        : ((<f32>a2 * rgbDistance) / <f32>255.0) + <f32>(a1 - a2);
}

/**
 * Test whether two pixels are close enough to be treated as equal by xBRZ.
 *
 * @param pixel1 - The first packed pixel.
 * @param pixel2 - The second packed pixel.
 * @returns `true` when the distance is below the configured equality threshold.
 */
@inline
function equalColor(pixel1: u32, pixel2: u32): bool {
    return colorDistanceARGB(pixel1, pixel2) < EQUAL_COLOR_TOLERANCE;
}

/**
 * Analyze the current 4x4 kernel neighborhood and encode which of the four corners around the center 2x2
 * block should be blended. Each corner consumes two bits in the returned byte:
 * `bits 0..1 = E`, `bits 2..3 = F`, `bits 4..5 = H`, `bits 6..7 = I`.
 *
 * Only the 12 pixels that actually participate in the decision are passed explicitly so the caller can keep
 * the sliding kernel in local variables instead of repeatedly loading it from linear memory.
 *
 * @param b - Kernel pixel at position `B`.
 * @param c - Kernel pixel at position `C`.
 * @param d - Kernel pixel at position `D`.
 * @param e - Kernel pixel at position `E`.
 * @param f - Kernel pixel at position `F`.
 * @param g - Kernel pixel at position `G`.
 * @param h - Kernel pixel at position `H`.
 * @param i - Kernel pixel at position `I`.
 * @param k - Kernel pixel at position `K`.
 * @param l - Kernel pixel at position `L`.
 * @param n - Kernel pixel at position `N`.
 * @param o - Kernel pixel at position `O`.
 * @returns A packed byte containing the blend decision for `E`, `F`, `H`, and `I`.
 */
@inline
function preProcessCorners(b: u32, c: u32, d: u32, e: u32, f: u32, g: u32, h: u32, i: u32, k: u32, l: u32, n: u32, o: u32): i32 {
    if ((e == f && h == i) || (e == h && f == i)) {
        return 0;
    }

    const allOpaque = getAlpha(b & c & d & e & f & g & h & i & k & l & n & o) == 255;
    const hfScore = allOpaque
        ? colorDistanceRGB(g, e)
            + colorDistanceRGB(e, c)
            + colorDistanceRGB(k, i)
            + colorDistanceRGB(i, o)
            + CENTER_DIRECTION_BIAS * colorDistanceRGB(h, f)
        : colorDistanceARGB(g, e)
            + colorDistanceARGB(e, c)
            + colorDistanceARGB(k, i)
            + colorDistanceARGB(i, o)
            + CENTER_DIRECTION_BIAS * colorDistanceARGB(h, f);

    const eiScore = allOpaque
        ? colorDistanceRGB(d, h)
            + colorDistanceRGB(h, l)
            + colorDistanceRGB(b, f)
            + colorDistanceRGB(f, n)
            + CENTER_DIRECTION_BIAS * colorDistanceRGB(e, i)
        : colorDistanceARGB(d, h)
            + colorDistanceARGB(h, l)
            + colorDistanceARGB(b, f)
            + colorDistanceARGB(f, n)
            + CENTER_DIRECTION_BIAS * colorDistanceARGB(e, i);

    let blendE = BLEND_NONE;
    let blendF = BLEND_NONE;
    let blendH = BLEND_NONE;
    let blendI = BLEND_NONE;

    if (hfScore < eiScore) {
        const dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * hfScore) < eiScore;
        if (e != f && e != h) {
            blendE = dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL;
        }
        if (i != h && i != f) {
            blendI = dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL;
        }
    } else if (eiScore < hfScore) {
        const dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * eiScore) < hfScore;
        if (h != e && h != i) {
            blendH = dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL;
        }
        if (f != e && f != i) {
            blendF = dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL;
        }
    }

    return blendE | (blendF << 2) | (blendH << 4) | (blendI << 6);
}

/**
 * Apply weighted color interpolation to one cell inside the expanded output block.
 *
 * @param blockBase   - Pointer to the first pixel of the current output block.
 * @param offsetsPtr  - Pointer to the flattened offset table for one rotation.
 * @param index       - The flattened cell index inside the scale block.
 * @param m           - The foreground weight numerator.
 * @param n           - The shared weight denominator.
 * @param color       - The edge color to blend in.
 */
function alphaGradAt(blockBase: usize, offsetsPtr: usize, index: i32, m: i32, n: i32, color: u32): void {
    const ptr = blockBase + <usize>offsetGet(offsetsPtr, index);
    const backColor = load<u32>(ptr);
    if (getAlpha(color & backColor) == 255) {
        const weightBack = n - m;
        const weightSum2 = n >>> 1;
        const red = ((getRed(color) * m + getRed(backColor) * weightBack + weightSum2) / n);
        const green = ((getGreen(color) * m + getGreen(backColor) * weightBack + weightSum2) / n);
        const blue = ((getBlue(color) * m + getBlue(backColor) * weightBack + weightSum2) / n);
        store<u32>(ptr, makePixel(255, blue, green, red));
        return;
    }

    const weightFront = getAlpha(color) * m;
    const weightBack = getAlpha(backColor) * (n - m);
    const weightSum = weightFront + weightBack;
    if (weightSum == 0) {
        store<u32>(ptr, 0);
        return;
    }

    const weightSum2 = weightSum >>> 1;
    const red = ((getRed(color) * weightFront + getRed(backColor) * weightBack + weightSum2) / weightSum);
    const green = ((getGreen(color) * weightFront + getGreen(backColor) * weightBack + weightSum2) / weightSum);
    const blue = ((getBlue(color) * weightFront + getBlue(backColor) * weightBack + weightSum2) / weightSum);
    const alpha = (weightSum + (n >>> 1)) / n;

    store<u32>(ptr, makePixel(alpha, blue, green, red));
}

/**
 * Overwrite one cell inside the expanded output block.
 *
 * @param blockBase   - Pointer to the first pixel of the current output block.
 * @param offsetsPtr  - Pointer to the flattened offset table for one rotation.
 * @param index       - The flattened cell index inside the scale block.
 * @param color       - The color to store.
 */
@inline
function setAt(blockBase: usize, offsetsPtr: usize, index: i32, color: u32): void {
    store<u32>(blockBase + <usize>offsetGet(offsetsPtr, index), color);
}

/**
 * Blend a predominantly horizontal edge into one rotated output corner.
 *
 * @param blockBase  - Pointer to the first pixel of the current output block.
 * @param offsetsPtr - Pointer to the flattened offset table for one rotation.
 * @param scale      - The xBRZ scale factor.
 * @param color      - The edge color to blend into the block.
 */
function blendLineShallow(blockBase: usize, offsetsPtr: usize, scale: i32, color: u32): void {
    switch (scale) {
        case 2:
            alphaGradAt(blockBase, offsetsPtr, 2, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 3, 3, 4, color);
            return;
        case 3:
            alphaGradAt(blockBase, offsetsPtr, 6, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 5, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 7, 3, 4, color);
            setAt(blockBase, offsetsPtr, 8, color);
            return;
        case 4:
            alphaGradAt(blockBase, offsetsPtr, 12, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 10, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 13, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 11, 3, 4, color);
            setAt(blockBase, offsetsPtr, 14, color);
            setAt(blockBase, offsetsPtr, 15, color);
            return;
        case 5:
            alphaGradAt(blockBase, offsetsPtr, 20, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 17, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 14, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 21, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 18, 3, 4, color);
            setAt(blockBase, offsetsPtr, 22, color);
            setAt(blockBase, offsetsPtr, 23, color);
            setAt(blockBase, offsetsPtr, 24, color);
            setAt(blockBase, offsetsPtr, 19, color);
            return;
        case 6:
            alphaGradAt(blockBase, offsetsPtr, 30, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 26, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 22, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 31, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 27, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 23, 3, 4, color);
            setAt(blockBase, offsetsPtr, 32, color);
            setAt(blockBase, offsetsPtr, 33, color);
            setAt(blockBase, offsetsPtr, 34, color);
            setAt(blockBase, offsetsPtr, 35, color);
            setAt(blockBase, offsetsPtr, 28, color);
            setAt(blockBase, offsetsPtr, 29, color);
            return;
    }
}

/**
 * Blend a predominantly vertical edge into one rotated output corner.
 *
 * @param blockBase  - Pointer to the first pixel of the current output block.
 * @param offsetsPtr - Pointer to the flattened offset table for one rotation.
 * @param scale      - The xBRZ scale factor.
 * @param color      - The edge color to blend into the block.
 */
function blendLineSteep(blockBase: usize, offsetsPtr: usize, scale: i32, color: u32): void {
    switch (scale) {
        case 2:
            alphaGradAt(blockBase, offsetsPtr, 1, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 3, 3, 4, color);
            return;
        case 3:
            alphaGradAt(blockBase, offsetsPtr, 2, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 7, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 5, 3, 4, color);
            setAt(blockBase, offsetsPtr, 8, color);
            return;
        case 4:
            alphaGradAt(blockBase, offsetsPtr, 3, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 10, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 7, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 14, 3, 4, color);
            setAt(blockBase, offsetsPtr, 11, color);
            setAt(blockBase, offsetsPtr, 15, color);
            return;
        case 5:
            alphaGradAt(blockBase, offsetsPtr, 4, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 13, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 22, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 9, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 18, 3, 4, color);
            setAt(blockBase, offsetsPtr, 14, color);
            setAt(blockBase, offsetsPtr, 19, color);
            setAt(blockBase, offsetsPtr, 24, color);
            setAt(blockBase, offsetsPtr, 23, color);
            return;
        case 6:
            alphaGradAt(blockBase, offsetsPtr, 5, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 16, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 27, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 11, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 22, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 33, 3, 4, color);
            setAt(blockBase, offsetsPtr, 17, color);
            setAt(blockBase, offsetsPtr, 23, color);
            setAt(blockBase, offsetsPtr, 29, color);
            setAt(blockBase, offsetsPtr, 35, color);
            setAt(blockBase, offsetsPtr, 28, color);
            setAt(blockBase, offsetsPtr, 34, color);
            return;
    }
}

/**
 * Blend a corner where shallow and steep edge hints are both present.
 *
 * @param blockBase  - Pointer to the first pixel of the current output block.
 * @param offsetsPtr - Pointer to the flattened offset table for one rotation.
 * @param scale      - The xBRZ scale factor.
 * @param color      - The edge color to blend into the block.
 */
function blendLineSteepAndShallow(blockBase: usize, offsetsPtr: usize, scale: i32, color: u32): void {
    switch (scale) {
        case 2:
            alphaGradAt(blockBase, offsetsPtr, 2, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 1, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 3, 5, 6, color);
            return;
        case 3:
            alphaGradAt(blockBase, offsetsPtr, 6, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 2, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 7, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 5, 3, 4, color);
            setAt(blockBase, offsetsPtr, 8, color);
            return;
        case 4:
            alphaGradAt(blockBase, offsetsPtr, 13, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 7, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 12, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 3, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 10, 1, 3, color);
            setAt(blockBase, offsetsPtr, 15, color);
            setAt(blockBase, offsetsPtr, 14, color);
            setAt(blockBase, offsetsPtr, 11, color);
            return;
        case 5:
            alphaGradAt(blockBase, offsetsPtr, 4, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 13, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 9, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 20, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 17, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 21, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 18, 2, 3, color);
            setAt(blockBase, offsetsPtr, 14, color);
            setAt(blockBase, offsetsPtr, 19, color);
            setAt(blockBase, offsetsPtr, 24, color);
            setAt(blockBase, offsetsPtr, 22, color);
            setAt(blockBase, offsetsPtr, 23, color);
            return;
        case 6:
            alphaGradAt(blockBase, offsetsPtr, 5, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 16, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 11, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 22, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 30, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 26, 1, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 31, 3, 4, color);
            alphaGradAt(blockBase, offsetsPtr, 27, 3, 4, color);
            setAt(blockBase, offsetsPtr, 17, color);
            setAt(blockBase, offsetsPtr, 23, color);
            setAt(blockBase, offsetsPtr, 29, color);
            setAt(blockBase, offsetsPtr, 35, color);
            setAt(blockBase, offsetsPtr, 28, color);
            setAt(blockBase, offsetsPtr, 34, color);
            setAt(blockBase, offsetsPtr, 32, color);
            setAt(blockBase, offsetsPtr, 33, color);
            return;
    }
}

/**
 * Blend a diagonal transition when no clear shallow or steep edge dominates.
 *
 * @param blockBase  - Pointer to the first pixel of the current output block.
 * @param offsetsPtr - Pointer to the flattened offset table for one rotation.
 * @param scale      - The xBRZ scale factor.
 * @param color      - The edge color to blend into the block.
 */
function blendLineDiagonal(blockBase: usize, offsetsPtr: usize, scale: i32, color: u32): void {
    switch (scale) {
        case 2:
            alphaGradAt(blockBase, offsetsPtr, 3, 1, 2, color);
            return;
        case 3:
            alphaGradAt(blockBase, offsetsPtr, 5, 1, 8, color);
            alphaGradAt(blockBase, offsetsPtr, 7, 1, 8, color);
            alphaGradAt(blockBase, offsetsPtr, 8, 7, 8, color);
            return;
        case 4:
            alphaGradAt(blockBase, offsetsPtr, 14, 1, 2, color);
            alphaGradAt(blockBase, offsetsPtr, 11, 1, 2, color);
            setAt(blockBase, offsetsPtr, 15, color);
            return;
        case 5:
            alphaGradAt(blockBase, offsetsPtr, 22, 1, 8, color);
            alphaGradAt(blockBase, offsetsPtr, 18, 1, 8, color);
            alphaGradAt(blockBase, offsetsPtr, 14, 1, 8, color);
            alphaGradAt(blockBase, offsetsPtr, 23, 7, 8, color);
            alphaGradAt(blockBase, offsetsPtr, 19, 7, 8, color);
            setAt(blockBase, offsetsPtr, 24, color);
            return;
        case 6:
            alphaGradAt(blockBase, offsetsPtr, 33, 1, 2, color);
            alphaGradAt(blockBase, offsetsPtr, 28, 1, 2, color);
            alphaGradAt(blockBase, offsetsPtr, 23, 1, 2, color);
            setAt(blockBase, offsetsPtr, 29, color);
            setAt(blockBase, offsetsPtr, 35, color);
            setAt(blockBase, offsetsPtr, 34, color);
            return;
    }
}

/**
 * Blend an isolated rounded corner instead of a line segment.
 *
 * @param blockBase  - Pointer to the first pixel of the current output block.
 * @param offsetsPtr - Pointer to the flattened offset table for one rotation.
 * @param scale      - The xBRZ scale factor.
 * @param color      - The edge color to blend into the block.
 */
function blendCorner(blockBase: usize, offsetsPtr: usize, scale: i32, color: u32): void {
    switch (scale) {
        case 2:
            alphaGradAt(blockBase, offsetsPtr, 3, 21, 100, color);
            return;
        case 3:
            alphaGradAt(blockBase, offsetsPtr, 8, 45, 100, color);
            return;
        case 4:
            alphaGradAt(blockBase, offsetsPtr, 15, 68, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 14, 9, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 11, 9, 100, color);
            return;
        case 5:
            alphaGradAt(blockBase, offsetsPtr, 24, 86, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 23, 23, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 19, 23, 100, color);
            return;
        case 6:
            alphaGradAt(blockBase, offsetsPtr, 35, 97, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 29, 42, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 34, 42, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 33, 6, 100, color);
            alphaGradAt(blockBase, offsetsPtr, 23, 6, 100, color);
            return;
    }
}

/**
 * Build the flattened rotation offset tables for all four quarter turns.
 *
 * @param scale       - The xBRZ scale factor.
 * @param targetWidth - The width of the target image in pixels.
 */
function buildRotationOffsets(scale: i32, targetWidth: i32): void {
    for (let i = 0; i < scale; i++) {
        for (let j = 0; j < scale; j++) {
            const index = (i * scale) + j;
            offsetSet(rot0OffsetsPtr, index, (j + (i * targetWidth)) << 2);
            offsetSet(rot90OffsetsPtr, index, (i + ((scale - 1 - j) * targetWidth)) << 2);
            offsetSet(rot180OffsetsPtr, index, ((scale - 1 - j) + ((scale - 1 - i) * targetWidth)) << 2);
            offsetSet(rot270OffsetsPtr, index, ((scale - 1 - i) + (j * targetWidth)) << 2);
        }
    }
}

/**
 * Fill the current scale x scale output block with the center source pixel before corner blending starts.
 *
 * @param blockBase   - Pointer to the first pixel of the current output block.
 * @param targetWidth - The width of the full target image.
 * @param scale       - The side length of the output block.
 * @param color       - The color copied into the block.
 */
function fillBlock(blockBase: usize, targetWidth: i32, scale: i32, color: u32): void {
    const colorPair = (<u64>color << 32) | <u64>color;
    const rowStride = <usize>targetWidth << 2;
    const firstRow = blockBase;
    switch (scale) {
        case 2: {
            const row1 = firstRow + rowStride;
            store<u64>(firstRow, colorPair);
            store<u64>(row1, colorPair);
            return;
        }
        case 3: {
            const row1 = firstRow + rowStride;
            const row2 = row1 + rowStride;
            store<u64>(firstRow, colorPair); store<u32>(firstRow + 8, color);
            store<u64>(row1, colorPair); store<u32>(row1 + 8, color);
            store<u64>(row2, colorPair); store<u32>(row2 + 8, color);
            return;
        }
        case 4: {
            const row1 = firstRow + rowStride;
            const row2 = row1 + rowStride;
            const row3 = row2 + rowStride;
            store<u64>(firstRow, colorPair); store<u64>(firstRow + 8, colorPair);
            store<u64>(row1, colorPair); store<u64>(row1 + 8, colorPair);
            store<u64>(row2, colorPair); store<u64>(row2 + 8, colorPair);
            store<u64>(row3, colorPair); store<u64>(row3 + 8, colorPair);
            return;
        }
        case 5: {
            const row1 = firstRow + rowStride;
            const row2 = row1 + rowStride;
            const row3 = row2 + rowStride;
            const row4 = row3 + rowStride;
            store<u64>(firstRow, colorPair); store<u64>(firstRow + 8, colorPair); store<u32>(firstRow + 16, color);
            store<u64>(row1, colorPair); store<u64>(row1 + 8, colorPair); store<u32>(row1 + 16, color);
            store<u64>(row2, colorPair); store<u64>(row2 + 8, colorPair); store<u32>(row2 + 16, color);
            store<u64>(row3, colorPair); store<u64>(row3 + 8, colorPair); store<u32>(row3 + 16, color);
            store<u64>(row4, colorPair); store<u64>(row4 + 8, colorPair); store<u32>(row4 + 16, color);
            return;
        }
        case 6: {
            const row1 = firstRow + rowStride;
            const row2 = row1 + rowStride;
            const row3 = row2 + rowStride;
            const row4 = row3 + rowStride;
            const row5 = row4 + rowStride;
            store<u64>(firstRow, colorPair); store<u64>(firstRow + 8, colorPair); store<u64>(firstRow + 16, colorPair);
            store<u64>(row1, colorPair); store<u64>(row1 + 8, colorPair); store<u64>(row1 + 16, colorPair);
            store<u64>(row2, colorPair); store<u64>(row2 + 8, colorPair); store<u64>(row2 + 16, colorPair);
            store<u64>(row3, colorPair); store<u64>(row3 + 8, colorPair); store<u64>(row3 + 16, colorPair);
            store<u64>(row4, colorPair); store<u64>(row4 + 8, colorPair); store<u64>(row4 + 16, colorPair);
            store<u64>(row5, colorPair); store<u64>(row5 + 8, colorPair); store<u64>(row5 + 16, colorPair);
            return;
        }
    }
}

/**
 * Load the rightmost kernel column `P/O/N/M` for the current x-position.
 *
 * Pixels outside the source image are treated as fully transparent.
 *
 * @param srcBase    - Pointer to the first source pixel.
 * @param srcWidth   - The source image width.
 * @param srcHeight  - The source image height.
 * @param y          - The source row whose center pixel maps to kernel position `E`.
 * @param x          - The source column whose center pixel maps to kernel position `E`.
 */
function readPonmTransparent(srcBase: usize, srcWidth: i32, srcHeight: i32, y: i32, x: i32): void {
    const xPlus2 = x + 2;
    if (xPlus2 < 0 || xPlus2 >= srcWidth) {
        kernelSet(P, 0);
        kernelSet(O, 0);
        kernelSet(N, 0);
        kernelSet(M, 0);
        return;
    }

    const columnBaseIndex = (y * srcWidth) + xPlus2;
    if (y > 0 && y < srcHeight - 2) {
        kernelSet(P, readPixel(srcBase, columnBaseIndex - srcWidth));
        kernelSet(O, readPixel(srcBase, columnBaseIndex));
        kernelSet(N, readPixel(srcBase, columnBaseIndex + srcWidth));
        kernelSet(M, readPixel(srcBase, columnBaseIndex + (srcWidth << 1)));
        return;
    }

    kernelSet(P, y > 0 ? readPixel(srcBase, columnBaseIndex - srcWidth) : 0);
    kernelSet(O, y >= 0 ? readPixel(srcBase, columnBaseIndex) : 0);
    kernelSet(N, y < srcHeight - 1 ? readPixel(srcBase, columnBaseIndex + srcWidth) : 0);
    kernelSet(M, y < srcHeight - 2 ? readPixel(srcBase, columnBaseIndex + (srcWidth << 1)) : 0);
}

/**
 * Rotates the packed corner blend byte by 90 degrees clockwise.
 */
@inline
function rotateBlend90(blend: i32): i32 {
    return ((blend << 2) | (blend >>> 6)) & 0xff;
}

/**
 * Rotates the packed corner blend byte by 180 degrees clockwise.
 */
@inline
function rotateBlend180(blend: i32): i32 {
    return ((blend << 4) | (blend >>> 4)) & 0xff;
}

/**
 * Rotates the packed corner blend byte by 270 degrees clockwise.
 */
@inline
function rotateBlend270(blend: i32): i32 {
    return ((blend << 6) | (blend >>> 2)) & 0xff;
}

/**
 * Blend one corner of the expanded output block.
 *
 * The kernel is rotated virtually so the same decision logic can be reused for all four corners around the
 * current source pixel.
 *
 * @param blockBase  - Pointer to the first pixel of the current output block.
 * @param scale      - The xBRZ scale factor.
 * @param blend      - The packed blend byte for the current corner rotation.
 * @param b          - Rotated kernel pixel at position `B`.
 * @param c          - Rotated kernel pixel at position `C`.
 * @param d          - Rotated kernel pixel at position `D`.
 * @param e          - Kernel pixel at position `E`.
 * @param f          - Rotated kernel pixel at position `F`.
 * @param g          - Rotated kernel pixel at position `G`.
 * @param h          - Rotated kernel pixel at position `H`.
 * @param i          - Rotated kernel pixel at position `I`.
 * @param offsetsPtr - Pointer to the precomputed offsets for that rotation.
 */
@inline
function blendPixelRotated(blockBase: usize, scale: i32, blend: i32, b: u32, c: u32, d: u32, e: u32, f: u32, g: u32, h: u32, i: u32, offsetsPtr: usize): void {
    const topRightBlend = (blend >>> 2) & 0x3;
    const bottomRightBlend = (blend >>> 4) & 0x3;
    const bottomLeftBlend = (blend >>> 6) & 0x3;

    let useLineBlend = false;
    if (bottomRightBlend >= BLEND_DOMINANT) {
        useLineBlend = true;
    } else {
        if (topRightBlend != BLEND_NONE && !equalColor(e, g)) {
            useLineBlend = false;
        } else if (bottomLeftBlend != BLEND_NONE && !equalColor(e, c)) {
            useLineBlend = false;
        } else if (!equalColor(e, i) && equalColor(g, h) && equalColor(h, i) && equalColor(i, f) && equalColor(f, c)) {
            useLineBlend = false;
        } else {
            useLineBlend = true;
        }
    }

    const blendColor = f == h ? f : colorDistanceARGB(e, f) <= colorDistanceARGB(e, h) ? f : h;

    if (useLineBlend) {
        const fgDistance = colorDistanceARGB(f, g);
        const hcDistance = colorDistanceARGB(h, c);
        const haveShallowLine = (STEEP_DIRECTION_THRESHOLD * fgDistance) <= hcDistance && e != g && d != g;
        const haveSteepLine = (STEEP_DIRECTION_THRESHOLD * hcDistance) <= fgDistance && e != c && b != c;

        if (haveShallowLine) {
            if (haveSteepLine) {
                blendLineSteepAndShallow(blockBase, offsetsPtr, scale, blendColor);
            } else {
                blendLineShallow(blockBase, offsetsPtr, scale, blendColor);
            }
        } else if (haveSteepLine) {
            blendLineSteep(blockBase, offsetsPtr, scale, blendColor);
        } else {
            blendLineDiagonal(blockBase, offsetsPtr, scale, blendColor);
        }
    } else {
        blendCorner(blockBase, offsetsPtr, scale, blendColor);
    }
}

/**
 * Core xBRZ scaler working on packed ARGB pixels in linear memory.
 *
 * It performs a two-stage pipeline:
 * 1. preprocess neighboring pixels to classify edge directions
 * 2. fill each enlarged block and then blend the affected corners
 *
 * @param srcBase        - Pointer to the first source pixel.
 * @param targetBase     - Pointer to the first target pixel.
 * @param preProcBufBase - Pointer to the temporary blend buffer.
 * @param srcWidth       - The source image width.
 * @param srcHeight      - The source image height.
 * @param scale          - The xBRZ scale factor.
 */
function scaleImageARGB(srcBase: usize, targetBase: usize, preProcBufBase: usize, srcWidth: i32, srcHeight: i32, scale: i32): void {
    if (srcWidth <= 0 || srcHeight <= 0) {
        return;
    }

    const targetWidth = srcWidth * scale;
    for (let i = 0; i <= srcWidth; i++) {
        preProcSet(preProcBufBase, i, 0);
    }

    let a: u32 = 0;
    let b: u32 = 0;
    let c: u32 = 0;
    let d: u32 = 0;
    let e: u32 = 0;
    let f: u32 = 0;
    let g: u32 = 0;
    let h: u32 = 0;
    let i: u32 = 0;
    let j: u32 = 0;
    let k: u32 = 0;
    let l: u32 = 0;
    let m: u32 = 0;
    let n: u32 = 0;
    let o: u32 = 0;
    let p: u32 = 0;

    // Seed the pre-processing buffer for the first source row before the main raster loop starts.
    readPonmTransparent(srcBase, srcWidth, srcHeight, -1, -4);
    p = kernelGet(P);
    o = kernelGet(O);
    n = kernelGet(N);
    m = kernelGet(M);
    a = p;
    d = o;
    g = n;
    j = m;

    readPonmTransparent(srcBase, srcWidth, srcHeight, -1, -3);
    p = kernelGet(P);
    o = kernelGet(O);
    n = kernelGet(N);
    m = kernelGet(M);
    b = p;
    e = o;
    h = n;
    k = m;

    readPonmTransparent(srcBase, srcWidth, srcHeight, -1, -2);
    p = kernelGet(P);
    o = kernelGet(O);
    n = kernelGet(N);
    m = kernelGet(M);
    c = p;
    f = o;
    i = n;
    l = m;

    readPonmTransparent(srcBase, srcWidth, srcHeight, -1, -1);
    p = kernelGet(P);
    o = kernelGet(O);
    n = kernelGet(N);
    m = kernelGet(M);

    let cornerBlend = preProcessCorners(b, c, d, e, f, g, h, i, k, l, n, o);
    preProcSet(preProcBufBase, 0, (cornerBlend >>> 6) & 0x3);

    for (let x = 0; x < srcWidth; x++) {
        a = b;
        d = e;
        g = h;
        j = k;
        b = c;
        e = f;
        h = i;
        k = l;
        c = p;
        f = o;
        i = n;
        l = m;

        readPonmTransparent(srcBase, srcWidth, srcHeight, -1, x);
        p = kernelGet(P);
        o = kernelGet(O);
        n = kernelGet(N);
        m = kernelGet(M);
        cornerBlend = preProcessCorners(b, c, d, e, f, g, h, i, k, l, n, o);
        preProcSet(preProcBufBase, x, preProcGet(preProcBufBase, x) | (((cornerBlend >>> 4) & 0x3) << 2));
        preProcSet(preProcBufBase, x + 1, (cornerBlend >>> 6) & 0x3);
    }

    // Process the image row by row while the 4x4 kernel slides horizontally across each source line.
    for (let y = 0; y < srcHeight; y++) {
        let targetIndex = scale * y * targetWidth;

        readPonmTransparent(srcBase, srcWidth, srcHeight, y, -4);
        p = kernelGet(P);
        o = kernelGet(O);
        n = kernelGet(N);
        m = kernelGet(M);
        a = p;
        d = o;
        g = n;
        j = m;

        readPonmTransparent(srcBase, srcWidth, srcHeight, y, -3);
        p = kernelGet(P);
        o = kernelGet(O);
        n = kernelGet(N);
        m = kernelGet(M);
        b = p;
        e = o;
        h = n;
        k = m;

        readPonmTransparent(srcBase, srcWidth, srcHeight, y, -2);
        p = kernelGet(P);
        o = kernelGet(O);
        n = kernelGet(N);
        m = kernelGet(M);
        c = p;
        f = o;
        i = n;
        l = m;

        readPonmTransparent(srcBase, srcWidth, srcHeight, y, -1);
        p = kernelGet(P);
        o = kernelGet(O);
        n = kernelGet(N);
        m = kernelGet(M);

        let carryBlend = 0;
        cornerBlend = preProcessCorners(b, c, d, e, f, g, h, i, k, l, n, o);
        carryBlend = (cornerBlend >>> 6) & 0x3;
        let currentBlend = preProcGet(preProcBufBase, 0) | (((cornerBlend >>> 2) & 0x3) << 6);

        const interiorRow = y > 0 && y + 2 < srcHeight;
        const interiorLimit = srcWidth - 2;
        let ptrP: usize = 0;
        let ptrO: usize = 0;
        let ptrN: usize = 0;
        let ptrM: usize = 0;
        if (interiorRow) {
            ptrP = pixelPtr(srcBase, ((y - 1) * srcWidth) + 2);
            ptrO = pixelPtr(srcBase, (y * srcWidth) + 2);
            ptrN = pixelPtr(srcBase, ((y + 1) * srcWidth) + 2);
            ptrM = pixelPtr(srcBase, ((y + 2) * srcWidth) + 2);
        }

        for (let x = 0; x < srcWidth; x++, targetIndex += scale) {
            a = b;
            d = e;
            g = h;
            j = k;
            b = c;
            e = f;
            h = i;
            k = l;
            c = p;
            f = o;
            i = n;
            l = m;

            if (interiorRow) {
                if (x < interiorLimit) {
                    p = load<u32>(ptrP);
                    o = load<u32>(ptrO);
                    n = load<u32>(ptrN);
                    m = load<u32>(ptrM);
                    ptrP += 4;
                    ptrO += 4;
                    ptrN += 4;
                    ptrM += 4;
                } else {
                    p = 0;
                    o = 0;
                    n = 0;
                    m = 0;
                }
            } else {
                readPonmTransparent(srcBase, srcWidth, srcHeight, y, x);
                p = kernelGet(P);
                o = kernelGet(O);
                n = kernelGet(N);
                m = kernelGet(M);
            }

            cornerBlend = preProcessCorners(b, c, d, e, f, g, h, i, k, l, n, o);
            currentBlend |= (cornerBlend & 0x3) << 4;
            carryBlend |= ((cornerBlend >>> 4) & 0x3) << 2;
            preProcSet(preProcBufBase, x, carryBlend);

            carryBlend = (cornerBlend >>> 6) & 0x3;
            const nextBlend = preProcGet(preProcBufBase, x + 1) | (((cornerBlend >>> 2) & 0x3) << 6);

            const centerColor = e;
            const blockBase = pixelPtr(targetBase, targetIndex);
            fillBlock(blockBase, targetWidth, scale, centerColor);

            if (currentBlend != 0) {
                if ((currentBlend & BLEND_H_MASK) != 0) {
                    blendPixelRotated(blockBase, scale, currentBlend, b, c, d, centerColor, f, g, h, i, rot0OffsetsPtr);
                }

                if ((currentBlend & BLEND_F_MASK) != 0) {
                    const blend1 = rotateBlend90(currentBlend);
                    blendPixelRotated(blockBase, scale, blend1, d, a, h, centerColor, b, i, f, c, rot90OffsetsPtr);
                }

                if ((currentBlend & BLEND_E_MASK) != 0) {
                    const blend2 = rotateBlend180(currentBlend);
                    blendPixelRotated(blockBase, scale, blend2, h, g, f, centerColor, d, c, b, a, rot180OffsetsPtr);
                }

                if ((currentBlend & BLEND_I_MASK) != 0) {
                    const blend3 = rotateBlend270(currentBlend);
                    blendPixelRotated(blockBase, scale, blend3, f, i, b, centerColor, h, a, d, g, rot270OffsetsPtr);
                }
            }

            currentBlend = nextBlend;
        }

        preProcSet(preProcBufBase, srcWidth, currentBlend);
    }
}

/**
 * Return the pointer to the configured source image buffer.
 *
 * @returns The source image pointer.
 */
export function getSourcePointer(): usize {
    return configuredSourcePtr;
}

/**
 * Return the pointer to the configured target image buffer.
 *
 * @returns The target image pointer.
 */
export function getTargetPointer(): usize {
    return configuredTargetPtr;
}

/**
 * Configure the scaler instance for one specific source size and scale factor.
 *
 * This allocates the source, target, and pre-processing buffers once, builds the rotation tables for the
 * chosen scale, and initializes the Y'CbCr lookup table eagerly.
 *
 * @param srcWidth  - The source image width.
 * @param srcHeight - The source image height.
 * @param factor    - The xBRZ scale factor.
 * @param largeLut  - Whether to use the full 8-bit Y'CbCr lookup table.
 */
export function init(srcWidth: i32, srcHeight: i32, factor: i32, largeLut: bool): void {
    configuredSourceWidth = srcWidth;
    configuredSourceHeight = srcHeight;
    configuredScaleFactor = factor;
    configuredLargeLut = largeLut;

    const sourceBytes = srcWidth * srcHeight * 4;
    const targetWidth = srcWidth * factor;
    const targetHeight = srcHeight * factor;
    const targetBytes = targetWidth * targetHeight * 4;
    const preProcBytes = srcWidth + 1;

    configuredSourcePtr = alloc(sourceBytes);
    configuredTargetPtr = alloc(targetBytes);
    configuredPreProcPtr = alloc(preProcBytes, 1);

    buildRotationOffsets(factor, targetWidth);
    distYCbCrLookupTablePtr = largeLut ? createLargeDistYCbCrLookupTable() : createSmallDistYCbCrLookupTable();
}

/**
 * Scale the configured source buffer into the configured target buffer.
 */
export function scale(): void {
    scaleImageARGB(configuredSourcePtr, configuredTargetPtr, configuredPreProcPtr, configuredSourceWidth, configuredSourceHeight, configuredScaleFactor);
}
