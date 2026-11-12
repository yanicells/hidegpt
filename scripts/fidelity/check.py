# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""pnpm fidelity:check: scores the last `pnpm fidelity:shots` against targets.json.

usage: check.py [--shots screenshots/fidelity] [--targets scripts/fidelity/targets.json]
                [--refs references/google-docs] [--only text] [--failing]

Prints one line per metric (PASS, FAIL, or MISS when its screen, element or
reference is missing) and exits 1 unless every metric passes.

Metric kinds (each names a phase, default "core", a viewport and a screen):
  box    an element's box from the layout dump (`selector`, `prop`: x y w h cx cy
         right bottom), optionally `relativeTo` another element's box
  style  a computed style of an element (`selector`, `prop`: any CSS property)
  ink    ink in a capture region, either `box` [x, y, w, h] or an element's box
         (`selector`, grown by `pad`, default 2), `prop`: x y w h cx cy mass;
         with `ref` and `refBox` the target is the same measure in that Google
         Docs reference, and `mass` compares as a ratio
  pixel  the colour under a point (`at` [x, y])
A metric passes at `target` within `tol`, or between `min` and `max`.
Colours compare per channel; strings compare exactly.
"""

import argparse
import json
import sys
from pathlib import Path

import imaging

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TOL = {'box': 0.5, 'ink': 0.5, 'mass': 0.04, 'colour': 0, 'number': 0.01}


def is_colour(value):
    return isinstance(value, str) and (value.startswith('#') or value.startswith('rgb'))


def number(value):
    """'19.38px' -> 19.38; None when the value isn't a plain length or number."""
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).removesuffix('px'))
    except ValueError:
        return None


class Missing(Exception):
    pass


class Checker:
    def __init__(self, shots, refs):
        self.shots, self.refs = shots, refs
        self.dumps, self.images = {}, {}

    def screen(self, metric):
        return self.shots / metric.get('phase', 'core') / str(metric['viewport']) / metric['screen']

    def dump(self, metric):
        path = self.screen(metric).with_suffix('.json')
        if path not in self.dumps:
            if not path.exists():
                raise Missing(f'no {path.relative_to(self.shots)}')
            self.dumps[path] = json.loads(path.read_text())
        return self.dumps[path]

    def image(self, path):
        if path not in self.images:
            if not path.exists():
                raise Missing(f'no {path}')
            self.images[path] = imaging.load(path)
        return self.images[path]

    def probe(self, metric, selector):
        probes = self.dump(metric).get('probes', {})
        if selector not in probes:
            raise Missing(f'{selector} was not probed; run pnpm fidelity:shots after editing targets.json')
        if probes[selector] is None:
            raise Missing(f'{selector} not on screen')
        return probes[selector]

    def region(self, metric):
        """An ink metric's region: its fixed `box`, or its element's box grown by `pad`."""
        if 'box' in metric:
            return metric['box']
        box, pad = self.probe(metric, metric['selector']), metric.get('pad', 2)
        return [box['x'] - pad, box['y'] - pad, box['w'] + 2 * pad, box['h'] + 2 * pad]

    def measure(self, metric):
        """(measured, target) for one metric; target None means bounds only."""
        kind, prop = metric['kind'], metric.get('prop')
        if kind == 'box':
            value = box_value(self.probe(metric, metric['selector']), prop)
            anchor = metric.get('relativeTo')
            if anchor:
                value -= box_value(self.probe(metric, anchor['selector']), anchor['prop'])
            return value, metric.get('target')
        if kind == 'style':
            return self.probe(metric, metric['selector'])['style'].get(prop, ''), metric.get('target')
        if kind == 'ink':
            found = imaging.ink(self.image(self.screen(metric).with_suffix('.png')), *self.region(metric))
            if found is None:
                raise Missing('no ink in box')
            if 'ref' not in metric:
                return found[prop], metric.get('target')
            ref = imaging.ink(self.image(self.refs / metric['ref']), *metric['refBox'])
            if ref is None:
                raise Missing('no ink in reference box')
            if prop == 'mass':
                return found['mass'] / ref['mass'] - 1, 0.0
            return found[prop], ref[prop]
        if kind == 'pixel':
            return imaging.pixel(self.image(self.screen(metric).with_suffix('.png')), *metric['at']), metric['target']
        raise ValueError(f'unknown kind {kind}')


def box_value(box, prop):
    derived = {
        'cx': box['x'] + box['w'] / 2, 'cy': box['y'] + box['h'] / 2,
        'right': box['x'] + box['w'], 'bottom': box['y'] + box['h'],
    }
    return derived[prop] if prop in derived else box[prop]


def judge(metric, measured, target):
    """(passed, measured text, target text)."""
    if is_colour(target):
        tol = metric.get('tol', DEFAULT_TOL['colour'])
        got = imaging.parse_colour(measured) if measured else None
        want = imaging.parse_colour(target)
        shown = imaging.hex_colour(got) if got else repr(measured)
        passed = got is not None and max(abs(a - b) for a, b in zip(got, want)) <= tol
        return passed, shown, target + (f' ±{tol}' if tol else '')
    if metric['kind'] == 'ink' and metric.get('prop') == 'mass':
        tol = metric.get('tol', DEFAULT_TOL['mass'])
        return abs(measured) <= tol, f'mass {measured:+.0%}', f'reference ±{tol:.0%}'
    value = number(measured)
    if value is None or (isinstance(target, str) and number(target) is None):
        return measured == target, repr(measured), repr(target)
    shown = f'{value:g}'
    if target is None:
        low, high = metric.get('min', float('-inf')), metric.get('max', float('inf'))
        bounds = ' and '.join(part for part in (
            f'>= {low:g}' if low != float('-inf') else '', f'<= {high:g}' if high != float('inf') else '') if part)
        return low <= value <= high, shown, bounds
    default = DEFAULT_TOL['number'] if metric['kind'] == 'style' else DEFAULT_TOL[metric['kind']]
    tol = metric.get('tol', default)
    want = number(target)
    return abs(value - want) <= tol + 1e-9, shown, f'{want:g} ±{tol:g}'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--shots', default=str(ROOT / 'screenshots/fidelity'))
    parser.add_argument('--targets', default=str(ROOT / 'scripts/fidelity/targets.json'))
    parser.add_argument('--refs', default=str(ROOT / 'references/google-docs'))
    parser.add_argument('--only', help='only metrics whose id contains this text')
    parser.add_argument('--failing', action='store_true', help='print only failing and missing metrics')
    args = parser.parse_args()

    metrics = json.loads(Path(args.targets).read_text())['metrics']
    if args.only:
        metrics = [m for m in metrics if args.only in m['id']]
    checker = Checker(Path(args.shots), Path(args.refs))
    counts = {'PASS': 0, 'FAIL': 0, 'MISS': 0}
    width = max((len(m['id']) for m in metrics), default=0)
    for metric in metrics:
        where = f"{metric.get('phase', 'core')}/{metric['viewport']}/{metric['screen']}"
        try:
            measured, target = checker.measure(metric)
            passed, shown, wanted = judge(metric, measured, target)
            status, detail = ('PASS' if passed else 'FAIL'), f'{shown}, want {wanted}'
        except Missing as error:
            status, detail = 'MISS', str(error)
        counts[status] += 1
        if args.failing and status == 'PASS':
            continue
        print(f"{status}  {metric['id']:<{width}}  {detail}  [{where}, §{metric['section']}]")
    print(f"\n{counts['PASS']} pass, {counts['FAIL']} fail, {counts['MISS']} missing of {len(metrics)} metrics")
    return 0 if counts['FAIL'] == counts['MISS'] == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
