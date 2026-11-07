import collections
from pathlib import Path

from src.FactorioPreviewToolkit.factorio_path_provider.base import FactorioPathProvider
from src.FactorioPreviewToolkit.shared.config import Config
from src.FactorioPreviewToolkit.shared.structured_logger import log


class FixedPathProvider(FactorioPathProvider):
    """
    Factorio path provider that uses a fixed executable path from the config.
    """

    def __init__(self, on_new_factorio_path: collections.abc.Callable[[Path], None]):
        """
        Initializes the provider with the callback for new Factorio paths.
        """
        super().__init__(on_new_factorio_path)

    def start(self) -> None:
        """
        Loads the fixed Factorio path and invokes the callback.
        """
        config = Config.get()
        fixed_path = config.fixed_path_factorio_executable
        log.info(f"📌 Using fixed Factorio path: {fixed_path}")
        self._on_new_factorio_path(fixed_path)

    def stop(self) -> None:
        """
        Cleans up after the provider if needed.
        """
        log.info("✅ FixedPathProvider does not require cleanup.")
