// Build script: generate lib/client.js (client-modules bundle) from
// plugin-src/client/index.js. Follows the dsh-client-ui-compaction-micro
// build.mjs pattern (text transformation + window.__ModuleLoader__.load
// wrapper; no esbuild is available in this package, so the bundle is not
// minified). Run `npm run build:client` after editing the client source;
// `npm run build:client -- --check` (or `npm run check`) verifies lib is in
// sync.
//
// Transformations applied to plugin-src/client/index.js:
//   - drop the leading documentation comment block
//   - replace the `import ... from "../host/management-rpc.mjs"` line with
//     `rpcEndpoint` + `callManagementRpc` extracted from the vendored
//     plugin-src/host/management-rpc.mjs, so the bundle stays self-contained
//     (the module-loader `require` only resolves platform seed modules)
//   - `React.createElement` -> `react.createElement` (and the other React
//     hooks the source uses)
//   - `export const name` -> `const name`, `export const inject` -> `const
//     inject`, `export function apply` -> `function apply`
//   - 2-space indentation -> tabs (matches the bundle template)
// then the body is wrapped in the module-loader format with `react` required
// from the platform seed and the CSS injected once.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcPath = join(root, "plugin-src", "client", "index.js");
const hostRpcPath = join(root, "plugin-src", "host", "management-rpc.mjs");
const libPath = join(root, "lib", "client.js");

const ID = "@blake-r/dsh-im-multiagent";
const TAG_ID = ID + "/mta.css";

const template = (body) => `window.__ModuleLoader__.load({
	id: ${JSON.stringify(ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

${body}
		// CSS for the settings page, injected once at materialization. Uses the
		// same data-plugin-css guard the official client bundles use so
		// re-materialization (HMR / reload) does not duplicate the <style> tag.
		const tagId = ${JSON.stringify(TAG_ID)};
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = ${JSON.stringify(ID)};
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`;

const toTabs = (line) => {
	const m = line.match(/^ +/);
	if (!m) return line;
	const n = m[0].length;
	return "\t".repeat(Math.floor(n / 2)) + " ".repeat(n % 2) + line.slice(n);
};

/** Extract one top-level function (with its body) from the vendored host RPC file. */
function extractFunction(source, name) {
	const match = source.match(new RegExp(`(?:export )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
	if (!match) throw new Error(`Cannot extract function ${name} from ${hostRpcPath}`);
	return match[0].replace(/^export /, "");
}

/** Inline the RPC carrier so the client bundle has no local imports. */
function inlineRpc(hostRpc) {
	return `${extractFunction(hostRpc, "rpcEndpoint")}\n${extractFunction(hostRpc, "callManagementRpc")}\n`;
}

const build = (src, hostRpc) => {
	const body = src
		.replace(/^(\/\/[^\n]*\n)+/, "")
		.replace(/^import .*management-rpc\.mjs.*\n/m, () => inlineRpc(hostRpc))
		.replaceAll("React.createElement", "react.createElement")
		.replaceAll("React.useState", "react.useState")
		.replaceAll("React.useCallback", "react.useCallback")
		.replaceAll("React.useEffect", "react.useEffect")
		.replaceAll("React.useRef", "react.useRef")
		.replaceAll("React.Fragment", "react.Fragment")
		.replace("export const name", "const name")
		.replace("export const inject", "const inject")
		.replace("export function apply", "function apply")
		.replace(/^\n+/, "")
		.split("\n")
		.map(toTabs)
		.join("\n");
	return template(body);
};

const src = await readFile(srcPath, "utf8");
const hostRpc = await readFile(hostRpcPath, "utf8");
const lib = build(src, hostRpc);
if (process.argv.includes("--check")) {
	const current = await readFile(libPath, "utf8");
	if (current !== lib) {
		console.error("lib/client.js is out of sync with plugin-src/client/index.js — run `npm run build:client`");
		process.exit(1);
	}
	console.log("lib/client.js is in sync with plugin-src/client/index.js");
} else {
	await mkdir(dirname(libPath), { recursive: true });
	await writeFile(libPath, lib);
	console.log("built lib/client.js from plugin-src/client/index.js");
}