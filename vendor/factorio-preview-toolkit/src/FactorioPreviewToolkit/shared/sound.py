import contextlib
import os
from pathlib import Path

from src.FactorioPreviewToolkit.shared.structured_logger import log

# Suppress stdout and stderr while importing and initializing pygame
with (
    open(os.devnull, "w") as devnull,
    contextlib.redirect_stdout(devnull),
    contextlib.redirect_stderr(devnull),
):
    import pygame

    pygame.mixer.init()

from src.FactorioPreviewToolkit.shared.config import Config


def _play_sound(path: Path, volume: float = 0.5) -> None:
    """
    Plays a sound file using pygame with the given volume.
    Blocks until playback is done.
    """
    try:
        pygame.mixer.music.load(str(path))
        pygame.mixer.music.set_volume(volume)
        pygame.mixer.music.play()
        while pygame.mixer.music.get_busy():
            pygame.time.wait(100)
    except Exception:
        log.warning(f"⚠️ Failed to play sound")
        raise


def play_start_sound() -> None:
    """
    Plays the configured 'start' sound.
    """
    config = Config.get()
    _play_sound(config.sound_start_filepath, config.start_sound_volume)


def play_success_sound() -> None:
    """
    Plays the configured 'success' sound.
    """
    config = Config.get()
    _play_sound(config.sound_success_filepath, config.success_sound_volume)


def play_failure_sound() -> None:
    """
    Plays the configured 'failure' sound.
    """
    config = Config.get()
    _play_sound(config.sound_failure_filepath, config.failure_sound_volume)
