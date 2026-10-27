"""Build a local, self-contained app: uv run --group build python scripts/build_app.py."""

from pathlib import Path

from PyInstaller.__main__ import run

if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    run(
        [
            str(root / "scripts" / "PCBVisualizer.spec"),
            "--noconfirm",
            "--clean",
            "--distpath",
            str(root / "dist"),
            "--workpath",
            str(root / "build" / "native"),
        ]
    )
