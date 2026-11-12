# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""pnpm fidelity:diff: compares two `pnpm fidelity:shots` outputs pixel by pixel.

usage: diff.py BEFORE AFTER [--phase core,states] [--out dir]

Prints one line per screen that differs (differing pixels, largest channel
difference, and the bounding box in CSS px), then a summary, and exits 1 when
any screen differs or is missing on one side. With --out it also writes a red
overlay of each differing screen. The motion phase is timing-dependent, so it
is not compared by default.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def compare(before, after):
    """(differing pixels, max channel difference, bbox in CSS px or None, mask)."""
    # Chrome encodes the same pixels to the same bytes, so equal files skip decoding.
    if before.read_bytes() == after.read_bytes():
        return 0, 0, None, None
    a = np.asarray(Image.open(before).convert('RGB'))
    b = np.asarray(Image.open(after).convert('RGB'))
    if a.shape != b.shape:
        return -1, 255, None, None
    mask = (a != b).any(axis=2)
    count = int(mask.sum())
    if not count:
        return 0, 0, None, None
    ys, xs = np.where(mask)
    worst = np.abs(a[mask].astype(int) - b[mask].astype(int)).max()
    bbox = (xs.min() / 2, ys.min() / 2, (xs.max() + 1) / 2, (ys.max() + 1) / 2)
    return count, int(worst), bbox, mask


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('before')
    parser.add_argument('after')
    parser.add_argument('--phase', default='core,states')
    parser.add_argument('--out', help='write a red overlay of each differing screen here')
    args = parser.parse_args()

    before, after = Path(args.before), Path(args.after)
    total = differing = missing = 0
    for phase in args.phase.split(','):
        names = {p.relative_to(before) for p in (before / phase).rglob('*.png')}
        names |= {p.relative_to(after) for p in (after / phase).rglob('*.png')}
        for name in sorted(names):
            total += 1
            if not (before / name).exists() or not (after / name).exists():
                missing += 1
                print(f'MISSING  {name} (only in {"after" if (after / name).exists() else "before"})')
                continue
            count, worst, bbox, mask = compare(before / name, after / name)
            if count == 0:
                continue
            differing += 1
            if count < 0:
                print(f'DIFF     {name}: sizes differ')
                continue
            box = ', '.join(f'{v:g}' for v in bbox)
            print(f'DIFF     {name}: {count} px, max channel diff {worst}, bbox [{box}]')
            if args.out:
                overlay = np.asarray(Image.open(after / name).convert('RGB')) // 3
                overlay[mask] = (255, 0, 0)
                target = Path(args.out) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(overlay.astype(np.uint8)).save(target)
    same = total - differing - missing
    print(f'\n{total} screens: {same} identical, {differing} differ, {missing} missing')
    return 0 if differing == missing == 0 and total > 0 else 1


if __name__ == '__main__':
    sys.exit(main())
