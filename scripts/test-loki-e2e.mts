// Superseded by test-loki-e2e.cjs — the ESM/loader approach was blocked by
// tsx's loader chain short-circuiting inner module resolution. The working
// end-to-end test is test-loki-e2e.cjs which uses CJS require.cache patching.
//
// Intentionally kept for reference / future ESM migration if/when this repo
// adopts "type": "module" in package.json.
export {}
