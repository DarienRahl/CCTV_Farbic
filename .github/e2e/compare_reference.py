"""CI reference renders: the game's picture next to the viewer's picture of the same camera, with a difference score.

usage: python3 compare_reference.py <game dir>/reference

Writes reference.png (game | viewer | difference) into the directory, prints the scores, a small JPEG of the
comparison as SHOT: lines (readable from the log without downloading artifacts) and adds both to the job summary.
"""
import base64
import io
import json
import os
import sys

from PIL import Image, ImageChops, ImageFilter

directory = sys.argv[1]
info = json.load(open(os.path.join(directory, "ready.json")))
game = Image.open(info["game"]).convert("RGB")
viewer = Image.open(os.path.join(directory, "viewer.png")).convert("RGB")
if viewer.size != game.size:
    viewer = viewer.resize(game.size, Image.BILINEAR)


def mean_difference(a, b):
    """Mean absolute difference of all channels, 0 (same) .. 100 (black against white)."""
    histogram = ImageChops.difference(a, b).histogram()
    total = sum(i % 256 * count for i, count in enumerate(histogram))
    return 100.0 * total / (255.0 * 3 * a.size[0] * a.size[1])


pixel = mean_difference(game, viewer)
# blurred at a quarter of the size: shapes and colours, less the texture pixels a small offset moves around
small = (game.size[0] // 4, game.size[1] // 4)
blur = lambda image: image.resize(small, Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.5))
coarse = mean_difference(blur(game), blur(viewer))
print(f"reference renders: pixel difference {pixel:.2f} %, coarse difference {coarse:.2f} %", flush=True)

difference = ImageChops.difference(game, viewer).point(lambda v: min(255, v * 3))
width, height = game.size
sheet = Image.new("RGB", (width * 3, height))
sheet.paste(game, (0, 0))
sheet.paste(viewer, (width, 0))
sheet.paste(difference, (width * 2, 0))
sheet.save(os.path.join(directory, "reference.png"))

jpeg = io.BytesIO()
sheet.resize((width * 3 // 2, height // 2)).save(jpeg, "JPEG", quality=70)
encoded = base64.b64encode(jpeg.getvalue()).decode()
for i in range(0, len(encoded), 4000):
    print("SHOT:reference:" + encoded[i:i + 4000])

summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as out:
        out.write("### Reference renders (game | viewer | difference)\n\n")
        out.write(f"Pixel difference **{pixel:.2f} %**, coarse difference **{coarse:.2f} %** "
                  "(the reference-renders artifact has the full pictures).\n")
