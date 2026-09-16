"""
Visitor 2 — semantic analysis on the dict AST.

Walks the AST returned by `src.parser.ast_visitor.ASTBuilder` and enforces:

  1. Condition side must contain a user action A(...) or system action call(...).
  2. Event side must contain a write event w(...), system action call(...),
     compound event, or guard.
  3. Element in A(e) must exist in the mapping and be kind="action".
  4. Element in w(e) must exist in the mapping.
  5. Element in r(e) (and len/increment over it) must exist in the mapping.
  6. Probability must lie in [0, 1].
  7. API in call(api) (and status(api)) must exist in the mapping.
  8. The only action allowed on the event side is a system action — no A(...).

`analyze()` collects every violation rather than failing fast so the UI can
surface them all in one pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from ..mapping.pipeline import load_mapping, MAPPING_FILE


# Element identifiers that are language sentinels, not real UI elements.
_BUILTIN_ELEMENT_NAMES = {"api_result"}

# Reserved synthetic action ids: not real DOM elements, but valid in A(...).
# Used for lifecycle events that don't have a clickable surface.
_SYNTHETIC_ACTIONS = {"page-load"}


@dataclass
class SemanticIssue:
    code: str        # short stable code, e.g. "E001"
    message: str     # human-readable detail

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


@dataclass
class SemanticAnalysisResult:
    valid: bool
    issues: list[SemanticIssue]

    def to_dict(self) -> dict:
        return {
            "valid":  self.valid,
            "issues": [i.to_dict() for i in self.issues],
        }


def analyze(ast: dict, mapping: dict | None = None) -> SemanticAnalysisResult:
    """Run every semantic check and return the collected issues."""
    issues: list[SemanticIssue] = []

    # Load the approved mapping if the caller didn't pre-supply one. Identifier
    # checks are silently skipped if no mapping has been approved yet.
    if mapping is None and MAPPING_FILE.exists():
        try:
            mapping = load_mapping(MAPPING_FILE)
        except Exception:
            mapping = None

    if not isinstance(ast, dict) or ast.get("type") != "Probabilistic":
        issues.append(SemanticIssue(
            "E000", "Top-level constraint must be a probabilistic constraint."))
        return SemanticAnalysisResult(valid=False, issues=issues)

    event     = ast.get("event")
    condition = ast.get("condition")

    _check_probability(ast, issues)
    _check_condition_side(condition, issues)
    _check_event_side(event, issues)
    _check_counterfactual_scope(ast, issues)

    if mapping is not None:
        _check_identifiers(ast, mapping, issues)

    return SemanticAnalysisResult(valid=(not issues), issues=issues)


def _check_counterfactual_scope(ast: dict, issues: list[SemanticIssue]) -> None:
    """Counterfactual (¬A on condition) with a guard on the same condition
    has ambiguous semantics — it would mean 'for every action other than
    A, when the guard holds, the event fires,' which we haven't committed
    to. Reject the combination at semantic time rather than silently
    dropping the guard at dispatch time."""
    condition = ast.get("condition") or {}
    if not condition.get("negated"):
        return
    if condition.get("guard") is not None:
        issues.append(SemanticIssue(
            "E009",
            "Counterfactual (¬A) with a guard (AND r(g) > ...) is not "
            "supported — the combined semantics are ambiguous. Either "
            "drop the guard, or replace ¬A with A(...) if you want the "
            "guard to apply."))


# ---------------------------------------------------------------------------
# Structural rules (1, 2, 6, 8)
# ---------------------------------------------------------------------------

def _check_probability(ast: dict, issues: list[SemanticIssue]) -> None:
    p = ast.get("probability")
    if not isinstance(p, (int, float)) or isinstance(p, bool):
        issues.append(SemanticIssue(
            "E006", f"Probability must be a number, got {p!r}."))
        return
    if p < 0 or p > 1:
        issues.append(SemanticIssue(
            "E006", f"Probability {p} must be in [0, 1]."))
        return
    # The static checker only decides the two endpoints of the probability
    # axis. P = 1 routes to the universal branch (behaviour must hold on
    # every handler path); P = 0 routes to the absence branch (behaviour
    # must never occur). Intermediate probabilities have no sound static
    # reading — reject them explicitly rather than silently coercing.
    if p != 0 and p != 1:
        issues.append(SemanticIssue(
            "E006",
            f"Probability {p} is not statically decidable — the checker "
            f"supports only P = 0 (event must not occur) and P = 1 "
            f"(event must occur on every path). Intermediate probabilities "
            f"are future work (runtime tracing)."))


def _check_condition_side(condition: Any, issues: list[SemanticIssue]) -> None:
    """Rule 1."""
    if not _contains_any_type(condition, {"Action", "CallEvent"}):
        issues.append(SemanticIssue(
            "E001",
            "Right side of '|' (condition) must contain a user action "
            "A(...) or a system action call(...)."))


def _check_event_side(event: Any, issues: list[SemanticIssue]) -> None:
    """Rules 2 and 8."""
    allowed = {"WriteEvent", "CallEvent", "CompoundEvent", "PersistEvent", "NotEvent"}
    if not _contains_any_type(event, allowed):
        issues.append(SemanticIssue(
            "E002",
            "Left side of '|' (event) must contain a write event w(...), "
            "a system action call(...), a compound event, "
            "or a persistence assertion persist(...). Bare guard "
            "comparisons (e.g., r(x) > 0) are only valid on the right "
            "side of '|' as condition modifiers."))
    if _contains_any_type(event, {"Action"}):
        issues.append(SemanticIssue(
            "E008",
            "Left side of '|' cannot contain a user action A(...) — "
            "only system actions call(...) are allowed there."))


def _contains_any_type(node: Any, type_set: set[str]) -> bool:
    """True if any dict in the subtree has `type` in *type_set*."""
    if isinstance(node, dict):
        if node.get("type") in type_set:
            return True
        return any(_contains_any_type(v, type_set) for v in node.values())
    if isinstance(node, list):
        return any(_contains_any_type(item, type_set) for item in node)
    return False


# ---------------------------------------------------------------------------
# Identifier rules (3, 4, 5, 7)
# ---------------------------------------------------------------------------

def _check_identifiers(ast: dict, mapping: dict, issues: list[SemanticIssue]) -> None:
    elements:  dict = mapping.get("elements",  {}) or {}
    storage:   dict = mapping.get("storage",   {}) or {}
    apis:      dict = mapping.get("apis",      {}) or {}
    selectors: dict = mapping.get("selectors", {}) or {}

    # Identifiers that w(...) and r(...) accept besides DOM elements:
    # storage entries (localStorage / sessionStorage) and API endpoints.
    # An "element-like" identifier is anything that can be written or read
    # — covers UI elements, storage entries, and API names.
    element_like: set[str] = (
        set(elements.keys()) | set(storage.keys()) | set(apis.keys())
    )

    for node in _walk_dicts(ast):
        ntype = node.get("type")

        if ntype == "Action":
            _check_action_element(node, elements, selectors, issues)

        elif ntype == "WriteEvent":
            name = node.get("element")
            if not isinstance(name, str):
                continue
            if name in _BUILTIN_ELEMENT_NAMES or name not in element_like:
                issues.append(SemanticIssue(
                    "E004",
                    f"'{name}' in w({name}) is not a known UI element, "
                    f"storage entry, or API in the mapping."))

        elif ntype == "PersistEvent":
            name = node.get("element")
            if not isinstance(name, str):
                continue
            # persist(target) requires the target to be a storage entry
            # (localStorage / sessionStorage key). DOM elements and APIs
            # don't make sense as persistence targets.
            if name not in storage:
                issues.append(SemanticIssue(
                    "E006",
                    f"'{name}' in persist({name}) is not a known storage "
                    f"entry in the mapping. persist(...) requires a target "
                    f"that the app calls localStorage.setItem(...) with."))

        elif ntype in ("ReadExpr", "LenExpr", "IncrementExpr"):
            name = node.get("element")
            if not isinstance(name, str):
                continue
            if name in _BUILTIN_ELEMENT_NAMES:
                continue  # api_result is a language sentinel, not a UI element
            if name not in element_like:
                issues.append(SemanticIssue(
                    "E005",
                    f"'{name}' in r({name}) is not a known UI element, "
                    f"storage entry, or API in the mapping."))

        elif ntype in ("CallEvent", "StatusExpr"):
            # API auto-discovery is not in the scan_ids pipeline yet, so we
            # only validate APIs when the user has manually populated the
            # apis section of element_mapping.json.
            if not apis:
                continue
            api_name = node.get("api")
            if isinstance(api_name, str) and api_name not in apis:
                issues.append(SemanticIssue(
                    "E007",
                    f"API '{api_name}' is not in the extracted API mapping."))


def _check_action_element(node: dict, elements: dict,
                          selectors: dict,
                          issues: list[SemanticIssue]) -> None:
    """Rule 3: ei in A(ei) must exist AND have kind 'action'.

    `ei` is either a DOM element id (looked up in mapping.elements) or
    a CSS class selector `.cls` (looked up in mapping.selectors, leading
    dot stripped). Selectors are implicitly action-kind, so the kind
    check is skipped for them.
    """
    name = node.get("element")
    if not isinstance(name, str):
        return

    # Reserved synthetic actions (lifecycle events). Not in the mapping
    # by design — they are not visible DOM elements but are still valid
    # in A(...). Extend this set when adding new lifecycle keywords.
    if name in _SYNTHETIC_ACTIONS:
        return

    # Class selector path: `.classname` → look up `classname` in selectors.
    if name.startswith("."):
        cls = name[1:]
        if not cls or cls not in selectors:
            issues.append(SemanticIssue(
                "E003",
                f"Class selector '{name}' in A({name}) is not in the mapping. "
                f"Run scan_ids — did you wire up a `querySelectorAll('.{cls}')` "
                f"or similar pattern in your source?"))
        return

    # DOM element path.
    if name in _BUILTIN_ELEMENT_NAMES or name not in elements:
        issues.append(SemanticIssue(
            "E003",
            f"Element '{name}' in A({name}) is not in the mapping."))
        return
    kind = elements[name].get("kind")
    if kind != "action":
        issues.append(SemanticIssue(
            "E003",
            f"Element '{name}' in A({name}) has kind '{kind or 'unknown'}', "
            f"but A(...) requires kind 'action'."))


def _walk_dicts(node: Any) -> Iterable[dict]:
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk_dicts(v)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_dicts(item)


__all__ = ["analyze", "SemanticIssue", "SemanticAnalysisResult"]
