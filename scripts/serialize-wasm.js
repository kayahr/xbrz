#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const data = await readFile("lib/assembly/xbrz.wasm", "base64");
const code = `export default new WebAssembly.Module(Uint8Array.from(atob("${data}"), c => c.charCodeAt(0)));\n`;
await writeFile("lib/main/xbrz.wasm.js", code);
