// Frame candidate generation for the orientation labeler.
//
// For each video, we produce a deterministic list of (round, frame) pairs
// the labelers will be asked about. The same seed + same video = same set,
// so labelers can resume across sessions and different team members can
// share a video without overlapping (or can be deliberately assigned
// overlapping slices for inter-rater agreement checks).
//
// Algorithm:
//   1. Walk every round.
//   2. Split each round into BUCKET_SECONDS-second windows.
//   3. Pick a random frame inside each window using a seeded RNG.
//   4. If the resulting candidate list exceeds the per-video cap, sample
//      down to the cap (seeded).
//   5. Shuffle the final list so labelers don't see chronologically
//      adjacent frames in sequence (kills cognitive fatigue patterns).

const DEFAULTS = {
  bucketSeconds: 5,
  perVideoCap: 100,
  // Per-video seed offset: combine with video stem hash for deterministic
  // but-not-everyone-sees-the-same-thing sampling.
  seedSalt: 0,
};

// Mulberry32 — small deterministic PRNG. Standard, well-distributed.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  // Simple deterministic 32-bit hash — used to seed the per-video RNG.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export function pickCandidates(video, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const seed = (hashString(video.stem) + cfg.seedSalt) >>> 0;
  const rng = mulberry32(seed);

  const candidates = [];
  for (const r of video.rounds || []) {
    const fps = Number(r.fps);
    const n_frames = Number(r.n_frames);
    if (!(fps > 0) || !(n_frames > 0)) continue;
    const roundSec = n_frames / fps;
    const nBuckets = Math.max(1, Math.floor(roundSec / cfg.bucketSeconds));
    const framesPerBucket = n_frames / nBuckets;
    for (let b = 0; b < nBuckets; b++) {
      const lo = Math.floor(b * framesPerBucket);
      const hi = Math.min(n_frames - 1, Math.floor((b + 1) * framesPerBucket) - 1);
      if (hi < lo) continue;
      const f = lo + Math.floor(rng() * (hi - lo + 1));
      candidates.push({ round: r.round ?? 0, frame: f });
    }
  }

  if (candidates.length > cfg.perVideoCap) {
    shuffleInPlace(candidates, mulberry32(seed ^ 0xC0FFEE));
    candidates.length = cfg.perVideoCap;
  }
  // Final shuffle — present non-chronologically
  shuffleInPlace(candidates, mulberry32(seed ^ 0xBADC0DE));
  return candidates;
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Quick sanity-checkable summary for the UI.
export function candidatesSummary(video, candidates) {
  const perRound = new Map();
  for (const c of candidates) {
    perRound.set(c.round, (perRound.get(c.round) || 0) + 1);
  }
  return {
    total: candidates.length,
    perRound: Object.fromEntries(perRound),
    bucketSeconds: DEFAULTS.bucketSeconds,
    perVideoCap: DEFAULTS.perVideoCap,
  };
}
