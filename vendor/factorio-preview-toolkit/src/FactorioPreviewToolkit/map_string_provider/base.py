import collections
from abc import ABC, abstractmethod


class MapStringProvider(ABC):
    """
    Abstract base class for map string providers.
    Implementations must handle their own detection logic and call the callback
    when a valid map exchange string is detected.
    """

    def __init__(self, on_new_map_string: collections.abc.Callable[[str], None]):
        self._on_new_map_string = on_new_map_string

    @abstractmethod
    def start(self) -> None:
        """Start the map string monitoring (threaded or otherwise)."""
        pass

    @abstractmethod
    def stop(self) -> None:
        """Stop the monitoring and clean up if needed."""
        pass
