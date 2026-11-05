# Third-party notices

HideGPT includes code adapted from, or assets bundled from, the projects below.

## T3 Code (MIT)

https://github.com/pingdotgg/t3code

These files are adapted from `apps/web/src/components/ui/`. Each one keeps a
header pointing to its source file:

| HideGPT file | Adapted from |
| --- | --- |
| `src/renderer/src/components/ui/closing-positioner.tsx` | `closing-positioner.tsx` |
| `src/renderer/src/components/ui/menu.tsx` | `menu.tsx` |
| `src/renderer/src/components/ui/popover.tsx` | `popover.tsx` |
| `src/renderer/src/components/ui/dialog.tsx` | `dialog.tsx` |
| `src/renderer/src/components/ui/tooltip.tsx` | `tooltip.tsx` |

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Material Symbols (Apache-2.0)

https://github.com/google/material-design-icons

`src/renderer/src/components/ui/symbols.ts` holds outlines that
`scripts/material-symbols.py` extracts from the Material Symbols Outlined font.
The full license text is in `src/renderer/src/components/ui/symbols.LICENSE.txt`.

## Fonts (SIL Open Font License 1.1)

Google Sans Flex (`@fontsource-variable/google-sans-flex`) and Roboto
(`@fontsource/roboto`) are installed as npm packages and bundled at build time.
So are the unmodified faces the font menu previews (`src/renderer/src/fonts.ts`):
Amatic SC, Caladea, Carlito, Caveat, Comfortaa, EB Garamond, Lexend, Lobster,
Lora, Merriweather, Montserrat, Nunito, Open Sans, Oswald, Pacifico, Playfair
Display, Roboto Mono and Spectral. Each package ships its license as `LICENSE`.
