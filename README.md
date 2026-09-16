# Flowcheck: Constraint Verification for Vibe-Coded Web Apps

Author behavioral constraints on a vibe-coded web app (e.g. *clicking
add-to-cart always updates the cart count*), then verify them with
CodeQL against the app source.

Constraints use a small DSL: `P(w(cartCount) | A(addBtn)) = 1` means
clicking `addBtn` always writes `cartCount`.

## Requirements

- Python 3.10+
- [CodeQL CLI](https://codeql.github.com/docs/codeql-cli/) on your `PATH`
- ANTLR4 only if you change `Constraint.g4`

## Run

```bash
pip install -r requirements.txt
codeql --version
python run.py
```

Open [http://localhost:5050](http://localhost:5050).

## In the UI

Work top to bottom (check steps off yourself as you go):

1. **Element Mapping → Inject IDs** — add stable `cv_`* ids to the app.
2. **Refresh the element list** — chips for the parser and overlay.
3. **Build the CodeQL database** — required before static checks.
4. **Visual Builder → Open preview** — click action and targets in the overlay.
5. **Send to app**, then **Parser** — load the formula and run checks.

Point every path at the same app directory (e.g. `./test-app`).

## Eval apps

```bash
python3 eval.py
```

Runs the constraint set on the modified Amazon / Twitter / Airbnb /
Slack apps and writes `eval_results.md`. Extra feature tests live next
to `eval.py`.

To add an app: put it in `test-app-<name>/`, then follow the UI steps
above on that path.

## Layout

- `Constraint.g4`, `src/parser/` — DSL grammar and AST visitor
- `src/constraints/` — classifier, semantics, constraint types
- `src/static_checks.py`, `queries/` — CodeQL primitives
- `src/mapping/` — id injection and element scan
- `app/`, `static/` — Flask UI and overlay (`constraint-builder.js`)
- `test-app-*/` — sample apps and `-modified` bug-injected copies



## Regenerating the parser

After editing `Constraint.g4`:

```bash
antlr4 -Dlanguage=Python3 -visitor Constraint.g4
```

