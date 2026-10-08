# dirscan-view

A local web viewer for [`dirscan.py`](dirscan.py), for understanding disk usage on the machine
where the files actually are, which is often a remote cluster reached over SSH.

1. **Follow a scan live.** While `dirscan.py` runs (in a terminal, or started from the viewer) the
   treemap and tables fill in as directories are scanned. Finished subtrees are ticked ✓,
   unfinished ones are striped and show lower-bound sizes (`≥ 1.2 GB`).
2. **Browse finished scans.** A cached snapshot opens instantly, with no rescan.
3. **Inspect at a low level.** In any directory, the *Files here* tab lists the real files and
   subdirectories straight from the filesystem, including tiny files that are not in the scan's
   largest-files list, sparse files (size vs. size on disk), symlinks, and directories the scan
   has not reached yet.

It is a personal tool that runs from this repo, not a published package. Scans are done by
**[gdu](https://github.com/dundee/gdu)** (about 4× faster than the Python scanner), with `dirscan.py` as a
fallback engine; both write the same cache files, so the UI cannot tell them apart. The formats in
[`VIEWER_SPEC.md`](VIEWER_SPEC.md) are a fixed contract.

## Setup

Needs Node ≥ 18 and, for scanning, Python 3.

```sh
npm install
npm run build
npm start -- [args]        # = node server/index.js [args]
```

`npm run dev` starts the API server (127.0.0.1:4174) and the Vite dev server (5173, proxying `/api`)
for working on the UI; it takes the same arguments and prints its own URL. Optionally `npm link` for
a `dirscan-view` command.

## Usage

```sh
npm start                          # dashboard: every scan in the cache, running ones first
npm start -- <path>                # open the running scan of <path> if any, else its newest snapshot
npm start -- <path> --scan [--du]  # start a fresh scan of <path> and follow it live
npm start -- <snapshot.json>       # open one snapshot (also a file copied from another machine)
```

| option | |
|---|---|
| `--port 4173` | Port. If you don't pass one and it is busy, the next free port is used. |
| `--host 127.0.0.1` | Loopback addresses only; anything else is refused. |
| `--no-open` | Don't try to open a browser (it is also skipped over SSH or without a display). |
| `--cache-dir <dir>` | dirscan's cache (default `$XDG_CACHE_HOME/dirscan` or `~/.cache/dirscan`). |
| `--engine auto\|gdu\|python` | Scanner for scans started from the viewer (default `auto`: gdu if found, else Python). |
| `--gdu <path>` | The gdu binary. Default: `$DIRSCAN_GDU`, then `gdu` on `$PATH`. An explicit path is never silently replaced by another gdu. |
| `--scanner ./dirscan.py` / `--python python3` | What the `python` engine runs. |

On start it prints a URL with a random token:

```
  dirscan-view  http://127.0.0.1:4173/?token=…#/scan?file=…
  on a remote machine? from your laptop:  ssh -L 4173:127.0.0.1:4173 <this-host>
```

### On a cluster

Run it on the login (or compute) node that holds the files, then tunnel from your laptop and open the
printed URL, token included, in your local browser:

```sh
ssh -L 4173:127.0.0.1:4173 <this-host>
```

The local port may differ from the remote one (`-L 8000:127.0.0.1:4173` works). The token is read once
from the URL, kept in `sessionStorage` for that tab, and removed from the address bar.

A scan started with `dirscan.py` on another node of a shared cache shows up as *on node07* and is not
followed (its files are on a different machine). Run dirscan-view on that node instead.

## Scan engines

The viewer reads dirscan's cache (`index.json`, `<name>.json` snapshots, `<name>.events.ndjson` streams);
it does not care who wrote them. Two things can:

- **`scanner/gduscan.js`** (default): runs gdu and writes the same files. It takes the same flags as
  `dirscan.py` (`ROOT --du --rescan --quiet --cache-dir …`), so it is also usable on its own:
  `node scanner/gduscan.js <dir> [--du] [--rescan]`.
- **`dirscan.py`**: the original single-threaded Python walker, kept as a fallback for machines without gdu.

Measured on the same 1.5M-file, 124k-directory, 8.3 TB tree (warm cache): **gdu 53 s, gduscan.js 59 s,
dirscan.py 220 s.** A gdu scan and a Python scan of the same root share one snapshot key, so each replaces
the other's result.

**Live following with gdu.** gdu writes its JSON export only when it finishes, so it cannot be tailed. To
keep the live treemap, `gduscan.js` reads the top few directory levels itself (cheap), then runs gdu once
per directory below them (3 at a time) and turns each finished export into the usual `n`/`s` events at once.
The treemap therefore fills in piece by piece, with finished pieces ticked ✓, instead of directory by
directory. gdu's own totals are ignored: sizes are re-summed from its per-file entries so they mean exactly
what `dirscan.py` computed (regular files only, each hardlink counted, no size for directories themselves);
unreadable directories come from gdu's error log. For both `--du` and apparent mode one run holds both
numbers. Tests check that every directory, total, extension and large file is identical to `dirscan.py`'s on
the same tree, in both modes.

Differences to know about:

- **Lumpy progress.** A piece is one directory; if one directory holds most of the data, the view sits still
  while gdu works on it (on the 1.5M-file tree the last ~300k files arrived as one piece after a 40 s pause in which
  the counters stood still while the elapsed time kept ticking). Directories with more than 20,000 entries or 256 subdirectories are not split
  further.
- **Fifos.** gdu marks sockets and symlinks as non-regular but not fifos, so inside a directory that gdu
  scans, a fifo counts as an empty file (sizes are unaffected). Directories read by the planner are exact.
- **Interrupted scans are exact.** A directory is only counted when it is finished, so unlike `dirscan.py` the
  partial snapshot of a stopped scan matches its event stream exactly.
- A scan of a single huge flat directory (or one with a huge number of entries) is one gdu run, so it shows
  nothing until it is done.

## What's in the UI

- **Dashboard**: all scans (root, host, mode, state, size, files, age), a live progress line for running
  ones, *Open* / *Rescan* / *Stop*, and *Scan a path…* with an apparent / du toggle. The sidebar lists the
  same scans.
- **Scan view**: stat cards (with files/s, errors and the current path while live), a clickable
  breadcrumb, the treemap, and a resizable side panel with four tabs: **Subdirs**, **Files here** (live
  from disk), **Largest files** (this subtree or global) and **Extensions** (global).
- **Treemap**: squarified, two levels deep, at most ~400 tiles (the rest roll into "other (N)"), colored
  by top-level folder or by size class. Hovering shows the path, size, % of the dir, % of the root and the
  file count; clicking a tile opens it. While live it re-lays out once a second and animates the change.
- **Keyboard**: `/` or `⌘K`/`Ctrl+K` search · `↑ ↓` move in a table · `Enter` open · `Backspace` or
  `Alt+←` up one level · `c` copy the current path.
- All view state (scan, directory, tab, color mode, scope) is in the URL hash, so reloads, bookmarks and
  the browser's Back button work. Light, dark and system themes are in the sidebar footer.

## How live mode works

`dirscan.py` appends to `<snapshot>.events.ndjson` (about every 0.5 s) and writes the snapshot when it
ends. The server tails that file by polling `fs.stat` every 300 ms, because `fs.watch` is unreliable
on NFS/Lustre/GPFS, holds back an unfinished last line until its newline arrives, and sends the lines to
the browser as Server-Sent Events (batches of up to ~5,000 lines, a keepalive every 15 s). A client that
connects mid-scan receives the file from offset 0 and then follows it. A restarted scan (the file shrinks,
or its first line changes, which also catches a file that regrew between two polls) starts a fresh stream
and the browser resets on the new `h` event.

The browser applies the events with an incremental reducer (`src/lib/events.ts`): totals are added to the
directory and its ancestors, and a per-subtree count of unscanned directories decides when a subtree is
complete, O(depth) per event with no recomputation. Events are applied in slices of a few milliseconds
and the UI is notified at most four times a second, so a 10k events/s backlog never blocks it. When the
final `e` event arrives, the view swaps to the snapshot on disk (directory ids are identical, so your
position is kept).

Because `EventSource` cannot send headers, the client reads the stream with `fetch`.

Scan state comes from `index.json`: **running** if its host is this machine and the pid is alive (and, where
`/proc` is readable, still looks like Python/dirscan, so a recycled pid is not mistaken for a scanner);
**abandoned** if the pid is gone (the scanner was SIGKILLed; the viewer replays what it got through);
**remote** if it ran elsewhere.

## Security

It is meant to run on shared login nodes, where other users can reach your localhost ports.

- Binds to `127.0.0.1` only. Every `/api/*` call must carry the per-run token (`crypto.randomBytes(24)`) in
  the `x-dirscan-token` header, compared in constant time; otherwise 403. The token is never accepted in a
  query string. Requests whose `Host` header is not a loopback name are refused (DNS rebinding).
- When it opens a browser it points it at a private (0700, short-lived) local page that redirects to the
  URL, so the token never appears in `ps` output; the printed URL is the only other place it is shown.
- Read-only toward your data: there are no delete, move or write endpoints. The only process it starts is
  `dirscan.py`, and the only one it will signal is one it started itself (it holds the child handle, so a
  recycled pid cannot be hit). Scans it starts are detached, so they survive the viewer exiting. Stop sends SIGTERM once per scan: a
  repeat signal during the scanner's shutdown can leave it with no snapshot.
- `/api/ls` serves only paths that, after `fs.realpath`, lie inside the root of some scan in the index (or a
  root given on the command line). `..`, symlinks pointing out, and name-prefix siblings (`/data/proj` vs
  `/data/proj-evil`) are rejected; a path that cannot be resolved gets the same 403 whether or not it
  exists, so it cannot be used to probe the filesystem.
- `/api/snapshot` and `/api/live` only serve scans listed in the index (or a snapshot file given on the
  command line), and read the events file next to the snapshot rather than a path taken from the index.
- The page is served with a restrictive Content-Security-Policy.

## Development

```sh
npm test            # vitest: reducer, server, store, library, 1M-dir performance
npm run build       # tsc -b && vite build
npm run fixtures    # regenerate test fixtures with the real dirscan.py
npm run synthetic -- --dirs 1000000   # write fixtures/synthetic-1m.json to try the viewer on
```

Tests build their fixtures by running the real `dirscan.py` on small synthetic trees (including one
interrupted with SIGTERM) into `fixtures/cache/` (git-ignored; regenerated when `dirscan.py` changes). The
gdu engine's tests need a gdu binary (they are skipped without one) and compare its output with `dirscan.py`'s
on trees with symlinks, hardlinks, sparse and empty files, odd names and unreadable directories, replay its
events through the reducer, and interrupt it with SIGTERM.

```
server/       CLI, HTTP server, tailing, spawning, path guards (plain Node, no framework)
scanner/      the gdu engine: export parser, chunk planner, scan state, cache-file writer, CLI
src/lib/      pure TypeScript: snapshot parsing, event reducer, tree, treemap layout, search, store
src/ui/       app components built from the shadcn components
src/hooks/    routing, scan list polling, scan lifecycle
src/components/ui/   shadcn-generated, untouched
tests/        vitest suites; scripts/ has the fixture and synthetic-snapshot generators
```

### Stack notes

shadcn/ui was set up with `npx shadcn@latest init -t vite -b base -p nova` (the defaults: Tailwind v4,
**Base UI** primitives, neutral base color, Lucide icons) and every component was added with
`shadcn add`; none are edited. Every component named in the spec exists in the current default registry,
so nothing had to be substituted. Things that differ from older shadcn/React-Table habits:

- Base UI, not Radix: triggers use `render={<Button />}` instead of `asChild`, `ToggleGroup` values are
  arrays, and toasts come from `@/components/ui/toast` (`toast.add({…})`), not Sonner.
- `Resizable` is react-resizable-panels v4: `orientation`, and sizes as strings (`"50%"`).
- `@tanstack/react-table` is **v9** (`tableFeatures`, `useTable`, `table.FlexRender`), not v8.
- Only `--chart-1…5` were changed from the preset, from grays to hued OKLCH values in both modes, because
  the treemap colors top-level folders from them and a gray palette would be indistinguishable.
- The shadcn `Table` wrapper adds an `overflow-x` container that breaks sticky headers in a virtualized
  list, so `DataTable` composes its parts (`TableHeader`, `TableRow`, …) inside its own scroller.
- `tsconfig.app.json` sets `noUnusedLocals: false` only because generated files in `components/ui` carry
  unused imports and must stay untouched.

## Known limitations

- **Interrupted scans and the live tree (Python engine).** If `dirscan.py` is killed by SIGTERM *during* `scandir` of a
  directory, it counts that directory's files so far into the snapshot but never emits an `s` event for
  it (and does not mark it visited). The event stream therefore cannot reproduce those bytes: the live tree
  can be short by that one directory's own files until the final `e` event, when the viewer switches to the
  snapshot, which is authoritative. The reducer test asserts the exact invariant (live totals equal the
  snapshot totals over visited directories) for this case, and exact equality for complete scans.
- `npm audit` currently reports 7 high-severity findings, all one issue (`braces`, a stack-exhaustion DoS on
  pathological glob patterns) reached through the `shadcn` CLI's tooling. It is dev-time only: the server
  uses just Node built-ins and nothing from it is in the browser bundle. `npm audit fix --force` would
  make breaking changes, so it was left alone.
- Search lowercases the name column once per tree (about 60 ms at 1M dirs); for finished scans this is done
  while the browser is idle. A live scan's tree grows, so its index is extended on demand.
- Subsequence ("fuzzy") matching only kicks in when a search finds fewer than 8 substring matches.
- `--python` must be the interpreter itself: a wrapper such as `conda run` would swallow the SIGTERM that
  Stop sends. `dirscan.py` writes `index.json` with a non-atomic read-modify-write, so two scans ending at
  the same instant could drop an entry (the viewer then waits up to 10 s and reports the start as failed).
- Scans started from the viewer keep running if the viewer exits; after a restart it can no longer stop
  them (it only stops processes it started itself).

## Performance

Measured on a synthetic 1,000,000-directory snapshot (35.7 MB), in headless Chromium and in Node:

| | measured | target |
|---|---|---|
| navigation → first treemap drawn (fetch, parse, index, layout, render) | ~1.4 s | < 2 s |
| `JSON.parse` + columnar build (Node) | ~0.55–0.65 s | < 2 s |
| treemap layout of the root / busiest dir | < 1 ms | < 50 ms |
| open a directory / go up / re-sort a table (browser) | 3–33 ms | < 50 ms |
| search per keystroke (warm) | ~26 ms | < 50 ms |
| live event reducer | > 1,000,000 events/s | 10,000 events/s |

`tests/perf.test.ts` asserts these budgets.
