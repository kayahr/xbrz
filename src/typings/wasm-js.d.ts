declare module "*.wasm.js" {
    const wasm: WebAssembly.Module;
    export default wasm;
}
