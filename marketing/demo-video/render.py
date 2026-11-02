#!/usr/bin/env python3
"""Render the 9:16 MiHome Mac demo from the captured storyboard frames."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
VOICE = BUILD / "voice"
FRAMES = BUILD / "frames"
CLIPS = BUILD / "clips"
OUTPUT = ROOT / "mihome-mac-demo-1080x1920.mp4"

FPS = 30
WIDTH = 1080
HEIGHT = 1920
XFADE = 0.50
VOICE_LEAD = 0.45
SCENE_TAIL = 1.0
FINAL_TAIL = 3.0


def run(command: list[str]) -> None:
    print("+", " ".join(command))
    subprocess.run(command, check=True)


def duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def main() -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe are required")

    missing = [
        str(path)
        for path in [
            *(FRAMES / f"scene-{index}.png" for index in range(1, 8)),
            *(VOICE / f"line-{index}.mp3" for index in range(1, 8)),
        ]
        if not path.exists()
    ]
    if missing:
        raise SystemExit("missing render inputs:\n" + "\n".join(missing))

    CLIPS.mkdir(parents=True, exist_ok=True)

    voice_durations = [duration(VOICE / f"line-{index}.mp3") for index in range(1, 8)]
    scene_durations = [
        value + (FINAL_TAIL if index == 6 else SCENE_TAIL)
        for index, value in enumerate(voice_durations)
    ]

    starts: list[float] = []
    cursor = 0.0
    for index, scene_duration in enumerate(scene_durations):
        if index:
            cursor -= XFADE
        starts.append(cursor)
        cursor += scene_duration

    total_duration = cursor
    print(f"voice total: {sum(voice_durations):.2f}s")
    print(f"video total: {total_duration:.2f}s")

    clips: list[Path] = []
    for index, scene_duration in enumerate(scene_durations, start=1):
        clip = CLIPS / f"scene-{index}.mp4"
        frames = max(2, round(scene_duration * FPS))
        zoom_end = 1.035 if index % 2 else 1.025
        video_filter = (
            f"scale={WIDTH}:{HEIGHT},"
            f"zoompan=z='1+({zoom_end - 1:.4f})*on/{frames - 1}':"
            "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d=1:s={WIDTH}x{HEIGHT}:fps={FPS},"
            "eq=contrast=1.012:saturation=1.025,format=yuv420p"
        )
        run(
            [
                "ffmpeg",
                "-y",
                "-loop",
                "1",
                "-framerate",
                str(FPS),
                "-i",
                str(FRAMES / f"scene-{index}.png"),
                "-t",
                f"{scene_duration:.3f}",
                "-vf",
                video_filter,
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(clip),
            ]
        )
        clips.append(clip)

    inputs: list[str] = []
    for clip in clips:
        inputs.extend(["-i", str(clip)])

    filter_parts: list[str] = []
    previous = "[0:v]"
    for index in range(1, len(clips)):
        output = f"[v{index:02d}]"
        filter_parts.append(
            f"{previous}[{index}:v]xfade=transition=fade:"
            f"duration={XFADE:.3f}:offset={starts[index] - XFADE:.3f}{output}"
        )
        previous = output
    filter_parts.append(f"{previous}format=yuv420p[vout]")

    voice_input_offset = len(clips)
    for index, voice_path in enumerate(
        VOICE / f"line-{index}.mp3" for index in range(1, 8)
    ):
        inputs.extend(["-i", str(voice_path)])
        input_index = voice_input_offset + index
        delay_ms = round((starts[index] + VOICE_LEAD) * 1000)
        filter_parts.append(
            f"[{input_index}:a]aresample=48000,"
            f"adelay={delay_ms}:all=1[a{index + 1:02d}]"
        )

    mixed_inputs = "".join(f"[a{index:02d}]" for index in range(1, 8))
    filter_parts.append(
        f"{mixed_inputs}amix=inputs=7:duration=longest:dropout_transition=0,"
        "volume=7,"
        "loudnorm=I=-16:TP=-1.5:LRA=11,"
        f"apad=whole_dur={total_duration:.3f},"
        f"atrim=0:{total_duration:.3f},"
        f"afade=t=out:st={max(0, total_duration - 0.8):.3f}:d=0.8[aout]"
    )

    run(
        [
            "ffmpeg",
            "-y",
            *inputs,
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[vout]",
            "-map",
            "[aout]",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-r",
            str(FPS),
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            "-shortest",
            str(OUTPUT),
        ]
    )

    print(f"rendered: {OUTPUT}")


if __name__ == "__main__":
    main()
