"""Finds out whether the mod can move to a newer Minecraft release (used by the watch-minecraft workflow).

Reads the newest release from Mojang's version manifest (or the version given), compares it with
minecraft_version in gradle.properties, and checks that Fabric Loader and Fabric API support it and that
the branch update/<version> does not exist yet (so every version is tried once). Prints GitHub Actions
outputs: version (empty when there is nothing to do), current, and reason.
Usage: watch_minecraft.py [<version>]
"""
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def current_version():
    with open("gradle.properties", encoding="utf-8") as f:
        match = re.search(r"^minecraft_version=(.+)$", f.read(), re.M)
    return match.group(1).strip()


def fabric_support(version):
    """Why Fabric cannot build the version yet, or None when it can."""
    try:
        if not json.loads(fetch(f"https://meta.fabricmc.net/v2/versions/loader/{version}")):
            return f"Fabric Loader does not support {version} yet"
    except urllib.error.URLError as e:
        return f"Fabric's servers could not be asked about {version} ({e})"
    metadata = fetch("https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml").decode()
    if f"+{version}</version>" not in metadata:
        return f"there is no Fabric API build for {version} yet"
    return None


def branch_exists(branch):
    result = subprocess.run(["git", "ls-remote", "--heads", "origin", branch], capture_output=True, text=True)
    return bool(result.stdout.strip())


def main():
    manifest = json.loads(fetch(MANIFEST))
    wanted = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else manifest["latest"]["release"]
    current = current_version()
    known = {v["id"] for v in manifest["versions"]}
    version, reason = "", ""
    if wanted not in known:
        reason = f"Mojang does not list {wanted}"
    elif wanted == current:
        reason = f"the mod is on {current}, the newest release"
    elif branch_exists(f"update/{wanted}"):
        reason = f"update/{wanted} exists already, so {wanted} was tried before"
    else:
        reason = fabric_support(wanted) or f"{wanted} is out and Fabric supports it"
        if reason.endswith("supports it"):
            version = wanted
    print(f"version={version}")
    print(f"current={current}")
    print(f"reason={reason}")


if __name__ == "__main__":
    main()
