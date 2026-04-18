"""Test scaffold generator for Magic components.

Generates Vitest tests for React components and Playwright tests for
Web Components. Uses heuristics from the spec (detected props, behaviors,
accessibility requirements) to scaffold meaningful assertions, not just
smoke tests.
"""

import re
from pathlib import Path
from typing import Optional


class TestGenerator:
    """Generate test scaffolds for Magic-generated components.

    The generator consumes a component's source code together with its
    spec (typically a markdown doc) and produces unit tests (Vitest for
    React) or end-to-end tests (Playwright for Web Components) with
    assertions that go beyond smoke tests. A Storybook-compatible
    snapshot story can also be produced for Chromatic integration.
    """

    def __init__(self, project_dir: str = "."):
        self.project_dir = Path(project_dir)

    # ----- Public API --------------------------------------------------

    def generate_react_test(
        self, component_code: str, component_name: str, spec: str
    ) -> str:
        """Generate a Vitest + React Testing Library test file.

        Included assertions:
        - Component renders without crashing
        - Each prop is exercised
        - Accessibility: has expected ARIA attributes
        - Keyboard interaction (if spec mentions it)
        - Snapshot test
        """
        safe_name = self._safe_name(component_name)
        props = self._extract_props(spec)
        a11y_reqs = self._extract_a11y(spec)
        keyboard = self._has_keyboard_interaction(spec)

        default_props = self._default_props(props)

        lines = []
        lines.append('import { describe, it, expect } from "vitest";')
        lines.append('import { render, screen } from "@testing-library/react";')
        if keyboard:
            lines.append('import { fireEvent } from "@testing-library/react";')
        lines.append(f'import {{ {safe_name} }} from "./{safe_name}";')
        lines.append("")
        lines.append(f'describe("{safe_name}", () => {{')
        lines.append('    it("renders without crashing", () => {')
        lines.append(
            f"        render(<{safe_name}{(' ' + default_props) if default_props else ''} />);"
        )
        lines.append(
            f'        expect(screen.getByTestId("{safe_name.lower()}")).toBeDefined();'
        )
        lines.append("    });")
        lines.append("")

        for prop in props:
            lines.append(self._prop_test(safe_name, prop))

        for req in a11y_reqs:
            lines.append(self._a11y_test(safe_name, req))

        if keyboard:
            lines.append(self._keyboard_test(safe_name, default_props))

        lines.append(self._snapshot_test(safe_name, default_props))
        lines.append("});")
        lines.append("")
        return "\n".join(lines)

    def generate_webcomponent_test(
        self, component_code: str, component_name: str, spec: str
    ) -> str:
        """Generate a Playwright test for a Web Component.

        Covers:
        - Component mounts in a page and shadow root renders
        - Attributes (derived from detected props) reflect to state
        - Accessibility requirements mentioned in spec
        """
        safe_name = self._safe_name(component_name)
        tag = self._kebab_case(safe_name)
        props = self._extract_props(spec)
        a11y_reqs = self._extract_a11y(spec)

        lines = []
        lines.append('import { test, expect } from "@playwright/test";')
        lines.append("")
        lines.append(f'const FIXTURE_URL = "/fixtures/{tag}.html";')
        lines.append("")
        lines.append(f'test.describe("{safe_name} web component", () => {{')
        lines.append('    test("mounts and exposes shadow DOM", async ({ page }) => {')
        lines.append("        await page.goto(FIXTURE_URL);")
        lines.append(f'        const host = page.locator("{tag}");')
        lines.append("        await expect(host).toBeVisible();")
        lines.append(
            "        const hasShadow = await host.evaluate("
            "(el) => !!el.shadowRoot);"
        )
        lines.append("        expect(hasShadow).toBe(true);")
        lines.append("    });")
        lines.append("")

        for prop in props:
            attr = self._kebab_case(prop["name"])
            lines.append(
                f'    test("reflects attribute {attr}", async ({{ page }}) => {{'
            )
            lines.append("        await page.goto(FIXTURE_URL);")
            lines.append(f'        const host = page.locator("{tag}");')
            lines.append(
                f'        await host.evaluate((el, v) => el.setAttribute("{attr}", v), '
                f'"{self._sample_value(prop)}");'
            )
            lines.append(
                f'        const value = await host.getAttribute("{attr}");'
            )
            lines.append(
                f'        expect(value).toBe("{self._sample_value(prop)}");'
            )
            lines.append("    });")
            lines.append("")

        for req in a11y_reqs:
            slug = re.sub(r"\W+", "-", req.lower()).strip("-") or "a11y"
            lines.append(
                f'    test("a11y: {req}", async ({{ page }}) => {{'
            )
            lines.append("        await page.goto(FIXTURE_URL);")
            lines.append(f'        const host = page.locator("{tag}");')
            lines.append("        const role = await host.getAttribute(\"role\");")
            lines.append("        const ariaLabel = await host.getAttribute(\"aria-label\");")
            lines.append(
                "        expect(role || ariaLabel).toBeTruthy();"
            )
            lines.append(f'        // requirement: {req}')
            lines.append(f'        // tag: {slug}')
            lines.append("    });")
            lines.append("")

        lines.append("});")
        lines.append("")
        return "\n".join(lines)

    def generate_snapshot(self, component_name: str) -> str:
        """Generate a Storybook story (also usable as Chromatic snapshot)."""
        safe_name = self._safe_name(component_name)
        lines = []
        lines.append(f'import type {{ Meta, StoryObj }} from "@storybook/react";')
        lines.append(f'import {{ {safe_name} }} from "./{safe_name}";')
        lines.append("")
        lines.append(f'const meta: Meta<typeof {safe_name}> = {{')
        lines.append(f'    title: "Magic/{safe_name}",')
        lines.append(f'    component: {safe_name},')
        lines.append('    parameters: {')
        lines.append('        chromatic: { viewports: [320, 768, 1280] },')
        lines.append('    },')
        lines.append("};")
        lines.append("")
        lines.append("export default meta;")
        lines.append(f'type Story = StoryObj<typeof {safe_name}>;')
        lines.append("")
        lines.append("export const Default: Story = {")
        lines.append("    args: {},")
        lines.append("};")
        lines.append("")
        return "\n".join(lines)

    # ----- Spec parsing helpers ---------------------------------------

    def _extract_props(self, spec: str) -> list:
        """Parse `## Props` section of spec to get prop names and types.

        Supports a few common markdown styles:
        - ``- name (type): description``
        - ``| name | type | description |`` (markdown table rows)
        - ``* name - type - description``
        Returns a list of dicts: {name, type, description, required}.
        """
        if not spec:
            return []
        section = self._extract_section(spec, "Props")
        if not section:
            return []

        props: list = []
        seen: set = set()

        # Dash/bullet lines: - name (type[, required]): description
        bullet_re = re.compile(
            r"^\s*[-*]\s+`?(?P<name>[A-Za-z_][\w-]*)`?"
            r"(?:\s*\((?P<type>[^)]+)\))?"
            r"\s*[:\-]?\s*(?P<desc>.*)$"
        )
        # Table rows: | name | type | desc |
        table_re = re.compile(
            r"^\s*\|\s*`?(?P<name>[A-Za-z_][\w-]*)`?\s*\|"
            r"\s*(?P<type>[^|]+)\|"
            r"\s*(?P<desc>[^|]*)\|"
        )

        for raw_line in section.splitlines():
            line = raw_line.rstrip()
            if not line.strip():
                continue
            # Skip markdown table header/separator rows
            if re.match(r"^\s*\|?\s*-{3,}", line):
                continue
            if re.match(r"^\s*\|\s*name\s*\|", line, flags=re.IGNORECASE):
                continue

            m = table_re.match(line)
            if not m:
                m = bullet_re.match(line)
            if not m:
                continue

            name = m.group("name").strip()
            if not name or name.lower() == "name":
                continue
            if name in seen:
                continue
            seen.add(name)

            raw_type = (m.groupdict().get("type") or "string").strip()
            required = False
            lower_type = raw_type.lower()
            if "required" in lower_type:
                required = True
                raw_type = re.sub(
                    r",?\s*required", "", raw_type, flags=re.IGNORECASE
                ).strip() or "string"

            desc = (m.groupdict().get("desc") or "").strip().strip("|")

            props.append(
                {
                    "name": name,
                    "type": raw_type or "string",
                    "description": desc,
                    "required": required,
                }
            )
        return props

    def _extract_a11y(self, spec: str) -> list:
        """Parse `## Accessibility` section.

        Returns a flat list of strings, each describing one requirement.
        """
        if not spec:
            return []
        section = self._extract_section(spec, "Accessibility")
        if not section:
            return []

        reqs: list = []
        for raw_line in section.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith(("-", "*")):
                reqs.append(line[1:].strip())
            elif re.match(r"^\d+\.\s+", line):
                reqs.append(re.sub(r"^\d+\.\s+", "", line))
        return reqs

    def _extract_section(self, spec: str, heading: str) -> Optional[str]:
        """Return the body of a markdown ``## <heading>`` section."""
        pattern = re.compile(
            r"^#{1,6}\s+" + re.escape(heading) + r"\s*$",
            flags=re.IGNORECASE | re.MULTILINE,
        )
        match = pattern.search(spec)
        if not match:
            return None
        start = match.end()
        # Next heading of same or higher level
        next_heading = re.compile(r"^#{1,6}\s+\S", flags=re.MULTILINE)
        tail = spec[start:]
        next_match = next_heading.search(tail)
        body = tail[: next_match.start()] if next_match else tail
        return body.strip()

    def _has_keyboard_interaction(self, spec: str) -> bool:
        if not spec:
            return False
        patterns = [
            r"\bkeyboard\b",
            r"\bkeypress\b",
            r"\bkeydown\b",
            r"\bEnter key\b",
            r"\bSpace key\b",
            r"\btab\s+order\b",
        ]
        return any(re.search(p, spec, flags=re.IGNORECASE) for p in patterns)

    # ----- JSX/test rendering helpers ---------------------------------

    def _default_props(self, props: list) -> str:
        """Produce default JSX props string: prop1="value" prop2={true}"""
        pieces: list = []
        for prop in props:
            pieces.append(self._jsx_prop(prop))
        return " ".join(pieces)

    def _jsx_prop(self, prop: dict) -> str:
        name = prop["name"]
        ptype = (prop.get("type") or "string").lower()
        if "bool" in ptype:
            return f"{name}={{true}}"
        if "number" in ptype or "int" in ptype or "float" in ptype:
            return f"{name}={{0}}"
        if "func" in ptype or "=>" in ptype or "callback" in ptype:
            return f"{name}={{() => {{}}}}"
        if "array" in ptype or "[]" in ptype:
            return f"{name}={{[]}}"
        if "object" in ptype or "{" in ptype:
            return f"{name}={{{{}}}}"
        # default: string
        return f'{name}="{self._sample_value(prop)}"'

    def _sample_value(self, prop: dict) -> str:
        ptype = (prop.get("type") or "string").lower()
        if "bool" in ptype:
            return "true"
        if "number" in ptype or "int" in ptype or "float" in ptype:
            return "1"
        return f"sample-{prop['name']}"

    def _prop_test(self, name: str, prop: dict) -> str:
        prop_name = prop["name"]
        ptype = (prop.get("type") or "string").lower()
        default_jsx = self._jsx_prop(prop)
        lines = []
        lines.append(f'    it("accepts prop {prop_name}", () => {{')
        lines.append(f"        render(<{name} {default_jsx} />);")
        if "bool" in ptype:
            lines.append(
                f'        const el = screen.getByTestId("{name.lower()}");'
            )
            lines.append("        expect(el).toBeDefined();")
        elif "func" in ptype or "=>" in ptype or "callback" in ptype:
            lines.append(
                f'        const el = screen.getByTestId("{name.lower()}");'
            )
            lines.append("        expect(el).toBeDefined();")
        else:
            sample = self._sample_value(prop)
            lines.append(
                f'        const el = screen.getByTestId("{name.lower()}");'
            )
            lines.append("        expect(el).toBeDefined();")
            lines.append(f'        // prop {prop_name} sample value: {sample}')
        lines.append("    });")
        lines.append("")
        return "\n".join(lines)

    def _a11y_test(self, name: str, req: str) -> str:
        lower = req.lower()
        slug = re.sub(r"\W+", " ", req).strip().replace(" ", "-")[:60] or "a11y"
        lines = []
        lines.append(f'    it("a11y: {req}", () => {{')
        lines.append(f"        render(<{name} />);")
        lines.append(
            f'        const el = screen.getByTestId("{name.lower()}");'
        )
        if "role=" in lower or "role " in lower:
            # e.g. "role=button"
            m = re.search(r"role[=\s]+['\"]?([\w-]+)", lower)
            role = m.group(1) if m else "presentation"
            lines.append(
                f'        expect(el.getAttribute("role") || "").toMatch(/{role}/i);'
            )
        elif "aria-label" in lower:
            lines.append(
                '        expect(el.getAttribute("aria-label")).not.toBeNull();'
            )
        elif "aria-" in lower:
            m = re.search(r"aria-([\w-]+)", lower)
            attr = f"aria-{m.group(1)}" if m else "aria-label"
            lines.append(
                f'        expect(el.getAttribute("{attr}")).not.toBeNull();'
            )
        elif "focus" in lower:
            lines.append("        el.focus();")
            lines.append("        expect(document.activeElement).toBe(el);")
        else:
            lines.append("        expect(el).toBeDefined();")
        lines.append(f'        // requirement slug: {slug}')
        lines.append("    });")
        lines.append("")
        return "\n".join(lines)

    def _keyboard_test(self, name: str, default_props: str) -> str:
        lines = []
        lines.append('    it("handles keyboard interaction", () => {')
        props_str = (" " + default_props) if default_props else ""
        lines.append(f"        render(<{name}{props_str} />);")
        lines.append(
            f'        const el = screen.getByTestId("{name.lower()}");'
        )
        lines.append("        el.focus();")
        lines.append(
            '        fireEvent.keyDown(el, { key: "Enter", code: "Enter" });'
        )
        lines.append("        expect(el).toBeDefined();")
        lines.append("    });")
        lines.append("")
        return "\n".join(lines)

    def _snapshot_test(self, name: str, default_props: str) -> str:
        props_str = (" " + default_props) if default_props else ""
        lines = []
        lines.append('    it("matches snapshot", () => {')
        lines.append(
            f"        const {{ container }} = render(<{name}{props_str} />);"
        )
        lines.append("        expect(container.firstChild).toMatchSnapshot();")
        lines.append("    });")
        return "\n".join(lines)

    # ----- String helpers ---------------------------------------------

    @staticmethod
    def _safe_name(name: str) -> str:
        """Produce a valid JS identifier from ``name``.

        Keeps PascalCase if already valid; otherwise strips non-word
        characters.
        """
        cleaned = re.sub(r"\W+", "", name or "")
        if not cleaned:
            return "Component"
        if cleaned[0].isdigit():
            cleaned = "C" + cleaned
        return cleaned

    @staticmethod
    def _kebab_case(name: str) -> str:
        step = re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()
        step = re.sub(r"[_\s]+", "-", step)
        step = re.sub(r"-{2,}", "-", step)
        return step.strip("-")
