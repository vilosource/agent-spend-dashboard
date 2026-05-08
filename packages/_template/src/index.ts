/**
 * Public entry point for this package.
 *
 * Other packages import from `@vilosource/<name>`, which resolves
 * here via the `exports` field in package.json.
 *
 * Keep this file small. Re-export named symbols from sibling
 * modules; do not put implementation here.
 */

export type { Greeting } from "./shared/greet.js";
export { greet } from "./shared/greet.js";
