"""Launch the configured legacy manager independently of the short WSL request.

Run as python3 -c SCRIPT HELPER_PATH CONFIG_PATH. No shell, installation,
configuration rewrite, service adoption, or signal to an existing process.
The legacy manager remains responsible for operation/server locks and dedup.
"""

import os
from pathlib import Path
import signal
import subprocess
import sys


def launch(helper_path, config_path):
    for path in (helper_path, config_path):
        if (not isinstance(path, str) or not Path(path).is_absolute()
                or any(ord(char) < 32 or ord(char) == 127 for char in path)):
            raise ValueError("invalid path")
    # POSIX preserves ignored dispositions across exec. setsid alone would not
    # protect the supervisor from a SIGHUP sent directly during WSL session exit.
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    return subprocess.Popen(
        [sys.executable, helper_path, "run", "--config", config_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
        shell=False,
    )


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if len(args) != 2:
            raise ValueError("invalid arguments")
        os.umask(0o077)
        # Intentionally do not wait: readiness is verified by the normal probe.
        # The manager and its CLI must survive this short-lived WSL request.
        launch(*args)
        return 0
    except Exception:
        # The caller receives only a static failure status; never echo paths,
        # environment variables, project output or authentication credentials.
        return 1


if __name__ == "__main__":
    sys.exit(main())
