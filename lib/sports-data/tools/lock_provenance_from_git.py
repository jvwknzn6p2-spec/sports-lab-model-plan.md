#!/usr/bin/env python3
"""Reconstruct from git history alone WHEN each pick was produced, and check
the rule lock-provenance.ts uses for picks that carry no `predictedAt`.

Read-only: walks `git log` / `git show`, writes nothing to the repository.
Needs full history (CI checks out depth 1 — run it on a full clone:
`git fetch --unshallow`).

    python3 lib/sports-data/tools/lock_provenance_from_git.py [data|data-npb]

For every (slate date, gamePk) it finds, across every committed version of
the lock file:
  - the BET: the pick standing in the last version produced before the pick's
    own lockDeadline, or — when no version predates it — the first version;
  - when that pick content was produced (the version's updatedAt, else its
    lockedAt, else the commit time) and first committed;
  - whether the content changed in any later version (it must not).

Then it compares that git-derived tier with the tier lock-provenance.ts
derives from the CURRENT lock file (flag + lockedAt) and prints every
disagreement. 2026-09-25: 716 MLB + 133 NPB games, 0 disagreements, 0
post-deadline changes; lockedAt within 2 s of the git-derived production
time for every late pick.
"""
import collections
import datetime as dt
import json
import os
import subprocess
import sys

LEAGUE = sys.argv[1] if len(sys.argv) > 1 else "data"
ROOT = subprocess.run(
    ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
).stdout.strip()
PATH = f"lib/sports-data/{LEAGUE}/predictions"
LATE_FLAG = "[warn] predicted_after_deadline"


def git(*a):
    return subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True, check=True).stdout


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def pick_key(p):
    h, t = p.get("handicap") or {}, p.get("total") or {}
    return json.dumps([
        p.get("pass"), p.get("predictedWinner"), p.get("winProbability"),
        p.get("confidence"), h.get("pick"), h.get("ev"), (h.get("input") or {}).get("notation"),
        t.get("pick"), t.get("line"), t.get("ev"),
    ], sort_keys=True)


def tier_from_lock(p, locked_at):
    """The legacy rule of lock-provenance.ts (picks without predictedAt)."""
    if LATE_FLAG not in (p.get("flags") or []):
        return "on_time"
    la, start = ts(locked_at), ts(p.get("gameDate"))
    if la is None or start is None:
        return "unverified"
    return "late_pre_start" if la < start else "post_start"


if git("rev-parse", "--is-shallow-repository").strip() == "true":
    sys.exit("shallow clone — run `git fetch --unshallow` first")

versions = collections.defaultdict(list)
sha = ctime = None
for line in git("log", "--reverse", "--format=%H %cI", "--name-only", "--", PATH).splitlines():
    if not line.strip():
        continue
    if line.startswith(PATH):
        try:
            versions[line].append((ts(ctime), json.loads(git("show", f"{sha}:{line}"))))
        except subprocess.CalledProcessError:
            continue  # the file was deleted in this commit
    else:
        sha, ctime = line.split(" ", 1)

counts, disagreements, mutated, drift = collections.Counter(), [], [], []
for f, vs in sorted(versions.items()):
    date = os.path.basename(f)[:-5]
    games = collections.defaultdict(list)
    for commit_t, d in vs:
        run_t = ts(d.get("updatedAt")) or ts(d.get("lockedAt")) or commit_t
        for p in d.get("predictions", []):
            games[p["gamePk"]].append((commit_t, run_t, p))
    current = os.path.join(ROOT, f)
    if not os.path.exists(current):
        continue
    lock = json.load(open(current))
    by_pk = {p["gamePk"]: p for p in lock.get("predictions", [])}
    for pk, hist in games.items():
        if pk not in by_pk:
            continue
        start, deadline = ts(by_pk[pk].get("gameDate")), ts(by_pk[pk].get("lockDeadline"))
        pre = [i for i, h in enumerate(hist) if deadline and h[1] < deadline]
        if pre:
            bi, tier = pre[-1], "on_time"
        else:
            bi = 0
            tier = "late_pre_start" if start and hist[0][1] < start else "post_start"
        bkey = pick_key(hist[bi][2])
        gi = bi
        while gi > 0 and pick_key(hist[gi - 1][2]) == bkey:
            gi -= 1
        produced = hist[gi][1]
        counts[tier] += 1
        if any(pick_key(h[2]) != bkey for h in hist[bi + 1:]):
            mutated.append((date, pk))
        rule = tier_from_lock(by_pk[pk], lock.get("lockedAt"))
        if rule != tier:
            disagreements.append((date, pk, tier, rule))
        if tier != "on_time" and ts(lock.get("lockedAt")) is not None:
            gap = abs((ts(lock["lockedAt"]) - produced).total_seconds())
            if gap > 2:
                drift.append((date, pk, gap))

print(f"{LEAGUE}: {sum(counts.values())} games {dict(counts)}")
print(f"changed after their bet was fixed: {len(mutated)} {mutated[:10]}")
print(f"git tier != lock-file rule: {len(disagreements)} {disagreements[:10]}")
print(f"late picks whose lockedAt differs from git production time by >2 s: {len(drift)} {drift[:10]}")
sys.exit(1 if mutated or disagreements or drift else 0)
