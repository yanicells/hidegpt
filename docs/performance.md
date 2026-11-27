# Performance

Three checks keep regressions from landing quietly, and the bench measures the rest. All of
it runs the app against a fake provider; nothing contacts a real service.

## What to run

| When                                                             | Run                                                                             | Takes             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------- |
| Always (CI runs both)                                            | `pnpm test` (the wire-size budget), and the bundle-size budgets after the build | seconds           |
| Before merging a change to the main process, preload or renderer | `pnpm bench:check`                                                              | about 3 minutes   |
| Before and after a change you want to claim is faster            | `pnpm bench --label before`, then `--label after`, then `pnpm bench:compare`    | 10 minutes a side |

CI's static job checks the bundle sizes (`node scripts/bench/run.mjs check --static`)
right after it builds: they need a build but no app, and a bundle is the same on any OS.
The rest of `pnpm bench:check` is a local step. It drives the app's real window (hidden),
and its counts were measured on macOS, the only platform the app ships for. CI has a macOS
job, but it runs the tests in a few minutes on a shared runner; the bench needs the
Electron binary (which CI skips downloading), about 3 minutes more, and budgets measured
on that runner, whose fonts and display may lay rows out differently from a Mac's. A macOS
`bench:check` job with its own budgets is a follow-up.

The bench, its phases and what each metric means are in
[scripts/bench/README.md](../scripts/bench/README.md).

## The wire-size budget

`src/shared/snapshot-patch.budget.test.ts` builds main's session state with a 300-turn
document open over a 500-document library, through the same functions the session
manager calls, streams one frame of text onto the last answer as a provider `text` event,
and checks that the patch main sends for it is under 1 KB as JSON. It needs no app. It
fails if a streamed frame ever resends the whole answer, the library, or blocks that did
not change (for example, if appending text copied every block).

## The bench budgets

`pnpm bench:check` builds, launches the app once to fill its compile cache, then runs one
counts run of the bench session and compares it with
[scripts/bench/budgets.json](../scripts/bench/budgets.json). Each metric there has the
range it was measured in (`low` to `high`, over three counts runs) and two bounds:

- `max`, 10% over `high` (and at least 2 over it for a whole count), rounded up. Over it,
  the check fails: a regression.
- `min`, 10% under `low` (at least 2 under it), rounded down. Under it, the check fails
  too: the count fell, and the budget must be re-baselined so the gain is kept. Without
  this, a budget set before an improvement would let the whole improvement be lost again.

The check prints a table and exits 1 when a metric is over its max, under its min, missing
from the run, or not a count.

Only counts are budgeted. Times (`*_ms`) and instructions retired (`*_ginstr`) move with
load, and a budget on them would fail at random. Most counts come out exactly the same on
a busy machine. A few move between runs of one build: `stream300.renders` read 62,893,
64,767 and 69,024 in three runs, because a few heavy commits (the library resent after a
turn) land in the phase or not; `open.commits` reads 12 to 14, the box reads move a few
percent, and `scroll300.commits` read 128, 197 and 130, depending on how many scroll
events land in one frame. The range and the 10% cover that, so `scroll300.commits` is a
loose backstop: it catches a change that doubles the commits per scroll, not a small one.

| Metric                                             | What it guards                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `open.commits`                                     | React commits while a document opens                                        |
| `stream300.recalcs`                                | style passes while an answer streams into 300 turns                         |
| `stream300.renders_per_commit_p50`                 | components the median streaming commit renders (exact: 7)                   |
| `stream300.renders`                                | all renders while it streams: a loose backstop                              |
| `stream300.box_reads`, `type_idle300.box_reads`    | boxes read from layout: the paginator measuring rows and lines              |
| `type_idle300.restyled`                            | elements restyled: rules (such as `:has()`) that restyle the whole document |
| `type_idle300.recalcs`                             | style passes while typing into a 300-turn document                          |
| `scroll300.commits`                                | React commits while the document scrolls                                    |
| `load_all.renders`                                 | renders while the older pages load                                          |
| `reopen.ipc_kb`, `reopen.renders`                  | what reopening the long document sends and renders                          |
| `mem_home.dom_nodes`                               | elements on Home with 500 documents                                         |
| `session.ipc_kb`                                   | every byte sent to the window over the session                              |
| `static.main_js_kb`, `static.renderer_entry_js_kb` | main's bundle and the renderer code loaded before first paint               |

`stream300.renders_per_commit_p50` is the gate for renders per streamed frame. The median
commit ignores the few heavy ones that make `stream300.renders` move, and read 7 in every
run, so it is budgeted exactly (`headroom` and `slack` 0): one more component rendered per
commit fails it, one fewer makes it stale.

`session.ipc_kb` stands in for the per-phase byte counts of launch, `code30` and
`load_all`, which depend on timing: the library arrives as growing pages and is resent
after each turn, and those land in whichever phase is running. The session's total moves
by about 2%.

`box_reads` counts `getBoundingClientRect` and `getClientRects` on elements and ranges, in
the page's own world, as the React counter does. `restyled` traces Blink's style passes in
the renderer and sums `elementCount` over the `UpdateLayoutTree` events. The trace runs
only in the two typing phases, so its cost stays out of the others. Typing restyles the
same elements every time (89,727 in every run), so `type_idle300.restyled` is the restyle
gate; a streaming phase's count moved by half between runs and is not traced.

### Overrides

A metric in `budgets.json` can set its own `headroom` (instead of 10%), `slack` (instead
of 2) and `cap`, an absolute max that the 10% rule never goes above. `--update` keeps all
three.

A cap is for a size a change brought down to a target, where 10% would let the gain erode.
`static.renderer_entry_js_kb` gets a cap of 500 (the B3 target) once B3 (#88) merges:
pending until then, since today's entry (570 KB) is over it.

The stale rule does not make the cap redundant. It fires only if B3 takes the entry more
than 10% under its `low`, below 512.9 KB. B3 measured a cut of about 50 KB (547 to 497.5
KB, on a base before the UI merge); the same cut from 570 lands near 520, above that min,
so the check would pass with no re-baseline and the max would stay at 627. And when the
stale rule does fire, the re-baseline it asks for sets the max 10% over the new size (550
for 500), so the entry could still grow back past the target. The cap holds the max at 500
whatever the baseline; the min still follows the measured size, so a further cut is still
caught as stale.

## When a budget fails, or a count moves on purpose

An over-budget count is a regression until shown otherwise: `pnpm bench --label after` and
`pnpm bench:compare` against the base show where it came from, and
`pnpm bench:profile --phase <phase>` shows which code did it.

When a change moves a count on purpose (a feature that adds rows, or a fix that removes
renders), or the check says a budget is stale, re-baseline:

```bash
pnpm bench:check --update   # three counts runs; rewrites scripts/bench/budgets.json
pnpm bench:check --update --from a.json --from b.json --from c.json   # from runs on disk
```

Commit `budgets.json` with the change and give the old and new values in the PR. To budget
another count, add its name to `metrics` in `budgets.json` and run `--update`; it refuses a
metric that is not a count, and one a run did not measure. `--update` exits 1 when a build
is over a cap.

The budgets hold for the default session (500 documents, 300 turns, no CPU throttle); the
check refuses a run with other options. Only one bench runs at a time on a machine;
`bench:check` waits for one already running.

## Follow-ups

- A macOS CI job for `bench:check`, with budgets measured on that runner.
- A lockstep counts mode, where the fake server waits for each frame to commit before it
  sends the next characters, so every count is exact. T3 Code makes its render counts exact
  this way (its `scripts/render-metrics.ts` fails unless three runs agree). Then the
  remaining ranges could close and `stream300.renders` could be budgeted exactly.
