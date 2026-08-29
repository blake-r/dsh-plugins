// dsh-tool-filter-root-find.js
// Cordis plugin: gates tool calls that sweep the WHOLE disk or the WHOLE
// home directory — `find /`, `find ~`, `find $HOME`, `find ../../..`,
// `grep -r ... /`, `ls -R /` via bash, and the fs-search tools (glob/grep/
// search) pointed at the drive root, the home directory, or an ancestor of it
// (e.g. /Users when home is /Users/<name>). It ALSO gates any `..` climb out
// of the working directory into a parent directory (e.g. `../../..` above
// the workspace), and searches rooted at an explicitly blocked system folder
// (/, /var, /var/folders, /Library — exact directory only; descendants allowed).
// Alternate drive-root spellings ("/Volumes/Macintosh HD", "/System/Volumes/
// Data") are canonicalised to "/" before the rules run. Mounted through the
// profile's cordis.patch.yml insert list.
//
// Enforcement model: a `tools/pre-execute` listener returns an `ask` decision
// only for a search rooted at `/` or the home directory (or blocked system
// folder). The approval seam (mounted in the base harness with policy `ask`)
// then prompts the user in the web UI; if the user allows, the call proceeds,
// otherwise it is denied. This is the same manual-confirmation flow the bash
// sandbox uses for escalation. AGENTS.md is advisory only — this listener is
// the enforcement layer.

const name = "dsh-tool-filter-root-find";
const inject = ["tools"];

/** fs-search tools that accept a `path` argument (defaults to the workspace). */
const PATH_TOOLS = new Set(["glob", "grep", "search"]);

/**
 * Explicit allowlist: searches rooted exactly at one of these directories
 * always run WITHOUT a confirmation prompt. With exact blocklist matching the
 * allowlist is largely defensive (descendants of a blocked dir are already
 * free), but it guarantees these paths never prompt.
 */
const ALLOW_PATHS = ["/tmp", "/private/tmp"];

/**
 * Explicit blocklist: searches rooted exactly at one of these directories are
 * ALWAYS gated and require manual approval. Only the exact directory matches —
 * a search under a descendant (e.g. /var/logs, /var/folders/<rand>) is allowed.
 * "/" is the drive root (canonicalRoot maps alternate spellings like
 * "/Volumes/Macintosh HD" and "/System/Volumes/Data" onto it). "/var" and
 * "/Library" are blocked system folders the behavioral rules would not catch;
 * "/var/folders" is gated too (its per-user descendants under it stay free).
 */
const BLOCK_PATHS = ["/", "/Library", "/var", "/var/folders"];

/** True when `p` is exactly one of `paths` (exact directory match, not descendants). */
function isOneOf(p, paths) {
	return paths.some((a) => p === a);
}

/** True when resolved path is exactly an allowlisted directory. */
function isAllowedPath(resolved) {
	return isOneOf(resolved, ALLOW_PATHS);
}

/** True when resolved path is exactly a blocklisted directory. */
function isBlockedPath(resolved) {
	return isOneOf(resolved, BLOCK_PATHS);
}

/**
 * Split a command into top-level statements on `;`, `&&` and `||`, but NOT on
 * those characters inside a quoted string. This is what scopes the path check
 * to the search command itself: a bare slash in `echo "a / b"` belongs to a
 * non-search statement and is never examined as a search root.
 */
function splitStatements(cmd) {
	const stmts = [];
	let cur = "";
	let quote = null; // "'", '"' or "`" when inside a string literal
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && quote !== "'") { cur += cmd[++i] ?? ""; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
		if (ch === "\\") { cur += ch + (cmd[++i] ?? ""); continue; }
		if (ch === ";" || (ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
			if (cur.trim() !== "") stmts.push(cur);
			cur = "";
			if (ch === "&" || ch === "|") i++; // skip the second char of && / ||
			continue;
		}
		cur += ch;
	}
	if (cur.trim() !== "") stmts.push(cur);
	return stmts;
}

/** True when a single statement is a recursive search operation. */
function isSearchOp(stmt) {
	return (
		/(?:^|[\s;])find\s/.test(stmt) || // find is recursive by default
		/(?:^|[\s;])grep\s+-[a-zA-Z]*r[a-zA-Z]*\s/.test(stmt) || // grep -r
		/(?:^|[\s;])ls\s+-[a-zA-Z]*R[a-zA-Z]*\s/.test(stmt) || // ls -R
		/(?:^|[\s;])glob\s/.test(stmt)
	);
}

/** Options whose following argument is that option's value (a pattern, type, etc.), not a search root. */
const VALUE_FLAGS = new Set([
	"-name", "-iname", "-path", "-ipath", "-type", "-size", "-mtime", "-mmin",
	"-amin", "-atime", "-cmin", "-ctime", "-maxdepth", "-mindepth", "-inum",
	"-exec", "-fstype", "-group", "-printf", "-perm",
]);

/** Quote-aware argument tokens of one statement: {text, quoted}. */
function tokenizeStatement(stmt) {
	const tokens = [];
	let cur = "";
	let curQuoted = false;
	let quote = null;
	for (let i = 0; i < stmt.length; i++) {
		const ch = stmt[i];
		if (quote) {
			if (ch === "\\" && quote !== "'") { cur += ch + (stmt[++i] ?? ""); continue; }
			if (ch === quote) { quote = null; curQuoted = true; continue; }
			cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
		if (/[\s]/.test(ch)) {
			if (cur) { tokens.push({ text: cur, quoted: curQuoted }); cur = ""; curQuoted = false; }
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push({ text: cur, quoted: curQuoted });
	return tokens;
}

/**
 * Path-like tokens of a search statement that are plausible search roots.
 * Quoted tokens are treated as string/pattern arguments, never as roots; a
 * token that is the value of a VALUE_FLAGS option (e.g. `-name '*.md'`) is
 * skipped too, so a slash inside a name pattern cannot be read as the root.
 */
function statementPathRoots(stmt) {
	const toks = tokenizeStatement(stmt);
	const roots = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t.quoted) continue;
		const prev = toks[i - 1];
		if (prev && !prev.quoted && VALUE_FLAGS.has(prev.text)) continue;
		const canonical = canonicalHome(t.text);
		if (isPathLike(canonical)) roots.push(canonical);
	}
	return roots;
}

/** The user's home directory, for expanding `~` and `$HOME`. */
function homeDir() {
	return process.env.HOME ?? process.env.USERPROFILE ?? "/";
}

/**
 * True when a resolved search root is a disk-wide or home-wide sweep: the
 * drive root (/), the home directory, or any ancestor of the home directory
 * (e.g. /Users when home is /Users/<name>). These root sweeps are gated.
 */
function isGlobalRoot(resolved) {
	const home = homeDir();
	if (resolved === "/" || resolved === home) return true;
	return home.startsWith(resolved + "/");
}

/**
 * True when a path token climbs OUT of the working directory via `..`
 * (e.g. `../../..` reaching above cwd). Any parent-directory escape is gated,
 * even if the resolved target is not the drive root or home — searching a
 * parent relative to the workspace is treated as a protected escape.
 */
function isParentEscape(t, cwd) {
	if (!t.includes("..")) return false;
	const resolved = resolveToken(t, cwd);
	// A `..` path that stays inside the workspace is fine; anything resolving
	// to a location above cwd (no longer under the workspace) is gated.
	return !(resolved === cwd || resolved.startsWith(cwd + "/"));
}

/** Resolve a relative path against `cwd`, collapsing `.` and `..` segments. */
function normalize(cwd, p) {
	const parts = [];
	for (const seg of `${cwd}/${p}`.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return "/" + parts.join("/");
}

/** True when a token is a path worth checking (absolute, ~, or `..`).
 * $HOME is canonicalised to ~ by canonicalHome before this runs, so it
 * needs no separate spelling here. */
function isPathLike(t) {
	return (
		t.startsWith("/") ||
		t === "~" || t.startsWith("~/") ||
		t.includes("..")
	);
}

/** Collapse `.` and `..` segments in an already-absolute path (no cwd base). */
function collapseDots(p) {
	const parts = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return "/" + parts.join("/");
}

/** Expand a path token to an absolute path against `cwd`. $HOME has already
 *  been canonicalised to ~ by canonicalHome, so only ~ and / remain here.
 *  Absolute paths keep their own `..` collapsed against the drive root (not
 *  folded onto cwd), so `….dsh/..` resolves to the parent of the workspace
 *  and is caught as a parent escape. */
function resolveToken(t, cwd) {
	if (t.startsWith("/")) return collapseDots(t);
	if (t === "~" || t.startsWith("~/")) return homeDir() + t.slice(1);
	return normalize(cwd, t);
}

/**
 * Canonical roots: alternative spellings that resolve to the drive root on
 * macOS. "/Volumes/Macintosh HD" is a symlink to the boot volume and
 * "/System/Volumes/Data" is the physical data volume that "/" reads, so all
 * three mean the same disk. Canonicalising them to "/" lets the plain rules
 * (blocklist "/", root sweep) catch every spelling.
 */
const ALT_ROOTS = [
	{ prefix: "/Volumes/Macintosh HD/", root: "/Volumes/Macintosh HD" },
	{ prefix: "/System/Volumes/Data/", root: "/System/Volumes/Data" },
];

/** Map any alternate-root spelling onto "/". */
function canonicalRoot(resolved) {
	for (const alt of ALT_ROOTS) {
		if (resolved === alt.root) return "/";
		if (resolved.startsWith(alt.prefix)) return "/" + resolved.slice(alt.prefix.length);
	}
	return resolved;
}

/**
 * Canonical home: "$HOME" (and "${HOME}") always mean the same directory as
 * "~", so all three spellings are mapped onto "~" here. Doing this up front —
 * the counterpoint to canonicalRoot, which maps alternate drive roots onto
 * "/" — lets isPathLike and resolveToken handle a single spelling each.
 */
function canonicalHome(t) {
	if (t === "$HOME" || t === "${HOME}") return "~";
	if (t.startsWith("$HOME/")) return "~" + t.slice("$HOME".length);
	if (t.startsWith("${HOME}/")) return "~" + t.slice("${HOME}".length);
	return t;
}

/** True when a path token is an explicit-allow, a blocked path, a disk/home root sweep, or a `..` parent escape. */
function escapesWorkspace(t, cwd) {
	// Canonicalise alternate spellings before the rules run: canonicalHome maps
	// $HOME / ${HOME} onto ~, canonicalRoot maps the alternate drive roots
	// (/Volumes/Macintosh HD, /System/Volumes/Data) onto / . Afterwards every
	// spelling is compared as a single canonical form by the rules below.
	const canonical = canonicalHome(t);
	const resolved = canonicalRoot(resolveToken(canonical, cwd));
	// Allowlist wins first: searching /tmp or /private/tmp is always allowed
	// even though "/" is blocked (and /tmp is a descendant of "/" only in
	// the canonical sense — exact match keeps it free).
	if (isAllowedPath(resolved)) return false;
	// Blocklist second: /var, /var/folders, /Library alone and their exact
	// paths gate; descendants like /var/logs are free.
	if (isBlockedPath(resolved)) return true;
	if (isGlobalRoot(resolved)) return true;
	return isParentEscape(canonical, cwd);
}

/**
 * First search root across the script that escapes the workspace, else null.
 * Only the statement actually performing a recursive search is examined — a
 * bare slash inside a quoted literal of a non-search statement (e.g. `echo`
 * output text) never counts as a search root here.
 */
function outsideSearchPath(cmd, cwd) {
	for (const st of splitStatements(cmd)) {
		if (!isSearchOp(st)) continue;
		for (const t of statementPathRoots(st)) {
			if (escapesWorkspace(t, cwd)) return t;
		}
	}
	return undefined;
}

/** True when an fs-search `path` argument is a disk-root or home-wide sweep. */
function isOutsideWorkspace(path, cwd) {
	if (typeof path !== "string") return false;
	const t = path.trim();
	if (t === "") return false;
	return escapesWorkspace(t, cwd);
}

/** Reason when a tool call performs a global search, else undefined. */
function globalSearchReason(exec, cwd) {
	const args = exec.arguments;
	if (exec.name === "bash" && typeof args?.command === "string") {
		const root = outsideSearchPath(args.command, cwd);
		if (root !== undefined) {
			return `Global filesystem sweep is blocked: "${args.command}" searches a protected path "${root}" — the drive root, the home directory, or a blocked system folder. Search a narrower path (e.g. the working directory ${cwd}) instead.`;
		}
	}
	if (PATH_TOOLS.has(exec.name)) {
		if (isOutsideWorkspace(args?.path, cwd)) {
			return `Global filesystem sweep is blocked: path "${args.path}" is a protected path — the drive root, the home directory, or a blocked system folder. Search a narrower path (e.g. the working directory ${cwd}) instead.`;
		}
	}
	return undefined;
}

function apply(ctx) {
	ctx.on("tools/pre-execute", (exec, next) => {
		const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
		const reason = globalSearchReason(exec, cwd);
		if (reason !== undefined) {
			return { kind: "ask", reason };
		}
		return next();
	}, { prepend: true });
}

export { apply, inject, name };
