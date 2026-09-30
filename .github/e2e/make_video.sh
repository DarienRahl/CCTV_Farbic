#!/bin/bash
# The README's video from the slow-motion recording (record_showcase.mjs): sped up to real time, which brings the
# sounds back to their pitch (explosions kept below clipping), as an MP4 with sound and a lighter animated WebP
# without it for the top of the README.
#
#     make_video.sh <recording.webm> <speed> <out dir>
set -euo pipefail
RAW=$1
SPEED=$2
OUT=$3
mkdir -p "$OUT"
FACTOR=$(python3 -c "print(round(1 / $SPEED, 6))")
ffmpeg -hide_banner -loglevel warning -y -i "$RAW" -filter_complex \
  "[0:v]setpts=PTS*$SPEED,fps=30,scale=960:-2:flags=lanczos,format=yuv420p[v];[0:a]asetrate=48000*$FACTOR,aresample=48000,alimiter=limit=0.9[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 25 -movflags +faststart -c:a aac -b:a 160k "$OUT/showcase.mp4"
ffmpeg -hide_banner -loglevel warning -y -i "$OUT/showcase.mp4" -an \
  -vf "fps=10,scale=720:-2:flags=lanczos" -loop 0 -c:v libwebp_anim -quality 45 -compression_level 4 "$OUT/showcase.webp"
ls -l "$OUT"
