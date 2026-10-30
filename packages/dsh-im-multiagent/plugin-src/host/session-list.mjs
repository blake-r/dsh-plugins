// dsh-im-multiagent session list helpers (plan section 9).
//
// Stable ordering for every session list: (name) -> createdAt -> sessionId.
// Numbers in commands are 1-based positions in this ordering, so the numbers
// shown by /as stay valid across calls. Names match case-insensitively
// against alias first, then the display name, then the raw sessionId prefix.

function displayName(sessionId, entry) {
  return entry?.name ?? sessionId;
}

/** Deterministic ordering: (name) -> createdAt -> sessionId. */
export function sortedSessions(mirrorEntries) {
  return Object.entries(mirrorEntries)
    .map(([sessionId, entry]) => ({ sessionId, entry }))
    .sort((left, right) => {
      const leftName = displayName(left.sessionId, left.entry).toLowerCase();
      const rightName = displayName(right.sessionId, right.entry).toLowerCase();
      const byName = leftName.localeCompare(rightName);
      if (byName !== 0) return byName;
      const leftCreated = Number.isFinite(left.entry?.createdAt) ? left.entry.createdAt : 0;
      const rightCreated = Number.isFinite(right.entry?.createdAt) ? right.entry.createdAt : 0;
      if (leftCreated !== rightCreated) return leftCreated - rightCreated;
      return left.sessionId.localeCompare(right.sessionId);
    });
}

/**
 * Resolve a session reference: a 1-based number from the stable ordering, or
 * a case-insensitive alias / display name / sessionId prefix.
 * @returns {{ sessionId: string, entry: object } | null}
 */
export function resolveSession(mirrorEntries, reference) {
  const sorted = sortedSessions(mirrorEntries);
  const text = String(reference ?? '').trim();
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    const hit = sorted[index];
    return hit ? { sessionId: hit.sessionId, entry: hit.entry } : null;
  }
  if (!text) return null;
  const needle = text.toLowerCase();
  for (const { sessionId, entry } of sorted) {
    const alias = String(entry?.alias ?? '').toLowerCase();
    if (alias && alias === needle) return { sessionId, entry };
  }
  for (const { sessionId, entry } of sorted) {
    if (displayName(sessionId, entry).toLowerCase() === needle) {
      return { sessionId, entry };
    }
  }
  for (const { sessionId, entry } of sorted) {
    if (sessionId.toLowerCase().startsWith(needle)) return { sessionId, entry };
  }
  return null;
}