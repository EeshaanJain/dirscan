#!/usr/bin/env python3
"""
Generate test fixtures by running the real dirscan.py on synthetic trees.

    python3 scripts/make_fixtures.py [--out fixtures/cache] [--force]

Writes snapshots, event streams and index.json into the output dir. Scanned trees
live in a temp dir and are deleted afterwards, so the roots recorded in the fixtures
no longer exist. One case is interrupted with SIGTERM so the partial-snapshot path is
covered; its timing is retried until the snapshot really is partial.
"""
import argparse
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCANNER = os.path.join(REPO, "dirscan.py")

EXTS = [".py", ".pt", ".npy", ".txt", ".JSON", ".log", "", ".tar.gz", ".bin"]


def build_tree(root, seed, n_dirs, files_per_dir, depth, big_every=0, real_bytes=False):
    """Random tree with n_dirs directories (not counting root). Returns the dir list."""
    rng = random.Random(seed)
    os.makedirs(root, exist_ok=True)
    dirs = [root]
    levels = {root: 0}
    for i in range(n_dirs):
        parent = rng.choice(dirs)
        if levels[parent] >= depth:
            parent = root
        d = os.path.join(parent, f"d{i}" if i % 7 else f"dir with space {i}")
        os.makedirs(d, exist_ok=True)
        dirs.append(d)
        levels[d] = levels[parent] + 1
    n = 0
    for d in dirs:
        for _ in range(rng.randint(0, files_per_dir)):
            n += 1
            name = f"f{n}{rng.choice(EXTS)}"
            p = os.path.join(d, name)
            size = rng.choice([0, 1, 100, 4096, 10_000, 250_000])
            if big_every and n % big_every == 0:
                size = rng.randint(1_000_000, 50_000_000)
            with open(p, "wb") as f:
                if real_bytes:
                    f.write(b"x" * min(size, 20_000))
                elif size:
                    f.truncate(size)
    # things the scanner must ignore or survive
    if dirs[1:]:
        os.symlink(dirs[1], os.path.join(root, "link-to-dir"))
    os.symlink("/nonexistent", os.path.join(root, "dangling"))
    return dirs


def run_scanner(root, cache_dir, extra=()):
    cmd = [sys.executable, SCANNER, root, "--cache-dir", cache_dir, "-q", "--rescan", *extra]
    subprocess.run(cmd, check=True)


def snapshot_for(cache_dir, root, mode):
    idx = json.load(open(os.path.join(cache_dir, "index.json")))
    for path, m in idx.items():
        if m["root"] == root and m["mode"] == mode:
            return path
    raise SystemExit(f"no index entry for {root} ({mode})")


def interrupted(root, cache_dir, tries=12):
    """Scan `root` and SIGTERM it mid-flight; retry until the snapshot is partial."""
    delay = 0.35
    for attempt in range(tries):
        proc = subprocess.Popen([sys.executable, SCANNER, root, "--cache-dir", cache_dir,
                                 "-q", "--rescan"])
        time.sleep(delay)
        proc.send_signal(signal.SIGTERM)
        proc.wait()
        snap = json.load(open(snapshot_for(cache_dir, root, "apparent")))
        visited = sum(1 for r in snap["dirs"] if r[6] & 2)
        if not snap["complete"] and 0 < visited < len(snap["dirs"]):
            print(f"  interrupted after {delay:.2f}s: {visited}/{len(snap['dirs'])} dirs visited")
            return
        # finished too early -> wait longer is wrong; interrupted too early -> wait longer
        delay = delay * 0.5 if snap["complete"] else delay * 1.6
    raise SystemExit("could not produce a partial snapshot")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, "fixtures", "cache"))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--big-dirs", type=int, default=4000,
                    help="dirs in the interrupted-scan tree")
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    stamp = os.path.join(out, ".stamp")
    scanner_mtime = str(os.path.getmtime(SCANNER)) + str(os.path.getmtime(__file__))
    if not args.force and os.path.exists(stamp) and open(stamp).read() == scanner_mtime:
        return
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    tmp = tempfile.mkdtemp(prefix="dirscan-fixtures-")
    try:
        print("small (apparent + du)")
        small = os.path.join(tmp, "small")
        build_tree(small, seed=1, n_dirs=60, files_per_dir=6, depth=6, big_every=40,
                   real_bytes=True)
        os.makedirs(os.path.join(small, "empty-dir"))
        run_scanner(small, out)
        run_scanner(small, out, ["--du"])

        print("flat (root with files only)")
        flat = os.path.join(tmp, "flat")
        os.makedirs(flat)
        for i in range(5):
            with open(os.path.join(flat, f"f{i}.txt"), "w") as f:
                f.write("hello" * i)
        run_scanner(flat, out)

        print("empty")
        empty = os.path.join(tmp, "empty")
        os.makedirs(empty)
        run_scanner(empty, out)

        if hasattr(os, "geteuid") and os.geteuid() != 0:
            print("unreadable")
            un = os.path.join(tmp, "unreadable")
            build_tree(un, seed=2, n_dirs=15, files_per_dir=3, depth=3, real_bytes=True)
            locked = os.path.join(un, "locked")
            os.makedirs(os.path.join(locked, "inner"))
            open(os.path.join(locked, "secret"), "w").write("x")
            os.chmod(locked, 0)
            try:
                run_scanner(un, out)
            finally:
                os.chmod(locked, 0o755)

        print(f"interrupted ({args.big_dirs} dirs)")
        big = os.path.join(tmp, "big")
        build_tree(big, seed=3, n_dirs=args.big_dirs, files_per_dir=40, depth=8, big_every=500)
        interrupted(big, out)
    finally:
        # unreadable dir is already restored; make sure removal can't trip on modes
        shutil.rmtree(tmp, ignore_errors=True)

    open(stamp, "w").write(scanner_mtime)
    print("fixtures written to", out)


if __name__ == "__main__":
    main()
