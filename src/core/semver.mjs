/**
 * Semver parsing and comparison.
 *
 * Extracted so the two version cards -- DSH's and the panel's own -- compare
 * versions the same way. The prerelease rules are the whole reason this is not a
 * string comparison: this project and DSH both publish `-rc.N` and `-alpha.N`
 * builds, and "0.1.5-rc.2 > 0.1.6-alpha.2" is what a naive compare concludes.
 *
 * Deliberately tiny: `src/core/` may not import `node_modules`, and the app
 * needs exactly two operations, not a full semver implementation.
 */

/**
 * Parse a version into comparable parts.
 *
 * Only the subset npm publishes is accepted: build metadata is tolerated and
 * ignored, anything else returns null so the caller can say "I could not compare
 * these" rather than guessing an order.
 *
 * @param {string} input
 * @returns {{major: number, minor: number, patch: number, prerelease: string[], raw: string}|null}
 */
export function parseSemver(input) {
  const s = String(input ?? '').trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw: s,
  };
}

/**
 * Compare two versions the way semver specifies.
 *
 * @returns {number|null} -1, 0, 1, or null when either side is unparseable.
 */
export function compareSemver(a, b) {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A || !B) return null;

  for (const key of ['major', 'minor', 'patch']) {
    if (A[key] !== B[key]) return A[key] < B[key] ? -1 : 1;
  }

  // A version without a prerelease outranks the same version with one:
  // 1.0.0 > 1.0.0-rc.1.
  if (A.prerelease.length === 0 && B.prerelease.length === 0) return 0;
  if (A.prerelease.length === 0) return 1;
  if (B.prerelease.length === 0) return -1;

  const len = Math.max(A.prerelease.length, B.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const x = A.prerelease[i];
    const y = B.prerelease[i];
    // A shorter identifier list is lower when every preceding one matched.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Is `candidate` strictly newer than `current`? Unknown versions are not. */
export function isNewer(candidate, current) {
  const cmp = compareSemver(candidate, current);
  return cmp === null ? false : cmp > 0;
}
