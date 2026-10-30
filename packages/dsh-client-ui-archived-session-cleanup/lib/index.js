/**
 * dsh-host-archived-session-cleanup
 *
 * Host half of the "Delete archived sessions" Settings control.
 *
 * Registers the host remote service `archivedSessionCleanup` with one Remote
 * endpoint `deleteOlderThan(days)`. It walks the workspace registry's archived
 * session set, and for each archived session whose creation time is older than
 * `days` days it removes the session directory from disk, detaches the session
 * from its accounting workspace, and drops it from the registry's archive set.
 * Sessions that are currently attached/running are skipped (never removed, never
 * unarchived) so they cannot resurface as active. The session-query index
 * reconciles the removed files on its next pass.
 *
 * The Settings UI section lives in the sibling client plugin package
 * `dsh-client-archived-session-cleanup` (see its `client.js`), which is
 * composed into the client graph by `@deepseek-ai/dsh-client-modules` and
 * mounted by the client runtime. It registers a `settings.section` entry whose
 * component renders a number field (days) and a Delete button; the button calls
 * this service through the client's `ctx.remote`.
 */
import { RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const name = "dsh-host-archived-session-cleanup";
export const inject = ["workspaceRegistry", "sessionPersistence", "sessions"];

const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/**
 * Register a public instance method as a Typert Remote "direct" endpoint
 * without relying on the `@Remote` decorator (which Node cannot parse without
 * a build step). Mirrors the descriptor the decorator would produce.
 */
function registerRemoteMethod(prototype, method) {
	const existing = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	const descriptor = existing?.value;
	const methods = descriptor?.methods ?? [];
	const marker = Object.freeze({
		method,
		invocation: Object.freeze({ kind: "direct" })
	});
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([...methods, marker])
		})
	});
}

class ArchivedSessionCleanupService extends TypertRemoteService {
	static inject = ["workspaceRegistry", "sessionPersistence"];

	constructor(ctx) {
		super(ctx, "archivedSessionCleanup", { namespace: "archivedSessionCleanup" });
	}

	/**
	 * Build an id -> header map for every stored session in ONE persistence pass.
	 *
	 * Per-session `persistence.stat(id)` is O(n^2) here: for v3-format sessions it
	 * triggers `historicalCorpusRevision()` (a full-corpus scan) on every call, so
	 * a few hundred archived sessions cost several seconds per RPC. `list()` reads
	 * every header once and computes the corpus revision once.
	 */
	async snapshotHeaders(signal) {
		const persistence = this.ctx.sessionPersistence;
		const headers = new Map();
		for (const snapshot of await persistence.list({ signal })) {
			if (snapshot === undefined || snapshot.header === undefined) continue;
			headers.set(snapshot.header.id, snapshot.header);
		}
		return headers;
	}

	/**
	 * Resolve the workspace display group for an archived session. Always
	 * returns a bucket so every candidate shows in the breakdown.
	 *
	 * Priority: the registry accounting slot (`entity.sessionIds`) first, then a
	 * registered workspace whose `path` equals the session header's `cwd`, then
	 * the cwd itself as a display group, and finally an explicit "ungrouped"
	 * bucket when no directory can be determined at all.
	 *
	 * @returns `{ group, entity }` where `entity` is the live registry entity
	 * when the session is registry-accounted (used for detach), and `group` is
	 * the display bucket (used for the breakdown).
	 */
	workspaceGroup(header, bySession, byPath) {
		const entity = header === undefined ? undefined : bySession.get(header.id);
		if (entity !== undefined) return { group: { id: entity.id, title: entity.title, path: entity.path }, entity };
		const cwd = header?.cwd;
		if (cwd !== undefined) {
			const byPathEntity = byPath.get(cwd);
			if (byPathEntity !== undefined) return { group: { id: byPathEntity.id, title: byPathEntity.title, path: byPathEntity.path }, entity: byPathEntity };
			return { group: { id: `cwd:${cwd}`, title: cwd, path: cwd }, entity: undefined };
		}
		return { group: { id: "ungrouped", title: "Ungrouped", path: "" }, entity: undefined };
	}

	/**
	 * Aggregate candidates into the per-workspace breakdown. Every candidate
	 * contributes, including those with no registry accounting slot or no
	 * header cwd at all.
	 */
	aggregateByWorkspace(candidates) {
		const byWorkspace = new Map();
		for (const { group } of candidates) {
			const entry = byWorkspace.get(group.id) ?? { id: group.id, title: group.title, path: group.path, deleted: 0 };
			entry.deleted += 1;
			byWorkspace.set(group.id, entry);
		}
		return [...byWorkspace.values()];
	}

	async collectOlderThan(days, signal) {
		const cutoff = Date.now() - Math.floor(days) * 86400000;
		const registry = this.ctx.workspaceRegistry;
		const persistence = this.ctx.sessionPersistence;
		const archived = [...registry.archivedSessionIds];
		const bySession = new Map();
		const byPath = new Map();
		for (const entity of registry.list()) {
			for (const id of entity.sessionIds) bySession.set(id, entity);
			byPath.set(entity.path, entity);
		}
		const headers = await this.snapshotHeaders(signal);
		const candidates = [];
		const skipped = [];
		const failures = [];
		for (const id of archived) {
			signal?.throwIfAborted();
			// Never touch a session that is currently attached/running: removing
			// its directory while the session is live either fails (files in use)
			// or is immediately undone when the running session re-persists, and
			// unarchiving it would resurface it as active. Leave such sessions
			// archived and report them as skipped.
			if (this.ctx.sessions.get(id) !== undefined) {
				skipped.push(id);
				continue;
			}
			const header = headers.get(id);
			if (header === undefined) continue;
			if (header.createdAt >= cutoff) continue;
			try {
				const located = persistence.locate(header);
				const { group, entity } = this.workspaceGroup(header, bySession, byPath);
				candidates.push({ id, sessionDir: dirname(located.path), entity, group });
			} catch (error) {
				failures.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { candidates, skipped, failures, total: archived.length };
	}

	async previewOlderThan(days, signal) {
		if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
			throw new RemoteError("archived-session-cleanup/invalid-days", "days must be a non-negative number", { days });
		}
		signal?.throwIfAborted();
		const { candidates, skipped, failures, total } = await this.collectOlderThan(days, signal);
		return { deleted: candidates.length, skipped: skipped.length, failures, total, byWorkspace: this.aggregateByWorkspace(candidates) };
	}

	async stats(signal) {
		signal?.throwIfAborted();
		const DAY = 86400000;
		const now = Date.now();
		const registry = this.ctx.workspaceRegistry;
		const archived = [...registry.archivedSessionIds];
		const bySession = new Map();
		const byPath = new Map();
		for (const entity of registry.list()) {
			for (const id of entity.sessionIds) bySession.set(id, entity);
			byPath.set(entity.path, entity);
		}
		const headers = await this.snapshotHeaders(signal);
		const ages = [];
		const byWorkspace14 = new Map();
		const byWorkspace30 = new Map();
		let deleted14 = 0;
		let deleted30 = 0;
		let skipped = 0;
		const failures = [];
		for (const id of archived) {
			signal?.throwIfAborted();
			if (this.ctx.sessions.get(id) !== undefined) {
				skipped += 1;
				continue;
			}
			const header = headers.get(id);
			if (header === undefined) continue;
			const ageDays = Math.max(0, Math.floor((now - header.createdAt) / DAY));
			ages.push(ageDays);
			const { group } = this.workspaceGroup(header, bySession, byPath);
			if (ageDays >= 14) {
				deleted14 += 1;
				const entry = byWorkspace14.get(group.id) ?? { id: group.id, title: group.title, path: group.path, deleted: 0 };
				entry.deleted += 1;
				byWorkspace14.set(group.id, entry);
			}
			if (ageDays >= 30) {
				deleted30 += 1;
				const entry = byWorkspace30.get(group.id) ?? { id: group.id, title: group.title, path: group.path, deleted: 0 };
				entry.deleted += 1;
				byWorkspace30.set(group.id, entry);
			}
		}
		const bucketMap = new Map();
		for (const age of ages) {
			const idx = Math.floor(age / 14);
			bucketMap.set(idx, (bucketMap.get(idx) ?? 0) + 1);
		}
		const maxIdx = bucketMap.size === 0 ? 0 : Math.max(...bucketMap.keys());
		const buckets = [];
		for (let i = 0; i <= maxIdx; i++) {
			buckets.push({ minDays: i * 14, maxDays: i === maxIdx ? null : (i + 1) * 14, count: bucketMap.get(i) ?? 0 });
		}
		const total = ages.length;
		const averageAgeDays = total === 0 ? 0 : Math.round(ages.reduce((a, b) => a + b, 0) / total);
		return {
			total,
			skipped,
			averageAgeDays,
			buckets,
			at14: { deleted: deleted14, total, byWorkspace: [...byWorkspace14.values()] },
			at30: { deleted: deleted30, total, byWorkspace: [...byWorkspace30.values()] },
			failures
		};
	}

	async deleteOlderThan(days, signal) {
		if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
			throw new RemoteError("archived-session-cleanup/invalid-days", "days must be a non-negative number", { days });
		}
		signal?.throwIfAborted();
		const { candidates, skipped, total } = await this.collectOlderThan(days, signal);
		const registry = this.ctx.workspaceRegistry;
		let deleted = 0;
		const failures = [];
		const removed = [];
		for (const { id, sessionDir, entity, group } of candidates) {
			signal?.throwIfAborted();
			try {
				// Remove the session directory from disk and confirm it is gone.
				// Only after a confirmed removal do we touch workspace accounting
				// (detach) or the registry archive set (unarchive): a failed or
				// missing deletion must never surface the session as active again.
				let present = true;
				try {
					await stat(sessionDir);
				} catch (error) {
					if (error !== undefined && error !== null && error.code === "ENOENT") present = false;
					else throw error;
				}
				if (present) {
					await rm(sessionDir, { recursive: true, force: true });
					try {
						await stat(sessionDir);
					} catch (error) {
						if (error !== undefined && error !== null && error.code === "ENOENT") present = false;
						else throw error;
					}
				}
				if (present) throw new Error(`session directory still present after removal: ${sessionDir}`);
				if (entity !== undefined) await entity.detachSession(id);
				await registry.unarchiveSession(id);
				deleted += 1;
				removed.push({ group });
			} catch (error) {
				failures.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return {
			deleted,
			skipped: skipped.length,
			failures,
			total,
			byWorkspace: this.aggregateByWorkspace(removed)
		};
	}
}

registerRemoteMethod(ArchivedSessionCleanupService.prototype, "previewOlderThan");
registerRemoteMethod(ArchivedSessionCleanupService.prototype, "stats");
registerRemoteMethod(ArchivedSessionCleanupService.prototype, "deleteOlderThan");

;

export function apply(ctx) {
	ctx.plugin(ArchivedSessionCleanupService);
}

export { ArchivedSessionCleanupService };
