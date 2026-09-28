"""Points the project at another Minecraft version (used by the update-minecraft workflow).

Resolves the newest Fabric Loader and Fabric API for the version from Fabric's servers and
updates gradle.properties and fabric.mod.json. Usage: bump_minecraft.py <minecraft version>
"""
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def loader_for(minecraft):
    entries = json.loads(fetch(f"https://meta.fabricmc.net/v2/versions/loader/{minecraft}"))
    if not entries:
        sys.exit(f"Fabric Loader does not support Minecraft {minecraft} yet")
    stable = [e for e in entries if e["loader"].get("stable")]
    return (stable or entries)[0]["loader"]["version"]


def fabric_api_for(minecraft):
    metadata = ET.fromstring(fetch("https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml"))
    versions = [v.text for v in metadata.iter("version") if v.text and v.text.endswith("+" + minecraft)]
    if not versions:
        sys.exit(f"No Fabric API build for Minecraft {minecraft} yet")
    return versions[-1]


def replace(path, pattern, value):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    updated, count = re.subn(pattern, value, text, flags=re.M)
    if count == 0:
        sys.exit(f"{path}: nothing matched {pattern}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(updated)


def main():
    minecraft = sys.argv[1].strip()
    loader = loader_for(minecraft)
    api = fabric_api_for(minecraft)
    replace("gradle.properties", r"^minecraft_version=.*$", f"minecraft_version={minecraft}")
    replace("gradle.properties", r"^loader_version=.*$", f"loader_version={loader}")
    replace("gradle.properties", r"^fabric_api_version=.*$", f"fabric_api_version={api}")
    replace("src/main/resources/fabric.mod.json", r'"minecraft": "[^"]*"', f'"minecraft": "~{minecraft}"')
    replace("src/main/resources/fabric.mod.json", r'"fabricloader": "[^"]*"', f'"fabricloader": ">={loader}"')
    print(f"Minecraft {minecraft}: Fabric Loader {loader}, Fabric API {api}")


if __name__ == "__main__":
    main()
