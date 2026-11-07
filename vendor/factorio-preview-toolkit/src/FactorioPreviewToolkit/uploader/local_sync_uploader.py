import shutil
from pathlib import Path

from src.FactorioPreviewToolkit.shared.config import Config
from src.FactorioPreviewToolkit.shared.structured_logger import log, log_section
from src.FactorioPreviewToolkit.uploader.base_uploader import BaseUploader


class LocalSyncUploader(BaseUploader):
    """
    Uploader that copies preview files to a local sync folder (e.g., OneDrive, Dropbox client folder).
    Returns a static shareable URL based on config.
    """

    def upload_single(self, local_path: Path, remote_filename: str) -> str:
        """
        Copies a file to the configured sync folder and returns the static public URL.
        """
        target_folder = Config.get().local_sync_target_dir
        destination_path = target_folder / remote_filename

        with log_section(f"📤 Copying {local_path.name} to local sync folder: {target_folder}"):
            try:
                shutil.copy2(local_path, destination_path)
                log.info(f"✅ File copied to: {destination_path}")
            except Exception as e:
                log.error(f"❌ Failed to copy file: {e}")
                raise
        log.info(f"🔗 The public URL must be set manually with this upload method.")
        return "The public URL must be set manually with this upload method."
