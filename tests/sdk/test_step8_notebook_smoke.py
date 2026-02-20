from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


def _strip_notebook_magics(source: str) -> str:
    lines = source.splitlines()
    filtered = [
        line
        for line in lines
        if not line.lstrip().startswith("%") and not line.lstrip().startswith("!")
    ]
    return "\n".join(filtered)


class Step8NotebookSmokeTests(unittest.TestCase):
    def test_step8_notebook_executes_all_code_cells(self) -> None:
        notebook_path = ROOT / "docs/sdk/notebooks/step8_core_image_flow.ipynb"
        notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
        state: dict[str, object] = {"__name__": "__main__"}

        code_cells = [cell for cell in notebook.get("cells", []) if cell.get("cell_type") == "code"]
        self.assertGreaterEqual(len(code_cells), 1)

        for index, cell in enumerate(code_cells):
            source = "".join(cell.get("source", []))
            source = _strip_notebook_magics(source)
            if not source.strip():
                continue
            try:
                exec(compile(source, f"{notebook_path.name}:cell-{index}", "exec"), state, state)
            except Exception as exc:  # pragma: no cover - failure path
                self.fail(f"Notebook cell {index} failed: {exc}")


if __name__ == "__main__":
    unittest.main()

