from __future__ import annotations

import json
import subprocess
from pathlib import Path


def run_generator(output_root: Path) -> dict:
    subprocess.run(
        [
            "python3",
            "qa/fixtures/generate_synthetic_corpus.py",
            "--output-root",
            str(output_root),
        ],
        check=True,
        cwd=Path(__file__).resolve().parents[2],
    )
    return json.loads((output_root / "manifest.json").read_text(encoding="utf-8"))


def test_fixture_generator_is_deterministic(tmp_path: Path) -> None:
    first = run_generator(tmp_path / "run_a")
    second = run_generator(tmp_path / "run_b")

    # Paths differ between runs; compare stable manifest content.
    for manifest in (first, second):
        for dataset in manifest["datasets"]:
            dataset.pop("path", None)
            if "metadata" in dataset and "revisions" in dataset["metadata"]:
                for revision in dataset["metadata"]["revisions"]:
                    revision.pop("path", None)

    assert first == second


def test_fixture_generator_covers_required_s1_shapes(tmp_path: Path) -> None:
    manifest = run_generator(tmp_path / "run")
    dataset_ids = {dataset["dataset_id"] for dataset in manifest["datasets"]}
    assert dataset_ids == {
        "ds_synth_2d",
        "ds_synth_3d",
        "ds_synth_labels",
        "ds_synth_churn",
    }
