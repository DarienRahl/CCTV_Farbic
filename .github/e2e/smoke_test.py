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
        self.url = f"{WEB}/api/cameras/{camera}/stream"
        self.events = {}
        self.first = {}
        self.entity_types = set()
        self.foil = set()
        self.leashed = set()
        self.effects = set()
        self.block_updates = []
        self.sections = set()
        self.names = set()
        self.sign_lines = set()
        self.block_entities = {}
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
                            for e in data["e"]:
                                for name in e.get("anim", {}):
                                    self.animation_states.add((e["type"], name))
                                for event_id in e.get("ev", []):
                                    self.entity_events.add((e["type"], event_id))
                                if e.get("foil"):
                                    self.foil.add((e["type"], e["foil"]))
                                if e.get("leash"):
                                    self.leashed.add(e["type"])
                            self.names.update(e["name"] for e in data["e"] if e.get("nameVisible"))
                            for fx in data.get("fx", []):
                                # level events by type, entity effects by kind, explosions by particle
                                self.effects.add(fx[0] + ":" + str(fx[6] if fx[0] == "ex" else fx[1]))
                        elif event == "blocks":
                            self.block_updates.extend(data["b"])
                        elif event == "section":
                            self.sections.add((data["x"], data["y"], data["z"]))
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
    rcon.command("fill -8 -61 6 -4 -61 12 minecraft:water")
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
    rcon.command("item replace entity @e[type=minecraft:armor_stand,limit=1] armor.head"
                 " with minecraft:golden_helmet[enchantments={'minecraft:protection':1}]")

    rcon.command("cctv create ci -1 -56 -8 10 30")
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
    rcon.command("setblock 4 -60 -4 minecraft:stone")
    rcon.command("setblock 4 -60 -4 minecraft:air destroy")
    rcon.command("summon minecraft:tnt -20 -59 -24 {fuse:0}")
    rcon.command('data merge block -3 -60 0 {front_text:{messages:["CCTV","edited","",""]}}')
    rcon.command("kill @e[type=minecraft:sheep]")
    time.sleep(4)

    print("events:", stream.events, flush=True)
    print("init:", stream.first.get("init"), flush=True)
    print("entity types:", sorted(stream.entity_types), flush=True)
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

    try:
        bundle = wait_for_assets()
        print("assets:", {k: len(v) for k, v in bundle.items() if isinstance(v, dict)}, flush=True)
        for key in ("blockstates", "models", "textures"):
            if len(bundle.get(key, {})) < 500:
                failures.append(f"asset bundle has too few {key}")
    except RuntimeError as e:
        failures.append(str(e))

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
    for key in ("sky", "fog", "sunAngle", "skyFactor", "ambient", "blockTint"):
        if key not in env:
            failures.append(f"env sample has no {key}")

    for event in ("init", "palette", "section", "ready", "entities", "env"):
        if not stream.events.get(event):
            failures.append(f"no '{event}' events")
    if stream.events.get("entities", 0) < 50:
        failures.append("entity frames are not live (expected ~20 per second)")
    if "Bob" not in stream.names:
        failures.append("the pig named Bob (name always visible) was not streamed with its name")
    if "minecraft:cow" not in stream.entity_types:
        failures.append("the cow in front of the camera was not streamed")
    if not any(b[0] == 0 and b[1] == -60 and b[2] == 0 for b in stream.block_updates):
        failures.append("instant block update (mixin) did not arrive")
    print("animation states:", sorted(stream.animation_states), "entity events:", sorted(stream.entity_events), flush=True)
    if ("minecraft:breeze", "idle") not in stream.animation_states:
        failures.append("the breeze's running idle AnimationState was not streamed")
    print("foil:", sorted(stream.foil), "leashed:", sorted(stream.leashed), "effects:", sorted(stream.effects), flush=True)
    for effect, what in (("le:2001", "the broken block's level event"), ("ee:poof", "the killed sheep's death poof"),
                         ("ex:minecraft:explosion_emitter", "the TNT explosion")):
        if effect not in stream.effects:
            failures.append(f"{what} ({effect}) was not streamed as an effect")
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
    campfire = stream.block_entities.get("campfire", {})
    if not any(item and item.endswith("beef") for item in campfire.get("i", [])):
        failures.append(f"the food on the campfire was not streamed (got {campfire})")
    if stream.block_entities.get("head", {}).get("name") != "Notch":
        failures.append(f"the player head's owner was not streamed (got {stream.block_entities.get('head')})")
    for line in ("CCTV", "Camera ci", "Welcome", "edited"):
        if line not in stream.sign_lines:
            failures.append(f"sign text '{line}' was not streamed (got {sorted(stream.sign_lines)})")
    if stream.error:
        failures.append(f"stream error: {stream.error}")

    stream.close()
    failures += far_terrain_check(rcon)
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
