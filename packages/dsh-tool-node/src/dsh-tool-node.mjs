// dsh-tool-node.mjs
// Prototype plugin. Registers two model-facing
// tools:
//   * node_run — execute an existing Node.js script file.
//   * node_npm — install packages with npm into the workspace node-env.
//
// Node subprocesses are confined through the same DSH sandbox seam the bash
// tool uses: `ctx.sandbox.confine` wraps the exact argv under the resolved
// per-call policy (on macOS this selects Apple's sandbox-exec / Seatbelt), and
// `ctx.sandboxPolicy` + `ctx.approval` drive the same-turn escalation flow.
// A blocked file operation is reported as `[sandbox: file access denied under
// <mode> mode]`; escalation is a one-shot retry with `sandbox_permissions` +
// `justification`. When no sandbox backend is usable the call fails closed
// (SandboxUnavailableError) — the command never runs unconfined.
//
// Mounting contract: mounted via cordis:include of shared.cordis.yml (preset
// plane). Any preset that should get these tools must cordis:include
// shared.cordis.yml — the same contract as dsh-tool-python. relay-claude is a
// pass-through preset and structurally excludes all dsh tools; nothing to
// configure there. A preset created from scratch without the include silently
// gets none of these tools.
//
// Environment isolation: packages install into <cwd>/.dsh/node-env via
// `npm install --prefix` (no package.json, no lockfile). Runs get
// NODE_PATH=<env>/node_modules (covers CommonJS require()) and
// PATH=<env>/node_modules/.bin:$PATH; ESM import resolves from the script's
// own directory, so ESM-dependent scripts should live inside the env
// (<env>/scripts/<name>.mjs). npm_config_cache is redirected into the env —
// the file sandbox denies writes outside the workspace otherwise (EACCES).
//
// Install serialization: node_npm takes an exclusive lock
// (<env>/.install.lock, O_CREAT|O_EXCL) and waits up to 60s for a concurrent
// install; stale locks older than 10min are force-dropped. py_pip has no such
// lock (pip's damage class under a race is lower) — the asymmetry is
// deliberate.
//
// Node binary resolution: process.env.NODE ?? process.execPath. No PATH
// lookup and no version globbing — the harness already runs under a working
// node, so execPath is the proven runtime. An explicit NODE pointing at a
// non-executable path fails loudly at mount time.

import { mkdir, access, open, stat, unlink } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ESCALATION_TARGETS, SandboxUnavailableError, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";

const name = "dsh-tool-node";
const inject = ["tools", "systemPrompt", "sandbox", "sandboxPolicy", "approval", "subprocess"];

/** Node binary: explicit override, else the harness's own proven runtime. */
const NODE = process.env.NODE ?? process.execPath;

/** npm CLI entry resolved relative to the real node binary (standard layout). */
const NPM_CLI = join(dirname(realpathSync(NODE)), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

/** Timeout code stamped onto the deadline signal so timeoutOf can recover it. */
const NODE_TIMEOUT = "NODE_TIMEOUT";
/** SIGTERM→SIGKILL grace period for the subprocess service (matches bash-local). */
const GRACE_MS = 3000;
/** Per-stream in-memory cap and spill cap for collected output. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SPILL_BYTES = 64 * 1024 * 1024;
/** Install lock: wait budget, stale threshold, poll cadence. */
const INSTALL_LOCK_WAIT_MS = 60000;
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000;
const INSTALL_LOCK_POLL_MS = 250;

if (process.env.NODE !== void 0) {
	try {
		await access(NODE, constants.X_OK);
	} catch {
		throw new Error(`dsh-tool-node: NODE=${NODE} is not an executable file`);
	}
}

/** Directory of the workspace node-env: <workspace>/.dsh/node-env. */
function nodeEnvDir(cwd) {
	return join(cwd, ".dsh", "node-env");
}

/** Environment wiring for runs and installs inside the node-env. */
function nodeEnvVars(env) {
	return {
		NODE_PATH: join(env, "node_modules"),
		PATH: `${join(env, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
		npm_config_cache: join(env, ".npm-cache"),
	};
}

/**
 * Acquire the exclusive install lock for one env: O_CREAT|O_EXCL with polling
 * up to INSTALL_LOCK_WAIT_MS, stale-lock recovery by mtime, loud failure after
 * the wait budget. Returns the lock path; caller must unlink it in finally.
 */
async function acquireInstallLock(env) {
	const lockPath = join(env, ".install.lock");
	const deadlineAt = Date.now() + INSTALL_LOCK_WAIT_MS;
	for (;;) {
		try {
			const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
			await handle.writeFile(`${process.pid}\n`);
			await handle.close();
			return lockPath;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			try {
				const info = await stat(lockPath);
				if (Date.now() - info.mtimeMs > INSTALL_LOCK_STALE_MS) {
					await unlink(lockPath).catch(() => {});
					continue;
				}
			} catch {
				/* lock vanished between stat and retry — try acquiring again */
				continue;
			}
			if (Date.now() >= deadlineAt) {
				throw new Error(`another install holds ${lockPath}; timed out after ${INSTALL_LOCK_WAIT_MS}ms`);
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, INSTALL_LOCK_POLL_MS));
		}
	}
}

/**
 * Match a non-zero exit against case-insensitive stderr signatures — the
 * selected backend's denial dialect (mirrors dsh-bash-sandbox/classifyDenial).
 */
function classifyDenial(exitCode, stderr, signatures) {
	if (exitCode === null || exitCode === 0) return false;
	const lowered = stderr.toLowerCase();
	return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}

/**
 * Classify one settled process against the selected backend's structured
 * runner-failure rules (mirrors dsh-bash-sandbox/classifyRunnerFailure).
 */
function classifyRunnerFailure(exitCode, stderr, rules) {
	if (exitCode === null || exitCode === 0) return void 0;
	const lines = stderr.split(/\r?\n/);
	for (const rule of rules) {
		if (rule.allowedExitCodes !== void 0 && !rule.allowedExitCodes.includes(exitCode)) continue;
		const informationalLines = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()));
		const fatalSignatures = rule.fatalSignatures.filter((signature) => signature.trim().length > 0).map((signature) => signature.toLowerCase());
		for (const line of lines) {
			const lowered = line.toLowerCase();
			if (informationalLines.has(lowered)) continue;
			if (fatalSignatures.some((signature) => lowered.includes(signature))) return { detail: line };
		}
	}
}

/** Append the sandbox denial marker + escalation hint to a result body. */
function appendSandboxMarkers(body, sandbox, escalationModes) {
	if (sandbox === void 0 || !sandbox.denied) return body;
	const markers = [sandboxDenialMarker(sandbox.mode)];
	if (escalationModes.length > 0) markers.push(escalationHintMarker("command"));
	if (body.length === 0) body = "(no output)";
	if (!body.endsWith("\n")) body += "\n";
	return body + markers.join("\n");
}

function apply(ctx) {
	const sandbox = ctx.get("sandbox");
	const sandboxPolicy = ctx.get("sandboxPolicy");
	const approval = ctx.get("approval");
	const escalationModes = sandboxPolicy === void 0 ? [] : ESCALATION_TARGETS;

	/** Resolve the complete standing policy for this call when a confining sandbox is mounted. */
	const resolvePolicy = (exec) => sandboxPolicy?.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session });

	/**
	 * Resolve a sandbox-escalation request through `ctx.approval` BEFORE anything
	 * executes, delegating the shared fail-closed sequence to approveEscalation
	 * (mirrors dsh-tool-bash/approveBashEscalation).
	 */
	const approveEscalationFor = async (mode, justification, exec, standingPolicy) => {
		if (escalationModes.length === 0) throw new Error("sandbox_permissions is not available in this composition (no sandboxing executor to escalate)");
		const effectiveMode = standingPolicy.mode;
		return approveEscalation({
			requestedMode: mode,
			justification,
			effectiveMode,
			subject: "command"
		}, {
			approver: approval,
			agent: exec.agent,
			callId: exec.callId,
			toolName: "node",
			signal: exec.signal
		});
	};

	/** Run an exact argv through ctx.subprocess with a deadline and collected output. */
	const runRaw = async (argv, workdir, env, timeoutMs, signal) => {
		const d = deadline(signal, timeoutMs, NODE_TIMEOUT);
		try {
			const handle = ctx.subprocess.spawn({
				argv,
				cwd: workdir,
				env,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
					stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } }
				},
				graceMs: GRACE_MS,
				signal: d.signal
			});
			const outcome = await handle.done;
			const stdout = handle.collected.stdout.readFrom(0);
			const stderr = handle.collected.stderr.readFrom(0);
			return {
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				timedOut: timeoutOf(d.signal, NODE_TIMEOUT) !== void 0,
				timeoutMs,
				stdout: stdout.text,
				stderr: stderr.text
			};
		} finally {
			d[Symbol.dispose]();
		}
	};

	/**
	 * Run an exact argv under the resolved policy: wrap through ctx.sandbox.confine
	 * unless the mode is danger-full-access (or no sandbox is mounted), then
	 * classify denial / runner failure (mirrors dsh-bash-sandbox/run).
	 */
	const runConfined = async (argv, workdir, env, timeoutMs, signal, policy) => {
		const mode = policy?.mode;
		if (sandbox === void 0 || mode === void 0 || mode === "danger-full-access") {
			return runRaw(argv, workdir, env, timeoutMs, signal);
		}
		const confined = await sandbox.confine(argv, { ...policy, mode });
		let result;
		try {
			result = await runRaw(confined.argv, workdir, env, timeoutMs, signal);
		} catch (error) {
			if (signal?.aborted === true) signal.throwIfAborted();
			throw error;
		}
		const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr, confined.runnerFailureRules);
		if (runnerFailure !== void 0) throw new SandboxUnavailableError(mode, runnerFailure.detail);
		return {
			...result,
			sandbox: {
				mode,
				denied: classifyDenial(result.exitCode, result.stderr, confined.denialSignatures),
				enforcement: confined.enforcement
			}
		};
	};

	/** Create the workspace node-env (idempotent, no package.json). */
	const ensureNodeEnv = async (cwd) => {
		const env = nodeEnvDir(cwd);
		await mkdir(join(cwd, ".dsh"), { recursive: true });
		await mkdir(env, { recursive: true });
		return env;
	};

	/** Resolve the per-call policy, approving escalation when requested. */
	const resolveCallPolicy = async (args, exec) => {
		const standingPolicy = resolvePolicy(exec);
		const approvedMode = args.sandbox_permissions !== void 0 && args.justification !== void 0
			? await approveEscalationFor(args.sandbox_permissions, args.justification, exec, standingPolicy)
			: void 0;
		return approvedMode === void 0 ? standingPolicy : { ...standingPolicy, mode: approvedMode };
	};

	/** Shape a settled run into the tool's result, appending sandbox markers. */
	const toResult = (result) => ({
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		timeoutMs: result.timeoutMs,
		...result.sandbox !== void 0 ? { sandbox: { mode: result.sandbox.mode, denied: result.sandbox.denied } } : {}
	});

	ctx.systemPrompt.section({
		name: "tool:node",
		order: 111,
		text: "Use node_run to run an existing Node.js script file and node_npm to install packages with npm. Create a script file with the file tools (write) and run it with node_run. node_run runs with the workspace node-env when it exists, otherwise with the harness's own node; it is stateless — pass everything each call needs. node_npm creates the workspace node-env on first use and installs packages into it. Node runs may be confined by a file sandbox; a blocked file operation is reported as [sandbox: file access denied under <mode> mode] — a policy denial, not a bug in the code; do not retry another way." + (escalationModes.length === 0 ? "" : " When a run is denied and a wider mode would let it succeed, escalate immediately in the same turn: retry the exact same run once with sandbox_permissions (the narrowest wider mode that suffices) plus a one-sentence justification. Never escalate speculatively: ground the request in a real denial."),
	});

	ctx.tools.register(defineTool({
		name: "node_run",
		description: "Execute an existing Node.js script file with the workspace node-env and return its stdout/stderr. The file must already exist on disk (create it with the write file tool). Non-zero exits are reported as [exit code: N]. Scripts run with NODE_PATH pointing at the node-env's node_modules, so CommonJS require() resolves packages installed by node_npm; ESM import resolves from the script's own directory, so scripts that import installed packages should live inside the node-env (e.g. <cwd>/.dsh/node-env/scripts/<name>.mjs).",
		parameters: {
			description: {
				type: "string",
				required: true,
				description: "A short human-readable description of what this execution does.",
			},
			path: {
				type: "string",
				required: true,
				description: "Path to the .js/.mjs/.cjs file to run, relative to the session workspace (or absolute).",
			},
			args: {
				type: "array",
				items: { type: "string" },
				description: "Command-line arguments passed to the script.",
			},
			workdir: {
				type: "string",
				description: "Working directory for the interpreter. Defaults to the session workspace.",
			},
			timeoutMs: {
				type: "number",
				description: "Timeout in milliseconds. The process is killed on expiry.",
			},
			...escalationModes.length > 0 ? {
				sandbox_permissions: {
					type: "string",
					enum: [...escalationModes],
					description: "The wider sandbox mode this run needs. Only valid as a one-shot retry of a run the sandbox just denied; requires justification and user approval.",
				},
				justification: {
					type: "string",
					description: "Required with sandbox_permissions: one sentence for the user explaining why this exact run needs the wider access.",
				},
			} : {},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					stdout: { type: "string", required: true },
					stderr: { type: "string", required: true },
					exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
					signal: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
					timedOut: { type: "boolean", required: true },
					timeoutMs: { type: "number", required: true },
					sandbox: {
						type: "object",
						additionalProperties: false,
						properties: {
							mode: { type: "string", required: true },
							denied: { type: "boolean", required: true },
						},
					},
				},
			},
			render: (_args, value) => {
				let body = value.stdout;
				if (value.stderr.length > 0) {
					if (body.length > 0 && !body.endsWith("\n")) body += "\n";
					body += `[stderr]\n${value.stderr}`;
				}
				if (body.length === 0) body = "(no output)";
				const markers = [];
				if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`);
				if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`);
				else if (value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`);
				if (markers.length > 0) body += `\n${markers.join("\n")}`;
				body = appendSandboxMarkers(body, value.sandbox, escalationModes);
				return [{ type: "text", text: body }];
			},
		},
		async execute(args, exec) {
			if (typeof args.path !== "string" || args.path.trim().length === 0) {
				throw new Error("invalid path: expected a non-empty string");
			}
			validateEscalationArgs(args.sandbox_permissions, args.justification);
			const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
			const file = isAbsolute(args.path) ? args.path : resolve(cwd, args.path);
			const workdir = args.workdir ? resolve(cwd, args.workdir) : cwd;
			const timeoutMs = args.timeoutMs ?? 30000;
			const env = await ensureNodeEnv(cwd);
			const policy = await resolveCallPolicy(args, exec);
			const result = await runConfined([NODE, file, ...(args.args ?? [])], workdir, nodeEnvVars(env), timeoutMs, exec.signal, policy);
			return toResult(result);
		},
		presentCall: (args) => ({
			card: "generic",
			title: "node_run",
			kind: "execute",
			rawInput: args.path,
			content: [{ type: "text", text: args.description }],
		}),
	}));

	ctx.tools.register(defineTool({
		name: "node_npm",
		description: "Install Node.js packages with npm into the workspace node-env. Creates the node-env on first use if it does not exist yet. Use this to add third-party packages so node_run scripts can require/import them. Installs run npm lifecycle scripts (preinstall/postinstall); network access is not gated by the sandbox — same posture as py_pip. Default timeout is 120s; pass a larger timeoutMs for large installs.",
		parameters: {
			description: {
				type: "string",
				required: true,
				description: "A short human-readable description of what this execution does.",
			},
			packages: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Package names to install (may include version specifiers, e.g. lodash@4.17.21).",
			},
			workdir: {
				type: "string",
				description: "Working directory for the npm process. Defaults to the session workspace.",
			},
			timeoutMs: {
				type: "number",
				description: "Timeout in milliseconds. The process is killed on expiry.",
			},
			...escalationModes.length > 0 ? {
				sandbox_permissions: {
					type: "string",
					enum: [...escalationModes],
					description: "The wider sandbox mode this run needs. Only valid as a one-shot retry of a run the sandbox just denied; requires justification and user approval.",
				},
				justification: {
					type: "string",
					description: "Required with sandbox_permissions: one sentence for the user explaining why this exact run needs the wider access.",
				},
			} : {},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					stdout: { type: "string", required: true },
					stderr: { type: "string", required: true },
					exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
					signal: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
					timedOut: { type: "boolean", required: true },
					timeoutMs: { type: "number", required: true },
					sandbox: {
						type: "object",
						additionalProperties: false,
						properties: {
							mode: { type: "string", required: true },
							denied: { type: "boolean", required: true },
						},
					},
				},
			},
			render: (_args, value) => {
				let body = value.stdout;
				if (value.stderr.length > 0) {
					if (body.length > 0 && !body.endsWith("\n")) body += "\n";
					body += `[stderr]\n${value.stderr}`;
				}
				if (body.length === 0) body = "(no output)";
				const markers = [];
				if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`);
				if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`);
				else if (value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`);
				if (markers.length > 0) body += `\n${markers.join("\n")}`;
				body = appendSandboxMarkers(body, value.sandbox, escalationModes);
				return [{ type: "text", text: body }];
			},
		},
		async execute(args, exec) {
			if (
				!Array.isArray(args.packages) ||
				args.packages.length === 0 ||
				args.packages.some((p) => typeof p !== "string" || p.trim().length === 0)
			) {
				throw new Error("invalid packages: expected a non-empty array of strings");
			}
			validateEscalationArgs(args.sandbox_permissions, args.justification);
			const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
			const workdir = args.workdir ? resolve(cwd, args.workdir) : cwd;
			const timeoutMs = args.timeoutMs ?? 120000;
			const policy = await resolveCallPolicy(args, exec);
			const env = await ensureNodeEnv(cwd);
			const lockPath = await acquireInstallLock(env);
			try {
				const result = await runConfined(
					[NODE, NPM_CLI, "install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--prefix", env, ...args.packages],
					workdir,
					nodeEnvVars(env),
					timeoutMs,
					exec.signal,
					policy
				);
				return toResult(result);
			} finally {
				await unlink(lockPath).catch(() => {});
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: "node_npm",
			kind: "execute",
			rawInput: (args.packages ?? []).join(", "),
			content: [{ type: "text", text: args.description }],
		}),
	}));
}

export { apply, inject, name };