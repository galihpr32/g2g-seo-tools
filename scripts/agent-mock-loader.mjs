// Superseded by test-loki-e2e.cjs — see note in test-loki-e2e.mts.
// Kept as a starting point if the repo migrates to ESM ("type": "module").
export const resolve = async (s, c, n) => n(s, c)
export const load    = async (u, c, n) => n(u, c)
