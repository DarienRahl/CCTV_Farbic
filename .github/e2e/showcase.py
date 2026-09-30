#!/usr/bin/env python3
"""The scene of the README's video (screenshots workflow): a party at sunset that gets out of hand.

    python3 showcase.py            builds the scene next to the smoke test's and places the "party" camera
    python3 showcase.py --speed S  sets the server's pace to S times its normal one (/tick rate 20 * S)
    python3 showcase.py --play S   plays the party's moments while the viewer records, the server running at
                                   S times its speed, so every moment is in game time

A jukebox plays Pigstep on a dance floor with parrots dancing on fence posts and allays around it, a jeb_ sheep
changes colour, Dinnerbone's cow stands on its head, fireworks go up, a happy ghast carries pigs across the sky,
lightning charges a creeper on a pillar, chickens rain down, a vault of TNT blows up and the charged creeper goes
off. Needs the smoke test's server (RCON) and world.
"""

import math
import random
import sys
import time

from smoke_test import Rcon

# the party's own spot on the flat world (the smoke test's scene is around 0 0); the grass is at y -61
X, Y, Z = 216, -60, 216
CAMERA = "party"
# the camera stands north of the dance floor and looks south at it, a little down, the sun setting on its right
CAMERA_AT = (X + 0.5, Y + 4.2, Z - 10.5, 0, 12)

FLOOR = ["red", "orange", "yellow", "lime", "light_blue", "blue", "magenta"]


def at(dx, dy, dz):
    return f"{X + dx} {Y + dy} {Z + dz}"


def firework(rcon, dx, dz, life, shape, colors, fade=None, trail=False, twinkle=False, height=0):
    explosion = f'shape:"{shape}",colors:[I;{",".join(str(c) for c in colors)}]'
    if fade:
        explosion += f',fade_colors:[I;{",".join(str(c) for c in fade)}]'
    if trail:
        explosion += ",has_trail:1b"
    if twinkle:
        explosion += ",has_twinkle:1b"
    rcon.command(f"summon minecraft:firework_rocket {X + dx + 0.5} {Y + height} {Z + dz + 0.5} {{LifeTime:{life},"
                 f'FireworksItem:{{id:"minecraft:firework_rocket",count:1,components:{{"minecraft:fireworks":'
                 f"{{flight_duration:2,explosions:[{{{explosion}}}]}}}}}}}}")


def build(rcon):
    rcon.command(f"forceload add {X - 40} {Z - 40} {X + 40} {Z + 40}")
    rcon.command("difficulty easy")  # lightning starts no fires, creepers stay
    rcon.command("time set 12400")
    rcon.command("weather clear")
    rcon.command(f"kill @e[type=!minecraft:player,x={X - 40},y=-64,z={Z - 40},dx=80,dy=100,dz=80]")
    # (a fill takes at most 32768 blocks)
    rcon.command(f"fill {X - 20} {Y} {Z - 16} {X + 20} {Y + 15} {Z + 30} minecraft:air")

    # the dance floor: stripes of wool with glowstone between them, lit up like a disco
    for i, color in enumerate(FLOOR):
        dx = i - 3
        for dz in range(1, 8):
            block = "glowstone" if (dx + dz) % 4 == 0 else f"{color}_wool"
            rcon.command(f"setblock {at(dx, -1, dz)} minecraft:{block}")
    rcon.command(f"setblock {at(0, 0, 4)} minecraft:jukebox")
    # fence posts for the parrots, lanterns at the corners
    for dx, dz in ((-2, 3), (2, 3), (-1, 6), (1, 6)):
        rcon.command(f"setblock {at(dx, 0, dz)} minecraft:oak_fence")
    for dx, dz in ((-4, 1), (4, 1), (-4, 7), (4, 7)):
        rcon.command(f"setblock {at(dx, 0, dz)} minecraft:oak_fence")
        rcon.command(f"setblock {at(dx, 1, dz)} minecraft:lantern")
    # a beacon behind the stage shining a magenta beam into the sky
    rcon.command(f"fill {at(-1, -1, 12)} {at(1, -1, 14)} minecraft:iron_block")
    rcon.command(f"setblock {at(0, 0, 13)} minecraft:beacon")
    rcon.command(f"setblock {at(0, 1, 13)} minecraft:magenta_stained_glass")
    # the vault on the left, full of TNT
    rcon.command(f"fill {at(-10, 0, 8)} {at(-7, 3, 11)} minecraft:cobblestone hollow")
    rcon.command(f"fill {at(-9, 1, 9)} {at(-8, 2, 10)} minecraft:tnt")
    rcon.command(f"setblock {at(-8, 0, 8)} minecraft:iron_door[facing=north,half=lower]")
    rcon.command(f"setblock {at(-8, 1, 8)} minecraft:iron_door[facing=north,half=upper]")
    # the pillar on the right with a creeper on it, a lightning rod next to it
    rcon.command(f"fill {at(9, 0, 10)} {at(9, 4, 10)} minecraft:stone_bricks")
    rcon.command(f"setblock {at(8, 0, 10)} minecraft:lightning_rod")

    # the dancers: parrots on the posts, allays over the floor
    for i, (dx, dz) in enumerate(((-2, 3), (2, 3), (-1, 6), (1, 6))):
        rcon.command(f"summon minecraft:parrot {X + dx + 0.5} {Y + 1.5} {Z + dz + 0.5} {{Variant:{i},NoAI:1b,Rotation:[{180 + dx * 20}f,0f]}}")
    for dx, dz in ((-1.5, 2.5), (1.5, 5.5)):
        rcon.command(f"summon minecraft:allay {X + dx} {Y + 1.2} {Z + dz} {{NoAI:1b,NoGravity:1b,Rotation:[180f,0f]}}")
    # the guests
    rcon.command(f'summon minecraft:sheep {X - 4.5} {Y} {Z + 2.5} {{CustomName:"jeb_",NoAI:1b,Rotation:[150f,0f]}}')
    rcon.command(f'summon minecraft:cow {X + 6.5} {Y} {Z + 3.5} {{CustomName:"Dinnerbone",NoAI:1b,Rotation:[210f,0f]}}')
    rcon.command(f'summon minecraft:villager {X - 5.5} {Y} {Z + 6.5} {{NoAI:1b,Rotation:[120f,0f],'
                 'VillagerData:{type:"minecraft:plains",profession:"minecraft:librarian",level:2}}')
    rcon.command(f'summon minecraft:villager {X + 5.5} {Y} {Z + 6.5} {{NoAI:1b,Rotation:[240f,0f],'
                 'VillagerData:{type:"minecraft:desert",profession:"minecraft:farmer",level:1}}')
    rcon.command(f"summon minecraft:creeper {X + 9.5} {Y + 5} {Z + 10.5} {{NoAI:1b,Rotation:[160f,0f]}}")
    rcon.command(f"summon minecraft:iron_golem {X + 3.5} {Y} {Z + 9.5} {{NoAI:1b,Rotation:[200f,0f]}}")
    # the happy ghast, out of sight on the left until it flies over, pigs on its back
    rcon.command(f'summon minecraft:happy_ghast {X - 26} {Y + 9} {Z + 14} {{NoAI:1b,NoGravity:1b,Tags:["show_ghast"],'
                 'Rotation:[-90f,0f],equipment:{body:{id:"minecraft:pink_harness",count:1}},'
                 'Passengers:[{id:"minecraft:pig"},{id:"minecraft:pig",CustomName:"Grumm"},{id:"minecraft:pig"}]}')

    rcon.command(f"cctv create {CAMERA} {' '.join(str(v) for v in CAMERA_AT)}")
    rcon.command(f"cctv range {CAMERA} 48")


def play(rcon, speed):
    """The party's moments at game seconds, the server running at `speed` times its normal pace."""
    random.seed(7)
    start = time.time()

    def wait_until(game_seconds):
        delay = start + game_seconds / speed - time.time()
        if delay > 0:
            time.sleep(delay)

    moments = [
        (0.3, lambda: rcon.command(f"item replace block {at(0, 0, 4)} container.0 with minecraft:music_disc_pigstep")),
        (1.0, lambda: firework(rcon, -6, 9, 18, "large_ball", [11743532, 15435844], fade=[16777215], trail=True)),
        (2.0, lambda: firework(rcon, 6, 9, 19, "creeper", [4312372], twinkle=True)),
        (3.0, lambda: firework(rcon, 0, 11, 20, "star", [2437522, 16777215], trail=True, twinkle=True)),
        (5.5, lambda: rcon.command(f"summon minecraft:lightning_bolt {X + 9.5} {Y + 5} {Z + 10.5}")),
        (7.0, lambda: [rcon.command(f"summon minecraft:chicken {X + random.uniform(-5, 5):.1f} {Y + 16 + random.uniform(0, 5):.1f} "
                                    f"{Z + random.uniform(1, 8):.1f}") for _ in range(9)]),
        (8.5, lambda: [rcon.command(f"summon minecraft:tnt {X - 8.5 + dx} {Y + 4} {Z + 9.5} {{fuse:{f}}}")
                       for dx, f in ((-0.5, 22), (0.5, 26))]),
        (10.5, lambda: rcon.command(f"data merge entity @e[type=minecraft:creeper,limit=1,x={X},y={Y},z={Z},distance=..30] {{ignited:1b}}")),
        (12.0, lambda: firework(rcon, -5, 10, 17, "burst", [14602026, 15790320], twinkle=True)),
        (12.4, lambda: firework(rcon, 5, 10, 18, "large_ball", [6719955, 11250603], fade=[16701501], trail=True)),
        (12.8, lambda: firework(rcon, 0, 12, 19, "star", [15435844, 16701501], trail=True, twinkle=True)),
    ]
    # the happy ghast crosses the sky from game second 4 to 14, one step every game tick
    ghast = [(4.0 + i / 20, i) for i in range(200)]
    events = sorted([(t, "moment", action) for t, action in moments] + [(t, "ghast", i) for t, i in ghast],
                    key=lambda e: e[0])
    for t, kind, what in events:
        wait_until(t)
        if kind == "moment":
            what()
        else:
            x = X - 22 + what * 0.22
            y = Y + 9 + math.sin(what / 25) * 0.6
            rcon.command(f"tp @e[tag=show_ghast,limit=1] {x:.2f} {y:.2f} {Z + 14} -90 0")
    wait_until(15.0)


def main():
    rcon = Rcon()
    if "--speed" in sys.argv:
        rcon.command(f"tick rate {20 * float(sys.argv[sys.argv.index('--speed') + 1]):g}")
    elif "--play" in sys.argv:
        play(rcon, float(sys.argv[sys.argv.index("--play") + 1]))
    else:
        build(rcon)


if __name__ == "__main__":
    main()
