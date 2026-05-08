# `@vilosource/agent-spend-dashboard-template`

**Not a published package.** This is the scaffold for new packages in `vilosource/agent-spend-dashboard`.

## How to start a new package

```bash
node scripts/new-package.mjs my-package-name
```

The script copies this directory to `packages/<name>/`, replaces template strings, and adds the new package to the root `tsconfig.json` references.

## What this scaffold demonstrates

- **Layered structure.** `src/index.ts` is the public surface (what other packages import). `src/shared/` holds pure helpers (no IO, enforced by dependency-cruiser). When a package adds `src/server/` (Express routes, DB, IO) or `src/cli/`, those become the IO-performing layers.
- **Tests next to source.** `src/example.test.ts` sits next to `src/example.ts`. Vitest picks them up via the root `vitest.config.ts`.
- **Strict TypeScript.** Inherits from the root `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.
- **Public API via package exports.** Other packages import from `@vilosource/<name>` (the package's `exports` field), never from `packages/<name>/src/...` directly. Enforced by dependency-cruiser.
- **No `any`.** Enforced by Biome (`suspicious.noExplicitAny: error`).

## Conventions that go beyond mechanical enforcement

These are conventions humans (and AI agents) follow because the codebase reads better when they hold:

- **One responsibility per file.** If you find yourself naming a file `utils.ts` or `helpers.ts`, the responsibility is unclear; pick a more specific name.
- **Functions stay short.** Aim for ~30 lines, hard ceiling around 60 (warned by Biome's cognitive-complexity rule).
- **Return types on exported functions.** Inferred return types are fine inside a function; at the module boundary, write them out.
- **Errors have meaning.** Throw `new Error("descriptive message")`, not `throw "string"`. Catch with `useUnknownInCatchVariables` discipline (the catch parameter is `unknown` and must be narrowed before use).
- **Side effects are concentrated.** Push IO to the edges (`src/server/`, `src/cli/`); keep `src/shared/` pure.

See the [agent-spend-dashboard repo's strategy docs](../../docs/strategy/) for the broader rationale.
