# Performance

Two checks keep regressions from landing quietly, and the bench measures the rest. All of
it runs the app against a fake provider; nothing contacts a real service.

## What to run

| When                                                             | Run                                                                          | Takes             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------- |
| Always (CI runs it)                                              | `pnpm test`, which includes the wire-size budget                             | seconds           |
| Before merging a change to the main process, preload or renderer | `pnpm bench:check`                                                           | about 3 minutes   |
| Before and after a change you want to claim is faster            | `pnpm bench --label before`, then `--label after`, then `pnpm bench:compare` | 10 minutes a side |

`pnpm bench:check` is a local step, not a CI job. It drives a real Electron window
(hidden), and its counts are measured on macOS, the only platform the app ships for. CI's
static job runs on Linux without the Electron binary, and a Linux window lays text out
with other fonts, so its row heights, pages and box reads would need budgets of their own.

The bench, its phases and what each metric means are in
[scripts/bench/README.md](../scripts/bench/README.md).

## The wire-size budget

`src/shared/snapshot-patch.budget.test.ts` builds a 300-turn document over a 500-document
library, streams one frame of text onto its last answer, and checks that the patch main
sends for it is under 1 KB as JSON. It needs no app. It fails if a streamed frame ever
resends the whole answer or a field that did not change (the library, the other blocks).

## The bench budgets

`pnpm bench:check` builds, launches the app once to fill its compile cache, then runs one
counts run of the bench session and compares it with
[scripts/bench/budgets.json](../scripts/bench/budgets.json). Each budget is its baseline
plus 10% (and at least 2), rounded up. The check prints a table and exits 1 when a metric is
over its budget or missing from the run.

Only counts are budgeted. Times (`*_ms`) and instructions retired (`*_ginstr`) move with
load, and a budget on them would fail at random. Most counts come out exactly the same on a
busy machine. A few that depend on how many frames or passes ran move a little between runs
of one build (`stream300.renders` by 8%, `stream300.box_reads` by 5%, `open.commits` by
one), so a baseline is the higher of two counts runs.

| Metric                                             | What it guards                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `open.commits`                                     | React commits while a document opens                                        |
| `stream300.recalcs`, `stream300.renders`           | style passes and component renders while an answer streams into 300 turns   |
| `stream300.box_reads`, `type_idle300.box_reads`    | `getBoundingClientRect` calls: the paginator measuring rows                 |
| `type_idle300.restyled`                            | elements restyled: rules (such as `:has()`) that restyle the whole document |
| `type_idle300.recalcs`                             | style passes while typing into a 300-turn document                          |
| `scroll300.commits`                                | React commits while the document scrolls                                    |
| `load_all.renders`                                 | renders while the older pages load                                          |
| `reopen.ipc_kb`, `reopen.renders`                  | what reopening the long document sends and renders                          |
| `mem_home.dom_nodes`                               | elements on Home with 500 documents                                         |
| `session.ipc_kb`                                   | every byte sent to the window over the session                              |
| `static.main_js_kb`, `static.renderer_entry_js_kb` | main's bundle and the renderer code loaded before first paint               |

`session.ipc_kb` stands in for the per-phase byte counts of launch, `code30` and
`load_all`, which depend on timing: the library arrives as growing pages and is resent
after each turn, and those land in whichever phase is running. The session's total does
not move with timing by more than a few percent.

`box_reads` and `restyled` are counted in the counts run only. `box_reads` wraps
`Element.prototype.getBoundingClientRect` in the page's own world, as the React counter
does. `restyled` traces Blink's style passes and sums `elementCount` over the
`UpdateLayoutTree` events. `stream300.restyled` is measured but not budgeted: it read
4,922 and then 2,074 in two runs of one build. Typing restyles the same elements every
time (25,840 in both runs), so `type_idle300.restyled` is the restyle gate.

## When a budget fails, or a count moves on purpose

An over-budget count is a regression until shown otherwise: `pnpm bench --label after` and
`pnpm bench:compare` against the base show where it came from, and
`pnpm bench:profile --phase <phase>` shows which code did it.

When a change moves a count on purpose (a feature that adds rows, or a fix that removes
renders), re-baseline:

```bash
pnpm bench:check --update   # two counts runs; rewrites scripts/bench/budgets.json from the higher
pnpm bench:check --update --from a.json --from b.json   # or from runs already on disk
```

Commit `budgets.json` with the change and give the old and new values in the PR. Do it
when counts fall too, so the budget stays tight and the gain cannot be lost again
unnoticed. To budget another count, add its name to `metrics` in `budgets.json` and run
`--update`; it refuses a metric that is not a count, and one a run did not measure.

The budgets hold for the default session (500 documents, 300 turns, no CPU throttle); the
check refuses a run with other options. Only one bench runs at a time on a machine;
`bench:check` waits for one already running.
