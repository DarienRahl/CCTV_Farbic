"""End-to-end smoke test run by CI against a real dedicated server with the mod.

Talks to the server over RCON (like an admin console), places a camera with
/cctv, then reads the live stream like a browser would and checks that world
data, entities and instant block updates arrive.
"""
import base64
import gzip
import json
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

RCON_PORT = 25575
RCON_PASSWORD = "cctv-ci"
WEB = "http://127.0.0.1:8100"


class Rcon:
    def __init__(self):
        self.sock = socket.create_connection(("127.0.0.1", RCON_PORT), timeout=30)
        self.request_id = 0
        self._send(3, RCON_PASSWORD)
        if self._receive()[0] == -1:
            raise RuntimeError("RCON login failed")

    def _send(self, kind, body):
        self.request_id += 1
        payload = struct.pack("<ii", self.request_id, kind) + body.encode() + b"\x00\x00"
        self.sock.sendall(struct.pack("<i", len(payload)) + payload)

    def _receive(self):
        length = struct.unpack("<i", self._read(4))[0]
        data = self._read(length)
        request_id, _kind = struct.unpack("<ii", data[:8])
        return request_id, data[8:-2].decode(errors="replace")

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("RCON connection closed")
            buf += chunk
        return buf

    def command(self, cmd):
        self._send(2, cmd)
        response = self._receive()[1]
        print(f"> /{cmd}\n  {response}", flush=True)
        return response


def wait_for_server(timeout=600):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return Rcon()
        except OSError:
            time.sleep(3)
    raise RuntimeError("server did not start")


class StreamReader(threading.Thread):
    def __init__(self, camera):
        super().__init__(daemon=True)
        self.block_tags = {}
        self.palette = {}
        self.url = f"{WEB}/api/cameras/{camera}/stream"
        self.events = {}
        self.first = {}
        self.entity_types = set()
        self.displays = {}
        self.mannequin = None
        self.sulfur_cube = None
        self.worn_heads = {}
        self.minecart = None
        self.cloud = None
        self.stack = None
        self.ominous = None
        self.posed_stand = None
        self.foil = set()
        self.glowing = set()
        self.leashed = set()
        self.equipment = set()
        self.cracks = set()
        self.poses = set()
        self.items = set()
        self.effects = set()
        self.block_updates = []
        self.sections = set()
        self.names = set()
        self.sign_lines = set()
        self.block_entities = {}
        # per section: how often it came and the block entity kinds of its latest message (diagnostics)
        self.section_messages = {}
        self.jukebox_texts = []
        self.paintings = set()
        self.beacon_beam = None
        self.animation_states = set()
        self.entity_events = set()
        self.ready = threading.Event()
        self.error = None
        self.response = None
        self.closed = False
        self.lines = 0
        self.connected = False

    def run(self):
        try:
            with urllib.request.urlopen(self.url, timeout=60) as response:
                self.response = response
                self.connected = True
                event = None
                for raw in response:
                    self.lines += 1
                    line = raw.decode().rstrip("\n")
                    if line.startswith("event: "):
                        event = line[7:]
                    elif line.startswith("data: ") and event:
                        data = json.loads(line[6:])
                        self.events[event] = self.events.get(event, 0) + 1
                        self.first.setdefault(event, data)
                        if event == "entities":
                            self.entity_types.update(e["type"] for e in data["e"])
                            self.items.update((e.get("item"), round(e["x"]), round(e["y"]), round(e["z"]))
                                              for e in data["e"] if e["type"] == "minecraft:item")
                            for e in data["e"]:
                                if e["type"] == "minecraft:mannequin":
                                    self.mannequin = e
                                if e["type"] == "minecraft:sulfur_cube":
                                    self.sulfur_cube = e
                                if e["type"] == "minecraft:furnace_minecart":
                                    self.minecart = e
                                if e["type"] == "minecraft:area_effect_cloud":
                                    self.cloud = e
                                if e["type"] == "minecraft:item" and e.get("n"):
                                    self.stack = e
                                if e["type"] == "minecraft:ominous_item_spawner":
                                    self.ominous = e
                                if e["type"] == "minecraft:armor_stand" and "pose" in e.get("d", {}):
                                    self.posed_stand = e
                                if e.get("helm") or e.get("skull"):
                                    self.worn_heads[e["type"]] = e
                                if e["type"] in ("minecraft:text_display", "minecraft:block_display", "minecraft:item_display"):
                                    self.displays.setdefault(e["type"], []).append(e)
                                    del self.displays[e["type"]][:-3]
                                for name in e.get("anim", {}):
                                    self.animation_states.add((e["type"], name))
                                for event_id in e.get("ev", []):
                                    self.entity_events.add((e["type"], event_id))
                                if e.get("foil"):
                                    self.foil.add((e["type"], e["foil"]))
                                if e["type"] == "minecraft:painting":
                                    d = e.get("d", {})
                                    self.paintings.add((d.get("asset"), d.get("pw"), d.get("ph"), d.get("facing")))
                                if e.get("leash"):
                                    self.leashed.add(e["type"])
                                if "glow" in e:
                                    self.glowing.add((e["type"], e["glow"]))
                                for key in ("sleeping", "armPose"):
                                    if key in e.get("d", {}):
                                        self.poses.add((e["type"], key, e["d"][key]))
                                for piece in e.get("eq") or []:
                                    if piece:
                                        # equipment asset, whether it is dyed, its trim pattern
                                        self.equipment.add((e["type"], piece["a"], "c" in piece, (piece.get("t") or [None])[0]))
                                        if piece.get("k"):
                                            self.cracks.add((e["type"], piece["k"]))
                            self.names.update(e["name"] for e in data["e"] if e.get("nameVisible"))
                            for fx in data.get("fx", []):
                                # level events by type, entity effects by kind, explosions by particle, fireworks by shape
                                key = (fx[6] if fx[0] == "ex" else fx[4] if fx[0] == "be" else (fx[8] or [[None]])[0][0] if fx[0] == "fw"
                                       else "moving" if fx[0] == "pm" else fx[1])
                                self.effects.add(fx[0] + ":" + str(key))
                                if fx[0] == "js":
                                    self.jukebox_texts.append(fx[5] if len(fx) > 5 else None)
                        elif event == "blocks":
                            self.block_updates.extend(data["b"])
                        elif event == "palette":
                            for entry in data.get("s", []):
                                self.palette[(entry.get("n"), entry.get("s", ""))] = entry
                                if entry.get("tg"):
                                    self.block_tags.setdefault(entry["n"], set()).update(entry["tg"])
                        elif event == "section":
                            self.sections.add((data["x"], data["y"], data["z"]))
                            count, _ = self.section_messages.get((data["x"], data["y"], data["z"]), (0, None))
                            self.section_messages[(data["x"], data["y"], data["z"])] = (
                                count + 1, [be.get("k") for be in data.get("be", [])])
                            for block_entity in data.get("be", []):
                                self.block_entities[block_entity.get("k")] = block_entity
                                if block_entity.get("k") == "beacon" and block_entity.get("s"):
                                    self.beacon_beam = block_entity
                                for side in ("f", "b"):
                                    self.sign_lines.update(block_entity.get(side, {}).get("l", []))
                        elif event == "ready":
                            self.ready.set()
        except Exception as e:  # noqa: BLE001 - reported below
            if not self.closed:
                self.error = e

    def close(self):
        self.closed = True
        try:
            self.response.close()
        except Exception:  # noqa: BLE001 - already gone
            pass


def wait_for_assets(timeout=300):
    """The mod downloads the client jar from Mojang on first start and builds the texture bundle."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{WEB}/assets/bundle.json", timeout=30) as response:
                bundle = json.load(response)
                return bundle
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise RuntimeError("client assets disabled or failed: " + e.read().decode(errors="replace"))
        except OSError:
            pass
        time.sleep(3)
    raise RuntimeError("client assets were not ready in time")


def wait_for_models(timeout=300):
    """Entity model geometry read from the client jar (after the block assets)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{WEB}/assets/models.json", timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise RuntimeError("entity models unavailable")
        except OSError:
            pass
        time.sleep(3)
    raise RuntimeError("entity models were not ready in time")


def main():
    if "--stop" in sys.argv:
        Rcon().command("stop")
        return

    rcon = wait_for_server()
    rcon.command("forceload add -48 -48 48 48")
    rcon.command("time set 1000")
    rcon.command("gamerule doDaylightCycle false")
    rcon.command("fill 2 -60 8 8 -56 14 minecraft:oak_planks hollow")
    rcon.command("fill 2 -55 8 8 -55 14 minecraft:cobblestone_slab")
    rcon.command("setblock 5 -59 8 minecraft:glass")
    rcon.command("setblock 5 -60 8 minecraft:oak_door[facing=north,half=lower]")
    rcon.command("setblock 5 -59 8 minecraft:oak_door[facing=north,half=upper]")
    rcon.command("setblock 3 -58 8 minecraft:glass_pane")
    rcon.command("setblock 7 -58 8 minecraft:glass_pane")
    rcon.command("setblock 4 -58 7 minecraft:wall_torch[facing=north]")
    # an item frame on the house wall, facing the camera (Facing 2 = north), with a turned sword
    rcon.command('summon minecraft:item_frame 6 -58 7 {Facing:2b,ItemRotation:1b,Item:{id:"minecraft:diamond_sword",count:1}}')
    # a painting on the house wall (PaintingRenderer: its picture, back and edges)
    rcon.command('summon minecraft:painting 3 -59 7 {facing:2b,variant:"minecraft:kebab"}')
    rcon.command("fill -8 -61 6 -4 -61 12 minecraft:water")
    # a slab at the pool's edge (FluidRenderer hides the water's side face only as high as the slab covers it)
    rcon.command("setblock -3 -61 9 minecraft:stone_slab[type=bottom]")
    rcon.command("fill -9 -60 3 -9 -60 14 minecraft:oak_fence")
    rcon.command("setblock 1 -60 3 minecraft:chest[facing=north]")
    # a lit campfire: its smoke column is the viewer's surest particle (screenshot.mjs checks it)
    rcon.command("setblock -1 -60 3 minecraft:campfire[lit=true]")
    # food on an unlit campfire stays there (a lit one cooks and drops it after 30 seconds)
    rcon.command('setblock -3 -60 4 minecraft:campfire[lit=false]{Items:[{Slot:0b,id:"minecraft:beef",count:1}]}')
    rcon.command("setblock 0 -60 5 minecraft:poppy")
    rcon.command("setblock 1 -60 6 minecraft:dandelion")
    rcon.command('setblock -3 -60 0 minecraft:oak_sign[rotation=8]{front_text:{messages:["CCTV","Camera ci","",""]}}')
    rcon.command('setblock 7 -59 7 minecraft:spruce_wall_sign[facing=north]'
                 '{front_text:{messages:["","Welcome","",""],color:"yellow",has_glowing_text:1b}}')
    rcon.command('setblock -5 -60 1 minecraft:white_banner[rotation=8]'
                 '{patterns:[{pattern:"minecraft:stripe_bottom",color:"blue"},{pattern:"minecraft:creeper",color:"black"}]}')
    # 26.3 PotDecorations: one item (stack template) per side
    rcon.command('setblock 2 -60 1 minecraft:decorated_pot[facing=north]'
                 '{sherds:{back:"minecraft:brick",left:"minecraft:angler_pottery_sherd",right:"minecraft:heart_pottery_sherd",'
                 'front:"minecraft:skull_pottery_sherd"}}')
    rcon.command('setblock 3 -60 -1 minecraft:player_head[rotation=8]{profile:{name:"Notch"}}')
    # a beacon on an iron pyramid with stained glass above, outside the house: its beam turns on at the
    # beacon's next check (the scene's chunks are force loaded above, so block entities tick)
    rcon.command("fill 9 -61 9 11 -61 11 minecraft:iron_block")
    rcon.command("setblock 10 -60 10 minecraft:beacon")
    rcon.command("setblock 10 -57 10 minecraft:red_stained_glass")
    rcon.command("setblock -3 -61 11 minecraft:end_portal")
    rcon.command("setblock 1 -60 -3 minecraft:enchanting_table")
    rcon.command("setblock -2 -60 -3 minecraft:lectern[facing=north,has_book=true]")
    # suspicious sand brushed from above, a diamond showing (BrushableBlockRenderer), and a conduit (its shell);
    # the side it is brushed from is set further down, because the block's first tick clears it (nobody brushes)
    # not waterlogged (the default): its water would flood the scene and wash the player head away
    rcon.command("setblock 7 -60 0 minecraft:conduit[waterlogged=false]")
    rcon.command('setblock 6 -60 0 minecraft:suspicious_sand[dusted=2]{item:{id:"minecraft:diamond",count:1}}')
    # a spawner with a zombie turning inside (no player near, so it spawns nothing)
    rcon.command('setblock -4 -60 -5 minecraft:spawner{SpawnData:{entity:{id:"minecraft:zombie"}}}')
    rcon.command("place feature minecraft:oak -6 -60 18")
    rcon.command("place feature minecraft:birch 12 -60 16")
    rcon.command("place feature minecraft:fancy_oak 14 -60 4")
    rcon.command("fill 10 -60 -2 13 -60 1 minecraft:short_grass")
    for mob, x, z in [("cow", -2, 4), ("pig", 1, 3), ("sheep", 3, 5), ("villager", -1, 7), ("creeper", 4, 2),
                      ("horse", -4, 9), ("wolf", 2, 1)]:
        rcon.command(f"summon minecraft:{mob} {x} -60 {z}")
    rcon.command("summon minecraft:happy_ghast 1 -55 16")
    rcon.command('summon minecraft:pig 0 -60 8 {CustomName:"Bob",CustomNameVisible:1b}')
    rcon.command("summon minecraft:armor_stand -3 -60 2")
    # a pig on a lead tied to a fence post (the game makes the leash knot)
    rcon.command("setblock -7 -60 -2 minecraft:oak_fence")
    rcon.command("summon minecraft:pig -6 -60 -4 {leash:[I;-7,-60,-2]}")
    rcon.command("summon minecraft:breeze 6 -60 2 {NoAI:1b}")
    # poses the viewer takes from the entities' state (FoxModel sleeping, IllagerModel holding a crossbow)
    rcon.command("summon minecraft:fox -6 -60 5 {Sleeping:1b,NoAI:1b}")
    rcon.command('summon minecraft:pillager 7 -60 9 {NoAI:1b,equipment:{mainhand:{id:"minecraft:crossbow",count:1}}}')
    rcon.command("item replace entity @e[type=minecraft:armor_stand,limit=1] armor.head"
                 " with minecraft:golden_helmet[enchantments={'minecraft:protection':1}]")
    # a dyed leather chestplate with a gold coast trim (equipment layers, dye and trim palette)
    rcon.command("item replace entity @e[type=minecraft:armor_stand,limit=1] armor.chest"
                 " with minecraft:leather_chestplate[dyed_color=3364095,trim={material:'minecraft:gold',pattern:'minecraft:coast'}]")
    # a tame wolf in badly worn wolf armour (14 of 64 durability left: the "high" cracks of WolfArmorLayer)
    rcon.command('summon minecraft:wolf 3 -60 1 {Owner:[I;1,2,3,4],'
                 'equipment:{body:{id:"minecraft:wolf_armor",count:1,components:{"minecraft:damage":50}}}}')

    # display entities (DisplayRenderer): a hologram, a small block and an item, the way servers decorate
    rcon.command('summon minecraft:text_display 0 -57 3 {text:{text:"Hello",color:"gold",bold:true},billboard:"center",'
                 'background:-16777216,line_width:120}')
    rcon.command('summon minecraft:block_display -3 -60 3 {block_state:"minecraft:stone",transformation:{translation:[0f,0f,0f],'
                 'left_rotation:[0f,0f,0f,1f],scale:[0.5f,0.5f,0.5f],right_rotation:[0f,0f,0f,1f]}}')
    rcon.command('summon minecraft:item_display 2 -58 3 {item:{id:"minecraft:diamond",count:1},item_display:"fixed"}')
    # a shelf with two items (ShelfRenderer) and a mannequin wearing Notch's skin with its own description
    rcon.command('setblock -2 -60 6 minecraft:oak_shelf[facing=north]{Items:[{Slot:0b,id:"minecraft:diamond",count:1},'
                 '{Slot:2b,id:"minecraft:apple",count:1}]}')
    rcon.command('summon minecraft:mannequin 1.5 -60 4.5 {profile:"Notch",description:"Shopkeeper",Rotation:[180f,0f]}')
    # CustomHeadLayer and left-handed mobs: a left-handed zombie in a carved pumpkin, an armour stand with Notch's head
    rcon.command('summon minecraft:zombie 6 -60 6 {NoAI:1b,LeftHanded:1b,PersistenceRequired:1b,equipment:{'
                 'head:{id:"minecraft:carved_pumpkin",count:1},mainhand:{id:"minecraft:iron_sword",count:1}}}')
    rcon.command('summon minecraft:armor_stand -1 -60 6 {equipment:{head:{id:"minecraft:player_head",count:1,'
                 'components:{"minecraft:profile":"Notch"}}}}')
    # a sulfur cube holding a block of TNT (drawn inside it, SulfurCubeInnerLayer)
    rcon.command('summon minecraft:sulfur_cube 5 -60 -2 {NoAI:1b,equipment:{body:{id:"minecraft:tnt",count:1}}}')
    # a furnace minecart (AbstractMinecartRenderer's display block), a stack of 20 cobblestone on the ground (three
    # copies, ItemEntityRenderer) and a lingering poison cloud (AreaEffectCloud's particles)
    rcon.command("summon minecraft:furnace_minecart 3 -60 -4")
    rcon.command('summon minecraft:item 4 -60 -6 {Item:{id:"minecraft:cobblestone",count:20},PickupDelay:32767,Age:-32768}')
    rcon.command('summon minecraft:area_effect_cloud 0 -60 -3 {Radius:2f,Duration:12000,potion_contents:{potion:"minecraft:poison"}}')
    # a posed armour stand with arms and no base plate (ArmorStandModel)
    rcon.command('summon minecraft:armor_stand -4 -60 8 {ShowArms:1b,NoBasePlate:1b,Pose:{Head:[-15f,25f,0f],RightArm:[-100f,0f,0f]}}')
    # an ominous item spawner holding three diamonds (OminousItemSpawnerRenderer draws them like a dropped stack)
    rcon.command('summon minecraft:ominous_item_spawner 5 -58 -6 {item:{id:"minecraft:diamond",count:3},spawn_item_after_ticks:1000000L}')

    rcon.command("cctv create ci -1 -56 -8 10 30")
    # a camera under water, in the pool (the water fog and the underwater overlay, screenshot.mjs)
    rcon.command("cctv create wet -5.5 -60.8 9.5 0 10")
    # the camera's marker in game (a small observer block_display)
    markers = rcon.command("execute if entity @e[type=minecraft:block_display,tag=cctv_camera]")
    print("camera markers:", markers, flush=True)
    if "passed" not in markers.lower():
        failures.append(f"no camera marker was placed: {markers}")
    listing = rcon.command("cctv list")
    assert "ci" in listing, "camera not listed"

    cameras = json.load(urllib.request.urlopen(f"{WEB}/api/cameras", timeout=10))
    print("cameras:", cameras, flush=True)
    assert any(c["name"] == "ci" for c in cameras), "camera missing from API"

    stream = StreamReader("ci")
    stream.start()
    assert stream.ready.wait(60), f"no 'ready' event (events so far: {stream.events}, error: {stream.error})"

    rcon.command("setblock 0 -60 0 minecraft:gold_block")
    # effects the client turns into particles: a broken block (level event 2001) and an explosion behind
    # the camera (the killed sheep below makes the death poof)
    # a jukebox playing a disc (level event 1010 with Gui.setNowPlaying's text, and the song in its block entity)
    rcon.command("setblock -1 -60 1 minecraft:jukebox")
    rcon.command("item replace block -1 -60 1 container.0 with minecraft:music_disc_cat")
    rcon.command("setblock 4 -60 -4 minecraft:stone")
    rcon.command("setblock 4 -60 -4 minecraft:air destroy")
    rcon.command("summon minecraft:tnt -20 -59 -24 {fuse:0}")
    # a firework rocket that explodes in front of the camera (entity event 17 with its explosions)
    rcon.command('summon minecraft:firework_rocket 2 -50 6 {LifeTime:5,FireworksItem:{id:"minecraft:firework_rocket",count:1,'
                 'components:{"minecraft:fireworks":{flight_duration:1,explosions:[{shape:"large_ball",colors:[I;11743532],'
                 'has_trail:true}]}}}}')
    # blocks whose client ambience needs block tags (desert sand, creaking heart logs)
    rcon.command("setblock 6 -60 3 minecraft:sand")
    rcon.command("setblock 7 -60 3 minecraft:pale_oak_log")
    # a piston pushing stone up when powered: the moving block (PistonMovingBlockEntity) is animated
    rcon.command("setblock 8 -60 -5 minecraft:piston[facing=up]")
    rcon.command("setblock 8 -59 -5 minecraft:stone")
    rcon.command("setblock 8 -60 -6 minecraft:redstone_block")
    # a note block played by redstone: a block event (the viewer shows its note)
    rcon.command("setblock 5 -60 -5 minecraft:note_block")
    rcon.command("setblock 5 -60 -6 minecraft:redstone_block")
    rcon.command('data merge block -3 -60 0 {front_text:{messages:["CCTV","edited","",""]}}')
    rcon.command("data merge block 6 -60 0 {hit_direction:1}")
    rcon.command("kill @e[type=minecraft:sheep]")
    # a glowing cow (the Glowing effect: outlined in white, the default team colour)
    rcon.command("effect give @e[type=minecraft:cow,limit=1] minecraft:glowing infinite 0 true")
    time.sleep(4)
    # the worn wolf armour breaks (pieces of it fly and its break sound plays, LivingEntity.breakItem)
    rcon.command("damage @e[type=minecraft:wolf,nbt={equipment:{body:{id:\"minecraft:wolf_armor\"}}},limit=1] 30")
    # a block changing next to the suspicious sand schedules its tick, which forgets the brushing side: set it
    # once more right before the checks
    rcon.command("data merge block 6 -60 0 {hit_direction:1}")
    time.sleep(2)

    print("events:", stream.events, flush=True)
    print("init:", stream.first.get("init"), flush=True)
    print("entity types:", sorted(stream.entity_types), "dropped items:", sorted(map(str, stream.items)), flush=True)
    print("block updates:", stream.block_updates[:10], flush=True)
    print("first palette entries:", json.dumps(stream.first.get("palette"))[:800], flush=True)
    print("first env sample:", json.dumps(stream.first.get("env")), flush=True)
    print("dimension:", json.dumps((stream.first.get("init") or {}).get("dim")), flush=True)

    failures = []
    section = stream.first.get("section") or {}
    if "sl" not in section or "bp" not in section:
        failures.append("sections carry no light/biome data")
    if not (stream.first.get("init") or {}).get("biomes"):
        failures.append("init carries no biome table")
    # the Nether's ambient particles (EnvironmentAttributes.AMBIENT_PARTICLES) ride along with the biome table
    deltas = ((stream.first.get("init") or {}).get("biomes") or {}).get("minecraft:basalt_deltas", {})
    print("basalt deltas:", json.dumps(deltas), flush=True)
    if not any(p[0] == "minecraft:white_ash" for p in deltas.get("ap", [])):
        failures.append(f"the basalt deltas' white ash is missing from the biome table (got {deltas})")

    try:
        bundle = wait_for_assets()
        print("assets:", {k: len(v) for k, v in bundle.items() if isinstance(v, dict)}, flush=True)
        for key in ("blockstates", "models", "textures"):
            if len(bundle.get(key, {})) < 500:
                failures.append(f"asset bundle has too few {key}")
    except RuntimeError as e:
        failures.append(str(e))

    # the game's sounds: the merged sound list and one sound file (downloaded from Mojang via the asset index)
    try:
        request = urllib.request.Request(f"{WEB}/assets/sounds.json", headers={"Accept-Encoding": "identity"})
        with urllib.request.urlopen(request, timeout=120) as response:
            sound_events = json.load(response)
        print("sound events:", len(sound_events), flush=True)
        if "minecraft:entity.cow.ambient" not in sound_events:
            failures.append("sounds.json has no minecraft:entity.cow.ambient")
        with urllib.request.urlopen(f"{WEB}/assets/sound/minecraft/mob/cow/say1.ogg", timeout=120) as response:
            ogg = response.read()
        if not ogg.startswith(b"OggS"):
            failures.append(f"the cow's sound is not an Ogg file ({len(ogg)} bytes)")
    except Exception as e:
        failures.append(f"sounds unavailable: {e}")

    # the Now Playing toast: song titles (the game's music.* texts) and its GUI sprites from the client jar
    try:
        music = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"{WEB}/assets/music.json", timeout=60) as response:
                    music = json.load(response)
                break
            except urllib.error.HTTPError as e:
                if e.code != 503:
                    raise
                time.sleep(2)
        names = (music or {}).get("names", {})
        print("song titles:", len(names), {k: names.get(k) for k in ("music.game.sweden", "music.game.clark")}, flush=True)
        if not names.get("music.game.sweden"):
            failures.append("music.json has no title for C418's Sweden")
        for sprite in ("toast/now_playing.png", "toast/now_playing.png.mcmeta", "icon/music_notes.png"):
            with urllib.request.urlopen(f"{WEB}/assets/gui/{sprite}", timeout=60) as response:
                if not response.read():
                    failures.append(f"GUI sprite {sprite} is empty")
    except Exception as e:
        failures.append(f"Now Playing assets unavailable: {e}")

    # the pages' web font, built from the game's glyph sheets (served without a token)
    try:
        for name in ("minecraft.ttf", "minecraft-bold.ttf"):
            with urllib.request.urlopen(f"{WEB}/assets/font/{name}", timeout=60) as response:
                ttf = response.read()
            print("web font", name, len(ttf), "bytes", flush=True)
            if not ttf.startswith(b"\x00\x01\x00\x00") or len(ttf) < 20000:
                failures.append(f"{name} is not a TrueType font ({len(ttf)} bytes)")
    except Exception as e:
        failures.append(f"web font unavailable: {e}")

    try:
        models = wait_for_models()
        layers = models.get("layers", {})
        animations = models.get("animations", {})
        print("entity model layers:", len(layers), "keyframe animations:", len(animations), flush=True)
        for layer in ("minecraft:horse#main", "minecraft:happy_ghast#main", "minecraft:cow#main", "minecraft:player#main"):
            if layer not in layers:
                failures.append(f"entity model {layer} missing")
        for name in ("WardenAnimation.WARDEN_ROAR", "SnifferAnimation.SNIFFER_WALK", "CamelAnimation.CAMEL_IDLE",
                     "FrogAnimation.FROG_CROAK", "BreezeAnimation.IDLE"):
            if name not in animations:
                failures.append(f"keyframe animation {name} missing")
        # which layers and textures each entity type's renderer uses (EntityRendererMap, from the bytecode)
        renderers = models.get("renderers", {})
        print("entity renderers:", len(renderers), {k: renderers.get(k) for k in ("minecraft:fox", "minecraft:mule", "minecraft:giant")},
              flush=True)
        fox = renderers.get("minecraft:fox", {})
        if "minecraft:fox#main" not in fox.get("l", []) or "fox/fox" not in fox.get("t", []) or fox.get("s") != 0.4:
            failures.append("the fox's renderer was not read from the client jar")
        # The animations as the viewer gets them, for local viewer tests (decode: base64 -d | gunzip).
        packed = base64.b64encode(gzip.compress(json.dumps(animations, separators=(",", ":")).encode())).decode()
        for i in range(0, len(packed), 4000):
            print("ANIMATIONS:" + packed[i:i + 4000], flush=True)
    except RuntimeError as e:
        failures.append(str(e))

    names = json.load(urllib.request.urlopen(f"{WEB}/assets/names.json", timeout=10))
    print("entity names:", len(names), {k: names.get(k) for k in ("cow", "happy_ghast", "zombie_villager")}, flush=True)
    if names.get("zombie_villager") != "Zombie Villager":
        failures.append("entity names from the game's language file are missing")

    viewer = json.load(urllib.request.urlopen(f"{WEB}/api/viewer", timeout=10))
    print("viewer settings:", viewer, flush=True)
    if "sepia" not in viewer.get("shaders", []):
        failures.append("example post shaders were not installed")

    env = stream.first.get("env") or {}
    for key in ("sky", "fog", "sunAngle", "skyFactor", "ambient", "blockTint", "borderTint"):
        if key not in env:
            failures.append(f"env sample has no {key}")
    if len(env.get("border", [])) != 4:
        failures.append(f"env sample has no world border (got {env.get('border')})")
    print("block tags:", {name: sorted(tags) for name, tags in stream.block_tags.items()}, flush=True)
    for block, tag in (("minecraft:sand", "minecraft:triggers_ambient_desert_sand_block_sounds"),
                       ("minecraft:pale_oak_log", "minecraft:pale_oak_logs")):
        if tag not in stream.block_tags.get(block, set()):
            failures.append(f"the palette entry of {block} does not list the tag {tag}")
    # FluidRenderer's face occlusion by shapes that are not whole blocks and FlowingFluid's #blocks_fluid_flow
    slab = next((e for (n, props), e in stream.palette.items() if n == "minecraft:stone_slab" and "type=bottom" in props
                 and "waterlogged=false" in props), None)
    sign = next((e for (n, props), e in stream.palette.items() if n == "minecraft:oak_sign"), None)
    print("fluid palette hints:", json.dumps(slab), json.dumps(sign), flush=True)
    if not slab or [round(v, 3) for v in (slab.get("fc") or [0] * 6)[2:]] != [0.5] * 4:
        failures.append(f"the bottom slab's palette entry does not say how high it hides fluids: {slab}")
    if not sign or not sign.get("f", 0) & 2048:
        failures.append(f"the oak sign's palette entry is not marked as blocking fluid flow: {sign}")
    if env.get("drip") != "minecraft:dripping_dripstone_water":
        failures.append(f"env sample does not say what dry stalactites drip: {env.get('drip')}")
    # the overworld's ambient sounds: cave sounds in the dark (AmbientMoodSettings.LEGACY_CAVE_SETTINGS)
    mood = (env.get("amb") or {}).get("mood") or []
    if not mood or mood[0] != "minecraft:ambient.cave":
        failures.append(f"env sample has no cave mood sound: {env.get('amb')}")

    for event in ("init", "palette", "section", "ready", "entities", "env"):
        if not stream.events.get(event):
            failures.append(f"no '{event}' events")
    if stream.events.get("entities", 0) < 50:
        failures.append("entity frames are not live (expected ~20 per second)")
    if "Bob" not in stream.names:
        failures.append("the pig named Bob (name always visible) was not streamed with its name")
    if "minecraft:cow" not in stream.entity_types:
        failures.append("the cow in front of the camera was not streamed")
    print("display entities:", json.dumps({k: v[-1].get("disp") for k, v in stream.displays.items()}), flush=True)
    text = (stream.displays.get("minecraft:text_display") or [{}])[-1].get("disp", {})
    if ["Hello", 0xFFAA00, 1] not in text.get("tx", {}).get("s", []) or text.get("bb") != 3 or text.get("tx", {}).get("bg") != -16777216:
        failures.append(f"the text display was not streamed with its styled text, billboard and background (got {text})")
    blocks = stream.displays.get("minecraft:block_display") or []
    # (/summon puts an entity given whole coordinates in the middle of the block: -2.5 -60 3.5)
    stone = [e for e in blocks if abs(e["x"] + 2.5) < 0.1 and abs(e["z"] - 3.5) < 0.1]
    if not stone or "b" not in stone[-1].get("disp", {}) or stone[-1]["disp"].get("t", [0] * 14)[7] != 0.5:
        failures.append(f"the block display was not streamed with its block and scale (got {stone})")
    if any(abs(e["x"] + 1) < 0.8 and abs(e["y"] + 56) < 0.8 and abs(e["z"] + 8) < 0.8 for e in blocks):
        failures.append("the camera's own marker (a tagged block display) was streamed")
    item = (stream.displays.get("minecraft:item_display") or [{}])[-1]
    if item.get("item") != "minecraft:diamond" or item.get("disp", {}).get("ctx") != "fixed":
        failures.append(f"the item display was not streamed with its item and context (got {item})")
    print("mannequin:", json.dumps(stream.mannequin), flush=True)
    mannequin = stream.mannequin or {}
    if mannequin.get("profile", {}).get("name") != "Notch" or mannequin.get("desc") != "Shopkeeper":
        failures.append(f"the mannequin was not streamed with its profile and description (got {stream.mannequin})")
    print("worn heads:", json.dumps(stream.worn_heads), flush=True)
    zombie = stream.worn_heads.get("minecraft:zombie", {})
    if zombie.get("helm") != "minecraft:carved_pumpkin" or zombie.get("mainArm") != "left":
        failures.append(f"the left-handed zombie in a carved pumpkin was not streamed (got {zombie})")
    stand = stream.worn_heads.get("minecraft:armor_stand", {})
    if stand.get("skull", {}).get("t") != "player" or stand.get("skull", {}).get("name") != "Notch":
        failures.append(f"the armour stand's player head was not streamed with its owner (got {stand})")
    print("sulfur cube:", json.dumps(stream.sulfur_cube), flush=True)
    if "cb" not in (stream.sulfur_cube or {}):
        failures.append(f"the block held by the sulfur cube was not streamed (got {stream.sulfur_cube})")
    print("minecart:", json.dumps(stream.minecart), "stack:", json.dumps(stream.stack), "cloud:", json.dumps(stream.cloud), flush=True)
    if "db" not in (stream.minecart or {}) or "dOff" not in (stream.minecart or {}):
        failures.append(f"the furnace minecart was not streamed with its display block (got {stream.minecart})")
    if (stream.stack or {}).get("n") != 3 or "seed" not in (stream.stack or {}):
        failures.append(f"the stack of cobblestone was not streamed as three copies with its seed (got {stream.stack})")
    print("posed armour stand:", json.dumps(stream.posed_stand), flush=True)
    posed = (stream.posed_stand or {}).get("d", {})
    if posed.get("pose", {}).get("h") != [-15, 25, 0] or posed.get("pose", {}).get("ra") != [-100, 0, 0] or not posed.get("noBase") or not posed.get("arms"):
        failures.append(f"the posed armour stand was not streamed with its pose, arms and missing base plate (got {stream.posed_stand})")
    print("ominous item spawner:", json.dumps(stream.ominous), flush=True)
    if (stream.ominous or {}).get("item") != "minecraft:diamond" or (stream.ominous or {}).get("n") != 2:
        failures.append(f"the ominous item spawner was not streamed with its diamonds as two copies (got {stream.ominous})")
    cloud = (stream.cloud or {}).get("cloud", {})
    if cloud.get("p") != "minecraft:entity_effect" or not cloud.get("r") or "color" not in cloud.get("o", {}):
        failures.append(f"the poison cloud was not streamed with its radius and coloured particle (got {stream.cloud})")
    if not any(b[0] == 0 and b[1] == -60 and b[2] == 0 for b in stream.block_updates):
        failures.append("instant block update (mixin) did not arrive")
    print("animation states:", sorted(stream.animation_states), "entity events:", sorted(stream.entity_events), flush=True)
    if ("minecraft:breeze", "idle") not in stream.animation_states:
        failures.append("the breeze's running idle AnimationState was not streamed")
    print("foil:", sorted(stream.foil), "leashed:", sorted(stream.leashed), "effects:", sorted(stream.effects), flush=True)
    for effect, what in (("le:2001", "the broken block's level event"), ("ee:poof", "the killed sheep's death poof"),
                         ("ex:minecraft:explosion_emitter", "the TNT explosion"),
                         ("fw:large_ball", "the firework rocket's explosion"),
                         ("pm:moving", "the block pushed by the piston"),
                         ("be:minecraft:note_block", "the note block's block event"),
                         ("js:minecraft:music_disc.cat", "the jukebox song (level event 1010)"),
                         ("s:minecraft:block.note_block.harp", "the note block's sound"),
                         ("s:minecraft:block.stone.break", "the broken block's sound (level event 2001)"),
                         ("s:minecraft:entity.generic.explode", "the explosion's sound"),
                         ("ip:minecraft:wolf_armor", "the pieces of the broken wolf armour"),
                         ("s:minecraft:item.wolf_armor.break", "the broken wolf armour's sound")):
        if effect not in stream.effects:
            failures.append(f"{what} ({effect}) was not streamed as an effect")
    print("equipment:", sorted(stream.equipment, key=str), flush=True)
    if ("minecraft:armor_stand", "minecraft:leather", True, "minecraft:coast") not in stream.equipment:
        failures.append("the armour stand's dyed and trimmed leather chestplate was not streamed with its equipment asset")
    print("glowing:", sorted(stream.glowing), flush=True)
    if ("minecraft:cow", 0xFFFFFF) not in stream.glowing:
        failures.append("the glowing cow was not streamed with its outline colour")
    print("poses:", sorted(stream.poses), flush=True)
    for pose, what in ((("minecraft:fox", "sleeping", True), "the sleeping fox"),
                       (("minecraft:pillager", "armPose", "crossbow_hold"), "the pillager holding its crossbow")):
        if pose not in stream.poses:
            failures.append(f"{what} was not streamed with its pose")
    print("armour cracks:", sorted(stream.cracks), flush=True)
    if ("minecraft:wolf", "high") not in stream.cracks:
        failures.append("the worn wolf armour was not streamed with its cracks")
    if ("minecraft:kebab", 1, 1, "north") not in stream.paintings:
        failures.append(f"the kebab painting was not streamed with its size and facing (got {sorted(stream.paintings, key=str)})")
    if "minecraft:pig" not in stream.leashed:
        failures.append("the pig on a lead was not streamed with its leash")
    if not any(t == "minecraft:armor_stand" and f & 4 for t, f in stream.foil):
        failures.append("the armour stand's enchanted helmet was not streamed with its glint (foil)")
    if ("minecraft:sheep", 3) not in stream.entity_events:
        failures.append("the killed sheep's death entity event (3) was not streamed")
    # BeaconBlockEntity checks its pyramid every 80 ticks; the session reads beacon sections every 40
    deadline = time.time() + 20
    while stream.beacon_beam is None and time.time() < deadline:
        time.sleep(0.5)
    print("block entities:", stream.block_entities, "beacon beam:", stream.beacon_beam, flush=True)
    print("beacon:", rcon.command("data get block 10 -60 10 Levels"), flush=True)
    beam = stream.beacon_beam or {}
    if [section[0] for section in beam.get("s", [])][:2] != [0xF9FFFE, 0xB02E26]:
        failures.append(f"the beacon beam (white, then red above the glass) was not streamed (got {beam})")
    banner = stream.block_entities.get("banner", {})
    if [layer[0] for layer in banner.get("p", [])] != ["minecraft:stripe_bottom", "minecraft:creeper"]:
        failures.append(f"banner patterns were not streamed (got {banner})")
    if stream.block_entities.get("pot", {}).get("front") != "minecraft:skull_pottery_pattern":
        failures.append(f"decorated pot sherds were not streamed (got {stream.block_entities.get('pot')})")
    shelf = stream.block_entities.get("shelf", {})
    slots = [slot and slot.get("i") for slot in shelf.get("s", [])]
    if slots != ["minecraft:diamond", None, "minecraft:apple"]:
        failures.append(f"the items on the shelf were not streamed (got {shelf})")
    campfire = stream.block_entities.get("campfire", {})
    if not any(item and item.endswith("beef") for item in campfire.get("i", [])):
        failures.append(f"the food on the campfire was not streamed (got {campfire})")
    if stream.block_entities.get("spawner", {}).get("e") != "minecraft:zombie":
        failures.append(f"the spawner's zombie was not streamed (got {stream.block_entities.get('spawner')})")
    brush = stream.block_entities.get("brush", {})
    if brush.get("i") != "minecraft:diamond" or brush.get("d") != "up":
        failures.append(f"the diamond in the brushed suspicious sand was not streamed (got {brush})")
    if "Now Playing: C418 - cat" not in stream.jukebox_texts:
        failures.append(f"the jukebox's Now Playing text was not streamed (got {stream.jukebox_texts})")
    jukebox = stream.block_entities.get("jukebox", {})
    if jukebox.get("s") != "minecraft:music_disc.cat" or not jukebox.get("l"):
        failures.append(f"the jukebox's song was not streamed with its block entity (got {jukebox})")
    if stream.block_entities.get("head", {}).get("name") != "Notch":
        failures.append(f"the player head's owner was not streamed (got {stream.block_entities.get('head')}; its section "
                        f"(0, -4, -1) came {stream.section_messages.get((0, -4, -1))}; "
                        f"the block: {rcon.command('data get block 3 -60 -1')})")
    for line in ("CCTV", "Camera ci", "Welcome", "edited"):
        if line not in stream.sign_lines:
            failures.append(f"sign text '{line}' was not streamed (got {sorted(stream.sign_lines)})")
    if stream.error:
        failures.append(f"stream error: {stream.error}")

    stream.close()
    failures += far_terrain_check(rcon)
    failures += cache_check()
    failures += budget_check()
    failures += resubscribe_check()

    if failures:
        print("FAILED:\n - " + "\n - ".join(failures), flush=True)
        sys.exit(1)
    print("Smoke test passed.", flush=True)


def far_terrain_check(rcon):
    """A steep "mesa" 70 blocks in front of a second camera. Its whole chunk lies below the mesa top, but the
    face towards the camera is visible from the low ground in front of it, so those sections must be streamed
    (they used to be skipped as "buried"). Sections inside the mesa must still be skipped."""
    rcon.command("forceload add 32 -32 95 31")
    rcon.command("fill 48 -60 -16 79 -41 15 minecraft:stone")
    rcon.command("fill 48 -40 -16 79 -21 15 minecraft:stone")
    rcon.command("cctv create far -22 -45 0 -90 5")
    rcon.command("cctv range far 128")
    stream = StreamReader("far")
    stream.start()
    if not stream.ready.wait(90):
        return [f"far camera: no 'ready' event (events: {stream.events}, error: {stream.error})"]
    time.sleep(2)
    near_face = sorted(s for s in stream.sections if s[0] == 3)
    print("far camera sections:", len(stream.sections), "mesa front column:", near_face, flush=True)
    failures = []
    for section in [(3, -4, 0), (3, -3, 0), (3, -3, -1)]:
        if section not in stream.sections:
            failures.append(f"far camera: visible cliff section {section} was not streamed")
    if (4, -3, 0) in stream.sections:
        failures.append("far camera: a section inside the mesa was streamed (buried sections are not skipped)")
    stream.close()
    return failures


def hash53(text):
    """cyrb53 over UTF-16 code units, like the viewer's cache.js and Protocol.hash53."""
    def imul(a, b):
        return (a * b) & 0xFFFFFFFF
    h1, h2 = 0xDEADBEEF, 0x41C6CE57
    for ch in memoryview(text.encode("utf-16-le")).cast("H"):
        h1 = imul(h1 ^ ch, 2654435761)
        h2 = imul(h2 ^ ch, 1597334677)
    h1 = imul(h1 ^ (h1 >> 16), 2246822507)
    h1 ^= imul(h2 ^ (h2 >> 13), 3266489909)
    h2 = imul(h2 ^ (h2 >> 16), 2246822507)
    h2 ^= imul(h1 ^ (h1 >> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + h1


def read_until_ready(url, on_init=None, timeout=120):
    """Reads a stream until "ready": (init, {(x, y, z): section message}, [kept (x, y, z)])."""
    init, sections, kept = None, {}, []
    deadline = time.time() + timeout
    with urllib.request.urlopen(url, timeout=60) as response:
        event = None
        for raw in response:
            line = raw.decode().rstrip("\n")
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: ") and event:
                text = line[6:]
                if event == "init":
                    init = json.loads(text)
                    if on_init:
                        on_init(init)
                elif event == "section":
                    data = json.loads(text)
                    sections[(data["x"], data["y"], data["z"])] = text
                elif event == "keep":
                    k = json.loads(text)["k"]
                    kept.extend(tuple(k[i:i + 3]) for i in range(0, len(k), 3))
                elif event == "ready":
                    break
            if time.time() > deadline:
                break
    return init, sections, kept


def cache_check():
    """The browser's section cache (cache.js): a viewer that reports the sections it has (with the hash of each
    message) gets "keep" for the ones that did not change instead of the sections again."""
    url = f"{WEB}/api/cameras/ci/stream?cache=1"
    init, first, _ = read_until_ready(url)
    if not init or "vid" not in init:
        return ["cache: the stream gave no viewer id for the cache manifest"]
    manifest = ",".join(f"{x},{y},{z},{hash53(text)}" for (x, y, z), text in first.items())

    def post(second_init):
        request = urllib.request.Request(f"{WEB}/api/cameras/ci/cache?vid={second_init['vid']}&epoch={second_init['epoch']}",
                                         data=manifest.encode(), method="POST")
        urllib.request.urlopen(request, timeout=10).read()

    _, second, kept = read_until_ready(url, on_init=lambda i: threading.Thread(target=post, args=(i,), daemon=True).start())
    print("section cache:", len(first), "sections the first time,", len(kept), "kept and", len(second),
          "sent again the second time", flush=True)
    if not first or len(kept) < len(first) * 0.8:
        return [f"cache: only {len(kept)} of {len(first)} cached sections were kept"]
    return []


# Performance budgets (docs/ROADMAP.md 1.4): the server's milliseconds per camera tick (running average over
# the last seconds) and the average size of a section message.
TICK_MS_BUDGET = 3.0
SECTION_BYTES_BUDGET = 8192


def budget_check():
    status = json.loads(urllib.request.urlopen(f"{WEB}/api/status", timeout=10).read().decode())
    failures = []
    for session in status.get("sessions", []):
        sent = session.get("sectionsSent", 0)
        per_section = session.get("sectionBytes", 0) / sent if sent else 0
        print(f"budget: camera {session.get('camera')}: {session.get('tickMs')} ms per tick (max {session.get('tickMsMax')}),"
              f" {sent} sections sent, {per_section:.0f} bytes each, {session.get('sectionsKept')} kept,"
              f" {session.get('compacted')} of {session.get('sections')} kept compact; per part: {session.get('phases')},"
              f" most: {session.get('phasesMax')}", flush=True)
        if session.get("camera") == "far" and session.get("ready", 0) > 0 and session.get("ticks", 0) > 300 \
                and not session.get("compacted"):
            failures.append("memory: the far camera's far sections were not compacted")
        if session.get("camera") != "ci":
            continue
        if session.get("tickMs", 0) > TICK_MS_BUDGET:
            failures.append(f"budget: camera ci takes {session['tickMs']} ms per tick (budget {TICK_MS_BUDGET})")
        if per_section > SECTION_BYTES_BUDGET:
            failures.append(f"budget: sections of camera ci are {per_section:.0f} bytes (budget {SECTION_BYTES_BUDGET})")
    return failures


def resubscribe_check():
    """Nobody watches for over a minute: the camera sessions are released and the empty server pauses
    (pause-when-empty-seconds). The next viewer must wake the server up and get a stream."""
    time.sleep(75)
    stream = StreamReader("far")
    stream.start()
    ok = stream.ready.wait(90)
    print("far camera after idle:", stream.events, "sections:", len(stream.sections), "error:", stream.error,
          "connected:", stream.connected, "lines:", stream.lines, "reading:", stream.is_alive(), flush=True)
    if not ok:
        try:
            print("status:", urllib.request.urlopen(f"{WEB}/api/status", timeout=10).read().decode(), flush=True)
        except OSError as e:
            print("status unavailable:", e, flush=True)
    return [] if ok else [f"far camera: no 'ready' after a minute without viewers (events: {stream.events})"]


if __name__ == "__main__":
    main()
