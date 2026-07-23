#!/usr/bin/env python3
"""Regenerate orientation/videos.json from glove-cache metadata.

Walks the glove_wrist_cache directory, groups _glove_r{N}_meta.json files
by video stem, and writes the video list the labeler reads on load. The
Apps Script URL is NOT written here — it lives in config.local.json.

Run after extracting new glove caches:
    python orientation/build_videos_json.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from collections import defaultdict

GLOVE_CACHE = Path(
    "/Users/mathewieme/Google Drive/My Drive/boxing_ai/glove_wrist_cache"
)
OUT = Path(__file__).parent / "videos.json"

# Set to True for any video stem that should be the held-out test set.
# Labelers won't see these in the dropdown; they're reserved for evaluating
# the trained model's generalization to unseen videos.
HELD_OUT = {
    # Example (edit before running):
    # "10 Combos Every Fighter Must Know",
}


def main() -> int:
    if not GLOVE_CACHE.exists():
        raise SystemExit(f"Glove cache dir not found: {GLOVE_CACHE}")

    by_stem: dict[str, list[dict]] = defaultdict(list)
    for meta_path in sorted(GLOVE_CACHE.glob("*_glove_r*_meta.json")):
        # Extract stem + round from filename "<stem>_glove_r<N>_meta.json"
        m = re.match(r"^(.+?)_glove_r(\d+)_meta\.json$", meta_path.name)
        if not m:
            continue
        stem, round_num = m.group(1), int(m.group(2))
        try:
            meta = json.loads(meta_path.read_text())
        except Exception as e:
            print(f"  skipping {meta_path.name}: {e}")
            continue
        by_stem[stem].append({
            "round": round_num,
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
            "heldOut": stem in HELD_OUT,
            "rounds": rounds,
        })

    # videos.json holds ONLY the video list. The Apps Script deployment URL
    # lives in the untracked config.local.json (this repo is public) — the
    # page merges it at runtime, so it is never written here.
    config = {
        "videos": videos,
    }
    OUT.write_text(json.dumps(config, indent=2, ensure_ascii=False))
    print(f"Wrote {OUT}")
    print(f"  {len(videos)} videos · "
          f"{sum(len(v['rounds']) for v in videos)} rounds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
