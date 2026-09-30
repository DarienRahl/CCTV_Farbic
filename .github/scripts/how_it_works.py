"""The "How it works" picture on the README page, in the style of Minecraft like the roadmap's (roadmap.py draws
it with the rest: python3 .github/scripts/roadmap.py). Original pixel art, no game textures.

Each step is a stone button with an item slot, the way from the server's world to the browser's picture runs
down the arrows between them.
"""

import random

from roadmap import GLYPHS, REPLACE, Svg, background, button, camera, chest, grass_block, outlined, slot, text_width

WIDTH = 880
ROW = 96
GAP = 40
TOP = 96


def monitor():
    """A screen showing a hill under the sky, on a stand."""
    grid = {}
    rnd = random.Random(5)
    for y in range(1, 12):
        for x in range(0, 16):
            if y in (1, 11) or x in (0, 15):
                grid[(x, y)] = "#2c2c2c"
            else:
                hill = 7 + (1 if x in (3, 4, 10, 11) else 0) - (1 if x in (6, 7, 8) else 0)
                grid[(x, y)] = ("#7fb2f0" if y < hill else rnd.choice(["#5d9b37", "#6aa84f", "#4f8a2e"]))
    grid[(11, 3)] = grid[(12, 3)] = grid[(11, 4)] = grid[(12, 4)] = "#ffe066"
    for y in range(12, 14):
        for x in range(7, 9):
            grid[(x, y)] = "#5a5a5a"
    for x in range(4, 12):
        grid[(x, 14)] = "#4a4a4a"
    return outlined(grid, "#101010")


def redstone():
    """A redstone torch: the camera session that powers the stream."""
    grid = {}
    for y in range(6, 16):
        grid[(7, y)] = "#6b4c22"
        grid[(8, y)] = "#896727"
    for y in range(2, 6):
        for x in range(6, 10):
            grid[(x, y)] = "#ff2a2a" if (x + y) % 2 else "#b30000"
    grid[(7, 1)] = grid[(8, 1)] = "#ff7070"
    return outlined(grid, "#2a0505")


STEPS = [
    (grass_block, "the minecraft server", "reads loaded chunks and region files - no gpu, no bot"),
    (redstone, "a camera session", "blocks, light, mobs, weather, sounds in the camera's view"),
    (monitor, "your browser", "web workers mesh the blocks, webgl2 draws it like the game"),
    (chest, "client.jar + resource packs", "textures, models, sounds and the font, read by the server"),
]
# (from step, to step, label): the arrows between the buttons
LINKS = [
    (0, 1, "only the sections the camera sees"),
    (1, 2, "server-sent events - 20x a second"),
    (3, 2, "http, cached in the browser"),
]


def arrow(svg, x, y, length, up=False):
    """A pixel arrow: a two-pixel shaft and a stepped head, white with the game's text shadow."""
    for color, dx in (("#3f3f3f", 4), ("#ffffff", 0)):
        shaft_y = y + (12 if up else 0)
        svg.rect(x - 4 + dx, shaft_y + dx, 8, length - 12, color)
        for i in range(4):
            w = 8 + (3 - i) * 8
            head_y = y + i * 3 if up else y + length - 12 + i * 3
            if up:
                w = 8 + i * 8
            svg.rect(x - w // 2 + dx, head_y + dx, w, 3, color)


def svg():
    height = TOP + len(STEPS) * ROW + (len(STEPS) - 1) * GAP + 24
    out = Svg(WIDTH, height, "How CCTV works: the server reads the world, a camera session streams its view, "
                             "the browser draws it like the game with assets from client.jar")
    background(out)
    title = "how it works"
    tw = text_width(title, 5)
    out.text(title, (WIDTH - tw) // 2 + 40, 28, 5, "#ffffff", shadow="#3f3f3f")
    out.pixels(camera(), (WIDTH - tw) // 2 - 44, 20, 3)
    tops = [TOP + i * (ROW + GAP) for i in range(len(STEPS))]
    for (icon, name, detail), top in zip(STEPS, tops):
        button(out, 8, top, WIDTH - 16, ROW - 16)
        slot(out, 22, top + 10, icon())
        out.text(name, 100, top + 14, 3, "#ffffff", shadow="#3f3f3f")
        assert 100 + text_width(detail, 2) < WIDTH - 24, detail
        out.text(detail, 100, top + 50, 2, "#e0e0e0", shadow="#3f3f3f")
    for start, end, label in LINKS:
        up = end < start
        y0 = tops[min(start, end)] + ROW - 16
        length = tops[max(start, end)] - y0
        arrow(out, 52, y0, length, up=up)
        out.text(label, 80, y0 + length // 2 - 7, 2, "#ffff55", shadow="#3f3f15")
    return out.render()


# the glyphs the picture needs must be in the pixel font
for _, name, detail in STEPS:
    for ch in (name + detail).upper():
        assert REPLACE.get(ch, ch) in GLYPHS, ch
