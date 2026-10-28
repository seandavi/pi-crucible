#!/usr/bin/env python3
"""Draw the README's workflow figure as SVG, in a light and a dark variant. Stdlib only.

    python3 docs/figures/make_figures.py     # writes docs/figures/crucible-flow-{light,dark}.svg

The README picks a variant with <picture> and prefers-color-scheme. Backgrounds are transparent;
label backings use GitHub's page colours so they blend with either theme. Every stage, model and
label drawn here comes from workflows/crucible.js: change the figure when the script changes.
"""
from html import escape
from pathlib import Path

OUT = Path(__file__).parent

THEMES = {
    "dark": dict(BG="#0d1117", TEXT="#e6edf3", MUTED="#9198a1", LINE="#3d444d",
                 VIOLET="#b49cff", BLUE="#4aa8e8", GREEN="#9fd05a", AMBER="#f2b441", CORAL="#ff7a66"),
    "light": dict(BG="#ffffff", TEXT="#1f2328", MUTED="#59636e", LINE="#d1d9e0",
                  VIOLET="#8250df", BLUE="#0969da", GREEN="#1a7f37", AMBER="#9a6700", CORAL="#cf222e"),
}
SANS = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"
MONO = "'JetBrains Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"


class Figure:
    """SVG primitives bound to one theme's palette."""

    def __init__(self, theme: dict[str, str]) -> None:
        self.t = theme
        self.roles = {k: theme[k] for k in ("MUTED", "VIOLET", "BLUE", "GREEN", "AMBER", "CORAL")}
        self.body: list[str] = []

    def add(self, s: str) -> None:
        self.body.append(s)

    def svg(self, w: int, h: int, title: str) -> str:
        markers = "".join(
            f'<marker id="ah-{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
            f'markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
            for n, c in self.roles.items()
        )
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-label="{escape(title)}">\n<title>{escape(title)}</title>\n'
            f"<defs>{markers}</defs>\n" + "".join(self.body) + "</svg>\n"
        )

    def text(self, x, y, s, size=18, color=None, weight=400, anchor="start", mono=False) -> str:
        fam = MONO if mono else SANS
        return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" '
                f'fill="{color or self.t["TEXT"]}" font-weight="{weight}" text-anchor="{anchor}" '
                f'xml:space="preserve">{escape(s)}</text>\n')

    def box(self, x, y, w, h, title, lines=(), role="BLUE", dashed=False, title_size=21, line_size=15):
        c = self.t[role]
        dash = ' stroke-dasharray="7 6"' if dashed else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{c}1f" '
                 f'stroke="{c}" stroke-width="2"{dash}/>\n')
        self.add(self.text(x + 18, y + 32, title, title_size, None, 650))
        for i, ln in enumerate(lines):
            self.add(self.text(x + 18, y + 44 + (i + 1) * (line_size + 8), ln, line_size,
                               self.t["MUTED"], mono=True))

    def tag_box(self, x, y, w, h, title, tag, role="VIOLET"):
        """A one-line box: a title on the left, a muted mono tag on the right."""
        c = self.t[role]
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{c}1f" '
                 f'stroke="{c}" stroke-width="2"/>\n')
        self.add(self.text(x + 16, y + h / 2 + 6, title, 18, None, 650))
        self.add(self.text(x + w - 14, y + h / 2 + 5, tag, 13, self.t["MUTED"], anchor="end", mono=True))

    def group(self, x, y, w, h, label, role):
        c = self.t[role]
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="none" stroke="{c}" '
                 f'stroke-width="1.5" stroke-dasharray="4 6" opacity="0.8"/>\n')
        self.add(self.text(x + 16, y - 10, label.upper(), 14, c, 700, mono=True))

    def arrow(self, pts, role="MUTED", label=None, lpos=None, dashed=False, width=2.5, lsize=14):
        c = self.t[role]
        d = "M" + " L".join(f"{a},{b}" for a, b in pts)
        dash = ' stroke-dasharray="8 7"' if dashed else ""
        self.add(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{width}"{dash} '
                 f'marker-end="url(#ah-{role})"/>\n')
        if label:
            lx, ly = lpos or ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
            lines = label.split("\n")
            wmax = max(len(s) for s in lines) * lsize * 0.62 + 16
            hh = len(lines) * (lsize + 5) + 8
            self.add(f'<rect x="{lx - wmax / 2}" y="{ly - hh / 2}" width="{wmax}" height="{hh}" '
                     f'rx="6" fill="{self.t["BG"]}" opacity="0.92"/>\n')
            for i, s in enumerate(lines):
                self.add(self.text(lx, ly - hh / 2 + (i + 1) * (lsize + 5), s, lsize, c, 500,
                                   "middle", mono=True))

    def pill(self, x, y, s, role, size=14) -> float:
        c = self.t[role]
        w = len(s) * size * 0.62 + 20
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{size + 12}" rx="{(size + 12) / 2}" '
                 f'fill="{c}33" stroke="{c}"/>\n')
        self.add(self.text(x + w / 2, y + size + 3, s, size, c, 600, "middle", mono=True))
        return w


def crucible_flow(theme: dict[str, str]) -> str:
    f = Figure(theme)
    top, h = 110, 175
    mid = top + h / 2

    f.box(30, top, 240, h, "/crucible <issue>", [".pi/crucible.json @ main", "worktree + branch", "lenses from labels",
                                                "args checked first"], "MUTED")
    f.box(330, top, 240, h, "Spec · Opus", ["docs/specs/", "  <n>-<slug>.md", "issue read as data", "one commit"], "VIOLET")
    f.box(630, top, 240, h, "Implement · Sonnet", ["code + tests", "small commits", "configured checks"],
          "BLUE")

    f.group(930, 80, 280, 286, "review · parallel", "VIOLET")
    f.tag_box(950, 100, 240, 46, "diff · Haiku", "r<n>.diff", "CORAL")
    for i, (lens, when) in enumerate([("code", "always"), ("blind", "always · no spec"),
                                      ("ux", "review:ux"), ("<lens>", "review:<lens>")]):
        f.tag_box(950, 160 + i * 52, 240, 46, lens, when)

    f.box(1280, top, 240, h, "Integrate · Haiku", ["fetch, merge", "  origin/main", "run every check",
                                                   "never stops the run"], "CORAL")
    f.box(1580, top, 240, h, "PR · Sonnet", ["push the branch", "follow-up issue for", "  minor/nit findings",
                                             "label needs:human", "sensitive paths first"], "BLUE")
    for i, note in enumerate(["draft if blocker/major", "findings remain,", "checks fail or", "main does not merge"]):
        f.add(f.text(1580, top + h + 28 + i * 22, note, 14, theme["MUTED"], mono=True))
    f.box(1880, top, 210, h, "A human merges", ["review the PR", "drop needs:human", "never automated"],
          "AMBER")

    for x0, x1 in [(270, 325), (570, 625), (870, 925), (1210, 1275), (1520, 1575), (1820, 1875)]:
        f.arrow([(x0, mid), (x1, mid)])

    f.box(950, 470, 240, 140, "Revise · Sonnet", ["fix the root cause", "keep the spec in step",
                                                  "at most 2 rounds"], "BLUE")
    f.arrow([(1010, 369), (1010, 465)], "BLUE", "blocker/\nmajor", (1010, 417))
    f.arrow([(1130, 468), (1130, 372)], "VIOLET", "re-review:\nlenses that\nasked + blind", (1130, 420))

    f.box(1280, 470, 240, 160, "Fix · Sonnet", ["conflict or failing", "  check: one round", "code lens re-reviews",
                                                "  non-test fixes"], "BLUE")
    f.arrow([(1350, top + h + 3), (1350, 465)], "BLUE", "conflict or\nfailing check", (1350, 377))
    f.arrow([(1460, 468), (1460, top + h + 3)], "CORAL", "re-check", (1460, 420))

    f.box(330, 470, 540, 140, "Flag · Haiku", ["label the issue needs:human,", "comment saying why;",
                                               "the run stops"], "CORAL")
    f.arrow([(450, top + h + 3), (450, 465)], "CORAL", "blocking\nquestions", (450, 377), dashed=True)
    f.arrow([(750, top + h + 3), (750, 465)], "CORAL", "blocked", (750, 377), dashed=True)

    # startAt entry points: resume past earlier stages.
    for x, s in [(750, "--start-at implement"), (1150, "--start-at review")]:
        w = len(s) * 14 * 0.62 + 20
        f.pill(x - w / 2, 18, s, "GREEN")
        f.arrow([(x, 46), (x, 76 if x > 900 else 106)], "GREEN", width=2)

    # Legend
    ly = 680
    f.add(f'<line x1="30" y1="{ly - 30}" x2="2090" y2="{ly - 30}" stroke="{theme["LINE"]}"/>\n')
    f.add(f.text(30, ly + 6, "LEGEND", 14, theme["MUTED"], 700, mono=True))
    x = 130
    for role, label in [("VIOLET", "Opus: judgment"), ("BLUE", "Sonnet: volume"),
                        ("CORAL", "Haiku: diff, merge and checks, flag a human"), ("AMBER", "a person"),
                        ("MUTED", "the caller")]:
        f.add(f'<rect x="{x}" y="{ly - 10}" width="22" height="22" rx="5" fill="{theme[role]}1f" '
              f'stroke="{theme[role]}" stroke-width="2"/>\n')
        f.add(f.text(x + 32, ly + 7, label, 16))
        x += 52 + len(label) * 9
    x += 20
    f.arrow([(x, ly + 1), (x + 50, ly + 1)])
    f.add(f.text(x + 60, ly + 7, "next stage", 16))
    x += 170
    f.arrow([(x, ly + 1), (x + 50, ly + 1)], "CORAL", dashed=True)
    f.add(f.text(x + 60, ly + 7, "stop", 16))
    x += 120
    w = f.pill(x, ly - 12, "--start-at", "GREEN")
    f.add(f.text(x + w + 10, ly + 7, "resume point", 16))

    return f.svg(2120, 720, "The pi-crucible workflow: launch, spec (Opus), implement (Sonnet), a diff "
                            "(Haiku) before each round of parallel review lenses (Opus), one of them "
                            "blind to the issue and spec, up to two "
                            "revise rounds (Sonnet), integration with main (Haiku, one Sonnet fix "
                            "round), then a PR (Sonnet) that a human merges. Spec or implement can "
                            "stop and flag a human.")


if __name__ == "__main__":
    for name, theme in THEMES.items():
        (OUT / f"crucible-flow-{name}.svg").write_text(crucible_flow(theme))
        print(f"wrote crucible-flow-{name}.svg")
