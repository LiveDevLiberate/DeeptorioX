# src/map_string_provider/clipboard_provider.py
import collections
import threading

import pyperclip

from src.FactorioPreviewToolkit.map_string_provider.base import MapStringProvider
from src.FactorioPreviewToolkit.shared.config import Config
from src.FactorioPreviewToolkit.shared.structured_logger import log, log_section
from src.FactorioPreviewToolkit.shared.utils import is_valid_map_string


class ClipboardMapStringProvider(MapStringProvider):
    """
    Watches the system clipboard for valid map exchange strings.
    Calls the callback when a new one is detected.
    """

    def __init__(
        self,
        on_new_map_string: collections.abc.Callable[[str], None],
    ):
        """
        Sets up the clipboard monitor and polling interval.
        """
        super().__init__(on_new_map_string)
        self._poll_interval = Config.get().map_exchange_input_poll_interval_in_seconds
        self._last_map_string = ""
        self._stop_flag = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="ClipboardMonitor",
            daemon=True,
        )

    def start(self) -> None:
        """
        Starts the clipboard monitoring thread.
        """
        log.info("🟢 Starting Clipboard Monitor...")
        self._stop_flag.clear()
        self._thread.start()

    def stop(self) -> None:
        """
        Stops the monitoring thread and waits for it to finish.
        """
        with log_section("🛑 Stopping Clipboard Monitor..."):
            self._stop_flag.set()
            self._thread.join()
            log.info("✅ Clipboard Monitor stopped.")

    def _run(self) -> None:
        """
        Loop that checks the clipboard for new map exchange strings.
        """
        with log_section("📋 Monitoring clipboard for new map exchange strings..."):
            while not self._stop_flag.is_set():
                try:
                    clipboard_text = pyperclip.paste().strip()
                    if clipboard_text != self._last_map_string and is_valid_map_string(
                        clipboard_text
                    ):
                        log.info("🎯 New map exchange string detected in clipboard.")
                        self._last_map_string = clipboard_text
                        self._on_new_map_string(clipboard_text)
                except Exception as e:
                    log.warning(f"⚠️ Failed to read clipboard: {e}")
                self._stop_flag.wait(timeout=self._poll_interval)
