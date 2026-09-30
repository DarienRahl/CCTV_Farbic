#!/usr/bin/env python3
"""What the README's video looks and sounds like, in the job's log: its streams, its loudness and a few
pictures as small JPEGs (SHOT:video-<second>:<base64> lines, like screenshot.mjs).

    python3 video_preview.py <video.mp4>
"""

import base64
import subprocess
import sys

VIDEO = sys.argv[1]
print(subprocess.run(["ffprobe", "-hide_banner", VIDEO], capture_output=True, text=True).stderr, flush=True)
loudness = subprocess.run(["ffmpeg", "-hide_banner", "-i", VIDEO, "-af", "volumedetect", "-f", "null", "-"],
                          capture_output=True, text=True).stderr
print("\n".join(line for line in loudness.splitlines() if "volume" in line), flush=True)
for second in (1, 3, 5, 6.5, 8, 10, 12, 13.5):
    jpeg = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(second), "-i", VIDEO, "-frames:v", "1",
                           "-vf", "scale=480:-2", "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "-"],
                          capture_output=True).stdout
    data = base64.b64encode(jpeg).decode()
    for i in range(0, len(data), 4000):
        print(f"SHOT:video-{second}:{data[i:i + 4000]}", flush=True)
