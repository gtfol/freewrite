// Stand-in for Node built-ins that Emscripten glue references but never calls
// in a browser. The Piper WASM module ships one bundle for both environments
// and guards its `fs`/`path` use behind a runtime isNode check, so the imports
// resolve here and the branch never runs. See turbopack.resolveAlias in
// next.config.ts.
const empty = {};
export default empty;
