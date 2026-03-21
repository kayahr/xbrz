/*
 * Copyright (c) 2026 Klaus Reimer
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { before, describe, it } from "node:test";
import { assertMatchImage, createImageData, loadImageData } from "./support/image.ts";
import { assertEquals, assertThrowWithMessage } from "@kayahr/assert";
import { Scaler } from "../main/Scaler.ts";

describe("Scaler", () => {
    let sample1: ImageData;
    let sample2: ImageData;
    let transparentEdgeCase: ImageData;
    let yoshi: ImageData;
    let yoshiTransparent: ImageData;
    let alphaTransparency: ImageData;

    before(async () => {
        sample1 = await loadImageData("src/test/images/sample1.png");
        sample2 = await loadImageData("src/test/images/sample2.png");
        transparentEdgeCase = await loadImageData("src/test/images/transparent-edge-case.png");
        yoshi = await loadImageData("src/test/images/yoshi.png");
        yoshiTransparent = await loadImageData("src/test/images/yoshi-transparent.png");
        alphaTransparency = await loadImageData("src/test/images/alpha-transparency.png");
    });

    describe("constructor", () => {
        it("throws error when width is invalid", () => {
            assertThrowWithMessage(() => new Scaler(-1, 1, 2, { largeLut: true }), RangeError, "Source width must be 0-8192 but is -1");
            assertThrowWithMessage(() => new Scaler(10001, 1, 2, { largeLut: true }), RangeError, "Source width must be 0-8192 but is 10001");
            assertThrowWithMessage(() => new Scaler(NaN, 1, 2, { largeLut: true }), RangeError, "Source width must be 0-8192 but is NaN");
        });
        it("throws error when height is invalid", () => {
            assertThrowWithMessage(() => new Scaler(1, -1, 2, { largeLut: true }), RangeError, "Source height must be 0-8192 but is -1");
            assertThrowWithMessage(() => new Scaler(1, 10001, 2, { largeLut: true }), RangeError, "Source height must be 0-8192 but is 10001");
            assertThrowWithMessage(() => new Scaler(1, NaN, 2, { largeLut: true }), RangeError, "Source height must be 0-8192 but is NaN");
        });
        it("throws exception when factor is invalid", () => {
            assertThrowWithMessage(() => new Scaler(1, 1, -3), RangeError, "Scale factor must be 2, 3, 4, 5 or 6 but is -3");
            assertThrowWithMessage(() => new Scaler(1, 1, 1), RangeError, "Scale factor must be 2, 3, 4, 5 or 6 but is 1");
            assertThrowWithMessage(() => new Scaler(1, 1, 7), RangeError, "Scale factor must be 2, 3, 4, 5 or 6 but is 7");
            assertThrowWithMessage(() => new Scaler(1, 1, NaN), RangeError, "Scale factor must be 2, 3, 4, 5 or 6 but is NaN");
            assertThrowWithMessage(() => new Scaler(1, 1, 3.5), RangeError, "Scale factor must be 2, 3, 4, 5 or 6 but is 3.5");
        });
        it("stores the scale factor", () => {
            const scaler = new Scaler(1, 2, 3, { largeLut: true });
            assertEquals(scaler.factor, 3);
        });
        it("converts width/height into integers", () => {
            const scaler = new Scaler(6.1, 4.9, 2, { largeLut: true });
            assertEquals(scaler.sourceWidth, 6);
            assertEquals(scaler.sourceHeight, 4);
            assertEquals(scaler.targetWidth, 12);
            assertEquals(scaler.targetHeight, 8);
        });
    });

    describe("scale", () => {
        it("creates empty target image when source image is empty", () => {
            const scaler = new Scaler(0, 0, 6);
            assertEquals(scaler.sourceWidth, 0);
            assertEquals(scaler.sourceHeight, 0);
            assertEquals(scaler.targetWidth, 0);
            assertEquals(scaler.targetHeight, 0);
            const target = scaler.scale(new Uint8ClampedArray(0));
            assertEquals(target.byteLength, 0);
        });

        it("throws exception when source image size is invalid", () => {
            const scaler = new Scaler(4, 2, 2, { largeLut: true });
            assertThrowWithMessage(() => scaler.scale(new Uint8ClampedArray(4 * 2 * 4 + 1)), RangeError, "Source image size does not match scaler size");
            assertThrowWithMessage(() => scaler.scale(new Uint8ClampedArray(4 * 2 * 4 - 1)), RangeError, "Source image size does not match scaler size");
        });

        it("keeps different scaler instances isolated", async () => {
            const scaler1 = new Scaler(sample1.width, sample1.height, 2, { largeLut: true });
            const scaler2 = new Scaler(sample2.width, sample2.height, 2, { largeLut: true });
            const target1 = scaler1.scale(sample1.data);
            const target2 = scaler2.scale(sample2.data);
            await assertMatchImage(createImageData(sample1.width * 2, sample1.height * 2, new Uint8ClampedArray(target1)), "sample1-xbrz-x2.png");
            await assertMatchImage(createImageData(sample2.width * 2, sample2.height * 2, new Uint8ClampedArray(target2)), "sample2-xbrz-x2.png");
        });

        describe("sample1", () => {
            it("scales correctly with factor 2", async () => {
                const scaler = new Scaler(sample1.width, sample1.height, 2, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample1.data)), "sample1-xbrz-x2.png");
            });
            it("scales correctly with factor 3", async () => {
                const scaler = new Scaler(sample1.width, sample1.height, 3, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample1.data)), "sample1-xbrz-x3.png");
            });
            it("scales correctly with factor 4", async () => {
                const scaler = new Scaler(sample1.width, sample1.height, 4, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample1.data)), "sample1-xbrz-x4.png");
            });
            it("scales correctly with factor 5", async () => {
                const scaler = new Scaler(sample1.width, sample1.height, 5, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample1.data)), "sample1-xbrz-x5.png");
            });
            it("scales correctly with factor 6", async () => {
                const scaler = new Scaler(sample1.width, sample1.height, 6, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample1.data)), "sample1-xbrz-x6.png");
            });
        });

        describe("sample2", () => {
            it("scales correctly with factor 2", async () => {
                const scaler = new Scaler(sample2.width, sample2.height, 2, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample2.data)), "sample2-xbrz-x2.png");
            });
            it("scales correctly with factor 3", async () => {
                const scaler = new Scaler(sample2.width, sample2.height, 3, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample2.data)), "sample2-xbrz-x3.png");
            });
            it("scales correctly with factor 4", async () => {
                const scaler = new Scaler(sample2.width, sample2.height, 4, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample2.data)), "sample2-xbrz-x4.png");
            });
            it("scales correctly with factor 5", async () => {
                const scaler = new Scaler(sample2.width, sample2.height, 5, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample2.data)), "sample2-xbrz-x5.png");
            });
            it("scales correctly with factor 6", async () => {
                const scaler = new Scaler(sample2.width, sample2.height, 6, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(sample2.data)), "sample2-xbrz-x6.png");
            });
        });

        describe("yoshi", () => {
            it("scales correctly with factor 2", async () => {
                const scaler = new Scaler(yoshi.width, yoshi.height, 2, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshi.data)), "yoshi-xbrz-x2.png");
            });
            it("scales correctly with factor 3", async () => {
                const scaler = new Scaler(yoshi.width, yoshi.height, 3, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshi.data)), "yoshi-xbrz-x3.png");
            });
            it("scales correctly with factor 4", async () => {
                const scaler = new Scaler(yoshi.width, yoshi.height, 4, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshi.data)), "yoshi-xbrz-x4.png");
            });
            it("scales correctly with factor 5", async () => {
                const scaler = new Scaler(yoshi.width, yoshi.height, 5, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshi.data)), "yoshi-xbrz-x5.png");
            });
            it("scales correctly with factor 6", async () => {
                const scaler = new Scaler(yoshi.width, yoshi.height, 6, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshi.data)), "yoshi-xbrz-x6.png");
            });
        });

        describe("yoshi-transparent", () => {
            it("scales correctly with factor 2", async () => {
                const scaler = new Scaler(yoshiTransparent.width, yoshiTransparent.height, 2, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshiTransparent.data)),
                    "yoshi-transparent-xbrz-x2.png");
            });
            it("scales correctly with factor 3", async () => {
                const scaler = new Scaler(yoshiTransparent.width, yoshiTransparent.height, 3, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshiTransparent.data)),
                    "yoshi-transparent-xbrz-x3.png");
            });
            it("scales correctly with factor 4", async () => {
                const scaler = new Scaler(yoshiTransparent.width, yoshiTransparent.height, 4, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshiTransparent.data)),
                    "yoshi-transparent-xbrz-x4.png");
            });
            it("scales correctly with factor 5", async () => {
                const scaler = new Scaler(yoshiTransparent.width, yoshiTransparent.height, 5, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshiTransparent.data)),
                    "yoshi-transparent-xbrz-x5.png");
            });
            it("scales correctly with factor 6", async () => {
                const scaler = new Scaler(yoshiTransparent.width, yoshiTransparent.height, 6, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(yoshiTransparent.data)),
                    "yoshi-transparent-xbrz-x6.png");
            });
        });

        describe("transparent-edge-case", () => {
            it("scales correctly with factor 2", async () => {
                const scaler = new Scaler(transparentEdgeCase.width, transparentEdgeCase.height, 2, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(transparentEdgeCase.data)),
                    "transparent-edge-case-xbrz-x2.png");
            });
            it("scales correctly with factor 3", async () => {
                const scaler = new Scaler(transparentEdgeCase.width, transparentEdgeCase.height, 3, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(transparentEdgeCase.data)),
                    "transparent-edge-case-xbrz-x3.png");
            });
            it("scales correctly with factor 4", async () => {
                const scaler = new Scaler(transparentEdgeCase.width, transparentEdgeCase.height, 4, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(transparentEdgeCase.data)),
                    "transparent-edge-case-xbrz-x4.png");
            });
            it("scales correctly with factor 5", async () => {
                const scaler = new Scaler(transparentEdgeCase.width, transparentEdgeCase.height, 5, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(transparentEdgeCase.data)),
                    "transparent-edge-case-xbrz-x5.png");
            });
            it("scales correctly with factor 6", async () => {
                const scaler = new Scaler(transparentEdgeCase.width, transparentEdgeCase.height, 6, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(transparentEdgeCase.data)),
                    "transparent-edge-case-xbrz-x6.png");
            });
        });

        describe("alpha-transparency", () => {
            it("scales correctly with factor 2", async () => {
                const scaler = new Scaler(alphaTransparency.width, alphaTransparency.height, 2, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(alphaTransparency.data)),
                    "alpha-transparency-xbrz-x2.png");
            });
            it("scales correctly with factor 3", async () => {
                const scaler = new Scaler(alphaTransparency.width, alphaTransparency.height, 3, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(alphaTransparency.data)),
                    "alpha-transparency-xbrz-x3.png");
            });
            it("scales correctly with factor 4", async () => {
                const scaler = new Scaler(alphaTransparency.width, alphaTransparency.height, 4, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(alphaTransparency.data)),
                    "alpha-transparency-xbrz-x4.png");
            });
            it("scales correctly with factor 5", async () => {
                const scaler = new Scaler(alphaTransparency.width, alphaTransparency.height, 5, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(alphaTransparency.data)),
                    "alpha-transparency-xbrz-x5.png");
            });
            it("scales correctly with factor 6", async () => {
                const scaler = new Scaler(alphaTransparency.width, alphaTransparency.height, 6, { largeLut: true });
                await assertMatchImage(createImageData(scaler.targetWidth, scaler.targetHeight, scaler.scale(alphaTransparency.data)),
                    "alpha-transparency-xbrz-x6.png");
            });
        });
    });
});
