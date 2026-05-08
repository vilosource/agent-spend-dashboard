/**
 * dependency-cruiser configuration.
 *
 * Encodes architectural invariants as machine-checkable rules.
 * Each rule explains the invariant it enforces and links to the
 * design decision that motivated it.
 *
 * Add new rules ONLY when they encode an actual decision from
 * docs/strategy/ or docs/design/. Do not add rules speculatively.
 *
 * Run:  npm run depgraph
 * Docs: https://github.com/sverweij/dependency-cruiser
 */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			comment: "Break cycles via interfaces or by moving shared code to a third module.",
			from: {},
			to: { circular: true },
		},

		{
			name: "no-reach-into-package-internals",
			severity: "error",
			comment:
				"Code in one package must consume another package via its package exports " +
				"(the package.json 'exports' field), not by deep-importing from packages/<other>/src/. " +
				"Keeps package boundaries meaningful.",
			from: { path: "^packages/([^/]+)/src/" },
			to: {
				path: "^packages/(?!\\1)([^/]+)/src/",
				pathNot: "^packages/[^/]+/src/index\\.ts$",
			},
		},

		{
			name: "shared-is-pure",
			severity: "error",
			comment:
				"Files under any package's src/shared/ MUST NOT perform IO " +
				"or read environment. Pure functions and types only. " +
				"Inject IO via interfaces from src/server/ or src/cli/.",
			from: { path: "^packages/[^/]+/src/shared/" },
			to: {
				path: [
					"^node:fs",
					"^node:child_process",
					"^node:os",
					"^node:net",
					"^node:http",
					"^node:https",
					"^node:dgram",
					"^node:cluster",
					"^node:worker_threads",
				],
			},
		},

		{
			name: "no-test-in-prod",
			severity: "error",
			comment: "Production code must not import from test files.",
			from: {
				path: "^packages/[^/]+/src/",
				pathNot: "\\.test\\.ts$",
			},
			to: { path: "\\.test\\.ts$" },
		},

		{
			name: "no-dev-dep-in-prod",
			severity: "error",
			comment: "Production code must not import from devDependencies.",
			from: {
				path: "^packages/[^/]+/src/",
				pathNot: "\\.test\\.ts$",
			},
			to: { dependencyTypes: ["npm-dev"] },
		},

		{
			name: "not-to-deprecated",
			severity: "error",
			comment: "Don't import from deprecated packages.",
			from: {},
			to: { dependencyTypes: ["deprecated"] },
		},

		{
			name: "no-non-package-json-deps",
			severity: "error",
			comment: "All runtime imports must be declared in package.json.",
			from: {},
			to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
		},
	],

	options: {
		doNotFollow: { path: "node_modules" },
		tsConfig: { fileName: "tsconfig.base.json" },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default"],
		},
		reporterOptions: {
			text: { highlightFocused: true },
		},
	},
};
