"""Copies the files listed in distribution.manifest.json to a destination folder: python scripts/build_dist.py <dest> [--force]."""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "distribution.manifest.json")


def load_manifest(path=MANIFEST):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def shipped_files(manifest, root=ROOT):
    """Relative paths of every file the build contains (raises FileNotFoundError on a listed path that does not exist)."""
    skip_names, skip_suffixes = set(manifest.get("exclude_names", [])), tuple(manifest.get("exclude_suffixes", []))
    out = []
    for entry in manifest["include"]:
        full = os.path.join(root, entry)
        if os.path.isfile(full):
            out.append(entry)
        elif os.path.isdir(full):
            for base, dirs, files in os.walk(full):
                dirs[:] = [d for d in dirs if d not in skip_names]
                for name in files:
                    if name not in skip_names and not name.endswith(skip_suffixes):
                        out.append(os.path.relpath(os.path.join(base, name), root))
        else:
            raise FileNotFoundError(f"distribution.manifest.json : {entry} n'existe pas")
    return sorted(set(out))


def build(dest, force=False):
    if os.path.isdir(dest) and os.listdir(dest) and not force:
        raise FileExistsError(f"{dest} n'est pas vide (--force pour ecraser)")
    files = shipped_files(load_manifest())
    for rel in files:
        target = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel), target)
    return len(files)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--force"]
    if len(args) != 1:
        sys.exit("usage: python scripts/build_dist.py <dest> [--force]")
    try:
        print(f"{build(os.path.abspath(args[0]), '--force' in sys.argv)} fichiers copies vers {args[0]}")
    except (FileExistsError, FileNotFoundError) as exc:
        sys.exit(str(exc))
