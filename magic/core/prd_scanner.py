"""PRD scanner for Magic Modules.

Runs during the REASON phase of a build. Reads the PRD, detects
UI component mentions (Button, Modal, Form, Table, Card, Nav, etc.),
and creates bare-minimum markdown specs at .loki/magic/specs/<Name>.md.

The generated specs are stubs -- placeholder for agents to refine
during the ACT phase. The goal is to make component needs explicit
and trackable from iteration 1, not discovered mid-build.
"""

import re
from pathlib import Path
from typing import Optional

# Component keywords to detect in PRDs. Map lowercase keyword -> default PascalCase name.
UI_COMPONENT_VOCAB = {
    "button": "Button",
    "modal": "Modal",
    "dialog": "Dialog",
    "form": "Form",
    "input": "Input",
    "textarea": "Textarea",
    "select": "Select",
    "dropdown": "Dropdown",
    "checkbox": "Checkbox",
    "radio": "Radio",
    "toggle": "Toggle",
    "switch": "Switch",
    "slider": "Slider",
    "table": "Table",
    "list": "List",
    "card": "Card",
    "tile": "Tile",
    "navigation": "Navigation",
    "navbar": "Navbar",
    "sidebar": "Sidebar",
    "header": "Header",
    "footer": "Footer",
    "tabs": "Tabs",
    "accordion": "Accordion",
    "badge": "Badge",
    "avatar": "Avatar",
    "toast": "Toast",
    "notification": "Notification",
    "tooltip": "Tooltip",
    "popover": "Popover",
    "menu": "Menu",
    "breadcrumb": "Breadcrumb",
    "pagination": "Pagination",
    "progress bar": "ProgressBar",
    "spinner": "Spinner",
    "loader": "Loader",
    "chart": "Chart",
    "graph": "Graph",
    "search bar": "SearchBar",
    "filter": "FilterPanel",
    "login": "LoginForm",
    "signup": "SignupForm",
    "profile": "ProfileCard",
    "dashboard": "Dashboard",
}

# Patterns that strongly suggest component intent (vs incidental mentions)
INTENT_MARKERS = [
    r"\badd\s+(?:a|an|the)\s+",
    r"\bbuild\s+(?:a|an|the)\s+",
    r"\bcreate\s+(?:a|an|the)\s+",
    r"\bneed\s+(?:a|an|the)\s+",
    r"\bwith\s+(?:a|an|the)\s+",
    r"\binclude\s+(?:a|an|the)\s+",
    r"\bshould\s+have\s+(?:a|an|the)\s+",
]

INTENT_RE = re.compile("|".join(INTENT_MARKERS), re.IGNORECASE)

STUB_TEMPLATE = """# {name}

## Description
Auto-seeded by the PRD scanner from phrase: "{evidence}".
Agents: refine this spec during the REASON/ACT phases. Fill in props,
behavior, visual details, and accessibility requirements based on the
PRD context. The spec is the source of truth; implementation regenerates
from it.

## Props
- (to be determined by agent based on PRD context)

## Behavior
(to be determined)

## Visual / Styling
(to be determined -- use design tokens from .loki/magic/tokens.json)

## Accessibility
- Keyboard navigation: (to be determined)
- Screen reader: (to be determined)
- Focus management: (to be determined)

## Examples
```tsx
<{name} />
```
"""


def scan_prd(prd_text: str, limit: int = 20) -> list:
    """Scan a PRD and return a list of detected component intents.

    Returns list of dicts: {name, keyword, evidence, confidence}
    Confidence is 'high' when intent marker + keyword co-occur in same sentence,
    'medium' for keyword alone, 'low' for case-sensitive matches only.
    """
    if not prd_text:
        return []
    detected = []
    seen_names = set()

    # Split into sentences (approximate)
    sentences = re.split(r"[.!?\n]+", prd_text)
    for sent in sentences:
        sent_clean = sent.strip()
        if not sent_clean:
            continue
        sent_lower = sent_clean.lower()
        has_intent = bool(INTENT_RE.search(sent_clean))

        for keyword, default_name in UI_COMPONENT_VOCAB.items():
            if keyword not in sent_lower:
                continue
            # Try to extract a more specific name from context, e.g.
            # "add a Submit button" -> "SubmitButton"
            name = _extract_compound_name(sent_clean, keyword, default_name)
            if name in seen_names:
                continue
            seen_names.add(name)
            confidence = "high" if has_intent else "medium"
            detected.append({
                "name": name,
                "keyword": keyword,
                "evidence": sent_clean[:200],
                "confidence": confidence,
            })
            if len(detected) >= limit:
                return detected
    return detected


def _extract_compound_name(sentence: str, keyword: str, default: str) -> str:
    """Try to derive a PascalCase compound name from context.

    Examples:
      "add a submit button" + "button" -> "SubmitButton"
      "create a user profile card" + "card" -> "UserProfileCard"
      "the search bar" + "search bar" -> "SearchBar"
    Falls back to the default PascalCase form of the keyword.
    """
    # Find the keyword position
    low = sentence.lower()
    idx = low.find(keyword)
    if idx < 0:
        return default
    # Look at 1-3 words before the keyword
    before = sentence[:idx].strip()
    tokens = re.findall(r"[A-Za-z]+", before)
    # Filter out stop words. Verb forms of intent markers ("includes",
    # "contains", "built", etc.) are stops -- otherwise phrases like
    # "dashboard includes navigation" produce "DashboardIncludesNavigation".
    stop = {
        "a", "an", "the", "with", "and", "or", "of", "for", "to", "in",
        "on", "at", "by", "from", "into", "as",
        "add", "adds", "added", "adding",
        "build", "builds", "built", "building",
        "create", "creates", "created", "creating",
        "need", "needs", "needed", "needing",
        "include", "includes", "included", "including",
        "contain", "contains", "contained", "containing",
        "have", "has", "had", "having",
        "require", "requires", "required", "requiring",
        "should", "must", "will", "can", "may",
        "our", "my", "their", "its", "this", "that", "these", "those",
        "new", "simple", "basic", "complex", "main", "primary", "user",
        "also", "plus", "along",
    }
    # Another UI component keyword in the modifier slot means we're spanning
    # two separate components (e.g. "navigation sidebar search bar" produces
    # name "NavigationSidebarSearchBar"). Stop before that token.
    other_component_keywords = {
        k.replace(" ", "") for k in UI_COMPONENT_VOCAB.keys() if k != keyword
    } | set(UI_COMPONENT_VOCAB.keys())
    # Take last 1-2 non-stop, non-component tokens
    modifiers = []
    for tok in reversed(tokens):
        tok_low = tok.lower()
        if tok_low in stop:
            if modifiers:
                break
            continue
        if tok_low in other_component_keywords:
            # Another distinct component name -- stop scanning modifiers.
            break
        modifiers.append(tok)
        if len(modifiers) >= 2:
            break
    modifiers.reverse()
    if not modifiers:
        return default
    # PascalCase the modifiers + default
    parts = [m.capitalize() for m in modifiers] + [default]
    # Deduplicate adjacent parts (e.g. "UserUser")
    out = [parts[0]]
    for p in parts[1:]:
        if p != out[-1]:
            out.append(p)
    name = "".join(out)
    # Validate against name regex
    if not re.match(r"^[A-Za-z][A-Za-z0-9_-]*$", name):
        return default
    return name


def seed_specs(detected: list, project_dir: str = ".", overwrite: bool = False) -> list:
    """Write stub specs to .loki/magic/specs/. Returns list of paths written.

    If overwrite=False (default), existing specs are never replaced.
    """
    specs_dir = Path(project_dir) / ".loki" / "magic" / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for item in detected:
        if item.get("confidence") == "low":
            continue
        name = item["name"]
        spec_path = specs_dir / f"{name}.md"
        if spec_path.exists() and not overwrite:
            continue
        stub = STUB_TEMPLATE.format(name=name, evidence=item["evidence"])
        spec_path.write_text(stub)
        written.append(str(spec_path))
    return written


def scan_and_seed(prd_text: str, project_dir: str = ".", overwrite: bool = False) -> dict:
    """Convenience: scan PRD, seed specs, return summary dict."""
    detected = scan_prd(prd_text)
    written = seed_specs(detected, project_dir=project_dir, overwrite=overwrite)
    return {
        "detected_count": len(detected),
        "detected": detected,
        "seeded_count": len(written),
        "seeded_paths": written,
    }


if __name__ == "__main__":
    import sys
    import json
    if len(sys.argv) < 2:
        print("Usage: python -m magic.core.prd_scanner <PRD_PATH> [project_dir]")
        sys.exit(1)
    prd_path = sys.argv[1]
    project = sys.argv[2] if len(sys.argv) > 2 else "."
    prd_text = Path(prd_path).read_text()
    result = scan_and_seed(prd_text, project_dir=project)
    print(json.dumps(result, indent=2))
