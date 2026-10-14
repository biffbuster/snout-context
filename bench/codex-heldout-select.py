#!/usr/bin/env python
"""Freeze natural Codex pilot issues before any agent run.

Input is the official SWE-bench Verified test Parquet. Only issue text and
metadata are exported; gold solution and test patches stay out of the prompt.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

DATASET_SHA256 = "a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd"
SEED = "20261013"
REPOS = ("astropy/astropy", "matplotlib/matplotlib", "scikit-learn/scikit-learn")
COLUMNS = ("instance_id", "repo", "base_commit", "problem_statement", "difficulty")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parquet", type=Path)
    parser.add_argument("--out", type=Path, default=Path("bench/codex-heldout-tasks.json"))
    parser.add_argument("--pydeps", type=Path, help="optional local directory containing pyarrow")
    args = parser.parse_args()
    if args.pydeps:
        sys.path.insert(0, str(args.pydeps.resolve()))
    import pyarrow.parquet as pq

    digest = hashlib.sha256(args.parquet.read_bytes()).hexdigest()
    if digest != DATASET_SHA256:
        raise SystemExit(f"Dataset SHA-256 mismatch: {digest}")
    rows = pq.read_table(args.parquet, columns=list(COLUMNS)).to_pylist()
    if len(rows) != 500 or len({row["instance_id"] for row in rows}) != 500:
        raise SystemExit("Expected 500 distinct SWE-bench Verified issues")

    prior = json.loads(Path("bench/swe-tasks.json").read_text(encoding="utf-8"))
    prior_ids = {task["instance_id"] for task in prior["tasks"]}
    chosen = []
    for repo in REPOS:
        eligible = [
            row for row in rows
            if row["repo"] == repo and row["difficulty"] == "<15 min fix"
            and row["instance_id"] not in prior_ids
        ]
        if not eligible:
            raise SystemExit(f"No eligible issue for {repo}")
        rank = lambda row: hashlib.sha256(
            f"{SEED}:{row['instance_id']}".encode("utf-8")
        ).hexdigest()
        row = min(eligible, key=rank)
        image_key = row["instance_id"].replace("__", "_1776_", 1)
        chosen.append({
            "instance_id": row["instance_id"],
            "repo": repo,
            "base_commit": row["base_commit"],
            "problem_statement": row["problem_statement"],
            "difficulty": row["difficulty"],
            "image": f"swebench/sweb.eval.x86_64.{image_key}:latest",
        })
    frozen = {
        "dataset": "princeton-nlp/SWE-bench_Verified",
        "split": "test",
        "parquetSha256": digest,
        "selection": {
            "seed": SEED,
            "repos": REPOS,
            "difficulty": "<15 min fix",
            "rank": "ascending SHA-256 of UTF-8 seed:instance_id",
            "onePerRepo": True,
            "excludedPriorPilotFile": "bench/swe-tasks.json",
        },
        "tasks": chosen,
    }
    with args.out.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(frozen, output, indent=2, ensure_ascii=False)
        output.write("\n")
    for task in chosen:
        print(f"{task['repo']}: {task['instance_id']}")
    print(f"Frozen {len(chosen)} tasks to {args.out}")


if __name__ == "__main__":
    main()