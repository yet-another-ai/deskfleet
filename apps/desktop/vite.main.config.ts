import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { defineConfig } from "vite"
import { nodeBuiltins } from "./build/node-builtins.ts"

export default defineConfig({
  plugins: [{
    name: "deskfleet-native-addon",
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "deskfleet.node",
        source: await readFile(resolve(import.meta.dirname, "../../crates/node/deskfleet.node")),
      })
    },
  }],
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/main/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    minify: false,
    outDir: resolve(import.meta.dirname, "out/main"),
    rolldownOptions: {
      // Bundled adapters include CommonJS modules that require Node built-ins.
      platform: "node",
      external: ["electron", ...nodeBuiltins],
    },
    sourcemap: true,
    target: "node22",
  },
})
