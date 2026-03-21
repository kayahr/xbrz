/*
 * Copyright (C) 2026 Klaus Reimer
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, it } from "node:test";

import { Scaler } from "../main/Scaler.ts";
import * as exports from "../main/index.ts";
import { assertEquals } from "@kayahr/assert";

describe("index", () => {
    it("exports relevant types", () => {
        // Check exports
        assertEquals({ ...exports }, {
            Scaler
        });
    });
});
