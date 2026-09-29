#!/usr/bin/env python3
"""The roadmap on the README page, in the style of Minecraft, generated from docs/ROADMAP.md.

Draws original pixel art (no game textures are used): a dark dirt background like the game's option
screens, stone buttons, inventory slots with item icons, experience bars and a pixel font. The
pictures go to docs/images/roadmap/*.svg; the milestone lists and the badges are written between
the markers in README.md.

    python3 .github/scripts/roadmap.py          # regenerate after editing docs/ROADMAP.md
    python3 .github/scripts/roadmap.py --check  # exit 1 when README.md or a picture is out of date
"""

import math
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROADMAP = ROOT / "docs" / "ROADMAP.md"
README = ROOT / "README.md"
GRADLE = ROOT / "gradle.properties"
IMAGES = ROOT / "docs" / "images" / "roadmap"
IMAGE_URL = "docs/images/roadmap"
REPO = "DarienRahl/CCTV_Farbic"

WIDTH = 880

# --- pixel font: 7 rows per glyph, "#" is a pixel; the width of a glyph is the length of its rows ---

GLYPHS = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "####.", "#...#", "#...#", "#...#", "####."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "###..", "#....", "#....", "#....", "#####"],
    "F": ["#####", "#....", "###..", "#....", "#....", "#....", "#...."],
    "G": [".####", "#....", "#..##", "#...#", "#...#", "#...#", ".####"],
    "H": ["#...#", "#...#", "#####", "#...#", "#...#", "#...#", "#...#"],
    "I": ["###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
    "J": ["....#", "....#", "....#", "....#", "....#", "#...#", ".###."],
    "K": ["#...#", "#..#.", "###..", "#..#.", "#...#", "#...#", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "P": ["####.", "#...#", "####.", "#....", "#....", "#....", "#...."],
    "Q": [".###.", "#...#", "#...#", "#...#", "#...#", "#..#.", ".##.#"],
    "R": ["####.", "#...#", "####.", "#...#", "#...#", "#...#", "#...#"],
    "S": [".####", "#....", ".###.", "....#", "....#", "#...#", ".###."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", ".#.#.", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#...#", "#.#.#", "##.##", "#...#"],
    "X": ["#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#", "#...#"],
    "Y": ["#...#", ".#.#.", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", "#####"],
    "2": [".###.", "#...#", "....#", "..##.", ".#...", "#...#", "#####"],
    "3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
    "4": ["...##", "..#.#", ".#..#", "#...#", "#####", "....#", "....#"],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
    "7": ["#####", "#...#", "....#", "...#.", "..#..", "..#..", "..#.."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
    ".": [".", ".", ".", ".", ".", ".", "#"],
    ",": [".", ".", ".", ".", ".", "#", "#"],
    ":": [".", "#", ".", ".", ".", "#", "."],
    "!": ["#", "#", "#", "#", "#", ".", "#"],
    "'": ["#", "#", ".", ".", ".", ".", "."],
    "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
    "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
    "(": ["..##", ".#..", "#...", "#...", "#...", ".#..", "..##"],
    ")": ["##..", "..#.", "...#", "...#", "...#", "..#.", "##.."],
    "%": ["#...#", "#..#.", "...#.", "..#..", ".#...", ".#..#", "#...#"],
    "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
    " ": ["...", "...", "...", "...", "...", "...", "..."],
}
REPLACE = {"—": "-", "–": "-", "·": "-", "×": "X"}


def text_width(text, scale):
    width = 0
    for ch in text.upper():
        glyph = GLYPHS.get(REPLACE.get(ch, ch), GLYPHS["?"])
        width += (len(glyph[0]) + 1) * scale
    return max(0, width - scale)


class Svg:
    def __init__(self, width, height, title):
        self.width, self.height, self.title = width, height, title
        self.defs = []
        self.parts = []

    def rect(self, x, y, w, h, fill, opacity=None, out=None):
        extra = f' fill-opacity="{opacity}"' if opacity is not None else ""
        (self.parts if out is None else out).append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"{extra}/>')

    @staticmethod
    def paths(runs, out):
        """Pixel runs [(x, y, w, h, colour)] as one path per colour (much smaller than one rect each)."""
        by_color = {}
        for x, y, w, h, color in runs:
            by_color.setdefault(color, []).append(f"M{x} {y}h{w}v{h}h-{w}z")
        for color, d in by_color.items():
            out.append(f'<path fill="{color}" d="{"".join(d)}"/>')

    def pixels(self, grid, x, y, scale, out=None):
        """Draws {(px, py): colour}, one run per horizontal stretch of a colour."""
        runs = []
        for py in range(16):
            px = 0
            while px < 16:
                color = grid.get((px, py))
                if color is None:
                    px += 1
                    continue
                run = px
                while run < 16 and grid.get((run, py)) == color:
                    run += 1
                runs.append((x + px * scale, y + py * scale, (run - px) * scale, scale, color))
                px = run
        self.paths(runs, self.parts if out is None else out)

    def text(self, text, x, y, scale, color, shadow=None, outline=None, out=None):
        """The pixel font; shadow: a darker copy one font pixel down and right like the game's text."""
        if outline:
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                self.text(text, x + dx * scale, y + dy * scale, scale, outline, out=out)
        if shadow:
            self.text(text, x + scale, y + scale, scale, shadow, out=out)
        runs = []
        cx = x
        for ch in text.upper():
            glyph = GLYPHS.get(REPLACE.get(ch, ch), GLYPHS["?"])
            for row, line in enumerate(glyph):
                col = 0
                while col < len(line):
                    if line[col] != "#":
                        col += 1
                        continue
                    run = col
                    while run < len(line) and line[run] == "#":
                        run += 1
                    runs.append((cx + col * scale, y + row * scale, (run - col) * scale, scale, color))
                    col = run
            cx += (len(glyph[0]) + 1) * scale
        self.paths(runs, self.parts if out is None else out)

    def pattern(self, name, grid, scale):
        tile = []
        self.pixels(grid, 0, 0, scale, out=tile)
        size = 16 * scale
        self.defs.append(f'<pattern id="{name}" width="{size}" height="{size}" patternUnits="userSpaceOnUse">'
                         + "".join(tile) + "</pattern>")

    def render(self):
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" '
                f'viewBox="0 0 {self.width} {self.height}" shape-rendering="crispEdges" role="img">\n'
                f"<title>{self.title}</title>\n")
        defs = "<defs>\n" + "\n".join(self.defs) + "\n</defs>\n" if self.defs else ""
        return head + defs + "\n".join(self.parts) + "\n</svg>\n"


# --- textures and item icons (16x16, drawn here) ---

def noise(seed, colors, weights=None):
    rnd = random.Random(seed)
    return {(x, y): rnd.choices(colors, weights)[0] for y in range(16) for x in range(16)}


DIRT = noise(3, ["#3a2a1d", "#453325", "#2f2217", "#4f3b2b", "#5a4533"], [5, 5, 3, 3, 1])
STONE = noise(7, ["#6f6f6f", "#737373", "#6a6a6a", "#7b7b7b", "#646464"], [6, 4, 4, 2, 2])


def outlined(grid, color):
    out = dict(grid)
    for (x, y) in grid:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if n not in grid and 0 <= n[0] < 16 and 0 <= n[1] < 16:
                out.setdefault(n, color)
    return out


def grass_block():
    rnd = random.Random(11)
    depth = [4, 3, 4, 5, 3, 4, 6, 4, 3, 5, 4, 3, 4, 5, 4, 3]
    greens, dirts = ["#5d9b37", "#6aa84f", "#4f8a2e", "#78b85a"], ["#866043", "#79553a", "#96704d", "#6b4a31", "#9c7a57"]
    return {(x, y): rnd.choice(greens if y < depth[x] else dirts) for y in range(16) for x in range(16)}


def pickaxe():
    grid = {}
    for x in range(1, 10):
        grid[(x, 15 - x)] = "#896727" if x % 2 else "#6b4c22"
        grid[(x + 1, 15 - x)] = "#4a3316"
    for y in range(16):
        for x in range(4, 16):
            d = ((x + 0.5 - 1.5) ** 2 + (y + 0.5 - 14.5) ** 2) ** 0.5
            if 11.0 <= d <= 13.2 and y <= 11:
                grid[(x, y)] = "#33ebcb" if d < 11.7 else "#a1fbe8" if d < 12.4 else "#1fa99a"
    return outlined(grid, "#0f2622")


def painting():
    grid = {}
    for y in range(1, 15):
        for x in range(1, 15):
            if x in (1, 14) or y in (1, 14):
                grid[(x, y)] = "#5a3a1e"
            elif x in (2, 13) or y in (2, 13):
                grid[(x, y)] = "#9a6a35"
            else:
                hill = 9 + round(1.6 * math.sin(x * 0.9))
                grid[(x, y)] = "#6ba4e8" if y < hill else "#4e9a3a" if y < hill + 2 else "#3c7d2c"
    for x, y in ((9, 4), (10, 4), (9, 5), (10, 5)):
        grid[(x, y)] = "#ffe066"
    return outlined(grid, "#2a1a0c")


def potion():
    grid = {}
    for y in range(0, 2):
        for x in range(6, 10):
            grid[(x, y)] = "#9a6b3c"
    for y in range(2, 5):
        for x in range(6, 10):
            grid[(x, y)] = "#d8f1ff"
    for y in range(5, 16):
        for x in range(16):
            d = ((x + 0.5 - 8) ** 2 + (y + 0.5 - 10.5) ** 2) ** 0.5
            if d <= 5.2:
                grid[(x, y)] = "#d8f1ff" if y < 8 else "#4d9be6" if d > 3.8 else "#7cc4ff"
    grid[(5, 9)] = grid[(5, 10)] = "#ffffff"
    return outlined(grid, "#1d2a3a")


def chest():
    grid = {}
    for y in range(3, 15):
        for x in range(1, 15):
            grid[(x, y)] = "#a0742f" if y < 7 else "#4a3413" if y == 7 else "#8b6326"
            if y in (3, 14) or x in (1, 14):
                grid[(x, y)] = "#6b4a1a"
    for y in range(6, 10):
        for x in range(7, 9):
            grid[(x, y)] = "#c6c6c6" if y < 9 else "#6f6f6f"
    return outlined(grid, "#2b1d0b")


def camera():
    grid = {}
    for y in range(4, 11):
        for x in range(1, 11):
            grid[(x, y)] = "#b0b0b0" if y == 4 else "#8a8a8a" if y < 10 else "#6a6a6a"
    for y in range(5, 10):
        for x in range(11, 15):
            grid[(x, y)] = "#3a3a3a"
    for y in range(6, 9):
        grid[(13, y)] = "#4fc3f7"
    grid[(2, 5)] = "#ff3030"
    for y in range(11, 15):
        for x in range(5, 7):
            grid[(x, y)] = "#5a5a5a"
    for x in range(3, 9):
        grid[(x, 15)] = "#4a4a4a"
    return outlined(grid, "#141414")


ICONS = [grass_block, pickaxe, painting, potion, chest]


# --- Minecraft GUI pieces ---

def background(svg):
    svg.pattern("dirt", DIRT, 4)
    svg.rect(0, 0, svg.width, svg.height, "url(#dirt)")


def button(svg, x, y, w, h):
    svg.pattern("stone", STONE, 2)
    svg.rect(x, y, w, h, "#000000")
    svg.rect(x + 2, y + 2, w - 4, h - 4, "url(#stone)")
    svg.rect(x + 2, y + 2, w - 4, 2, "#aaaaaa")
    svg.rect(x + 2, y + 2, 2, h - 4, "#aaaaaa")
    svg.rect(x + 2, y + h - 4, w - 4, 2, "#555555")
    svg.rect(x + w - 4, y + 2, 2, h - 4, "#555555")


def slot(svg, x, y, icon):
    svg.rect(x, y, 60, 60, "#8b8b8b")
    svg.rect(x, y, 60, 3, "#373737")
    svg.rect(x, y, 3, 60, "#373737")
    svg.rect(x, y + 57, 60, 3, "#ffffff")
    svg.rect(x + 57, y, 3, 60, "#ffffff")
    svg.pixels(icon, x + 6, y + 6, 3)


def xp_bar(svg, x, y, w, h, fraction):
    """The experience bar: green fill over a dark bar, split in 18 notches."""
    svg.rect(x, y, w, h, "#000000")
    ix, iy, iw, ih = x + 2, y + 2, w - 4, h - 4
    svg.rect(ix, iy, iw, ih, "#2b2b2b")
    fill = round(iw * fraction)
    if fill:
        svg.rect(ix, iy, fill, ih, "#80ff20")
        svg.rect(ix, iy, fill, 2, "#c3ff8a")
        svg.rect(ix, iy + ih - 2, fill, 2, "#4ca30c")
    for i in range(1, 18):
        svg.rect(ix + round(iw * i / 18) - 1, iy, 2, ih, "#000000", opacity=0.45)


# --- the roadmap ---

def parse():
    milestones, current = [], None
    for line in ROADMAP.read_text(encoding="utf-8").splitlines():
        heading = re.match(r"^## (.+)$", line)
        if heading:
            m = re.match(r"^(\S+) — (.+?)(?: \((.+)\))?$", heading.group(1))
            if heading.group(1).strip() == "Principles":
                current = None
                continue
            current = {"version": m.group(1) if m else None, "name": m.group(2) if m else heading.group(1).strip(),
                       "status": m.group(3) if m else None, "items": []}
            milestones.append(current)
            continue
        if current is None:
            continue
        item = re.match(r"^- \[([ x])\] (.*)$", line)
        if item:
            current["items"].append({"done": item.group(1) == "x", "text": item.group(2)})
        elif re.match(r"^- ", line):
            current["items"].append({"done": None, "text": line[2:]})
        elif line.startswith("  ") and current["items"]:
            current["items"][-1]["text"] += " " + line.strip()
    for m in milestones:
        m["slug"] = re.sub(r"[^a-z0-9]+", "-", (m["version"] or m["name"]).lower()).strip("-")
        m["done"] = sum(1 for i in m["items"] if i["done"])
        m["total"] = sum(1 for i in m["items"] if i["done"] is not None)
        m["title"] = f"{m['version']} — {m['name']}" if m["version"] else m["name"]
        # "released: 1.2.0", or for a milestone that comes in parts "first part released: 1.3.0" and later
        # "parts released: 1.3.0, 1.3.1" (the newest is shown)
        released = re.search(r"released: ([^)]+)", m["status"] or "")
        latest = released.group(1).split(",")[-1].strip() if released else None
        if released and ("first part" in m["status"] or "parts released" in m["status"]):
            m["label"], m["color"] = f"in progress - {latest} is out", "#ffff55"
        elif released:
            m["label"], m["color"] = f"released {latest}", "#55ff55"
        elif m["total"] == 0:
            m["label"], m["color"] = "ideas for later", "#aaaaaa"
        elif m["done"]:
            m["label"], m["color"] = "started", "#ffaa00"
        else:
            m["label"], m["color"] = "planned", "#aaaaaa"
    return milestones


def milestone_svg(m, icon):
    svg = Svg(WIDTH, 96, f"{m['title']}: {m['label']}, {m['done']} of {m['total']} done")
    background(svg)
    button(svg, 8, 8, WIDTH - 16, 80)
    slot(svg, 22, 18, icon())
    svg.text(m["title"], 100, 22, 3, "#ffffff", shadow="#3f3f3f")
    svg.text(m["label"], 100, 58, 2, m["color"], shadow="#2a2a2a")
    if m["total"]:
        count = f"{m['done']}/{m['total']}"
        svg.text(count, WIDTH - 32 - text_width(count, 2), 36, 2, "#80ff20", outline="#000000")
        xp_bar(svg, 560, 60, WIDTH - 32 - 560, 14, m["done"] / m["total"])
    return svg.render()


def banner_svg(milestones):
    done = sum(m["done"] for m in milestones)
    total = sum(m["total"] for m in milestones)
    svg = Svg(WIDTH, 184, f"CCTV roadmap: {done} of {total} done")
    background(svg)
    title = "CCTV ROADMAP"
    tw = text_width(title, 6)
    tx = (WIDTH - tw) // 2
    svg.text(title, tx, 22, 6, "#ffffff", shadow="#3f3f3f")
    svg.pixels(camera(), tx - 84, 16, 4)
    # the title screen's yellow splash text, tilted at the end of the title
    splash = []
    svg.text("1:1 like the game!", 0, -14, 2, "#ffff00", shadow="#3f3f00", out=splash)
    svg.parts.append(f'<g transform="translate({tx + tw + 6} {72}) rotate(-12)">' + "".join(splash) + "</g>")
    sub = "live minecraft cameras in the browser"
    svg.text(sub, (WIDTH - text_width(sub, 2)) // 2, 84, 2, "#aaaaaa", shadow="#2a2a2a")
    level = str(done)
    svg.text(level, (WIDTH - text_width(level, 3)) // 2, 108, 3, "#80ff20", outline="#000000")
    xp_bar(svg, 140, 134, WIDTH - 280, 14, done / total if total else 0)
    caption = f"{done} of {total} done"
    svg.text(caption, (WIDTH - text_width(caption, 2)) // 2, 158, 2, "#ffffff", shadow="#3f3f3f")
    return svg.render()


def badges(milestones):
    props = dict(re.findall(r"^(\w+)=(.*)$", GRADLE.read_text(encoding="utf-8"), re.M))
    minecraft = props.get("minecraft_version", "?")
    shield = "https://img.shields.io"
    return "\n".join([
        '<p align="center">',
        f'  <a href="https://github.com/{REPO}/releases/latest"><img alt="Latest release" '
        f'src="{shield}/github/v/release/{REPO}?style=for-the-badge&amp;label=release&amp;color=5d8c3e"></a>',
        f'  <img alt="Minecraft {minecraft}" src="{shield}/badge/minecraft-{minecraft}-866043?style=for-the-badge">',
        f'  <img alt="Fabric, server side only" src="{shield}/badge/fabric-server%20side%20only-8b8b8b?style=for-the-badge">',
        f'  <a href="#roadmap"><img alt="Roadmap" src="{shield}/badge/roadmap-'
        f'{sum(m["done"] for m in milestones)}%2F{sum(m["total"] for m in milestones)}%20done-80ff20?style=for-the-badge"></a>',
        f'  <a href="LICENSE"><img alt="MIT license" src="{shield}/badge/license-MIT-555555?style=for-the-badge"></a>',
        "</p>",
    ])


def roadmap_section(milestones):
    done = sum(m["done"] for m in milestones)
    total = sum(m["total"] for m in milestones)
    current = next((m for m in milestones if m["label"].startswith("in progress")), None)
    lines = [
        f'<p align="center"><img src="{IMAGE_URL}/banner.svg" width="100%" alt="CCTV roadmap: {done} of {total} done"></p>',
        "",
        "What is done and what comes next, milestone by milestone (the full plan with its principles is in",
        "[docs/ROADMAP.md](docs/ROADMAP.md)).",
        "",
    ]
    for m in milestones:
        count = f"{m['done']} of {m['total']} done" if m["total"] else f"{len(m['items'])} ideas"
        lines += [
            f'<img src="{IMAGE_URL}/{m["slug"]}.svg" width="100%" alt="{m["title"]}: {m["label"]}, {count}">',
            "",
            f"<details{' open' if m is current else ''}>",
            f"<summary><b>{m['title']}</b> · {m['label']} · {count}</summary>",
            "",
        ]
        for item in m["items"]:
            box = "- [x] " if item["done"] else "- [ ] " if item["done"] is False else "- "
            lines.append(box + item["text"])
        lines += ["", "</details>", ""]
    lines.append("<sub>The pictures are pixel art drawn by `.github/scripts/roadmap.py` from docs/ROADMAP.md "
                 "(no game textures); CI checks that they are up to date.</sub>")
    return "\n".join(lines)


def replace_between(text, name, body):
    start, end = f"<!-- {name}:start -->", f"<!-- {name}:end -->"
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    if not pattern.search(text):
        raise SystemExit(f"README.md has no {start} ... {end} markers")
    return pattern.sub(lambda _: f"{start}\n{body}\n{end}", text)


def generate():
    milestones = parse()
    files = {IMAGES / "banner.svg": banner_svg(milestones)}
    for i, m in enumerate(milestones):
        files[IMAGES / f"{m['slug']}.svg"] = milestone_svg(m, ICONS[i % len(ICONS)])
    readme = README.read_text(encoding="utf-8")
    readme = replace_between(readme, "badges", badges(milestones))
    readme = replace_between(readme, "roadmap", roadmap_section(milestones))
    files[README] = readme
    return files


def main():
    files = generate()
    if "--check" in sys.argv:
        stale = [str(p.relative_to(ROOT)) for p, content in files.items()
                 if not p.exists() or p.read_text(encoding="utf-8") != content]
        known = {p.name for p in files}
        stale += [str(p.relative_to(ROOT)) + " (not generated any more)" for p in IMAGES.glob("*.svg") if p.name not in known]
        if stale:
            print("Out of date, run python3 .github/scripts/roadmap.py:\n  " + "\n  ".join(stale))
            sys.exit(1)
        print("roadmap pictures and README.md are up to date")
        return
    IMAGES.mkdir(parents=True, exist_ok=True)
    known = {p.name for p in files}
    for p in IMAGES.glob("*.svg"):
        if p.name not in known:
            p.unlink()
    for p, content in files.items():
        p.write_text(content, encoding="utf-8")
    print(f"wrote {len(files)} files")


if __name__ == "__main__":
    main()
