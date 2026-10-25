"""Create only the explicitly selected assistant workspace; never run user code."""
import json
import os
import sys
from pathlib import Path


def prepare(raw):
    if not isinstance(raw, str) or len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        raise ValueError("invalid path")
    raw = raw.strip() or "~/.dsh-wsl-desktop/assistant"
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
    if target == Path.home() / ".dsh-wsl-desktop" / "assistant":
        # pathlib parents=True creates intermediate directories with default
        # permissions, not mode. The shared managed root must start private so
        # speech initialization can safely reuse it after assistant-first setup.
        parent = target.parent
        if parent.is_symlink():
            raise ValueError("linked data root")
        parent.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                os.mkdir("assistant", mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
        finally:
            os.close(fd)
    else:
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
