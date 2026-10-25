"""Prepare or inspect the fixed assistant workspace; never run user code."""
import json
import os
import sys
from pathlib import Path


def _default_target():
    target = Path.home() / ".dsh-wsl-desktop" / "assistant"
    if target.parent.is_symlink():
        raise ValueError("linked data root")
    if target.is_symlink():
        raise ValueError("linked workspace")
    return target


def inspect():
    """Return the canonical default path without creating or changing anything."""
    target = _default_target()
    for directory in (target.parent, target):
        if directory.exists() and not directory.is_dir():
            raise ValueError("workspace unavailable")
    if target.exists() and not os.access(target, os.R_OK | os.W_OK | os.X_OK):
        raise ValueError("workspace unavailable")
    return {"path": str(target.resolve(strict=False))}


def prepare():
    """Create the fixed workspace on first enable, preserving existing contents."""
    target = _default_target()
    # parents=True would create the shared data root with default permissions.
    # Both managed directories must instead start private, and neither may be
    # replaced by a symlink between the initial checks and directory creation.
    target.parent.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir("assistant", mode=0o700, dir_fd=fd)
        except FileExistsError:
            pass
        workspace_fd = os.open(
            "assistant", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
        )
        os.close(workspace_fd)
    finally:
        os.close(fd)
    return inspect()


if __name__ == "__main__":
    try:
        if sys.argv[1:] == []:
            result = prepare()
        elif sys.argv[1:] == ["--inspect"]:
            result = inspect()
        else:
            raise ValueError("invalid arguments")
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError):
        print(json.dumps({"error": "workspace unavailable"}))
        sys.exit(1)
