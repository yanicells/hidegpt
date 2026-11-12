# Perf bench

Drives the built app through one fixed session and reports what it cost. It is a
black box: the app runs its real main process, IPC, preload and renderer. The only
stand-in is the provider, a fake `codex app-server` that speaks the same JSON-RPC
lines over stdio (`fake-codex.mjs`), so the bench never contacts a model and works
on any branch that still talks to `codex app-server`.

```bash
pnpm bench                       # build, 3 timed runs + 1 counts run, table on stdout
pnpm bench --runs 5 --label mine # more runs, results under bench-results/mine.json
pnpm bench:compare bench-results/before.json bench-results/after.json
pnpm bench:profile --phase stream300,type_idle300   # where the CPU time went, by source file
```

Another checkout (an older branch, a colleague's worktree) is measured with the same
harness, from this one:

```bash
node scripts/bench/run.mjs --repo ../other-checkout --build --label other
```

`--repo` needs `pnpm install` done there. Results go to `bench-results/` (ignored by
git) unless `--out <dir>` says otherwise.

## What a run does

| Phase | Action | Felt as |
| --- | --- | --- |
| `cold` | start the app, wait for the library on Home | launch time |
| `home_list`, `home_grid` | switch Home between list and grid | Home responsiveness |
| `open` | open a 300-turn document (its newest 30 turns load) | open time |
| `type_idle` | 30 keys, one per 100 ms | typing latency |
| `stream30` | a 17k-character answer streams in (8 characters every 5 ms) | streaming smoothness |
| `code30` | the same with one 240-line code block | streaming code |
| `load_all` | "Show earlier text" until all 300 turns are loaded | paging |
| `stream300` | `stream30` again, now with 300 turns on the page | long-document streaming |
| `type_stream300` | a shorter answer streams while a key lands every 100 ms | typing during an answer |
| `type_idle300` | `type_idle` with 300 turns on the page | long-document typing |
| `scroll300` | scroll up 600 px a frame for 150 frames | scrolling |
| `to_home`, `open_other`, `reopen` | back to Home, open a 20-turn document, reopen the long one | switching documents |
| `mem_home`, `mem300`, `mem_end` | memory after a forced GC: at Home, with 300 turns, back at Home at the end | long-session growth |

The first launch of a run set starts from an empty profile and fills the V8 compile
cache; only its start-up numbers are kept (`first_launch`). The timed runs that follow
reuse the profile, like a normal second launch.

## Metrics and how far to trust them

Each phase records the same counters, named `phase.metric`. The `tier` column in every
table says how much noise to expect:

| Tier | Metrics | Under load |
| --- | --- | --- |
| `count` | `layouts`, `recalcs` (Blink layout and style passes), `ipc_sends`, `ipc_kb`, `commits`, `renders` (React), `dom_nodes`, bundle sizes | exact |
| `instr` | `r_ginstr`, `m_ginstr`, `g_ginstr`: billions of CPU instructions retired by the renderer, main and GPU processes | within about 1% |
| `cpu` | `*_cpu_ms` (process CPU time), `layout_ms`, `recalc_ms`, `script_ms`, `task_ms` (renderer main thread, thread time) | drifts 10-30% |
| `memory` | `r_heap_mb` (JS heap after GC), `*_footprint_mb` (what Activity Monitor shows) | stable, footprint varies a little |
| `wall` | `first_ms`, `settled_ms`, `key_p95_ms`, `frame_p95_ms`, `late_frames` (>25 ms), `janky_frames` (>50 ms), `longtask_*`, `end_lag_ms`, `lag_max_ms` (main event loop) | only on a quiet machine |

Instructions retired is the main CPU measure. It comes from the kernel
(`proc_pid_rusage`, read by `rusage.py`), counts work rather than time, and does not
move when other programs share the machine or a thread lands on an efficiency core.
On a machine running ten other builds it repeated within 0.2% while wall time swung 15%.

One caveat: it counts the work the app did, and some work is per frame. A phase that
streams or types drops frames on a loaded machine, so it runs fewer per-frame passes
and retires fewer instructions (`stream300.r_ginstr` ranged 77 to 110 over five loaded
runs, with `frames` 417 to 614). Phases with a fixed amount of work (`cold`, `open`,
`load_all`, every `m_ginstr`) stay within 1 to 2%. Read a per-frame phase next to its
`frames`, or compare on a quiet machine.

Counts are exact for what the app did, and two byte counts depend on when the app did it.
`cold.ipc_kb` varies between runs (1,475 to 1,743 KB in 15 messages on one build): the library
arrives as cumulative pages and the publisher sends whichever is newest at each frame. And the
library is listed again after each turn, so its 270 KB lands in whichever phase is running when
the list returns (`code30.ipc_kb` reads 304 or 35). Compare those as a sum over phases.

`type_idle300.r_ginstr` is the one instruction count seen to differ between sessions of the
same build: 2.4 to 3.3 on a quiet machine, 1.87 to 1.90 in four busier ones (probably deferred
work that only runs when the phase has idle time; not confirmed). Compare typing on `script_ms`,
`recalc_ms` and key latency from runs taken side by side.

Launch has three marks, all from the process starting: `cold.listed_ms` (the provider
served the last page of the library; everything before it is the main process and the
provider), `cold.first_card_ms` (the first documents painted) and `cold.all_cards_ms`
(every document is on the page). A Home that mounts only the cards in view never reaches
the third, so it is reported only when it happens.

Latency definitions:

- `first_ms`: click to the first frame that shows the result.
- `settled_ms`: click to the frame after the page last changed (rows that render
  progressively count until the last one).
- `key_*_ms`: key press to the frame after the character appeared.
- `end_lag_ms`: the server sending its last character to that character on screen.
- `lag_*_ms`: how late the main process's event loop ran its timers.

`commits`, `renders` and `ipc_kb` come from the separate counts run, because counting
them costs CPU: a React DevTools-style hook walks each commit, and each IPC message is
serialized once more to size it. The timed runs carry no such instrumentation.

`compare` marks a change `real` only when the two ranges (min to max over the runs) do
not overlap. Anything else is `within spread`.

## Busy machine or quiet machine

On a shared or busy machine, read the `count` and `instr` rows and ignore `wall`
differences under about 30%. Each run prints the load average and a fixed spin loop's
time (`noise.spin_ms`) so a noisy run is visible afterwards.

For numbers to publish:

1. Quit other apps and agents, plug in power, turn off Low Power Mode, wait for
   Spotlight and backups to finish. `uptime` should show a load average under 1.5.
2. `pnpm bench --runs 7 --label <name>` for each build to compare, back to back, without
   touching the machine. The window stays hidden either way.
3. Check `noise.spin_ms` in the result: its max should be within 10% of its min. Rerun
   if not.
4. `pnpm bench:compare before.json after.json`.

## Profiling

`pnpm bench:profile --phase <phase[,phase]>` runs the session once with V8's sampling
profiler on the named phases, in both the renderer and the main process, and prints
self time per package or source file and the hottest functions as `file:line` (mapped
through the build's source maps). The `.cpuprofile` files load in Chrome DevTools.
`(program)` is native work between JavaScript calls: style, layout, paint and IPC.
Read it next to that phase's `recalc_ms` and `layout_ms`.

## How it stays safe and out of the way

- `hook.cjs` is preloaded into the main process (`electron -r`). It gives the app its
  own profile folder, and patches `child_process` so that `codex` resolves to the fake
  server and every other program the app tries to start is refused (reported as
  `cold.blocked_spawns`). The runner sends nothing until the fake server has connected.
- The window is never shown or focused and the app has no Dock icon, but it renders
  at full frame rate (background throttling is off). `--show` shows it.
- `--throttle 4` slows the renderer's main thread four times, like a slower laptop.

## Files

| File | Role |
| --- | --- |
| `run.mjs` | command line, runs, results |
| `scenario.mjs` | the session, phase by phase |
| `launch.mjs` | starts the app, connects to it, `measure()` |
| `hook.cjs` | in the main process: isolation, hidden window, IPC and event-loop counters |
| `probe.cjs` | in the page: paint, frame, key and DOM timing; React commit counter |
| `fake-codex.mjs` | the stand-in provider and its deterministic library |
| `cdp.mjs` | DevTools protocol client |
| `rusage.py` | per-process instructions, CPU time and footprint (macOS) |
| `report.mjs`, `profile.mjs` | tables, comparison, profile summaries |
