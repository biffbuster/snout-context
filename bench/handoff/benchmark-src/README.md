# Benchmark handoff sources

The projects in bench/handoff/<name>/ for spec-benchmark.json and the spec itself are written from these
definitions, so a handoff is changed here and written again, never edited in place:

    node bench/handoff/benchmark-src/write-projects.mjs bench/handoff/benchmark-src/batch2.mjs bench/handoff   # OVERWRITE=1 to replace
    node bench/handoff/benchmark-src/write-spec.mjs bench/handoff/spec-benchmark.json bench/handoff/benchmark-src/batch*.mjs

Free checks before any freeze: `node bench/handoff-check.mjs --spec spec-benchmark.json --grade-check`,
`node bench/benchmark-notes.mjs`, then a stand-in dry run (`SWE_FAKE_AGENT=1 ... --allow-dirty`).
