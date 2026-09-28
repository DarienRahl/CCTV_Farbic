"""Downloads the client jar (and optionally the server jar) of a Minecraft version from Mojang.

Usage: fetch_minecraft.py <version> <client.jar> [<server.jar>]
The server download is Mojang's bundler; the real server jar is extracted from it.
"""
import io
import json
import sys
import urllib.request
import zipfile


def main():
    version, client = sys.argv[1], sys.argv[2]
    server = sys.argv[3] if len(sys.argv) > 3 else None
    manifest = json.load(urllib.request.urlopen("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"))
    entry = next((v for v in manifest["versions"] if v["id"] == version), None)
    if entry is None:
        sys.exit(f"Unknown Minecraft version {version}")
    downloads = json.load(urllib.request.urlopen(entry["url"]))["downloads"]
    urllib.request.urlretrieve(downloads["client"]["url"], client)
    if server:
        bundle = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(downloads["server"]["url"]).read()))
        inner = next(n for n in bundle.namelist() if n.startswith("META-INF/versions/") and n.endswith(".jar"))
        with open(server, "wb") as f:
            f.write(bundle.read(inner))


if __name__ == "__main__":
    main()
