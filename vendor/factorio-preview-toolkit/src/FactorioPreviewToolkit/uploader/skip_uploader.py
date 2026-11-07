from pathlib import Path

from src.FactorioPreviewToolkit.shared.structured_logger import log
from src.FactorioPreviewToolkit.uploader.base_uploader import BaseUploader


class SkipUploader(BaseUploader):
    """
    Dummy uploader that skips uploading but logs the action.
    Useful when upload_method is set to 'skip' in the config.
    """

    def upload_single(self, local_path: Path, remote_filename: str) -> str:
        log.info(f"⏩ Skipping upload for '{local_path.name}' (upload method is set to 'skip').")
        return f"(skipped upload for {local_path.name})"
