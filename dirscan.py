#!/usr/bin/env python3
"""
dirscan: live disk-usage scan with a JSON cache and a live event stream.

  python3 dirscan.py ROOT             show a fresh cached scan if there is one, else scan and cache
  python3 dirscan.py ROOT --rescan    force a new scan
  python3 dirscan.py ROOT --du        allocated blocks (like du) instead of apparent size
  python3 dirscan.py --list-cache     list cached and running scans

While scanning it appends events to <cache>.events.ndjson so a viewer can follow
along live; when done it writes the full snapshot to <cache>.json.
Both formats (version 2) are documented in VIEWER_SPEC.md.
"""
import argparse
import hashlib
import heapq
import json
import os
import shutil
import signal
import socket
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone

CACHE_VERSION = 2
F_UNREADABLE, F_VISITED, F_COMPLETE = 1, 2, 4   # bits of the dir "flags" field
BULK_EVERY = 5.0                                # seconds between largest/extension events

DEFAULT_CACHE_DIR = os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "dirscan")

ap = argparse.ArgumentParser(description="Live disk-usage scan with a JSON cache.")
ap.add_argument("root", nargs="?", default=".")
ap.add_argument("-n", "--rows", type=int, default=20, help="max rows per table (default 20)")
ap.add_argument("--du", action="store_true",
                help="count allocated disk blocks (like du) instead of apparent size")
ap.add_argument("--interval", type=float, default=0.5, help="refresh interval in seconds")
ap.add_argument("--rescan", action="store_true", help="ignore the cache and scan again")
ap.add_argument("--max-age", type=float, default=24,
                help="hours before a cached scan counts as stale (default 24)")
ap.add_argument("--no-cache", action="store_true",
                help="neither read nor write the cache (also disables events)")
ap.add_argument("--no-events", action="store_true", help="don't write the live event stream")
ap.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR, help=f"default: {DEFAULT_CACHE_DIR}")
ap.add_argument("-o", "--out", help="write the cache to this file instead of the cache dir")
ap.add_argument("--largest", type=int, default=1000,
                help="how many of the largest files to record (default 1000)")
ap.add_argument("-q", "--quiet", action="store_true", help="no terminal output (for use by the viewer)")
ap.add_argument("--list-cache", action="store_true", help="list cached and running scans and exit")
args = ap.parse_args()
if hasattr(signal, "SIGPIPE"):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # quiet exit when piped into head/less
args.cache_dir = os.path.abspath(os.path.expanduser(args.cache_dir))

LIVE = sys.stdout.isatty() and not args.quiet
COLOR = LIVE and "NO_COLOR" not in os.environ
HOST = socket.gethostname()


def sty(code, s):
    return f"\033[{code}m{s}\033[0m" if COLOR else s


bold = lambda s: sty("1", s)
dim = lambda s: sty("2", s)
green = lambda s: sty("32", s)
yellow = lambda s: sty("33", s)
cyan = lambda s: sty("36", s)


def human(n):
    n = float(n)
    for u in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1024:
            return f"{n:,.1f} {u}"
        n /= 1024
    return f"{n:,.1f} EB"


def ago(seconds):
    s = int(max(0, seconds))
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if s >= n:
            return f"{s // n}{unit} ago"
    return f"{s}s ago"


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


# ---------------------------------------------------------------- cache I/O

def write_json(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)  # atomic: readers never see a half-written file


def read_index(cache_dir):
    try:
        with open(os.path.join(cache_dir, "index.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def update_index(path, entry):
    cache_dir = os.path.dirname(path)
    idx = read_index(cache_dir)
    idx[path] = entry
    write_json(os.path.join(cache_dir, "index.json"), idx)


if args.list_cache:
    idx = read_index(args.cache_dir)
    if not idx:
        print(f"no cached scans in {args.cache_dir}")
        sys.exit(0)
    key = lambda kv: kv[1].get("scanned_epoch") or kv[1].get("started_epoch", 0)
    for path, m in sorted(idx.items(), key=key, reverse=True):
        when = m.get("scanned_epoch") or m.get("started_epoch", 0)
        flag = ""
        if m.get("in_progress"):
            alive = m.get("host") != HOST or pid_alive(m.get("pid", -1))
            flag = yellow(f"  scanning (pid {m.get('pid')})") if alive else yellow("  abandoned")
        elif not m.get("complete"):
            flag = yellow("  partial")
        if not os.path.exists(path) and not m.get("in_progress"):
            flag += dim("  (file missing)")
        print(f"{human(m.get('bytes', 0)):>10}  {m.get('files', 0):>12,} files  {m['mode']:<8}  "
              f"{ago(time.time() - when):>8}  {bold(m['root'])}{flag}")
        print(dim(f"{'':>10}  {path}"))
    sys.exit(0)

root = os.path.abspath(args.root)
if not os.path.isdir(root):
    sys.exit(f"not a directory: {root}")
mode = "du" if args.du else "apparent"


def default_cache_file():
    if args.out:
        return os.path.abspath(args.out)
    h = hashlib.sha1(f"{root}\0{mode}".encode("utf-8", "surrogateescape")).hexdigest()[:10]
    name = os.path.basename(root) or "root"
    return os.path.join(args.cache_dir, f"{name}-{mode}-{h}.json")


cache_file = None if args.no_cache else default_cache_file()
events_file = None
if cache_file and not args.no_events:
    events_file = (cache_file[:-5] if cache_file.endswith(".json") else cache_file) + ".events.ndjson"


def load_fresh(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if data.get("version") != CACHE_VERSION or not data.get("complete"):
        return None
    if (time.time() - data.get("scanned_epoch", 0)) / 3600 > args.max_age:
        return None
    return data


# ---------------------------------------------------------------- state

ROOT_FILES = "(files in root)"

ext_size, ext_count = defaultdict(int), defaultdict(int)
top_size, top_count = defaultdict(int), defaultdict(int)
pending = defaultdict(int)  # dirs still to scan under each top-level entry

# one row per directory; a parent's index is always smaller than its children's
# [parent, name, own_bytes, own_files, total_bytes, total_files, flags]
DIR_FIELDS = ["parent", "name", "own_bytes", "own_files", "total_bytes", "total_files", "flags"]
dirs = [[-1, os.path.basename(root) or root, 0, 0, 0, 0, 0]]
largest = []  # min-heap of (bytes, mtime, dir_index, name)

files_seen = bytes_seen = dirs_seen = errors = 0
current_path, current_top = root, None
start = time.time()
duration = None   # set when showing a cached scan
heading = None    # overrides the title line
notes = []        # extra footer lines
last_tick = 0.0
last_bulk = 0.0
interrupted = False


def largest_list():
    return [[d, n, s, m] for s, m, d, n in sorted(largest, reverse=True)]


def extensions_dict():
    return {e: {"files": ext_count[e], "bytes": ext_size[e]} for e in ext_size}


# ---------------------------------------------------------------- display

EIGHTHS = " ▏▎▍▌▋▊▉"


def bar(frac, width):
    filled = max(0.0, min(1.0, frac)) * width
    whole = int(filled)
    part = EIGHTHS[int((filled - whole) * 8)] if whole < width else ""
    return ("█" * whole + part).ljust(width)


def shorten(s, w):
    return s if len(s) <= w else s[: w - 1] + "…"


def status(name):
    if name == ROOT_FILES or pending[name] == 0:
        return green("✓")          # fully scanned
    if name == current_top:
        return yellow("●")         # scanning now
    return dim("·")                # not started yet


def table(title, sizes, counts, limit, cols, marks=False):
    items = sorted(sizes.items(), key=lambda kv: kv[1], reverse=True)
    shown, hidden = items[:limit], items[limit:]
    name_w = min(36, max([10] + [len(k) for k, _ in shown]))
    fixed = 2 + name_w + 2 + 10 + 2 + 10 + 2 + 6 + 2
    bar_w = max(8, min(40, cols - fixed - 1))

    lines = [bold(title),
             dim(f"  {'NAME':<{name_w}}  {'FILES':>10}  {'SIZE':>10}  {'%':>6}")]
    for name, size in shown:
        frac = size / bytes_seen if bytes_seen else 0.0
        mark = status(name) if marks else " "
        lines.append(
            f"{mark} {shorten(name, name_w):<{name_w}}  {counts[name]:>10,}  "
            f"{human(size):>10}  {frac * 100:>5.1f}%  {cyan(bar(frac, bar_w))}"
        )
    if hidden:
        lines.append(dim(f"  … {len(hidden):,} more  ({human(sum(v for _, v in hidden))})"))
    return lines


def frame(final):
    cols, rows = shutil.get_terminal_size((100, 40))
    elapsed = duration if duration is not None else max(time.time() - start, 1e-9)

    stats = f"{files_seen:,} files · {dirs_seen:,} dirs · {human(bytes_seen)} · "
    if duration is not None:
        stats += f"scan took {elapsed:,.1f}s"
    else:
        stats += f"{files_seen / elapsed:,.0f} files/s · {elapsed:,.1f}s"
    if args.du:
        stats += " · disk usage"
    if errors:
        stats += f" · {errors:,} unreadable"

    if LIVE and not final:
        limit = max(3, min(args.rows, (rows - 12) // 2))  # fit both tables on screen
    else:
        limit = args.rows

    out = [heading or bold(("Scanned " if final else "Scanning ") + root),
           "  " + stats,
           dim("─" * min(cols, 100))]
    out += table("By top-level entry", top_size, top_count, limit, cols, marks=True)
    out.append("")
    out += table("By extension", ext_size, ext_count, limit, cols)
    out.append("")
    if interrupted:
        out.append(yellow("  interrupted, partial results"))
    elif not final:
        out.append(dim("  in: " + shorten(current_path, max(10, cols - 8))))
    out += notes
    return out


def emit(lines, inplace):
    if args.quiet:
        return
    if inplace and LIVE:
        sys.stdout.write("\033[H" + "\n".join(l + "\033[K" for l in lines) + "\n\033[J")
    else:
        sys.stdout.write("\n".join(lines) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------- cached view

cached = None if (cache_file is None or args.rescan) else load_fresh(cache_file)
if cached:
    t = cached["totals"]
    bytes_seen, files_seen, dirs_seen, errors = t["bytes"], t["files"], t["dirs"], t["errors"]
    duration = cached["duration_s"]
    for e, v in cached["extensions"].items():
        ext_size[e], ext_count[e] = v["bytes"], v["files"]
    d = cached["dirs"]
    if d[0][3]:
        top_size[ROOT_FILES], top_count[ROOT_FILES] = d[0][2], d[0][3]
    for r in d[1:]:
        if r[0] == 0:
            top_size[r[1]], top_count[r[1]] = r[4], r[5]
    heading = bold(f"Cached scan of {root}") + dim(
        f"  ({ago(time.time() - cached['scanned_epoch'])}; --rescan to refresh)")
    notes.append(dim(f"  cache: {cache_file}"))
    emit(frame(final=True), inplace=False)
    sys.exit(0)


# ---------------------------------------------------------------- live events

class Events:
    """Append-only NDJSON stream, one compact JSON array per line."""

    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.f = open(path, "w", encoding="ascii", buffering=1 << 20)

    def emit(self, *rec):
        self.f.write(json.dumps(rec, separators=(",", ":")) + "\n")

    def flush(self):
        self.f.flush()

    def close(self):
        self.f.close()


ev = Events(events_file) if events_file else None
if ev:
    ev.emit("h", {"version": CACHE_VERSION, "root": root, "host": HOST, "mode": mode,
                  "pid": os.getpid(), "started_epoch": int(start), "cache_file": cache_file,
                  "dir_fields": DIR_FIELDS,
                  "flags": {"unreadable": F_UNREADABLE, "visited": F_VISITED, "complete": F_COMPLETE}})
    ev.emit("n", 0, -1, dirs[0][1])
    ev.flush()
if cache_file:
    try:
        update_index(cache_file, {"root": root, "host": HOST, "mode": mode, "pid": os.getpid(),
                                  "started_epoch": int(start), "in_progress": True,
                                  "complete": False, "events": events_file})
    except OSError:
        pass


def tick():
    global last_tick, last_bulk
    now = time.time()
    if now - last_tick < args.interval:
        return
    last_tick = now
    if LIVE:
        emit(frame(False), inplace=True)
    if ev:
        ev.emit("p", files_seen, dirs_seen, bytes_seen, errors, round(now - start, 1), current_path)
        if now - last_bulk >= BULK_EVERY:
            ev.emit("L", largest_list())
            ev.emit("x", extensions_dict())
            last_bulk = now
        ev.flush()


def _stop(signum, frame_):
    raise KeyboardInterrupt


for _sig in ("SIGTERM", "SIGHUP"):
    if hasattr(signal, _sig):
        signal.signal(getattr(signal, _sig), _stop)


# ---------------------------------------------------------------- scan

def finalize_totals():
    for r in dirs:
        r[4], r[5] = r[2], r[3]
        r[6] = (r[6] | F_COMPLETE) if r[6] & F_VISITED else (r[6] & ~F_COMPLETE)
    for i in range(len(dirs) - 1, 0, -1):  # children always come after parents
        r = dirs[i]
        p = dirs[r[0]]
        p[4] += r[4]
        p[5] += r[5]
        if not r[6] & F_COMPLETE:
            p[6] &= ~F_COMPLETE


def write_cache(path, complete):
    now = time.time()
    data = {
        "version": CACHE_VERSION,
        "tool": "dirscan.py",
        "root": root,
        "host": HOST,
        "mode": mode,
        "scanned_at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "started_epoch": int(start),
        "scanned_epoch": int(now),
        "duration_s": round(now - start, 2),
        "complete": complete,
        "totals": {"bytes": bytes_seen, "files": files_seen, "dirs": len(dirs), "errors": errors},
        "dir_fields": DIR_FIELDS,
        "flags": {"unreadable": F_UNREADABLE, "visited": F_VISITED, "complete": F_COMPLETE},
        "dirs": dirs,
        "file_fields": ["dir", "name", "bytes", "mtime"],
        "largest_files": largest_list(),
        "extensions": extensions_dict(),
    }
    write_json(path, data)
    entry = {k: data[k] for k in ("root", "host", "mode", "scanned_at", "started_epoch",
                                  "scanned_epoch", "duration_s", "complete")}
    entry.update(bytes=bytes_seen, files=files_seen, dirs=len(dirs),
                 in_progress=False, events=events_file)
    update_index(path, entry)
    return data


if LIVE:
    sys.stdout.write("\033[?25l\033[2J")  # hide cursor, clear screen

stack = [(root, None, 0)]
try:
    while stack:
        path, top, di = stack.pop()
        current_path, current_top = path, top
        row = dirs[di]
        try:
            with os.scandir(path) as it:
                dirs_seen += 1
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            t = entry.name if top is None else top
                            if top is None:  # register so empty dirs still show
                                top_size.setdefault(t, 0)
                                top_count.setdefault(t, 0)
                            pending[t] += 1
                            dirs.append([di, entry.name, 0, 0, 0, 0, 0])
                            child = len(dirs) - 1
                            stack.append((entry.path, t, child))
                            if ev:
                                ev.emit("n", child, di, entry.name)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue

                        st = entry.stat(follow_symlinks=False)
                        size = st.st_blocks * 512 if args.du else st.st_size
                        ext = os.path.splitext(entry.name)[1].lower() or "[no ext]"
                        t = ROOT_FILES if top is None else top

                        row[2] += size
                        row[3] += 1
                        ext_size[ext] += size
                        ext_count[ext] += 1
                        top_size[t] += size
                        top_count[t] += 1
                        files_seen += 1
                        bytes_seen += size

                        if args.largest > 0:
                            item = (size, int(st.st_mtime), di, entry.name)
                            if len(largest) < args.largest:
                                heapq.heappush(largest, item)
                            elif size > largest[0][0]:
                                heapq.heapreplace(largest, item)
                    except OSError:
                        errors += 1
                    tick()
        except OSError:
            errors += 1
            row[6] |= F_UNREADABLE
        row[6] |= F_VISITED
        if ev:
            ev.emit("s", di, row[2], row[3], row[6])
        if top is not None:
            pending[top] -= 1
        tick()
except KeyboardInterrupt:
    interrupted = True
finally:
    current_top = None
    finalize_totals()
    if cache_file:
        try:
            data = write_cache(cache_file, complete=not interrupted)
            note = dim(f"  cache: {cache_file}")
            if interrupted:
                note += yellow("  (partial, won't be reused)")
            notes.append(note)
        except OSError as e:
            notes.append(yellow(f"  could not write cache: {e}"))
    if ev:
        ev.emit("L", largest_list())
        ev.emit("x", extensions_dict())
        ev.emit("e", {"complete": not interrupted, "duration_s": round(time.time() - start, 2),
                      "cache_file": cache_file,
                      "totals": {"bytes": bytes_seen, "files": files_seen,
                                 "dirs": len(dirs), "errors": errors}})
        ev.close()
    emit(frame(final=True), inplace=True)
    if LIVE:
        sys.stdout.write("\033[?25h")  # restore cursor
        sys.stdout.flush()