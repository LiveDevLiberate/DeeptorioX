# src/map_string_provider/file_provider.py

import collections
import threading

from src.FactorioPreviewToolkit.map_string_provider.base import MapStringProvider
from src.FactorioPreviewToolkit.shared.config import Config
from src.FactorioPreviewToolkit.shared.structured_logger import log, log_section
from src.FactorioPreviewToolkit.shared.utils import is_valid_map_string


class FileMapStringProvider(MapStringProvider):
    """
    Monitors a file for changes to detect new map exchange strings.
    Calls the callback when a valid new one is found.
    """

    def __init__(self, on_new_map_string: collections.abc.Callable[[str], None]):
        """
        Initializes the file watcher with the configured path and polling interval.
        """
        super().__init__(on_new_map_string)
        self._filepath = Config.get().file_monitor_filepath
        self._poll_interval = Config.get().map_exchange_input_poll_interval_in_seconds
        self._last_map_string = ""
        self._stop_flag = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="FileMapStringMonitor",
            daemon=True,
        )

    def start(self) -> None:
        """
        Starts the file monitoring thread.
        """
        log.info(f"🟢 Starting FileMapStringProvider... (watching {self._filepath})")
        self._stop_flag.clear()
        self._thread.start()

    def stop(self) -> None:
        """
        Stops the monitoring thread and waits for it to finish.
        """
        with log_section("🛑 Stopping FileMapStringProvider..."):
            self._stop_flag.set()
            self._thread.join()
            log.info("✅ FileMapStringProvider stopped.")

    def _run(self) -> None:
        """
        Loop that watches the file and triggers callback on new valid map string.
        """
        with log_section(f"📋 Watching file for map exchange strings: {self._filepath}"):
            while not self._stop_flag.is_set():
                try:
                    if self._filepath.exists():
                        text = self._filepath.read_text(encoding="utf-8").strip()
                        if text and text != self._last_map_string and is_valid_map_string(text):
                            log.info("📍 New map exchange string detected in file.")
                            self._last_map_string = text
                            self._on_new_map_string(text)
                except Exception as e:
                    log.warning(f"⚠️ Failed to read file '{self._filepath}': {e}")

                self._stop_flag.wait(timeout=self._poll_interval)
