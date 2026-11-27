"""Generate src/renderer/src/components/ui/symbols.ts from the Material Symbols variable font.

Docs draws its chrome with Material Symbols Outlined at weight 400, grade 0,
unfilled, in 20px and 24px optical sizes. This pins those axes, extracts the
outlines of only the icons listed below, each at only the optical sizes the
renderer draws it at, and writes them as compact SVG paths (viewBox
"0 -960 960 960", same as Google's own SVG exports).

Usage (dev only; fonttools is not an app dependency):
  uv run --with fonttools --with brotli python scripts/material-symbols.py path/to/material-symbols-outlined.woff2
  pnpm exec oxfmt src/renderer/src/components/ui/symbols.ts
The woff2 comes from the `material-symbols` npm package (Apache-2.0); 0.49.0
reproduces the checked-in paths.

To add an icon, add its name to OPSZ under each size it is drawn at, and
regenerate. An icon whose name reaches MIcon through a new prop (a component
that passes its own `icon` or `name` on) also needs a FORWARDERS entry in
MaterialIcon.test.ts; the test names the site. If two branches conflict in
symbols.ts, merge OPSZ here and re-run the script; never resolve symbols.ts by
hand.
"""

import re
import sys
from pathlib import Path

from fontTools.pens.filterPen import FilterPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# The icons the renderer draws, by optical size: MIcon draws sizes up to 20px
# from the 20px cut and larger ones from the 24px cut. MaterialIcon.test.ts fails
# when these lists and the renderer's MIcon sites disagree. A `_fill` name is the
# filled glyph (FILL 1), as Docs draws File > New, Print and Drive's folders.
OPSZ = {
    20: """
accessibility_new add add_comment add_link add_to_drive arrow_drop_down arrow_right article
article_fill bar_chart bookmark border_style check checklist chevron_right close cloud_done
cloud_sync code content_copy content_cut content_paste crop_rotate delete description dictionary
difference download draw draw_fill drive_file_move edit edit_note extension file_copy find_replace
folder format_align_left format_bold format_clear format_color_text format_indent_decrease
format_indent_increase format_italic format_line_spacing format_list_bulleted format_list_numbered
format_list_numbered_rtl format_paint format_quote format_underlined functions help history
horizontal_rule image info ink_highlighter insert_page_break keyboard keyboard_arrow_up language
link list list_alt_fill lock logout mail mic monitoring mood more_vert notifications offline_pin
page_header person_add photo_camera print print_fill radio_button_checked rate_review redo remove
school search select_all settings shield_person slideshow_fill smart_button special_character
spellcheck star table table_fill tag text_fields text_format toc translate undo view_column
visibility water_drop
""".split(),
    24: """
apps arrow_back arrow_drop_down close comment folder folder_fill help history menu more_vert
search settings sort_by_alpha unfold_more videocam view_list view_module
""".split(),
}

# Keys drawn from a different glyph. Docs' Paint format tool is a paint roller;
# the font's own format_paint is a brush.
ALIASES = {"format_paint": "imagesearch_roller"}

class DropEmptySegments(FilterPen):
    """Skips segments that end where they start, and contours that are a single point; the font has a
    few of each, they fill nothing, and they only bloat the paths."""

    dot = False

    def moveTo(self, pt):
        self.current = pt
        super().moveTo(pt)

    def _segment(self, method, *points):
        if all(point == self.current for point in points):
            return
        self.current = points[-1]
        getattr(super(), method)(*points)

    def lineTo(self, pt):
        self._segment("lineTo", pt)

    def curveTo(self, *points):
        self._segment("curveTo", *points)

    def qCurveTo(self, *points):
        # A closed all-off-curve contour ends in None; keep it as drawn unless all its points coincide.
        if points[-1] is None:
            self.dot = len(set(points[:-1])) == 1
            if not self.dot:
                super().qCurveTo(*points)
        else:
            self._segment("qCurveTo", *points)

    def closePath(self):
        if self.dot:
            self.dot = False
        else:
            super().closePath()


ARITY = {"M": 2, "L": 2, "H": 1, "V": 1, "Q": 4, "C": 6, "Z": 0}


def segments(path: str) -> list[tuple[str, list[int], tuple[int, int]]]:
    """SVGPathPen's absolute integer path as (command, coordinates, start point) per segment."""
    if not re.fullmatch(r"[MLHVQCZ\d -]*", path):
        sys.exit(f"unexpected path syntax: {path}")
    out = []
    x = y = start_x = start_y = 0
    for cmd, args in re.findall(r"([MLHVQCZ])([^MLHVQCZ]*)", path):
        if cmd == "Z":
            out.append(("Z", [], (x, y)))
            x, y = start_x, start_y
            continue
        values = [int(value) for value in args.split()]
        for i in range(0, len(values), ARITY[cmd]):
            coords = values[i : i + ARITY[cmd]]
            # Implicit repeats after M are lines.
            seg = "L" if cmd == "M" and i > 0 else cmd
            out.append((seg, coords, (x, y)))
            if seg == "H":
                x = coords[0]
            elif seg == "V":
                y = coords[0]
            else:
                x, y = coords[-2], coords[-1]
            if seg == "M":
                start_x, start_y = x, y
    return out


def numbers(values: list[int]) -> str:
    """Numbers joined as SVG allows: no separator before a minus sign."""
    text = ""
    for value in values:
        text += str(value) if not text or value < 0 else f" {value}"
    return text


def drawn(path: str) -> list:
    """The pen calls a path makes, through fontTools' own SVG path parser (absolute points)."""
    pen = RecordingPen()
    parse_path(path, pen)
    return pen.value


def compact(path: str) -> str:
    """The same path in fewer bytes: each segment in the shorter of its absolute and relative forms, a Q
    whose control point mirrors the previous one as T, and a repeated command letter left out. Coordinates
    are integers, so relative ones land on exactly the same points; fontTools' SVG parser checks that
    both strings draw the same outline."""
    out, last, control = [], None, None
    for cmd, coords, (x, y) in segments(path):
        if cmd == "Z":
            out.append("Z")
            last, control = "Z", None
            continue
        origin = [y] if cmd == "V" else [x] if cmd == "H" else [x, y] * (len(coords) // 2)
        relative = [value - o for value, o in zip(coords, origin)]
        if cmd == "Q":
            # T's control point is the previous Q's mirrored through the current point (or the point itself).
            mirror = [2 * x - control[0], 2 * y - control[1]] if control else [x, y]
            if coords[:2] == mirror:
                cmd, coords, relative = "T", coords[2:], relative[2:]
            control = coords[:2] if cmd == "Q" else mirror
        else:
            control = None
        letter, text = min([(cmd, numbers(coords)), (cmd.lower(), numbers(relative))], key=lambda f: len(f[1]))
        # A repeated letter can go, except after M, where a repeat means L.
        if letter == last and letter not in "MmZ":
            out.append(text if text.startswith("-") else f" {text}")
        else:
            out.append(letter + text)
        last = letter
    result = "".join(out)
    if drawn(result) != drawn(path):
        sys.exit(f"compacting changed a path: {path}")
    return result


def paths(font_path: str, opsz: int, names: list[str]) -> dict[str, str]:
    """Path data per name at one optical size; `_fill` names come from the FILL 1 instance."""
    out = {}
    for fill in (0, 1):
        font = instantiateVariableFont(TTFont(font_path), {"FILL": fill, "GRAD": 0, "wght": 400, "opsz": opsz})
        glyphs = font.getGlyphSet()
        for name in names:
            if name.endswith("_fill") != bool(fill):
                continue
            base = name.removesuffix("_fill")
            glyph = ALIASES.get(base, base)
            if glyph not in glyphs:
                sys.exit(f"missing icon: {glyph}")
            pen = SVGPathPen(glyphs, ntos=lambda n: str(round(n)))
            # Font units are y-up from the baseline; SVG viewBox 0 -960 960 960 is y-down.
            glyphs[glyph].draw(TransformPen(DropEmptySegments(pen), (1, 0, 0, -1, 0, 0)))
            out[name] = compact(pen.getCommands())
    return out

def main() -> None:
    src = sys.argv[1]
    cuts = {opsz: paths(src, opsz, names) for opsz, names in OPSZ.items()}
    lines = [
        "// Generated by scripts/material-symbols.py from Material Symbols Outlined",
        "// (Apache-2.0, https://github.com/google/material-design-icons): wght 400, GRAD 0, FILL 0 (FILL 1 for *_fill).",
        "// Do not edit by hand; add names to the script and regenerate.",
        "",
        "/** SVG path data per icon, keyed by the optical sizes it is drawn at (viewBox 0 -960 960 960). */",
        "export const SYMBOLS = {",
    ]
    names = sorted(set().union(*cuts.values()))
    for name in names:
        entries = ", ".join(f"{opsz}: '{cuts[opsz][name]}'" for opsz in OPSZ if name in cuts[opsz])
        lines.append(f"  {name}: {{ {entries} }},")
    lines += ["} as const", "", "export type SymbolName = keyof typeof SYMBOLS", ""]
    target = Path(__file__).resolve().parent.parent / "src/renderer/src/components/ui/symbols.ts"
    target.write_text("\n".join(lines))
    print(f"wrote {len(names)} icons to {target}")

if __name__ == "__main__":
    main()
