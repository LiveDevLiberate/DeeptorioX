import sys
from pathlib import Path
from threading import Lock, Thread

from src.FactorioPreviewToolkit.controller.single_process_executor import (
    SubprocessStatus,
    SingleProcessExecutor,
)
from src.FactorioPreviewToolkit.shared.sound import (
    play_failure_sound,
    play_success_sound,
    play_start_sound,
)
from src.FactorioPreviewToolkit.shared.structured_logger import log
from src.FactorioPreviewToolkit.shared.utils import get_script_base


class MapProcessingPipeline:
    """
    Runs the map generation and upload subprocesses for a given map string.

    Ensures only one job is active at a time. If a new job is triggered while another is running,
    the current one is canceled before starting the new one.
    """

    def __init__(self) -> None:
        self.generator_executor: SingleProcessExecutor | None = None
        self.uploader_executor: SingleProcessExecutor | None = None
        self._lock = Lock()
        self._worker_thread: Thread | None = None
        self._worker_ID = 0

    def run_async(self, factorio_path: Path, map_string: str) -> None:
        """
        Starts the pipeline in a background thread after stopping any existing job.
        """
        self._shutdown_existing_worker()
        with self._lock:
            self._prepare_executors(factorio_path, map_string)
            self._start_worker_thread()

    def _shutdown_existing_worker(self) -> None:
        """
        Stops any existing background job and ensures thread shutdown.
        """
        self._stop()
        if self._worker_thread is not None:
            self._worker_thread.join(timeout=1)
            if self._worker_thread.is_alive():
                log.error("❌ Worker thread did not terminate in time. Raising exception.")
                raise TimeoutError("Worker thread did not terminate within the expected time.")

    def _prepare_executors(self, factorio_path: Path, map_string: str) -> None:
        """
        Sets up the generator and uploader subprocess executors.
        """
        script_base = get_script_base()

        if getattr(sys, "frozen", False):
            # Frozen: use same EXE but route via flags
            self.generator_executor = SingleProcessExecutor(
                "Preview Generator",
                [sys.executable, "--preview-generator-mode", str(factorio_path), map_string],
            )
            self.uploader_executor = SingleProcessExecutor(
                "Uploader",
                [sys.executable, "--uploader-mode", str(factorio_path)],
            )
        else:
            # Dev: use `-m` style to run modules
            self.generator_executor = SingleProcessExecutor(
                "Preview Generator",
                [
                    "-m",
                    "src.FactorioPreviewToolkit.preview_generator",
                    str(factorio_path),
                    map_string,
                ],
            )
            self.uploader_executor = SingleProcessExecutor(
                "Uploader",
                ["-m", "src.FactorioPreviewToolkit.uploader", str(factorio_path)],
            )

    def _start_worker_thread(self) -> None:
        """
        Starts the worker thread to execute the pipeline.
        """
        thread_name = f"Worker-{self._worker_ID}"
        self._worker_ID += 1
        self._worker_thread = Thread(
            target=self._execute_pipeline,
            name=thread_name,
            daemon=True,
        )
        self._worker_thread.start()

    def _execute_pipeline(self) -> None:
        """
        Executes the preview generator and uploader sequentially.
        Aborts on failure or if stopped mid-execution.
        """
        with self._lock:
            play_start_sound()

            assert self.generator_executor is not None
            generator_status = self.generator_executor.run_subprocess()
            if generator_status == SubprocessStatus.KILLED:
                return
            if generator_status != SubprocessStatus.SUCCESS:
                play_failure_sound()
                return

            assert self.uploader_executor is not None
            upload_status = self.uploader_executor.run_subprocess()
            if upload_status == SubprocessStatus.KILLED:
                return
            if upload_status != SubprocessStatus.SUCCESS:
                play_failure_sound()
                return

            play_success_sound()

    def _stop(self) -> None:
        """
        Stops any currently running subprocesses and waits for the worker thread to finish.
        """
        if self.generator_executor and self.generator_executor.get_status() in [
            SubprocessStatus.RUNNING,
            SubprocessStatus.NOT_RUN,
        ]:
            self.generator_executor.stop()

        if self.uploader_executor and self.uploader_executor.get_status() in [
            SubprocessStatus.RUNNING,
            SubprocessStatus.NOT_RUN,
        ]:
            self.uploader_executor.stop()

        if self._worker_thread and self._worker_thread.is_alive():
            log.info("⚠️ Pipeline Aborted.")
