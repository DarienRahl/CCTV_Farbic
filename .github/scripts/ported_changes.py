"""Summarises how the game classes the viewer ports changed between two Minecraft versions, as Markdown.

Takes the two folders of decompiled sources (inspect-minecraft's "diff ported classes" step) and
docs/ported-classes.txt, whose comment lines name the viewer files each group of classes is ported to,
and lists per group the classes that changed (with the number of changed lines), appeared or went away.
Usage: ported_changes.py <old sources> <new sources> <ported-classes.txt> <old version> <new version>
"""
import difflib
import os
import sys


def source(folder, cls):
    """The decompiled source of a class and its nested classes (Vineflower writes them into one file)."""
    path = os.path.join(folder, cls + ".java")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read().splitlines()


def main():
    old, new, listing, old_version, new_version = sys.argv[1:6]
    groups, heading = [], None
    with open(listing, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                text = line.lstrip("#").strip()
                # a heading starts a group; the comment lines right after it continue the heading
                if heading is not None and not groups[-1][1]:
                    groups[-1][0] += " " + text
                else:
                    heading = text
                    groups.append([text, []])
                continue
            if not groups:
                groups.append(["(no group)", []])
            groups[-1][1].append(line)

    lines = [f"## Ported game classes from {old_version} to {new_version}", ""]
    changed = unchanged = 0
    for title, classes in groups:
        entries = []
        for cls in classes:
            before, after = source(old, cls), source(new, cls)
            if before is None and after is None:
                entries.append(f"- `{cls}`: not in either version (renamed or moved before?)")
            elif after is None:
                entries.append(f"- `{cls}`: **gone** in {new_version} (renamed or moved?)")
            elif before is None:
                entries.append(f"- `{cls}`: new in {new_version}")
            elif before != after:
                diff = [d for d in difflib.unified_diff(before, after, lineterm="", n=0) if d[:1] in "+-" and d[:3] not in ("+++", "---")]
                entries.append(f"- `{cls}`: {len(diff)} lines changed")
            else:
                unchanged += 1
                continue
            changed += 1
        if entries:
            lines.append(f"**{title}**")
            lines.extend(entries)
            lines.append("")
    if changed == 0:
        lines.append(f"None of the {unchanged} classes changed: the viewer needs no porting.")
    else:
        lines.append(f"{changed} classes to look at, {unchanged} unchanged. The full diff is in the log of the "
                     "`diff ported classes` step; port the changes into the files each group names (docs/UPDATING.md).")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
