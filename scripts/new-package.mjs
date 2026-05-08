#!/usr/bin/env node
/**
 * Bootstrap a new package from packages/_template/.
 *
 * Usage: node scripts/new-package.mjs <package-name>
 *
 * Example: node scripts/new-package.mjs pi-usage-reporter
 *
 * What this does:
 *   - Copies packages/_template/ to packages/<name>/
 *   - Replaces all instances of the template name and "template" placeholders
 *     with the new name in package.json, README.md, source files
 *   - Adds the new package to the root tsconfig.json's references[]
 *
 * What this does NOT do:
 *   - It does not run `npm install`. Run that yourself.
 *   - It does not commit the result. Stage and commit explicitly.
 */

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const name = process.argv[2];
if (!name) {
	console.error("Usage: node scripts/new-package.mjs <package-name>");
	console.error("Example: node scripts/new-package.mjs pi-usage-reporter");
	process.exit(1);
}

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
	console.error(`Invalid package name: ${JSON.stringify(name)}`);
	console.error("Must be lowercase, start with a letter, contain only letters, digits, hyphens.");
	process.exit(1);
}

const src = join(repoRoot, "packages", "_template");
const dst = join(repoRoot, "packages", name);

if (!existsSync(src)) {
	console.error(`Template directory not found: ${src}`);
	process.exit(1);
}
if (existsSync(dst)) {
	console.error(`Target directory already exists: ${dst}`);
	process.exit(1);
}

console.log(`Copying ${src} → ${dst}`);
cpSync(src, dst, {
	recursive: true,
	filter: (source) =>
		!source.includes("/dist") && !source.endsWith(".tsbuildinfo") && !source.includes("/node_modules"),
});

// Patch package.json
const pkgPath = join(dst, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = `@vilosource/${name}`;
pkg.private = false;
pkg.description = `TODO: describe ${name}`;
pkg.publishConfig = { access: "public" };
pkg.keywords = ["pi-package", "pi-extension"];
delete pkg.private;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
console.log(`  updated ${pkgPath}`);

// Patch README placeholder name
const readmePath = join(dst, "README.md");
let readme = readFileSync(readmePath, "utf8");
readme =
	`# \`@vilosource/${name}\`\n\n` +
	`TODO: describe this package.\n\n` +
	`## Conventions\n\n` +
	`This package follows the conventions in the root [\`AGENTS.md\`](../../AGENTS.md) ` +
	`and the per-package [\`README.md\`](../_template/README.md) of the template it was created from.\n`;
writeFileSync(readmePath, readme);
console.log(`  rewrote ${readmePath}`);

// Add to root tsconfig.json references
const rootTsconfigPath = join(repoRoot, "tsconfig.json");
const rootTsconfig = JSON.parse(readFileSync(rootTsconfigPath, "utf8"));
rootTsconfig.references ??= [];
const newRef = { path: `packages/${name}` };
const exists = rootTsconfig.references.some((r) => r.path === newRef.path);
if (!exists) {
	rootTsconfig.references.push(newRef);
	rootTsconfig.references.sort((a, b) => a.path.localeCompare(b.path));
	writeFileSync(rootTsconfigPath, `${JSON.stringify(rootTsconfig, null, "\t")}\n`);
	console.log(`  added reference to ${rootTsconfigPath}`);
}

console.log("");
console.log(`Created packages/${name}/.`);
console.log("Next steps:");
console.log(`  1. cd packages/${name}`);
console.log(`  2. Edit src/ to fit your package`);
console.log(`  3. From repo root: npm install && npm run check`);
console.log(`  4. git add packages/${name} tsconfig.json && git commit`);
