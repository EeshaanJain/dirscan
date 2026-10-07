# dirscan-view: build spec

Build **dirscan-view**, a local web viewer for `dirscan.py` (which sits in this repo). It is a personal tool that runs from this repo with `npm`, not a published package. The goal is to understand disk usage on the machine where the files actually are, which is often a remote cluster reached over SSH. It does three jobs:

1. **Follow a scan live.** While `dirscan.py` runs, in a terminal or started from the viewer, the UI fills in as directories are scanned.
2. **Browse finished scans.** Load a cached snapshot instantly, with no rescan.
3. **Inspect at a low level.** In any directory, list its actual files and subdirectories straight from the filesystem, down to individual small files that are not in the scan's largest-files list.

Do not change `dirscan.py` or its file formats. Treat the formats below as a fixed contract.

## Files written by dirscan.py (format version 2)

Everything lives in the cache dir: `~/.cache/dirscan/`, or `$XDG_CACHE_HOME/dirscan/`.

### `index.json`
This is an object keyed by the absolute snapshot path. The scanner writes an entry when a scan starts and updates it when the scan ends.

```json
{ "/home/u/.cache/dirscan/genbo-apparent-1a2b3c4d5e.json": {
    "root": "/cv/home/jaine1/code/genbo", "host": "node01", "mode": "apparent",
    "pid": 4242, "started_epoch": 1791374000,
    "in_progress": true, "complete": false,
    "events": "/home/u/.cache/dirscan/genbo-apparent-1a2b3c4d5e.events.ndjson",
    "scanned_at": "…", "scanned_epoch": 1791374400, "duration_s": 12.3,
    "bytes": 0, "files": 0, "dirs": 0 } }
```

The `scanned_*`, `duration_s`, `bytes`, `files` and `dirs` fields only appear once the scan has ended. An entry with `in_progress: true` is running if its `host` equals `os.hostname()` and `process.kill(pid, 0)` succeeds. If `host` matches but the pid is dead, the entry is **abandoned** (the scanner was SIGKILLed); show it as such. If `host` differs, the scan ran on another machine: show it as "on <host>" and don't try to tail it.

### Snapshot: `<name>-<mode>-<hash>.json`
The snapshot is written once, at the end of a scan. Interrupted scans (Ctrl-C, SIGTERM, SIGHUP) still write one, with `complete: false`.

```json
{
  "version": 2, "tool": "dirscan.py",
  "root": "/abs/path", "host": "node01", "mode": "apparent" | "du",
  "scanned_at": "ISO-8601 UTC", "started_epoch": 0, "scanned_epoch": 0, "duration_s": 0,
  "complete": true,
  "totals": { "bytes": 0, "files": 0, "dirs": 0, "errors": 0 },
  "dir_fields": ["parent","name","own_bytes","own_files","total_bytes","total_files","flags"],
  "flags": { "unreadable": 1, "visited": 2, "complete": 4 },
  "dirs": [[-1, "genbo", 3, 1, 5403, 4, 6], [0, "a", 300, 1, 5300, 2, 6]],
  "file_fields": ["dir","name","bytes","mtime"],
  "largest_files": [[4, "x.pt", 5000, 1791359698]],
  "extensions": { ".pt": { "files": 1, "bytes": 5000 } }
}
```

- `dirs` is a flat list, and the row index is the dir id. Row 0 is the root, with `parent = -1`. A parent always has a smaller id than its children.
- `own_*` covers files directly in that dir. `total_*` is recursive.
- `flags` is a bitmask:
  - `unreadable` (1): the dir couldn't be opened.
  - `visited` (2): the scanner got to this dir.
  - `complete` (4): this dir and every dir below it were visited.
- In a partial snapshot, totals of incomplete dirs are **lower bounds**. Show them as "≥ 1.2 GB".
- To get a full path, follow `parent` links up to row 0, join the names, and prefix `root`. `largest_files` is sorted by bytes, descending. `dir` is a row id. `mtime` is in epoch seconds.
- `extensions` is global only; there is no per-directory breakdown.

### Live stream: `<name>-<mode>-<hash>.events.ndjson`
The scanner truncates this file and starts it fresh at the beginning of each scan, then appends to it. Each line is a JSON array whose first element is the event type. The writer flushes about every 0.5 s, so the last line may be incomplete: buffer it until its newline arrives.

| event | shape | meaning |
|---|---|---|
| `h` | `["h", {version, root, host, mode, pid, started_epoch, cache_file, dir_fields, flags}]` | first line; resets all state |
| `n` | `["n", id, parent, name]` | dir discovered, not yet scanned (row 0 comes right after `h`) |
| `s` | `["s", id, own_bytes, own_files, flags]` | dir scanned; its own files are now counted |
| `p` | `["p", files, dirs_scanned, bytes, errors, elapsed_s, current_path]` | progress, every ~0.5 s |
| `L` | `["L", [[dir, name, bytes, mtime], …]]` | full replacement of the largest-files list, every ~5 s |
| `x` | `["x", {ext: {files, bytes}}]` | full replacement of the extension totals, every ~5 s |
| `e` | `["e", {complete, duration_s, cache_file, totals}]` | last line; the snapshot is now on disk |

Applying events in order reconstructs the same tree as the snapshot. Maintain the following incrementally, never by full recompute per event:
- `total_bytes`/`total_files`: on `s`, add the dir's own values to the dir and all its ancestors (O(depth)).
- **Subtree completeness**: keep a count of unvisited dirs per subtree. `n` increments it on the new dir and all its ancestors; `s` decrements it on the dir and all its ancestors. A dir is complete when its count reaches 0.

If the file shrinks, or a new `h` line appears, a new scan has started. Reset and re-read from offset 0.

## Architecture

The server is plain Node (≥ 18) with `node:http`, no framework. The frontend uses Vite + React + TypeScript with **shadcn/ui** (see "UI stack" below), plus `d3-hierarchy` for the treemap layout. Run commands:

```
npm install && npm run build
npm start -- [args]           # = node server/index.js [args]
npm run dev                   # vite dev server + API server, for working on the UI
```

Optionally `npm link` for a `dirscan-view` command. This is not required.

### CLI
```
npm start                          # dashboard: all scans in index.json (running ones first)
npm start -- <path>                # open the running scan of <path> if any, else its newest snapshot
npm start -- <path> --scan [--du]  # start a fresh scan of <path> and follow it live
npm start -- <snapshot.json>       # open a specific snapshot (also works for a file copied from elsewhere)
  --port 4173  --host 127.0.0.1  --no-open  --cache-dir <dir>
  --scanner ./dirscan.py  --python python3
```

### Security (this will run on shared cluster login nodes)
- Bind to `127.0.0.1` only. Even so, other users on the same node can reach localhost ports.
- At startup, generate a random token (`crypto.randomBytes(24)`) and print the URL as `http://127.0.0.1:4173/?token=…`, like Jupyter does. Every `/api/*` request must carry the token in a header; otherwise return 403. The frontend reads the token from the URL once, keeps it in `sessionStorage`, and strips it from the address bar.
- Print an SSH hint: `ssh -L 4173:127.0.0.1:4173 <this-host>`.
- The tool is **read-only** toward user data: no delete, move, or write endpoints. The only process it can start is `dirscan.py`, and the only process it can stop is one it started itself.
- `/api/ls` serves only paths that, after `fs.realpath`, lie inside the root of some scan in the index or a root passed on the CLI. Reject everything else.

### API
- `GET /api/scans`: index entries plus a derived `state` (`running`, `done`, `partial`, `abandoned`, or `remote`), sorted with running scans first, then newest.
- `GET /api/snapshot?file=<path>`: streams the snapshot JSON from disk. Only paths listed in the index or given on the CLI are allowed.
- `GET /api/live?file=<snapshot path>`: Server-Sent Events. The server tails the events file by polling `fs.stat` every 300 ms; `fs.watch` is unreliable on NFS/Lustre/GPFS. It reads the new bytes and sends complete lines in batches: one SSE message with up to ~5,000 lines as a JSON array. It sends `: keepalive` every 15 s. A client that connects mid-scan first gets the whole file from offset 0, batched, so it can catch up. When the `e` event arrives, the server closes the stream after sending it.
- `GET /api/ls?path=<abs path>`: a live directory listing via `fs.opendir` + `lstat`. For each entry it returns `{name, type: file|dir|symlink|other, size, blocks, mtime, mode, uid, target?}`, sorted by size descending. Cap the response at 5,000 entries and add `truncated: true` plus a total count when capped. Errors come back as `{error, code}`, e.g. EACCES.
- `POST /api/scan {root, du}`: spawns `python3 dirscan.py <root> --rescan --quiet [--du]`, detached, with its own process group, and returns the snapshot path key so the UI can switch to `/api/live`. Refuse if a running scan of the same root and mode already exists.
- `POST /api/stop {file}`: sends SIGTERM to a scan this server started. The scanner then writes a partial snapshot and an `e` event.

## UI

### UI stack: shadcn/ui
Set up shadcn/ui the standard way for Vite (Tailwind CSS, `npx shadcn@latest init`; accept its defaults for Tailwind version and base library), the `@/` path alias, and the `src/components/ui/` folder. Add components with `npx shadcn@latest add …`. Never hand-copy them, and don't fork their internals. Put customization in wrapper components under `src/ui/`.

- **Components to use:** `sidebar` (scan list and navigation), `resizable` (treemap | side panel split), `breadcrumb`, `tabs`, `table` together with `@tanstack/react-table` (the shadcn "data table" pattern), `badge` (state: running / done / partial / abandoned / remote; dir status), `button`, `input`, `command` inside a `dialog` (search palette), `tooltip` and `hover-card` (treemap and table hovers), `progress`, `card` (header stats), `alert` (partial / abandoned / error banners), `scroll-area`, `toggle-group` (color mode, subtree vs global), `dropdown-menu` (row actions: copy path, open in tree), `skeleton` and `spinner` (loading), `empty` (no scans yet, empty dir), `kbd` (shortcut hints), `toast` (copied, scan started/stopped, errors), and `chart` (Recharts-based) for the extensions bar chart.
- **Large lists:** the shadcn table is the look; rows are virtualized with `@tanstack/react-virtual` whenever a table can exceed ~200 rows (Files here, Largest files, search results). Sorting state goes through react-table.
- **Theme:** use the shadcn CSS variables (`--background`, `--muted`, `--primary`, `--chart-1…5`, etc.) with the `class` dark-mode strategy and a theme toggle (light / dark / system) stored in `localStorage`. The treemap is custom SVG or canvas but takes **all** its colors from those variables. Read them via `getComputedStyle`, cycling the `--chart-*` palette for top-level ancestors, so it matches the theme in both modes.
- **Look:** a dense, calm developer tool, something like ncdu crossed with a modern dashboard. Use the shadcn defaults (neutral base color) with compact spacing (`size="sm"` buttons, tight table rows), `tabular-nums` for all numbers, and `font-mono` for paths and sizes. No custom CSS beyond Tailwind utilities and the treemap.

### Using the shadcn skill (Claude Code)
This repo has the **official shadcn/ui skill** installed (`npx skills add shadcn/ui`). It activates once `components.json` exists, so run `shadcn init` early. After that, follow it:
- Trust the project context it injects (`shadcn info --json`: Tailwind version, aliases, base library, icon library, installed components) over assumptions. Write code for the base library `shadcn init` chose; don't mix Radix-, Base UI- or Aria-specific APIs.
- Before using a component, look it up with `shadcn docs <name>` / `shadcn search`. Don't guess props from memory, especially for `sidebar`, `chart`, `command`, `resizable`, and the data-table pattern.
- Install only with `shadcn add`; use `--dry-run` / `shadcn diff` before overwriting anything.
- Follow the skill's composition and theming rules: `ToggleGroup` for option sets, semantic color tokens, and OKLCH CSS variables for any custom colors.

If a component named in this spec doesn't exist in the current registry, or has been renamed, use the closest current equivalent from `shadcn search` and note it in the README. Stick to the default shadcn/ui registry; no third-party or paid registries unless the user asks.

Keep all view state in the URL hash (scan, current dir id, tab, toggles) so reloads and bookmarks work.

**Dashboard (no scan selected).** Show a `table` of scans: root, host, mode, state badge, size, files, and age. Running scans show a live progress line from their latest `p` event. Each row has an "Open" button, plus "Rescan" and "Stop" where those apply. Add a "Scan a path…" `input`, with a mode `toggle-group` (apparent / du), at the top. The `sidebar` lists the same scans for quick switching from any view.

**Scan view.**
1. **Header.** A row of compact `card`s. Shows root, host, mode, and age or elapsed time. While live, also show files, dirs, bytes, files/s, errors, and the current path (from `p`), plus a `progress` indicator (indeterminate while scanning) and a Stop button. Show an `alert` banner for "partial" or "abandoned" when it applies. When the `e` event arrives, switch seamlessly to the snapshot without losing the user's position.
2. **Breadcrumb.** Every segment is clickable. Backspace or Alt+← goes up one level.
3. **Treemap.** A squarified layout of the current dir's children by `total_bytes`, two levels deep. The current dir's own files appear as a single `(files)` tile. Click a tile to drill in. On hover, show the full path, size, % of the current dir, % of root, and file count. Cap the treemap at ~400 rectangles and roll the rest into an "other (N)" tile. Color by top-level ancestor, with a toggle to color by size class instead. Incomplete subtrees get a subtle animated stripe and "≥" sizes; unvisited dirs show as "pending". **Live updates are throttled to one re-layout per second.** Animate tile transitions briefly so growth reads as movement, not flicker.
4. **Side panel `tabs`** (in a `resizable` panel to the right of the treemap; the layout stacks vertically on narrow screens).
   - **Subdirs.** A sortable data table: name, total size with % bar, files, own size, and status `badge` (done / scanning / pending / unreadable). It stays in sync with the treemap: hover highlights the tile, click drills in.
   - **Files here (live).** Calls `/api/ls` for the current dir and shows every entry: name, type, size, size on disk (`blocks*512`), modified time, owner uid, and symlink target. Sort by any column; files are sorted by size by default. Subdirs in this list link to the tree and show their scanned totals next to the live `lstat` size. Label this tab "live from disk", with a refresh button and a "listed at hh:mm:ss" stamp. This tab is how you inspect anything at a low level, including dirs that are tiny, unreadable, or not yet scanned.
   - **Largest files.** Restricted to the current subtree by default, with a toggle for global. Subtree membership is computed by walking parents, memoized per dir id. Each row has a copy-path button.
   - **Extensions.** A horizontal bar `chart` of the top 20 extensions by bytes, with a compact table below it. Label it as global.
5. **Search.** A `command` palette in a dialog (⌘K / Ctrl+K, or `/`). It fuzzy-filters dir names and paths, debounced, and does its own filtering outside cmdk, since cmdk's built-in filter won't scale to 1M items. Show at most 200 results; picking one jumps there. It works during a live scan over whatever has been discovered so far.
6. **Keyboard.** `/` or ⌘K for search, `↑↓` to move in the table, `Enter` to drill in, `Backspace` to go up, `c` to copy the current path.

## Performance targets
- The tree lives in typed arrays or columnar structures (parent: `Int32Array`; sizes: `Float64Array`; names: a string array). Children lists are built incrementally.
- A 1M-dir snapshot parses and indexes in under 2 s. Interactions take under 50 ms.
- In live mode, ingesting 10k events per second must not block the UI. Apply batches in a Web Worker or in small chunks, and render on a throttle.

## Project layout and tests
- `server/`: CLI, HTTP server, tailing, spawning, path guards.
- `src/lib/`: pure TypeScript with snapshot parsing, the event reducer, path building, and subtree tests, all unit-tested.
- `src/components/ui/`: shadcn-generated components, left untouched.
- `src/ui/`: app components (Treemap, DirTable, FilesHere, LargestFiles, ExtensionsChart, ScanHeader, ScanList, SearchPalette), built from the shadcn components.
- Tests use vitest:
  - The **event reducer**, run over a full events file, must yield exactly the same tree (totals and complete flags) as the matching snapshot. Generate fixtures by running `python3 dirscan.py <tmpdir> --cache-dir fixtures/cache -q` on small synthetic trees, including one interrupted with SIGTERM.
  - Partial-line handling: feed the events file in random byte chunks.
  - Path-guard tests for `/api/ls`: `..`, symlink escapes, and paths outside every root.
  - A synthetic 1M-dir snapshot generator for the load-time check.
- The README covers setup, the CLI, the SSH tunnel, and how live mode works.

## Acceptance checklist
- [ ] Start `python3 dirscan.py <big dir> --rescan` in one terminal and `npm start -- <big dir>` in another. The viewer attaches and the treemap grows live, with completed subtrees marked ✓.
- [ ] Starting a scan from the dashboard works, Stop produces a partial snapshot, and both show the right state badges.
- [ ] Opening the viewer mid-scan catches up and then follows.
- [ ] Drilling 5+ levels down and back works; the URL updates; reload restores the view.
- [ ] "Files here" lists every file in a dir, including small ones and dirs not yet scanned. It refuses paths outside scan roots.
- [ ] API calls without the token get 403.
- [ ] The 1M-dir snapshot meets the performance targets.
- [ ] Light, dark, and system themes all look right, including treemap colors.
- [ ] `npm test` passes and `npm run build` has no type errors.