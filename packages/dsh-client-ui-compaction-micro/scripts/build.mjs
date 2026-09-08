// Build script: generate lib/client.js (client-modules bundle) from
// src/client.js (source mirror). Run `npm run build` after editing src;
// `npm run build -- --check` (or `npm run check`) verifies lib is in sync.
//
// Transformations applied to src/client.js:
//   - drop the leading documentation comment block and the
//     `import ... from "@deepseek-ai/dsh-client-ui-primitives"` line
//   - `React.createElement` -> `react.createElement`
//   - `IconSkillOutline16` -> `primitives.IconSkillOutline16`
//   - `export const inject` -> `const inject`, `export function apply` -> `function apply`
//   - 2-space indentation -> tabs (matches the bundle template)
// then the body is wrapped in the module-loader format with `react` and
// `primitives` required from the platform seed and the CSS injected once.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcPath = join(root, "src", "client.js");
const libPath = join(root, "lib", "client.js");

const ID = "@blake-r/dsh-client-ui-compaction-micro";
const TAG_ID = ID + "/cmc.css";

const template = (body) => `window.__ModuleLoader__.load({
	id: ${JSON.stringify(ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

${body}
		// CSS for the marker, injected once at materialization. Uses the same
		// data-plugin-css guard the official client bundles use so re-materialization
		// (HMR / reload) does not duplicate the <style> tag.
		const tagId = ${JSON.stringify(TAG_ID)};
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = ${JSON.stringify(ID)};
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

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

const build = (src) => {
	const body = src
		.replace(/^(\/\/[^\n]*\n)+/, "")
		.replace(/^import .*@deepseek-ai\/dsh-client-ui-primitives.*\n/m, "")
		.replaceAll("React.createElement", "react.createElement")
		.replaceAll("IconSkillOutline16", "primitives.IconSkillOutline16")
		.replace("export const inject", "const inject")
		.replace("export function apply", "function apply")
		.replace(/^\n+/, "")
		.split("\n")
		.map(toTabs)
		.join("\n");
	return template(body);
};

const src = await readFile(srcPath, "utf8");
const lib = build(src);
if (process.argv.includes("--check")) {
	const current = await readFile(libPath, "utf8");
	if (current !== lib) {
		console.error("lib/client.js is out of sync with src/client.js — run `npm run build`");
		process.exit(1);
	}
	console.log("lib/client.js is in sync with src/client.js");
} else {
	await writeFile(libPath, lib);
	console.log("built lib/client.js from src/client.js");
}