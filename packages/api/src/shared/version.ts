/**
 * Compile-time version constant.
 *
 * Kept in src/shared/ because it's pure data with no IO. Bumped manually
 * in lockstep with package.json's "version" field; a small CI check could
 * be added later to enforce that the two stay in sync.
 */
export const VERSION = "0.0.0";
