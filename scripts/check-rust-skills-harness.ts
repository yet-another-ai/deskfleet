import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const harness = fileURLToPath(
  new URL("../.agents/skills/rust-skills/checks/", import.meta.url),
);
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--manifest-path", `${harness}/Cargo.toml`, "--no-deps", "--format-version", "1", "--offline"],
    { encoding: "utf8" },
  ),
);

assert.equal(
  realpathSync(metadata.workspace_root),
  realpathSync(harness),
  "Keep .agents/skills/rust-skills/checks excluded from the DeskFleet Cargo workspace",
);
console.log("rust-skills example harness is a standalone Cargo workspace");
