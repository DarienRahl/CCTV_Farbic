"""CI reference renders: the game's picture next to the viewer's picture of the same camera, with difference scores,
for every shot of the client game test (day, night, mobs, a room, under water, dusk, rain, snow, a cave, the Nether,
the End, glass, decorations, redstone, shapes of blocks, plants, lights at night, biome colours, blocks of work,
flowing water and lava, display entities, mannequins, thirteen rows of mobs up close in a frozen world, vehicles,
projectiles, fireballs, blocks that are entities, signs, chests, heads and banners, armour stands at night, young mobs
and the kinds of wolves, farm animals, villagers and horses, mobs in armour and tack, and mobs in their moods).

usage: python3 compare_reference.py <game dir>/reference

Writes reference-<shot>.png (game | viewer | difference) into the directory, prints the scores, a small JPEG of each
comparison (and both pictures) as SHOT: lines (readable from the log without downloading artifacts) and adds a
table of the scores to the job summary. A shot whose coarse difference is above its bound is marked; with --strict the
script then fails.
"""
import base64
import glob
import io
import json
import os
import sys

from PIL import Image, ImageChops, ImageFilter

# Coarse difference (%) above which a shot counts as a regression: about three times what each shot scored when it
# was added (1.13: day 0.10, night 0.06, mobs 0.10, room 0.20, water 0.36-0.45; 1.14: dusk 0.06, nether 0.08-0.10,
# end 0.11-0.21, cave 0.14-0.34; 1.15: glass 0.14, decor 0.13, redstone 0.12; 1.16: the rows of mobs 0.06-0.14; 1.17:
# shapes 0.11-0.16, plants 0.10, lights 0.15-0.25, biomes 0.08-0.10, workshop 0.11; 1.18: fluids 0.14, displays 0.20,
# mannequins 0.11, vehicles 0.06, projectiles 0.07, fireballs 0.06, blocks 0.14; 1.19: signs 0.19, chests 0.06, heads
# 0.10, stands 0.22; 1.20: babies 0.06-0.08, wolves 0.08, climates 0.07, villagers 0.07, horses 0.07; 1.21: armour
# 0.08, tack 0.07, saddles 0.09, harness 0.06, pets 0.07, colours 0.06, moods 0.11, pandas 0.06), so a change that
# moves the picture away from the game's shows up, while the game's own random particles (bubbles, smoke, torch and candle flames) and
# what moves with the time (a beacon's beam, banners, an enchanting table's book) stay under. Rain and snow fall at random places in both pictures, so
# their bounds leave room for that (0.8-0.9).
BOUNDS = {"day": 0.4, "night": 0.3, "mobs": 0.4, "room": 0.6, "water": 1.2, "dusk": 0.3, "rain": 2.0, "snow": 2.0,
          "cave": 1.0, "nether": 0.3, "end": 0.6, "glass": 0.5, "decor": 0.5, "redstone": 0.4,
          "zoo-farm": 0.3, "zoo-pets": 0.3, "zoo-undead": 0.3, "zoo-illagers": 0.3, "zoo-nether": 0.4, "zoo-small": 0.3,
          "zoo-flyers": 0.4, "zoo-water": 0.3, "zoo-big": 0.3, "zoo-ride": 0.3, "zoo-rare": 0.3, "zoo-sea": 0.4,
          "zoo-ghasts": 0.3, "shapes": 0.5, "plants": 0.3, "lights": 0.7, "biomes": 0.3, "workshop": 0.4,
          "fluids": 0.4, "displays": 0.6, "mannequins": 0.4, "vehicles": 0.3, "projectiles": 0.3, "fireballs": 0.3,
          "blocks": 0.4, "signs": 0.5, "chests": 0.3, "heads": 0.3, "stands": 0.6, "babies-farm": 0.3,
          "babies-wild": 0.3, "babies-folk": 0.3, "babies-ride": 0.3, "wolves": 0.3, "climates": 0.3, "villagers": 0.3,
          "horses": 0.3, "armour": 0.3, "tack": 0.3, "saddles": 0.3, "harness": 0.3, "pets": 0.3, "colours": 0.3,
          "moods": 0.4, "pandas": 0.3}
DEFAULT_BOUND = 2.0


def mean_difference(a, b):
    """Mean absolute difference of all channels, 0 (same) .. 100 (black against white)."""
    histogram = ImageChops.difference(a, b).histogram()
    total = sum(i % 256 * count for i, count in enumerate(histogram))
    return 100.0 * total / (255.0 * 3 * a.size[0] * a.size[1])


def print_shot(name, image, quality):
    jpeg = io.BytesIO()
    image.save(jpeg, "JPEG", quality=quality)
    encoded = base64.b64encode(jpeg.getvalue()).decode()
    for i in range(0, len(encoded), 4000):
        print(f"SHOT:{name}:" + encoded[i:i + 4000])


def compare(directory, info):
    name = info.get("shot", "day")
    viewer_path = os.path.join(directory, f"viewer-{name}.png")
    if not os.path.exists(viewer_path):
        print(f"{name}: the viewer took no picture", flush=True)
        return None
    game = Image.open(info["game"]).convert("RGB")
    viewer = Image.open(viewer_path).convert("RGB")
    if viewer.size != game.size:
        viewer = viewer.resize(game.size, Image.BILINEAR)
    pixel = mean_difference(game, viewer)
    # blurred at a quarter of the size: shapes and colours, less the texture pixels a small offset moves around
    small = (game.size[0] // 4, game.size[1] // 4)
    blur = lambda image: image.resize(small, Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.5))
    coarse = mean_difference(blur(game), blur(viewer))
    bound = BOUNDS.get(name, DEFAULT_BOUND)
    print(f"reference renders, {name}: pixel difference {pixel:.2f} %, coarse difference {coarse:.2f} % (bound {bound} %)", flush=True)

    difference = ImageChops.difference(game, viewer).point(lambda v: min(255, v * 3))
    width, height = game.size
    sheet = Image.new("RGB", (width * 3, height))
    sheet.paste(game, (0, 0))
    sheet.paste(viewer, (width, 0))
    sheet.paste(difference, (width * 2, 0))
    sheet.save(os.path.join(directory, f"reference-{name}.png"))
    print_shot(f"reference-{name}", sheet.resize((width * 3 // 2, height // 2)), 70)
    # both pictures at full size too, for a closer look from the log
    print_shot(f"game-{name}", game, 80)
    print_shot(f"viewer-{name}", viewer, 80)
    return {"name": name, "pixel": pixel, "coarse": coarse, "bound": bound}


def main():
    directory = sys.argv[1]
    strict = "--strict" in sys.argv
    infos = sorted((json.load(open(f)) for f in glob.glob(os.path.join(directory, "ready-*.json"))),
                   key=lambda i: os.path.getmtime(i["game"]) if os.path.exists(i["game"]) else 0)
    if not infos:
        sys.exit("no pictures to compare: the game test did not get as far (see the logs above)")
    results = [r for r in (compare(directory, info) for info in infos) if r]
    over = [r for r in results if r["coarse"] > r["bound"]]

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as out:
            out.write("### Reference renders (game | viewer | difference)\n\n")
            out.write("| shot | pixel difference | coarse difference | bound |\n|---|---|---|---|\n")
            for r in results:
                mark = " ✗" if r in over else ""
                out.write(f"| {r['name']} | {r['pixel']:.2f} % | **{r['coarse']:.2f} %**{mark} | {r['bound']} % |\n")
            missing = [i.get("shot") for i in infos if i.get("shot") not in {r["name"] for r in results}]
            if missing:
                out.write(f"\nNo viewer picture of: {', '.join(missing)}.\n")
            out.write("\nThe reference-renders artifact has the full pictures.\n")
    if len(results) < len(infos):
        print(f"{len(infos) - len(results)} shots have no viewer picture", flush=True)
    if over:
        print("over the bound: " + ", ".join(f"{r['name']} {r['coarse']:.2f} % > {r['bound']} %" for r in over), flush=True)
        if strict:
            sys.exit(1)


if __name__ == "__main__":
    main()
