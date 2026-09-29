#!/usr/bin/env python3
"""Deep-merge new message keys into both locale catalogs: i18n-merge.py <patch.json>
Patch shape: {"en": {...}, "bn": {...}}. Keeps key order stable and formatting consistent."""
import json, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent / "packages/localization/src/locales"

def merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict):
            merge(dst.setdefault(k, {}), v)
        else:
            dst[k] = v

patch = json.load(open(sys.argv[1], encoding="utf8"))
for loc in ("en", "bn"):
    p = root / f"{loc}.json"
    data = json.load(open(p, encoding="utf8"))
    merge(data, patch[loc])
    with open(p, "w", encoding="utf8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
print("merged")
