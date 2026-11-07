#!/usr/bin/env python3
"""Narrate autorio decisions and STATE plan updates with edge-tts.

Every --interval seconds it speaks the newest decision-like digest line that
appeared since the previous narration. New ``STATE.md updated: ...`` activity
lines are spoken as soon as they appear.

Default voices are young female Edge voices:
  Chinese: zh-CN-XiaoxiaoNeural
  English: en-US-AvaNeural
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ZH_VOICE = "zh-CN-XiaoxiaoNeural"
DEFAULT_EN_VOICE = "en-US-AvaNeural"
CJK = re.compile(r"[\u3400-\u9fff]")
STATE_LINE = re.compile(r"STATE\.md updated:\s*(.*?)\s*\(revision\s+\d+\)")


def clean_text(text: str, limit: int = 280) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def choose_voice(text: str, zh_voice: str, en_voice: str) -> str:
    return zh_voice if CJK.search(text) else en_voice


class Tail:
    def __init__(self, path: Path, from_start: bool = False):
        self.path = path
        self.offset = 0 if from_start else self._size()
        self.buffer = b""

    def _size(self) -> int:
        try:
            return self.path.stat().st_size
        except OSError:
            return 0

    def read_lines(self) -> list[str]:
        try:
            size = self.path.stat().st_size
        except OSError:
            return []
        if size < self.offset:
            self.offset = 0
            self.buffer = b""
        if size == self.offset:
            return []
        try:
            with self.path.open("rb") as handle:
                handle.seek(self.offset)
                chunk = handle.read(size - self.offset)
        except OSError:
            return []
        self.offset = size
        data = self.buffer + chunk
        lines = data.split(b"\n")
        self.buffer = lines.pop()
        return [line.decode("utf-8", "replace").rstrip("\r") for line in lines if line]


def resolve_run_dir(args: argparse.Namespace) -> Path:
    if args.run_dir:
        return Path(args.run_dir)
    base = Path(args.root) / ".autorio" / "runs"
    if args.run_id:
        return base / args.run_id
    runs = [entry for entry in base.iterdir() if entry.is_dir()] if base.exists() else []
    if not runs:
        raise SystemExit(f"no runs found under {base}")
    return max(runs, key=lambda entry: entry.stat().st_mtime)


def play_mp3(path: Path) -> None:
    if sys.platform == "win32":
        media = str(path).replace("'", "''")
        script = (
            "Add-Type -AssemblyName PresentationCore; "
            f"$p=New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'{media}'); "
            "Start-Sleep -Milliseconds 350; "
            "$d=0; if($p.NaturalDuration.HasTimeSpan){$d=$p.NaturalDuration.TimeSpan.TotalSeconds}; "
            "$p.Play(); Start-Sleep -Seconds ([Math]::Min(60,[Math]::Max(1,$d+0.4))); $p.Close()"
        )
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        subprocess.run(
            ["powershell", "-NoProfile", "-EncodedCommand", encoded],
            check=False,
            timeout=70,
        )
        return
    for player in (["afplay"], ["mpv", "--no-video", "--really-quiet"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]):
        try:
            subprocess.run([*player, str(path)], check=False, timeout=70)
            return
        except FileNotFoundError:
            continue


def speak(text: str, voice: str, dry_run: bool, no_play: bool) -> None:
    text = clean_text(text)
    if not text:
        return
    print(f"[narrate] {voice}: {text}", flush=True)
    if dry_run:
        return
    try:
        import edge_tts
    except ImportError as error:
        raise SystemExit(
            "edge-tts is not installed; run `python -m pip install edge-tts`"
        ) from error
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as handle:
        audio_path = Path(handle.name)
    try:
        asyncio.run(edge_tts.Communicate(text, voice).save(str(audio_path)))
        if not no_play:
            play_mp3(audio_path)
    finally:
        audio_path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="edge-tts narration for autorio")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--run-dir")
    parser.add_argument("--run-id")
    parser.add_argument("--interval", type=float, default=300.0)
    parser.add_argument("--voice-zh", default=DEFAULT_ZH_VOICE)
    parser.add_argument("--voice-en", default=DEFAULT_EN_VOICE)
    parser.add_argument("--min-chars", type=int, default=10)
    parser.add_argument("--from-start", action="store_true")
    parser.add_argument("--once", action="store_true", help="speak one pending item, then exit")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-play", action="store_true", help="synthesize but do not play audio")
    args = parser.parse_args(argv)
    run_dir = resolve_run_dir(args)
    digest = Tail(run_dir / "thoughts.digest.log", args.from_start)
    activity = Tail(run_dir / "activity.log", args.from_start)
    print(f"[narrate] run={run_dir.name} interval={args.interval:.0f}s", flush=True)
    next_decision = time.monotonic() + max(1.0, args.interval)
    pending_decision = ""
    pending_state = ""
    while True:
        for line in digest.read_lines():
            text = clean_text(line)
            if len(text) >= args.min_chars and not text.startswith(("{", "[", "/sc")):
                pending_decision = text
        for line in activity.read_lines():
            match = STATE_LINE.search(line)
            if match:
                pending_state = clean_text(match.group(1))
        if pending_state:
            text = f"计划更新：{pending_state}"
            pending_state = ""
            speak(text, choose_voice(text, args.voice_zh, args.voice_en), args.dry_run, args.no_play)
            if args.once:
                return 0
        now = time.monotonic()
        if now >= next_decision:
            if pending_decision:
                text = pending_decision
                pending_decision = ""
                speak(text, choose_voice(text, args.voice_zh, args.voice_en), args.dry_run, args.no_play)
                if args.once:
                    return 0
            next_decision = now + max(1.0, args.interval)
        time.sleep(1.0)


if __name__ == "__main__":
    raise SystemExit(main())
