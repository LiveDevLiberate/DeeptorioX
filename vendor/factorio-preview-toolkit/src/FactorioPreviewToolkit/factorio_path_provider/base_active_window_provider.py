import collections
import threading
from abc import abstractmethod
from pathlib import Path

from src.FactorioPreviewToolkit.factorio_path_provider.base import FactorioPathProvider
from src.FactorioPreviewToolkit.shared.config import Config
from src.FactorioPreviewToolkit.shared.structured_logger import log, log_section


class BaseActiveWindowProvider(FactorioPathProvider):
    """
    Abstract base class
    Continuously monitors the active window to detect if a Factorio instance is running.

    When a new Factorio window is detected, its executable path is passed to a callback.
    This is an abstract base class—platform-specific logic must implement the detection.
    """

    def __init__(self, on_new_factorio_path: collections.abc.Callable[[Path], None]):
        super().__init__(on_new_factorio_path)
        self._current_path: Path | None = None
        self._poll_interval = Config.get().factorio_locator_poll_interval_in_seconds
        self._stop_flag = threading.Event()
        self._thread = threading.Thread(target=self._run, name="ActiveWindowWatcher", daemon=True)

    def start(self) -> None:
        """Starts the background thread for monitoring the active window."""
        log.info(
            f"🟢 Starting Active Window Provider monitoring with a poll interval of {self._poll_interval} seconds..."
        )
        self._stop_flag.clear()
        self._thread.start()

    def stop(self) -> None:
        """Stops the background thread monitoring the active window."""
        with log_section("🛑 Stopping Active Window Provider monitoring..."):
            self._stop_flag.set()
            log.info("✅ Active Window Provider monitoring stopped.")

    def _run(self) -> None:
        """Periodically checks for a new active Factorio window and emits updates."""
        with log_section("🪟 Monitoring active windows for Factorio instances..."):
            while not self._stop_flag.is_set():
                factorio_path = self.get_factorio_executable_path()
                if factorio_path and self._current_path != factorio_path:
                    log.info(f"🎯 Detected new Factorio window.")
                    self._current_path = factorio_path
                    self._on_new_factorio_path(factorio_path)
                self._stop_flag.wait(self._poll_interval)

    @abstractmethod
    def get_factorio_executable_path(self) -> Path | None:
        """
        Returns the path to the Factorio executable for the currently focused window.

        Must be implemented by platform-specific subclasses.
        """
        pass
