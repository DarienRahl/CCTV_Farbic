#!/usr/bin/env python3
"""The README's pictures from the screenshots readme_shots.mjs took (screenshots workflow).

    python3 readme_images.py <shots folder> <docs/images/screenshots>

Labels are written in the game's font as the server builds it (minecraft-bold.ttf, downloaded with the shots),
with the game's text shadow on a translucent black box like the game's text background.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SHOTS = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
FONT = ImageFont.truetype(str(SHOTS / "minecraft-bold.ttf"), 32)
SMALL = ImageFont.truetype(str(SHOTS / "minecraft-bold.ttf"), 24)


def label(image, text, x, y, font=FONT, anchor="left"):
    """A label at (x, y); anchor "right" puts its right edge at x."""
    d = ImageDraw.Draw(image, "RGBA")
    size = font.size
    pixel = size // 8
    width = round(d.textlength(text, font=font))
    if anchor == "right":
        x -= width + 4 * pixel
    d.rectangle((x, y, x + width + 4 * pixel, y + size + 3 * pixel), fill=(0, 0, 0, 150))
    d.text((x + 2 * pixel + pixel, y + 2 * pixel + pixel), text, font=font, fill=(63, 63, 63, 255))
    d.text((x + 2 * pixel, y + 2 * pixel), text, font=font, fill=(255, 255, 255, 255))


def save(image, name, quality=88):
    image.convert("RGB").save(OUT / name, quality=quality, optimize=True, progressive=True)
    print("wrote", name, image.size)


def load(name):
    return Image.open(SHOTS / f"{name}.png").convert("RGB")


vanilla, shaders = load("vanilla"), load("shaders")
save(shaders, "hero.jpg")

# the game's look on the left, the shaders mode on the right
w, h = vanilla.size
split = vanilla.copy()
split.paste(shaders.crop((w // 2, 0, w, h)), (w // 2, 0))
ImageDraw.Draw(split).rectangle((w // 2 - 2, 0, w // 2 + 1, h), fill=(255, 255, 255))
label(split, "Vanilla", w // 2 - 24, h - 96, anchor="right")
label(split, "Shaders", w // 2 + 24, h - 96)
save(split, "vanilla-vs-shaders.jpg")

save(load("far"), "far.jpg")
save(load("underwater"), "underwater.jpg")

# every built-in post effect next to the plain picture
effects = json.loads((SHOTS / "effects.json").read_text())
# the effect's name without its description in brackets
tiles = [("Vanilla", load("vanilla"))] + [(name.split(" (")[0], load("effect-" + value.split(":", 1)[1])) for value, name in effects]
TW, TH, GAP, COLS = 480, 270, 6, 4
rows = (len(tiles) + COLS - 1) // COLS
grid = Image.new("RGB", (COLS * TW + (COLS + 1) * GAP, rows * TH + (rows + 1) * GAP), (22, 24, 28))
for k, (name, image) in enumerate(tiles):
    iw, ih = image.size
    # the same framing in every tile (the HUD corners cut a little)
    crop_h = iw * TH // TW
    top = max(0, (ih - crop_h) // 2)
    tile = image.crop((0, top, iw, top + crop_h)).resize((TW, TH), Image.LANCZOS)
    label(tile, name, 10, TH - 42, font=SMALL)
    grid.paste(tile, (GAP + (k % COLS) * (TW + GAP), GAP + (k // COLS) * (TH + GAP)))
save(grid, "effects.jpg", quality=86)

save(load("ui"), "ui.jpg")
save(load("list"), "list.jpg")
