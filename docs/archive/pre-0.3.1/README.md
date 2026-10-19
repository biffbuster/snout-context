# Historical benchmark archive

These are pre-0.3.1 measurements, retained for audit and comparison. They are **not scores for Snout 0.3.1**. In particular, the older Mac PointFive and compaction figures still lack same-set, current-build raw rows in this repository.

- `ab-results/`: 10 previously tracked raw result files from September and October 2026.
- `results/`: 18 derived CSV, JSON, and SVG report files across six studies.
- `benchmark.md`, `claims.md`, and `benchmark-protocol.md`: the previous benchmark narrative, claim ledger, and long pre-registration/pilot log, preserved as historical snapshots. Paths beginning `bench/ab-results/` in those snapshots now refer to this archive's `ab-results/`; `results/` remains within this archive.
- `.snout/archive/pre-0.3.1/ab-results/`: 29 additional local-only scratch result files, preserved on this machine and still ignored by Git. They are not part of a shared clone.

The 39 raw JSON files were all produced before the 0.3.1 candidate: 29 lack a version stamp and 10 are stamped 0.3.0. The raw files are preserved rather than deleted; benchmark scripts and task fixtures remain active for reruns. The local-only archive should be copied separately if the machine is retired.

The current release score status is in [../../claims.md](../../claims.md); the current rerun instructions are in [../../benchmark.md](../../benchmark.md).
