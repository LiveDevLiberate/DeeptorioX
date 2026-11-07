import collections
from abc import ABC, abstractmethod
from pathlib import Path


class FactorioPathProvider(ABC):
    """
    Base class for all Factorio path providers.

    Each implementation must call the `_on_new_factorio_path` with a new path
    whenever the executable path is changed.
    """

    def __init__(self, on_new_factorio_path: collections.abc.Callable[[Path], None]):
        self._on_new_factorio_path = on_new_factorio_path

    @abstractmethod
    def start(self) -> None:
        """
        Starts the provider’s update mechanism.
        This can either run in a background thread or simply call the callback once.
        """
        pass

    @abstractmethod
    def stop(self) -> None:
        """
        Stops any internal polling or background thread if applicable.
        """
        pass
