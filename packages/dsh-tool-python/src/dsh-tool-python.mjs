// dsh-tool-python.mjs
// Registers two model-facing tools:
//   * py_run  — execute an existing Python script file.
//   * py_pip  — install packages with pip into the workspace venv.
//
// Python subprocesses are confined through the same DSH sandbox seam the bash
// tool uses: `ctx.sandbox.confine` wraps the exact argv under the resolved
// per-call policy (on macOS this selects Apple's sandbox-exec / Seatbelt), and
// `ctx.sandboxPolicy` + `ctx.approval` drive the same-turn escalation flow.
// A blocked file operation is reported as `[sandbox: file access denied under
// <mode> mode]`; escalation is a one-shot retry with `sandbox_permissions` +
// `justification`. When no sandbox backend is usable the call fails closed
// (SandboxUnavailableError) — the command never runs unconfined.
//
// The plugin manages a per-workspace venv at <cwd>/.dsh/pyenv. When the
// workspace directory moves, the venv moves with it but its hardcoded paths
// (console-script shebangs, activate scripts, pyvenv.cfg `command`, and the
// __pycache__ bytecode) still point at the OLD location. repairVenv detects a
// stale venv and rewrites old-path -> new-path in place before any run, so a
// relocated workspace keeps working transparently without recreating the venv
// (which would lose installed packages).

import { mkdir, access, readFile, writeFile, readdir, stat, chmod, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ESCALATION_TARGETS, SandboxUnavailableError, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";

const name = "dsh-tool-python";
const inject = ["tools", "systemPrompt", "sandbox", "sandboxPolicy", "approval", "subprocess"];

const PYTHON = process.env.PYTHON ?? "python3";

/** Timeout code stamped onto the deadline signal so timeoutOf can recover it. */
const PYTHON_TIMEOUT = "PYTHON_TIMEOUT";
/** SIGTERM→SIGKILL grace period for the subprocess service (matches bash-local). */
const GRACE_MS = 3000;
/** Per-stream in-memory cap and spill cap for collected output. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SPILL_BYTES = 64 * 1024 * 1024;

/** Directory of the workspace venv: <workspace>/.dsh/pyenv. */
function venvDir(cwd) {
	return join(cwd, ".dsh", "pyenv");
}

/** Candidate interpreter paths inside a venv (POSIX then Windows). */
function venvPythonCandidates(venv) {
	return [join(venv, "bin", "python"), join(venv, "Scripts", "python.exe")];
}

/** Return the existing venv interpreter path, or null if the venv is absent. */
async function findVenvPython(cwd) {
	for (const p of venvPythonCandidates(venvDir(cwd))) {
		try {
			await access(p);
			return p;
		} catch {
			/* keep checking the next candidate */
		}
	}
	return null;
}

/** Extract the venv path embedded in a pyvenv.cfg `command` line, or null. */
function venvPathFromCfg(cfgText) {
	for (const line of cfgText.split(/\r?\n/)) {
		const m = /^\s*command\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		const tokens = m[1].trim().split(/\s+/).filter(Boolean);
		if (tokens.length > 0) return tokens[tokens.length - 1];
	}
	return null;
}

/** Rewrite oldPath -> newPath in one file, preserving mode; skip binaries. */
async function rewriteTextFile(file, oldPath, newPath) {
	let raw;
	try {
		raw = await readFile(file);
	} catch {
		return;
	}
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		return; // binary — leave untouched
	}
	if (!text.includes(oldPath)) return;
	const mode = (await stat(file)).mode;
	await writeFile(file, text.split(oldPath).join(newPath));
	await chmod(file, mode);
}

/** Recursively visit every file under dir. */
async function walk(dir, onFile) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, onFile);
		} else if (entry.isFile()) {
			await onFile(full);
		}
	}
}

/** Delete every .pyc bytecode cache under the venv (regenerated on import). */
async function clearPycache(venv) {
	await walk(venv, async (file) => {
		if (file.endsWith(".pyc")) {
			try {
				await rm(file);
			} catch {
				/* best effort */
			}
		}
	});
}

/**
 * Repair a relocated venv in place. Returns true when the venv's embedded path
 * differed from the actual venvDir(cwd) and was rewritten; false when the venv
 * is absent, already current, or repair failed (callers degrade to today's
 * behavior). Never throws.
 */
async function repairVenv(venv, cwd) {
	try {
		let cfgText;
		try {
			cfgText = await readFile(join(venv, "pyvenv.cfg"), "utf8");
		} catch {
			return false; // no venv yet
		}
		const oldPath = venvPathFromCfg(cfgText);
		if (!oldPath || oldPath === venv) return false;
		await rewriteTextFile(join(venv, "pyvenv.cfg"), oldPath, venv);
		await walk(join(venv, "bin"), (file) => rewriteTextFile(file, oldPath, venv));
		await clearPycache(venv);
		return true;
	} catch {
		return false;
	}
}

/** Interpreter to use: the venv's python if it exists, else the system python. */
async function resolvePython(cwd) {
	await repairVenv(venvDir(cwd), cwd);
	return (await findVenvPython(cwd)) ?? PYTHON;
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
			toolName: "python",
			signal: exec.signal
		});
	};

	/** Run an exact argv through ctx.subprocess with a deadline and collected output. */
	const runRaw = async (argv, workdir, timeoutMs, signal) => {
		const d = deadline(signal, timeoutMs, PYTHON_TIMEOUT);
		try {
			const handle = ctx.subprocess.spawn({
				argv,
				cwd: workdir,
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
				timedOut: timeoutOf(d.signal, PYTHON_TIMEOUT) !== void 0,
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
	const runConfined = async (argv, workdir, timeoutMs, signal, policy) => {
		const mode = policy?.mode;
		if (sandbox === void 0 || mode === void 0 || mode === "danger-full-access") {
			return runRaw(argv, workdir, timeoutMs, signal);
		}
		const confined = await sandbox.confine(argv, { ...policy, mode });
		let result;
		try {
			result = await runRaw(confined.argv, workdir, timeoutMs, signal);
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

	/** Create the workspace venv (idempotent) and return its interpreter path. */
	const ensureVenv = async (cwd, policy, signal) => {
		await repairVenv(venvDir(cwd), cwd);
		const existing = await findVenvPython(cwd);
		if (existing) return existing;
		const venv = venvDir(cwd);
		await mkdir(join(cwd, ".dsh"), { recursive: true });
		const result = await runConfined([PYTHON, "-m", "venv", venv], cwd, 120000, signal, policy);
		if (result.exitCode !== 0) {
			throw new Error(`failed to create venv at ${venv}: ${result.stderr}`);
		}
		return findVenvPython(cwd);
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
		name: "tool:python",
		order: 110,
		text: "Use py_run to run an existing .py file and py_pip to install packages with pip. Create a .py file with the file tools (write) and run it with py_run. py_run runs in the workspace venv when it exists, otherwise in the system python; it is stateless — pass everything each call needs. py_pip creates the workspace venv on first use and installs packages into it. Python runs may be confined by a file sandbox; a blocked file operation is reported as [sandbox: file access denied under <mode> mode] — a policy denial, not a bug in the code; do not retry another way." + (escalationModes.length === 0 ? "" : " When a run is denied and a wider mode would let it succeed, escalate immediately in the same turn: retry the exact same run once with sandbox_permissions (the narrowest wider mode that suffices) plus a one-sentence justification. Never escalate speculatively: ground the request in a real denial."),
	});

	ctx.tools.register(defineTool({
		name: "py_run",
		description: "Execute an existing Python script file in the workspace venv and return its stdout/stderr. The file must already exist on disk (create it with the write file tool). Non-zero exits are reported as [exit code: N].",
		parameters: {
			description: {
				type: "string",
				required: true,
				description: "A short human-readable description of what this execution does.",
			},
			path: {
				type: "string",
				required: true,
				description: "Path to the .py file to run, relative to the session workspace (or absolute).",
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
			const python = await resolvePython(cwd);
			const policy = await resolveCallPolicy(args, exec);
			const result = await runConfined([python, file, ...(args.args ?? [])], workdir, timeoutMs, exec.signal, policy);
			return toResult(result);
		},
		presentCall: (args) => ({
			card: "generic",
			title: "py_run",
			kind: "execute",
			rawInput: args.path,
			content: [{ type: "text", text: args.description }],
		}),
	}));

	ctx.tools.register(defineTool({
		name: "py_pip",
		description: "Install Python packages with pip into the workspace venv. Creates the venv on first use if it does not exist yet. Use this to add third-party packages so py_run can import them.",
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
				description: "Package names to install (may include version specifiers, e.g. requests==2.31.0).",
			},
			workdir: {
				type: "string",
				description: "Working directory for the pip process. Defaults to the session workspace.",
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
			const python = await ensureVenv(cwd, policy, exec.signal);
			const result = await runConfined([python, "-m", "pip", "install", ...args.packages], workdir, timeoutMs, exec.signal, policy);
			return toResult(result);
		},
		presentCall: (args) => ({
			card: "generic",
			title: "py_pip",
			kind: "execute",
			rawInput: (args.packages ?? []).join(", "),
			content: [{ type: "text", text: args.description }],
		}),
	}));
}

export { apply, inject, name };
