import os
import subprocess
import sys
from enum import Enum, auto
from threading import Lock

from src.FactorioPreviewToolkit.shared.structured_logger import log


class SubprocessStatus(Enum):
    """
    Represents the execution state of a subprocess.
    """

    NOT_RUN = auto()
    SUCCESS = auto()
    FAILED = auto()
    KILLED = auto()
    RUNNING = auto()


class SingleProcessExecutor:
    """
    Manages a single subprocess with safe lifecycle control and live output streaming.

    Ensures that only one instance of a subprocess is running, and supports interruption,
    status reporting, and synchronized execution.
    """

    def __init__(self, process_name: str, args: list[str]):
        """
        Initializes the executor with a name and subprocess arguments.
        """
        self._process_name = process_name
        self._args = args
        self._active_process: subprocess.Popen[str] | None = None
        self._status = SubprocessStatus.NOT_RUN
        self._lock = Lock()

    def run_subprocess(self) -> SubprocessStatus:
        """
        Launches the subprocess and streams its output to the console.
        Sets the execution status based on completion or failure.
        """
        if not self._prepare_subprocess():
            return self._status
        self._stream_output()
        return self._finalize_status()

    def _prepare_subprocess(self) -> bool:
        """
        Starts the subprocess and updates its status if not already running.
        """
        with self._lock:
            if self._status != SubprocessStatus.NOT_RUN:
                return False

            log.info(f"🟢 Launching {self._process_name} subprocess with args: {self._args}...")
            self._active_process = subprocess.Popen(
                [sys.executable, "-u"] + self._args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
            self._status = SubprocessStatus.RUNNING
            return True

    def _stream_output(self) -> None:
        """
        Streams the subprocess output to the console.
        """
        assert self._active_process is not None
        try:
            if self._active_process.stdout:
                for line in self._active_process.stdout:
                    print(line, end="")
        except Exception:
            self._status = SubprocessStatus.FAILED
            log.error(f"❌ Failed to read {self._process_name} output.")
            raise

    def _finalize_status(self) -> SubprocessStatus:
        """
        Waits for process to exit and sets final status accordingly.
        """
        assert self._active_process is not None
        exit_code = self._active_process.wait()

        with self._lock:
            if self._status == SubprocessStatus.KILLED:
                log.info(f"⚠️ {self._process_name} was killed externally.")
            elif exit_code == 0:
                self._status = SubprocessStatus.SUCCESS
            else:
                self._status = SubprocessStatus.FAILED

            return self._status

    def stop(self) -> bool:
        """
        Terminates the subprocess if running. Returns True if a process was stopped.
        """
        with self._lock:
            if self._active_process is None or self._status not in [
                SubprocessStatus.RUNNING,
                SubprocessStatus.NOT_RUN,
            ]:
                log.info(f"⚠️ No active process to stop for {self._process_name}.")
                return False

            log.info(f"🛑 Stopping {self._process_name} subprocess...")
            self._active_process.kill()
            self._status = SubprocessStatus.KILLED
            log.info(f"✅ {self._process_name} subprocess killed.")
            return True

    def get_status(self) -> SubprocessStatus:
        """
        Returns the current status of the subprocess.
        """
        return self._status
