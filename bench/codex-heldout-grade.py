#!/usr/bin/env python
"""Grade saved Codex patches with official SWE-bench 3.0.17 on Windows.

The temporary dataset contains gold tests only while grading, after all agent runs.
"""
import argparse
import hashlib
import json
import os
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / '.snout/heldout/swe-bench-verified.parquet'
MANIFEST = ROOT / 'bench/codex-heldout-tasks.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--arm', choices=('off', 'enforce'))
    args = parser.parse_args()
    report_path = args.report.resolve()
    run_dir = report_path.parent
    report = json.loads(report_path.read_text(encoding='utf-8'))
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if hashlib.sha256(PARQUET.read_bytes()).hexdigest() != manifest['parquetSha256']:
        raise SystemExit('Verified dataset SHA-256 changed')
    import pyarrow.parquet as pq
    rows = {row['instance_id']: row for row in pq.read_table(PARQUET).to_pylist()}
    if os.name == 'nt':
        # 3.0.17 imports POSIX resource in image-preparation code; the names are
        # unused when grading prebuilt registry images on Windows.
        sys.modules['resource'] = types.ModuleType('resource')
        # Official evaluator writes eval.sh and patch.diff with Path.write_text.
        # On Windows its default CRLF conversion breaks the Linux eval script.
        original_write_text = Path.write_text
        def write_lf(self, data, *args, **kwargs):
            kwargs.setdefault('newline', '\n')
            return original_write_text(self, data, *args, **kwargs)
        Path.write_text = write_lf
    from swebench.harness.run_evaluation import main as evaluate
    from swebench.harness.test_spec.test_spec import make_test_spec
    from swebench import __version__
    if __version__ != '3.0.17':
        raise SystemExit(f'Expected official swebench 3.0.17, got {__version__}')
    for result in report['rows']:
        if args.arm and result['arm'] != args.arm:
            continue
        if result.get('infrastructureError') or result.get('codexExit') != 0 or not result.get('rootScopeClean'):
            print(f"Skipping invalid run {result['instanceId']} {result['arm']}")
            continue
        task_id = result['instanceId']
        task = next(task for task in manifest['tasks'] if task['instance_id'] == task_id)
        image = make_test_spec(rows[task_id], namespace='swebench').instance_image_key
        if image != task['image']:
            raise SystemExit(f'Official image differs from frozen manifest: {image}')
        stem = task_id.replace('_', '-') + '-' + result['arm'] + '-' + str(result['repeat'])
        patch = (run_dir / (stem + '.patch')).read_text(encoding='utf-8')
        if not patch:
            print(f'Skipping empty patch: {stem}')
            continue
        prediction = {'instance_id': task_id, 'model_patch': patch,
                      'model_name_or_path': 'snout-codex-' + result['arm']}
        dataset_file = run_dir / (stem + '.grade-dataset.json')
        prediction_file = run_dir / (stem + '.prediction.jsonl')
        dataset_file.write_text(json.dumps([rows[task_id]], ensure_ascii=False), encoding='utf-8')
        prediction_file.write_text(json.dumps(prediction, ensure_ascii=False) + '\n', encoding='utf-8')
        grade_id = report['runId'].replace('-', '_').replace(':', '_') + '_' + stem.replace('-', '_') + '_lf2'
        print(f'Grading {task_id} {result["arm"]} with {image}', flush=True)
        try:
            os.chdir(run_dir)
            grade = evaluate(
                dataset_name=str(dataset_file), split='test', instance_ids=[task_id],
                predictions_path=str(prediction_file), max_workers=1,
                force_rebuild=False, cache_level='instance', clean=False,
                open_file_limit=4096, run_id=grade_id, timeout=900,
                namespace='swebench', rewrite_reports=False, modal=False,
                instance_image_tag='latest', report_dir=str(run_dir),
            )
            official_report = run_dir / f"{prediction['model_name_or_path']}.{grade_id}.json"
            result = json.loads(official_report.read_text(encoding='utf-8'))
            (run_dir / (stem + '.grade-result.json')).write_text(
                json.dumps({'officialReport': str(official_report), 'summary': result}, indent=2) + '\n',
                encoding='utf-8')
            print(json.dumps({'resolved': task_id in result['resolved_ids'],
                              'errors': result['error_ids']}), flush=True)
        finally:
            dataset_file.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
