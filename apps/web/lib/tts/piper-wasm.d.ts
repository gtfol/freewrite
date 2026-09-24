// @diffusionstudio/piper-wasm ships Emscripten output and no types. Only the
// three hooks lib/tts/piper.ts uses are declared.
declare module "@diffusionstudio/piper-wasm/build/piper_phonemize.js" {
  interface PiperPhonemizeModule {
    callMain(args: string[]): void;
  }

  interface PiperPhonemizeOptions {
    // Emscripten calls these once per line of stdout / stderr.
    print?: (line: string) => void;
    printErr?: (line: string) => void;
    // Resolves the .wasm and .data files the module loads at startup.
    locateFile?: (file: string, prefix: string) => string;
  }

  const createPiperPhonemize: (
    options: PiperPhonemizeOptions
  ) => Promise<PiperPhonemizeModule>;

  export default createPiperPhonemize;
}
