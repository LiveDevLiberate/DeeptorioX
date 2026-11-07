import subprocess
from pathlib import Path

from src.FactorioPreviewToolkit.shared.config import Config
from src.FactorioPreviewToolkit.shared.structured_logger import log, log_section
from src.FactorioPreviewToolkit.uploader.base_uploader import BaseUploader


def _is_rclone_configured(remote_name: str) -> bool:
    """
    Checks whether the given rclone remote is already configured.
    """
    rclone_executable = Config.get().rclone_executable
    result = subprocess.run([rclone_executable, "listremotes"], capture_output=True, text=True)
    remotes = result.stdout.strip().splitlines()
    return any(remote_name + ":" == remote for remote in remotes)


def _open_rclone_config() -> None:
    """
    Launches the interactive rclone config tool.
    """
    rclone_executable = Config.get().rclone_executable
    log.info("🔧 Opening rclone config interface...")

    try:
        subprocess.run([rclone_executable, "config"], check=True)
    except subprocess.CalledProcessError as e:
        log.error("❌ Failed to launch rclone config.")
        log.error(f"stdout:\n{e.stdout}")
        log.error(f"stderr:\n{e.stderr}")
        raise


class RcloneUploader(BaseUploader):
    """
    Rclone-based uploader implementation that copies images to a remote and returns shareable links.
    """

    def upload_single(self, local_path: Path, remote_filename: str) -> str:
        """
        Uploads a single file using rclone and returns a shareable link.
        Prompts the user to configure the remote if it's missing.
        """
        config = Config.get()
        rclone_executable = Config.get().rclone_executable
        remote_name = config.rclone_remote_service
        remote_folder = config.rclone_remote_upload_dir
        remote_target = f"{remote_name}:{remote_folder}"
        full_remote_path = f"{remote_target}/{remote_filename}"

        if not _is_rclone_configured(remote_name):
            log.warning(f"⚠️ Rclone remote '{remote_name}' is not configured.")
            _open_rclone_config()
            raise RuntimeError(
                f"Rclone remote '{remote_name}' was not configured. Run 'rclone config' and restart the application"
            )

        with log_section(f"☁️ Uploading {local_path.name} to {remote_target}..."):
            try:
                result = subprocess.run(
                    [rclone_executable, "copy", str(local_path), remote_target],
                    check=True,
                    capture_output=True,
                    text=True,
                )

                # Filter out known harmless notices
                for line in result.stderr.splitlines():
                    if "Forced to upload files to set modification times" not in line:
                        log.info(line)

                log.info("✅ Upload complete.")
            except subprocess.CalledProcessError as e:
                log.error("❌ Upload failed.")
                log.error(f"stdout:\n{e.stdout}")
                log.error(f"stderr:\n{e.stderr}")
                raise

        with log_section("🌐 Generating shareable link..."):
            try:
                result = subprocess.run(
                    [rclone_executable, "link", full_remote_path],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                share_url = result.stdout.strip()

                # Handle Dropbox
                if "dropbox.com" in share_url:
                    # Force raw preview link
                    share_url = share_url.replace("www.dropbox.com", "dl.dropboxusercontent.com")
                    share_url = share_url.replace("&dl=0", "")
                    share_url = share_url.replace("&dl=1", "")

                log.info(f"🔗 Shareable URL: {share_url}")
                return share_url
            except subprocess.CalledProcessError as e:
                log.error("❌ Failed to generate shareable link.")
                log.error(f"stdout:\n{e.stdout}")
                log.error(f"stderr:\n{e.stderr}")
                raise
