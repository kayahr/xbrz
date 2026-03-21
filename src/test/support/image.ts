import { PNG } from "pngjs";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import pixelmatch from "pixelmatch";
import { AssertionError, assertSame } from "@kayahr/assert";
import { basename, dirname, join } from "node:path";

export function createImageData(width: number, height: number, data = new Uint8ClampedArray(width * height * 4),
        colorSpace: PredefinedColorSpace = "srgb"): ImageData {
    return { width, height, data, colorSpace };
}

export async function loadImageData(file: string): Promise<ImageData> {
    const buffer = await readFile(file);
    const png = PNG.sync.read(buffer);
    return createImageData(png.width, png.height, new Uint8ClampedArray(png.data));
}

export function cloneImageData(imageData: ImageData): ImageData {
    return {
        data: new Uint8ClampedArray(imageData.data),
        width: imageData.width,
        height: imageData.height,
        colorSpace: imageData.colorSpace
    };
}

function createPNG(imageData: ImageData): Uint8Array {
    const png = new PNG({ width: imageData.width, height: imageData.height });
    png.data.set(imageData.data);
    return PNG.sync.write(png);
}

export async function assertMatchImage(actualImageData: ImageData, name: string): Promise<void> {
    const expectedFile = join("src/test/images", name);
    const expectedImageData = await loadImageData(expectedFile);
    const { width, height } = expectedImageData;
    assertSame(actualImageData.width, width, "Width does not match");
    assertSame(actualImageData.height, height, "Height does not match");
    const diffImageData = createImageData(width, height);
    const mismatchedPixels = pixelmatch(actualImageData.data, expectedImageData.data, diffImageData.data, width, height);
    if (mismatchedPixels > 0) {
        const actualFile = join("lib/test/actual", basename(expectedFile));
        await mkdir(dirname(actualFile), { recursive: true });
        const diffFile = join("lib/test/diffs", basename(expectedFile));
        await mkdir(dirname(diffFile), { recursive: true });
        await writeFile(actualFile, createPNG(actualImageData));
        await writeFile(diffFile, createPNG(diffImageData));
        throw new AssertionError(`Image mismatched <${mismatchedPixels}> pixels.\n`
            + `  Actual  : ${actualFile}\n`
            + `  Expected: ${expectedFile}\n`
            + `  Diff    : ${diffFile}`, { actual: actualFile, expected: expectedFile });
    }
}
