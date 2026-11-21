// Builds the standalone script into one file that runs with plain Node.js
// 22.13+, and puts the launchers and an example config next to it.
//
//   node --experimental-strip-types standalone-src/build.mjs [outDir]   (default: standalone-src/dist)
//   npm run build:standalone -- [outDir]
//
// Only the files it produces are replaced; anything else in outDir stays.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(process.cwd(), process.argv[2] ?? resolve(here, "dist"));
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [resolve(here, "main.ts")],
  outfile: resolve(outDir, "newsdesk.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  // Some bundled CommonJS dependencies call require() for Node built-ins.
  banner: {
    js: `// AiXenix Telegram Scraper AI ${version}, standalone build. Generated from bb-plugin/; do not edit by hand.\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`,
  },
  logLevel: "warning",
});
for (const name of readdirSync(resolve(here, "files"))) copyFileSync(resolve(here, "files", name), resolve(outDir, name));
// The example lists every setting: the defaults with placeholders where your own values go.
const { DEFAULT_CONFIG, deepMerge } = await import(pathToFileURL(resolve(root, "src", "config.ts")).href);
const { EXAMPLE_OVERRIDES } = await import(pathToFileURL(resolve(here, "example-config.ts")).href);
writeFileSync(resolve(outDir, "newsdesk.config.example.json"), `${JSON.stringify(deepMerge(DEFAULT_CONFIG, EXAMPLE_OVERRIDES), null, 2)}\n`);
console.log(`standalone ${version} -> ${outDir}`);
