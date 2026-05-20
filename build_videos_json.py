#!/usr/bin/env python3
"""Regenerate boxing-labeler/videos.json from Apple Vision pose-cache metadata.

The orientation labeler ONLY labels videos that appear in videos.json. Each
saved label's (round, frame) is a direct index into `<video>_vision_r<round>.npy`,
so a label without a matching cache entry is unrecoverable at train time.

Run this script after extracting new Apple Vision caches and commit + push
the resulting videos.json so the deployed labeler picks them up. Videos
not yet in videos.json simply won't appear in the dropdown.

    python build_videos_json.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
from collections import defaultdict

CACHE = pathlib.Path(
    "/Users/mathewieme/Library/CloudStorage/GoogleDrive-mathee.wieme@gmail.com/"
    "My Drive/boxing_ai/apple_vision_pose_cache"
)
OUT = pathlib.Path(__file__).parent / "videos.json"

# Stems that should be hidden from labelers (reserved for unseen-video evals).
# Preserved across regens by reading the previous videos.json.
HELD_OUT_FALLBACK: set[str] = set()


def main() -> int:
    if not CACHE.exists():
        print(f"cache dir not found: {CACHE}", file=sys.stderr)
        return 1

    # Carry forward heldOut flags from any existing videos.json so we don't
    # lose curation work on every regen.
    prev_held: set[str] = set(HELD_OUT_FALLBACK)
    if OUT.exists():
        try:
            prev = json.loads(OUT.read_text())
            for v in prev.get("videos", []):
                if v.get("heldOut"):
                    prev_held.add(v["stem"])
        except Exception as e:
            print(f"warning: couldn't read previous {OUT.name}: {e}", file=sys.stderr)

    by_stem: dict[str, list[dict]] = defaultdict(list)
    pat = re.compile(r"^(?P<stem>.+)_vision_r(?P<rnd>\d+)_meta\.json$")
    for meta_path in sorted(CACHE.glob("*_vision_r*_meta.json")):
        if meta_path.name.endswith(".bak.json"):
            continue
        m = pat.match(meta_path.name)
        if not m:
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except Exception as e:
            print(f"  skipping {meta_path.name}: {e}")
            continue
        # Sanity: the matching .npy must exist or the round is useless.
        npy = meta_path.with_name(meta_path.name.replace("_meta.json", ".npy"))
        if not npy.exists():
            continue
        by_stem[m.group("stem")].append({
            "round": int(m.group("rnd")),
            "n_frames": int(meta["n_frames"]),
            "fps": float(meta["fps"]),
            "actual_start_sec": float(
                meta.get("actual_start_sec", meta.get("start_sec", 0))
            ),
        })

    videos = []
    for stem in sorted(by_stem):
        rounds = sorted(by_stem[stem], key=lambda r: r["round"])
        videos.append({
            "stem": stem,
            "heldOut": stem in prev_held,
            "rounds": rounds,
        })

    OUT.write_text(json.dumps({"videos": videos}, indent=2, ensure_ascii=False))
    print(f"wrote {OUT}")
    print(f"  {len(videos)} videos · {sum(len(v['rounds']) for v in videos)} rounds")
    print(f"  heldOut preserved: {sum(1 for v in videos if v['heldOut'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
