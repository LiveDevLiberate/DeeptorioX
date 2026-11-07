"""
Tee logger setup for the Factorio Preview Toolkit.

Replaces sys.stdout and sys.stderr with a stream that writes to both
the terminal and a timestamped log file. This ensures all output
(including print(), logging, and tracebacks) is visible in the console
and saved to a unique file per run.

Also includes optional automatic cleanup to limit the number of logs.
"""

import sys
from datetime import datetime
from io import TextIOWrapper
from pathlib import Path
from typing import TextIO, cast


class TeeStream:
    """
    A stream that writes to both the original terminal (stdout or stderr)
    and a specified log file. Ensures immediate, unbuffered output to both.
    """

    def __init__(self, log_file: Path, original: TextIO):
        if original.encoding is None or original.encoding.lower() != "utf-8":
            original = TextIOWrapper(
                original.buffer, encoding="utf-8", line_buffering=True, errors="replace"
            )
        self.original = original
        self.log = log_file.open("w", encoding="utf-8")
        self.encoding = self.original.encoding

    def write(self, message: str) -> int:
        self.original.write(message)
        self.original.flush()
        self.log.write(message)
        self.log.flush()
        return len(message)

    def flush(self) -> None:
        self.original.flush()
        self.log.flush()

    def close(self) -> None:
        self.log.close()


def enable_tee_logging(log_dir: Path, keep_last_n: int = 10) -> Path:
    """
    Enables tee logging by replacing sys.stdout and sys.stderr with a TeeStream.
    A timestamped log file will be created in the given directory, and older
    logs will be deleted to keep only the latest N.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_path = log_dir / f"run_{timestamp}.log"

    # Delete older logs
    logs = sorted(log_dir.glob("run_*.log"), key=lambda p: p.stat().st_mtime)
    for old_log in logs[:-keep_last_n]:
        old_log.unlink()

    # Runtime guarantees
    assert sys.__stdout__ is not None
    assert sys.__stderr__ is not None

    tee = TeeStream(log_path, sys.__stdout__)
    sys.stdout = cast(TextIO, tee)
    sys.stderr = cast(TextIO, tee)

    return log_path
