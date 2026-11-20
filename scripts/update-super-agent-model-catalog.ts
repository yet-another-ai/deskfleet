import { readFile, writeFile } from "node:fs/promises"

// Eve's compiler has already reduced the Gateway response to the model IDs,
// provider aliases and context windows that it needs for dynamic model selection.
const compiled = new URL("../apps/super-agent/.output/.eve/compile/model-metadata.json", import.meta.url)
const output = new URL("../nix/super-agent-model-catalog.json", import.meta.url)
const metadata = JSON.parse(await readFile(compiled, "utf8"))
if (metadata.kind !== "eve-model-metadata" || metadata.version !== 1 || !metadata.fetchedAt || !metadata.models?.length) {
  throw new Error("Run mise run super-agent:build with access to the Vercel AI Gateway model catalog first")
}

// One model per line keeps changes to the snapshot reviewable.
const models = metadata.models.map((model: unknown) => "    " + JSON.stringify(model))
const snapshot = [
  "{",
  '  "kind": "eve-model-catalog-cache",',
  '  "version": 2,',
  '  "fetchedAt": ' + JSON.stringify(metadata.fetchedAt) + ",",
  '  "providerAliases": ' + JSON.stringify(metadata.providerAliases) + ",",
  '  "models": [',
  models.join(",\n"),
  "  ]",
  "}",
  "",
].join("\n")
await writeFile(output, snapshot)
