"""End-to-end smoke test run by CI against a real dedicated server with the mod.

Talks to the server over RCON (like an admin console), places a camera with
/cctv, then reads the live stream like a browser would and checks that world
data, entities and instant block updates arrive.
"""
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
        self.block_updates = []
        self.ready = threading.Event()
        self.error = None

    def run(self):
        try:
            with urllib.request.urlopen(self.url, timeout=60) as response:
                event = None
                for raw in response:
                    line = raw.decode().rstrip("\n")
                    if line.startswith("event: "):
                        event = line[7:]
                    elif line.startswith("data: ") and event:
                        data = json.loads(line[6:])
                        self.events[event] = self.events.get(event, 0) + 1
                        self.first.setdefault(event, data)
                        if event == "entities":
                            self.entity_types.update(e["type"] for e in data["e"])
                        elif event == "blocks":
                            self.block_updates.extend(data["b"])
                        elif event == "ready":
                            self.ready.set()
        except Exception as e:  # noqa: BLE001 - reported below
            self.error = e


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


def main():
    if "--stop" in sys.argv:
        Rcon().command("stop")
        return

    rcon = wait_for_server()
    rcon.command("forceload add -48 -48 48 48")
    rcon.command("time set 1000")
    rcon.command("gamerule doDaylightCycle false")
    rcon.command("fill 2 -60 8 8 -56 14 minecraft:oak_planks hollow")
    rcon.command("setblock 5 -59 8 minecraft:glass")
    rcon.command("setblock -3 -60 6 minecraft:oak_log")
    rcon.command("setblock -3 -59 6 minecraft:oak_leaves")
    for mob, x, z in [("cow", -2, 4), ("pig", 1, 3), ("sheep", 3, 5), ("villager", -1, 7), ("creeper", 4, 2)]:
        rcon.command(f"summon minecraft:{mob} {x} -60 {z}")

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
    time.sleep(4)

    print("events:", stream.events, flush=True)
    print("init:", stream.first.get("init"), flush=True)
    print("entity types:", sorted(stream.entity_types), flush=True)
    print("block updates:", stream.block_updates[:10], flush=True)
    print("first palette entries:", json.dumps(stream.first.get("palette"))[:800], flush=True)

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

    for event in ("init", "palette", "section", "ready", "entities", "env"):
        if not stream.events.get(event):
            failures.append(f"no '{event}' events")
    if stream.events.get("entities", 0) < 50:
        failures.append("entity frames are not live (expected ~20 per second)")
    if "minecraft:cow" not in stream.entity_types:
        failures.append("the cow in front of the camera was not streamed")
    if not any(b[0] == 0 and b[1] == -60 and b[2] == 0 for b in stream.block_updates):
        failures.append("instant block update (mixin) did not arrive")
    if stream.error:
        failures.append(f"stream error: {stream.error}")

    if failures:
        print("FAILED:\n - " + "\n - ".join(failures), flush=True)
        sys.exit(1)
    print("Smoke test passed.", flush=True)


if __name__ == "__main__":
    main()
