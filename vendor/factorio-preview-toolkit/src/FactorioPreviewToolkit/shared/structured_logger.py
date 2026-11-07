import logging
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from io import TextIOWrapper
from typing import TextIO


class NestingState(threading.local):
    """
    Thread-local state holder for managing logging indentation levels independently per thread.
    """

    level: int = 0


# Thread-local storage for nesting level (per thread)
_nesting = NestingState()


def get_logging_indent() -> str:
    """
    Returns the current indentation string based on nesting level.
    Ensures that each thread has its own independent level initialized.
    """
    return "   " * _nesting.level


@contextmanager
def log_section(title: str) -> Iterator[None]:
    """
    Context manager for logging a section with increased indentation.
    Restores indentation level after the block ends.
    """
    log.info(title)
    _nesting.level += 1
    try:
        yield
    finally:
        _nesting.level = max(0, _nesting.level - 1)


def set_logging_indent(level: int) -> None:
    """
    Sets the current thread's indentation level manually.
    """
    _nesting.level = max(0, level)


class IndentedFormatter(logging.Formatter):
    """
    Custom log formatter that adds process/thread metadata and supports indentation.
    """

    def format(self, record: logging.LogRecord) -> str:
        pid_part = f"PID:{record.process:>5}"
        thread_part = f"{record.threadName}"
        tag = f"[{pid_part}, {thread_part}]"
        level = f"{record.levelname:<5}"

        prefix = get_logging_indent()

        super().format(record)
        message = record.getMessage()

        formatted_msg = f"{record.asctime} {tag:<32} {level}: {message}"
        if prefix and record.levelno >= logging.INFO:
            return formatted_msg.replace(message, f"{prefix}{message}")
        return formatted_msg


def _ensure_utf8_output(stream: TextIO) -> TextIO:
    """
    Wraps a text stream with UTF-8 encoding if not already enforced.
    Handles environments where .buffer may not exist (e.g., PyInstaller).
    """
    try:
        encoding = stream.encoding or ""
    except Exception:
        encoding = ""

    if encoding.lower() != "utf-8":
        if hasattr(stream, "buffer"):
            return TextIOWrapper(stream.buffer, encoding="utf-8")
        else:
            # Can't fix encoding, fallback with warning
            print("⚠️ stdout/stderr encoding is not UTF-8 and can't be replaced safely.")
    return stream


def setup_logger() -> logging.Logger:
    """
    Sets up the structured logger with custom formatting and UTF-8 stdout handling.
    """
    sys.stdout = _ensure_utf8_output(sys.stdout)
    sys.stderr = _ensure_utf8_output(sys.stderr)

    formatter = IndentedFormatter(
        "%(asctime)s [PID:%(process)d, %(threadName)s] %(levelname)s: %(message)s"
    )

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)

    logger = logging.getLogger("structured_logger")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.addHandler(stream_handler)
    logger.propagate = False
    return logger


log = setup_logger()
