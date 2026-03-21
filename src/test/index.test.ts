/*
 * Copyright (C) 2026 Klaus Reimer
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, it } from "node:test";

import { Scaler, type ScalerOptions } from "../main/Scaler.ts";
import * as exports from "../main/index.ts";
import { assertEquals } from "@kayahr/assert";

describe("index", () => {
    it("exports relevant types", () => {
        // Check runtime exports
        assertEquals({ ...exports }, {
            Scaler
        });

        // Check compile-time exports
        ((): ScalerOptions => (({} as exports.ScalerOptions)))();
    });
});
