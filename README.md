# JSON Tree Viewer

A zero-install, single-page tool for pasting JSON (or JSON Lines) and exploring it as a syntax-highlighted document stacked above an interactive D3 tree. Clicking anywhere in one pane jumps to the matching spot in the other.

## Files

```
json-tree-viewer.html   entry point — layout and script tags
json-tree-viewer.css    styling for panels, tree nodes, popover, highlights
json-tree-viewer.js     parsing, HTML rendering, D3 tree, cross-pane linking
test.json               sample input
```

No build step, no dependencies to install. D3 v7 and jsonrepair are loaded from CDNs in the HTML.

## How to use

1. Open `json-tree-viewer.html` in any modern browser (double-click, or `open json-tree-viewer.html` on macOS).
2. Paste JSON or JSON Lines into the **JSON Input** textarea.
3. Press **Enter** (or click **Visualize**). Use **Shift+Enter** to insert a newline inside the textarea without visualizing.
4. Explore:
   - **JSON Input pane (top)** — pretty-printed, color-coded JSON. Hovering highlights the element; clicking scrolls the tree to the same node and flashes it.
   - **Tree Visualization pane (bottom)** — collapsible tree. Click an internal node to expand/collapse; click a leaf to see the full value in a popover and scroll the JSON pane to that key.
   - **Zoom / pan** the tree with the mouse wheel and by dragging with the left mouse button.
5. **Edit JSON** puts the input back into a textarea for changes; **Clear** resets both panes.
6. If parsing fails, the right pane shows an error report: the native message, a code excerpt with a
   caret at the failing column, and a bracket-structure analysis (unclosed or mismatched `{`/`[`,
   pinpointed by line *and* column so a line with several closing brackets isn't ambiguous) — useful
   for spotting truncated pastes. The input textarea also has a line-number gutter so you can jump
   straight to the line the error names.
7. A **Fix JSON** button appears next to Edit JSON whenever the last Visualize failed. Click it to
   auto-repair the input (closes unterminated strings/brackets, strips trailing commas, falls back to
   the jsonrepair library for anything tougher) and immediately re-visualize. It disappears again as
   soon as a parse succeeds.

### JSON Lines support

If a top-level `JSON.parse` fails, the input is retried line by line. If every non-blank line parses cleanly and there are at least two of them, the result is treated as an array of records — useful for pasting Claude Code transcript files (`~/.claude/projects/.../*.jsonl`) or any NDJSON stream. Regular JSON always wins the first attempt, so behavior is unchanged for normal input.

## Internals

### Parsing — `parseJSONOrJSONL` (json-tree-viewer.js)

Tries `JSON.parse(input)` first; on failure splits on `\n`, trims, drops blanks, and re-parses line-by-line. Rethrows the original error if the JSONL fallback doesn't apply, so the error banner keeps showing the more informative single-parse message.

### JSON Input pane: HTML render — `renderJSONAsHTML`

Recursively walks the parsed value, emitting a `<pre>` with:

- Type-specific spans: `.json-key`, `.json-string`, `.json-number`, `.json-boolean`, `.json-null`, `.json-clickable-brace`.
- A stable `id` on every key/item, built from the object path (`root_address_city`, `root_hobbies_[0]`, …). These IDs are the link between the two panes.
- Long strings (>80 chars or containing newlines) are broken into `.json-string-line` spans so horizontal scrolling stays sane.

### Tree Visualization pane: tree — `jsonToHierarchy` + `renderTree` + `update`

- `jsonToHierarchy` converts the parsed value into a `{name, value, path, type, displayValue, fullValue, children}` tree. `displayValue` is truncated for compact node labels; `fullValue` is kept for the popover.
- `renderTree` sets up the SVG (2400×1200 canvas), the `d3.tree()` layout, and a `d3.zoom` behavior. All children are collapsed on first render via `collapse()`.
- `update(source)` handles the enter/update/exit cycle with 500 ms transitions and draws the cubic-bezier links via `diagonal()`.

### Cross-pane linking

- **JSON → tree**: `attachJSONClickHandlers` binds a click on every `[id^="root"]` element. The ID is split back into a path and passed to `expandTreeNode`, which walks the hierarchy, expands ancestors, centers the target node in view, and flashes its circle red.
- **Tree → JSON**: `click` (the D3 node handler) calls `scrollToNodeInJSON`, which reconstructs the element ID from `d.data.path`, scrolls it into view, and briefly applies `.json-highlight`.

### Popover

Leaf-node clicks show the untruncated value in `#popover`, positioned near the cursor. A document-level click listener dismisses it when you click outside.

### Input editor gutter — `buildInputEditor` / `renderInputEditor` / `initInputEditor`

The input panel is an `.editor` div holding a `.line-numbers` gutter and a `wrap="off"` textarea
(built via DOM element creation, not `innerHTML`, so it's safe to hand it arbitrary pasted text).
`renderInputEditor(value)` rebuilds this pair and is called on page load and by `editJSON`/`clearAll`.
`updateLineNumbers` recomputes the gutter from `textarea.value.split('\n').length` on every `input`
event; a `scroll` listener keeps the gutter's `scrollTop` locked to the textarea's.

### Error diagnostics — `buildErrorReport`

Replaces the plain `error.message` banner shown on a failed parse. Three pieces, all built via
`createElement`/`textContent` (never `innerHTML`) since the excerpt echoes raw pasted bytes:

- `locateErrorPosition` regexes `line`/`column`/`position` out of the native `SyntaxError` message,
  falling back to counting newlines up to `position` when the engine only reports one.
- `buildExcerpt` renders ~3 lines of context around the failing line with a `^` caret under the column.
- `analyzeBrackets` walks the input tracking string/escape state (so quoted `{`/`[` don't count) and a
  1-based line *and* column for every opener/closer. A non-empty stack at EOF is reported as "N
  brackets never closed" with each opener's line — the signal for a truncated paste. A closer that
  doesn't match the top of the stack is reported as a mismatch with both endpoints' line **and**
  column, and `buildErrorReport` renders a second `buildExcerpt` caret at that exact character —
  necessary because a single line can contain more than one `]`/`}`.

### Auto-fix — `repairJSON` / `fixJSON`

The **Fix JSON** button (`#fixBtn` in the HTML) is hidden by default and toggled by `setFixVisible`,
called from `visualizeJSON`'s success path (hide) and `catch` (show), plus `clearAll` and initial load.

- `repairJSON(input)` is a small, targeted heuristic — not a general repair — aimed at the failure
  modes this tool actually surfaces: it re-scans for open brackets/unterminated strings independently
  of `analyzeBrackets` (which stops at the first mismatch), closes a dangling string, strips trailing
  commas, and appends the missing closers in reverse stack order. This alone fixes a truncated paste.
- `fixJSON()` runs the heuristic, and if `JSON.parse` still fails, falls back to the `jsonrepair`
  library loaded from CDN (`window.JSONRepair.jsonrepair`) when that global is present — so the tool
  degrades gracefully (heuristic-only) if the CDN is unreachable. The result replaces the editor
  content via `renderInputEditor` and `visualizeJSON()` runs again, which naturally hides the button
  on success or shows an updated error report if repair wasn't enough.

### State

Everything lives in a handful of module-scoped variables (`svg`, `g`, `tree`, `root`, `zoomBehavior`, `i` for node IDs). The current input is stashed on `#jsonInput`'s `dataset.jsonContent` so **Edit JSON** can round-trip back to the textarea.

## Extending

- **New value types / colors** — add a `.json-*` class in the CSS, a branch in `renderValue` (`renderJSONAsHTML`), and a `data.type === '...'` branch in the text-rendering block of `update`.
- **Different layout** — swap `d3.tree()` for `d3.cluster()` or a radial layout in `renderTree`; the enter/update/exit code doesn't care.
- **Search / filter** — the path-based IDs make it easy to walk the tree, collect matches, and reuse `expandTreeNode` to jump to each hit.
