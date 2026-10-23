"""Create only the explicitly selected assistant workspace; never run user code."""
import json
import os
import sys
from pathlib import Path


def prepare(raw):
    if not isinstance(raw, str) or len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        raise ValueError("invalid path")
    raw = raw.strip() or "~/DSH-Assistant"
    if raw.startswith("~/"):
        target = Path.home() / raw[2:]
    elif raw.startswith("/") and not raw.startswith("//"):
        target = Path(raw)
    else:
        raise ValueError("absolute WSL path required")
    if ".." in target.parts or target == Path("/"):
        raise ValueError("invalid path")
    # Workspaces may be existing directories, but a linked final component is
    # rejected so the confirmation never silently selects another project.
    if target.is_symlink():
        raise ValueError("linked workspace")
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    resolved = target.resolve(strict=True)
    if not resolved.is_dir() or not os.access(resolved, os.R_OK | os.W_OK | os.X_OK):
        raise ValueError("workspace unavailable")
    return {"path": str(resolved)}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("invalid arguments")
        print(json.dumps(prepare(sys.argv[1]), ensure_ascii=False))
    except (ValueError, OSError):
        print(json.dumps({"error": "workspace unavailable"}))
        sys.exit(1)
