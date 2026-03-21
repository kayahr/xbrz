/*
 * Copyright (C) 2026 Klaus Reimer
 * SPDX-License-Identifier: GPL-3.0-only
 */

import xbrzWasm from "../../lib/main/xbrz.wasm.js";

/** Exports of the wasm module */
type WasmExports = {
    /** The internal wasm memory. */
    readonly memory: WebAssembly.Memory;

    /**
     * Initializes the wasm module.
     *
     * @param sourceWidth  - The source image width in pixels (0-8192). Fractional parts are discarded.
     * @param sourceHeight - The source image height in pixels (0-8192). Fractional parts are discarded.
     * @param factor       - The scale factor. Must be 2, 3, 4, 5 or 6.
     */
    init(sourceWidth: number, sourceHeight: number, factor: number): void;

    /** @returns The source image pointer. */
    getSourcePointer(): number;

    /** @returns The target image pointer. */
    getTargetPointer(): number;

    /** Performs the scale operation. */
    scale(): void;
};

/** Maximum width/height of source image. Maximum target image size is up to six times larger. */
const MAX_SOURCE_DIMENSION = 8192;

/**
 * Scaler instance for a specific source image size and scale factor.
 */
export class Scaler {
    readonly #wasm: WasmExports;
    readonly #source: Uint8ClampedArray<ArrayBuffer>;
    readonly #target: Uint8ClampedArray<ArrayBuffer>;
    readonly #sourceBytes: number;

    /** The source image width in pixels. */
    readonly #sourceWidth: number;

    /** The source image height in pixels. */
    readonly #sourceHeight: number;

    /** The target image width in pixels. */
    readonly #targetWidth: number;

    /** The target image height in pixels. */
    readonly #targetHeight: number;

    /** The scale factor (2, 3, 4, 5 or 6). */
    readonly #factor: number;

    /**
     * Creates a new scaler instance for the given source image size and scale factor.
     *
     * @param sourceWidth  - The source image width in pixels (0-8192). Fractional parts are discarded.
     * @param sourceHeight - The source image height in pixels (0-8192). Fractional parts are discarded.
     * @param factor       - The scale factor. Must be 2, 3, 4, 5 or 6.
     * @throws {@link !RangeError} if width, height or scale factor is invalid.
     */
    public constructor(sourceWidth: number, sourceHeight: number, factor: number) {
        if (!(sourceWidth >= 0 && sourceWidth <= MAX_SOURCE_DIMENSION)) {
            throw new RangeError(`Source width must be 0-${MAX_SOURCE_DIMENSION} but is ${sourceWidth}`);
        }
        if (!(sourceHeight >= 0 && sourceHeight <= MAX_SOURCE_DIMENSION)) {
            throw new RangeError(`Source height must be 0-${MAX_SOURCE_DIMENSION} but is ${sourceHeight}`);
        }
        if (factor !== 2 && factor !== 3 && factor !== 4 && factor !== 5 && factor !== 6) {
            throw new RangeError(`Scale factor must be 2, 3, 4, 5 or 6 but is ${factor}`);
        }
        const intSourceWidth = this.#sourceWidth = sourceWidth | 0;
        const intSourceHeight = this.#sourceHeight = sourceHeight | 0;
        this.#factor = factor;
        const wasm = this.#wasm = new WebAssembly.Instance(xbrzWasm).exports as WasmExports;
        const sourceBytes = this.#sourceBytes = intSourceWidth * intSourceHeight * 4;
        const targetWidth = this.#targetWidth = intSourceWidth * factor;
        const targetHeight = this.#targetHeight = intSourceHeight * factor;
        wasm.init(intSourceWidth, intSourceHeight, factor);
        this.#source = new Uint8ClampedArray(wasm.memory.buffer, wasm.getSourcePointer(), sourceBytes);
        this.#target = new Uint8ClampedArray(wasm.memory.buffer, wasm.getTargetPointer(), targetWidth * targetHeight * 4);
    }

    /** @returns The source image width in pixels. */
    public get sourceWidth(): number {
        return this.#sourceWidth;
    }

    /** @returns The source image height in pixels. */
    public get sourceHeight(): number {
        return this.#sourceHeight;
    }

    /** @returns The target image width in pixels. */
    public get targetWidth(): number {
        return this.#targetWidth;
    }

    /** @returns The target image height in pixels. */
    public get targetHeight(): number {
        return this.#targetHeight;
    }

    /** @returns The scale factor (2, 3, 4, 5 or 6). */
    public get factor(): number {
        return this.#factor;
    }

    /**
     * Scales the given source image data and returns the target image data.
     *
     * @param source - The source image data. Size (width * height * 4) must match the image size for which the scaler was initialized.
     * @returns The target image data. The scaler always updates and returns the same array buffer, so when you do not immediately write
     *          the buffer to a file or canvas before scaling a different image with the same scaler you might want to copy the buffer.
     */
    public scale(source: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
        if (source.byteLength !== this.#sourceBytes) {
            throw new RangeError("Source image size does not match scaler size");
        }
        this.#source.set(source);
        this.#wasm.scale();
        return this.#target;
    }
}
