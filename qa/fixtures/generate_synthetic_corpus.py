#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path
from typing import Any


SEED = 20260301


def write_bytes(path: Path, size: int, rng: random.Random) -> str:
    data = bytes(rng.randrange(0, 256) for _ in range(size))
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def dataset_metadata(
    name: str,
    shape: dict[str, int],
    spacing: dict[str, float],
    channel_names: list[str],
    extra: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": name,
        "shape": shape,
        "spacing": spacing,
        "channels": channel_names,
        **extra,
    }


def generate(output_root: Path) -> dict[str, Any]:
    rng = random.Random(SEED)
    output_root.mkdir(parents=True, exist_ok=True)

    datasets: list[dict[str, Any]] = []

    two_d_root = output_root / "two_d_multichannel"
    two_d_root.mkdir(parents=True, exist_ok=True)
    two_d_hash = write_bytes(two_d_root / "payload.bin", size=64 * 64 * 3, rng=rng)
    two_d_meta = dataset_metadata(
        name="two_d_multichannel",
        shape={"t": 1, "c": 3, "z": 1, "y": 64, "x": 64},
        spacing={"x": 1.0, "y": 1.0, "z": 1.0},
        channel_names=["DAPI", "GFP", "RFP"],
        extra={"dtype": "uint8"},
    )
    (two_d_root / "metadata.json").write_text(
        json.dumps(two_d_meta, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    datasets.append(
        {
            "dataset_id": "ds_synth_2d",
            "path": str(two_d_root),
            "payload_sha256": two_d_hash,
            "metadata": two_d_meta,
        }
    )

    three_d_root = output_root / "three_d_anisotropic"
    three_d_root.mkdir(parents=True, exist_ok=True)
    three_d_hash = write_bytes(
        three_d_root / "payload.bin", size=24 * 64 * 64, rng=rng
    )
    three_d_meta = dataset_metadata(
        name="three_d_anisotropic",
        shape={"t": 1, "c": 1, "z": 24, "y": 64, "x": 64},
        spacing={"x": 0.5, "y": 0.5, "z": 2.0},
        channel_names=["intensity"],
        extra={"dtype": "uint16", "anisotropy_ratio": 4.0},
    )
    (three_d_root / "metadata.json").write_text(
        json.dumps(three_d_meta, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    datasets.append(
        {
            "dataset_id": "ds_synth_3d",
            "path": str(three_d_root),
            "payload_sha256": three_d_hash,
            "metadata": three_d_meta,
        }
    )

    labels_root = output_root / "labels_sparse_ids"
    labels_root.mkdir(parents=True, exist_ok=True)
    labels_hash = write_bytes(labels_root / "labels.bin", size=64 * 64, rng=rng)
    labels_meta = dataset_metadata(
        name="labels_sparse_ids",
        shape={"t": 1, "c": 1, "z": 1, "y": 64, "x": 64},
        spacing={"x": 1.0, "y": 1.0, "z": 1.0},
        channel_names=["labels"],
        extra={"dtype": "uint32", "sparse_ids": [1, 7, 42, 128, 4096]},
    )
    (labels_root / "metadata.json").write_text(
        json.dumps(labels_meta, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    datasets.append(
        {
            "dataset_id": "ds_synth_labels",
            "path": str(labels_root),
            "payload_sha256": labels_hash,
            "metadata": labels_meta,
        }
    )

    churn_root = output_root / "source_churn_sequence"
    churn_root.mkdir(parents=True, exist_ok=True)
    revisions = []
    for revision in range(1, 6):
        revision_path = churn_root / f"revision_{revision:02d}.bin"
        revision_hash = write_bytes(revision_path, size=1024, rng=rng)
        revisions.append(
            {
                "revision": revision,
                "path": str(revision_path),
                "sha256": revision_hash,
            }
        )
    churn_meta = {
        "name": "source_churn_sequence",
        "revisions": revisions,
        "shape": {"t": 1, "c": 1, "z": 1, "y": 32, "x": 32},
    }
    (churn_root / "metadata.json").write_text(
        json.dumps(churn_meta, indent=2, sort_keys=True), encoding="utf-8"
    )
    datasets.append(
        {
            "dataset_id": "ds_synth_churn",
            "path": str(churn_root),
            "metadata": churn_meta,
        }
    )

    manifest = {
        "generator_version": "0.1",
        "seed": SEED,
        "datasets": datasets,
    }
    manifest_path = output_root / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("qa/fixtures/corpus"),
        help="output directory for generated synthetic corpus",
    )
    args = parser.parse_args()
    manifest = generate(args.output_root)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
