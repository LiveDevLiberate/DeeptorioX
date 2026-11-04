# External UI skills audit (ui-skills.com)

Reference: [ui-skills.com](https://www.ui-skills.com/) /
[ibelick/ui-skills](https://github.com/ibelick/ui-skills) (MIT license).

The registry provides agent skills as `SKILL.md` files plus a remote MCP
endpoint (`https://www.ui-skills.com/mcp`, tools `list_skills` / `get_skill`)
and an `npx ui-skills` CLI. The skill contents are guidance; only the parts that
fit this repository's stack are applied.

## Applicability to autorio

The skills assume React + Tailwind CSS + Base UI/Radix + `motion/react`. The
recording window is vanilla HTML/CSS/JS (`public/recording.*`), so framework
rules do not apply. The following constraints were audited and the transferable
ones were applied:

| Constraint | Status |
| --- | --- |
| Icon-only buttons need `aria-label` | Already present (`statusToggle`, search input) |
| Visible focus states | Already present (`:focus-visible` outline) |
| Respect `prefers-reduced-motion` | Already present |
| Use `dvh` for full-height layout | Already using `100dvh` |
| Tabular numerals for data | Applied to metrics table, status meta, durations, radar |
| `text-wrap: balance` / `pretty` | Applied to status lines and long transcript text |
| Empty states get one clear action | Applied: filter empty state has a **Show all / 显示全部** reset button |
| No gradients / one accent / no glow | Partially conflicts with the intentional cool-slate + multi-hue icon theme requested by the operator; not changed |
| No animation unless requested | No new animation added |
| Errors next to the action | Existing per-row error/warning styling retained |

## How to consume without installing

Individual skills can be fetched as raw markdown, for example:

- `https://raw.githubusercontent.com/ibelick/ui-skills/main/skills/baseline-ui/SKILL.md`
- `https://raw.githubusercontent.com/ibelick/ui-skills/main/skills/improve-ui/SKILL.md`

`improve-ui` is a read-only audit workflow (findings + plan under
`design-plans/`); it is not implemented as a runtime feature here. The remote
MCP endpoint can be registered in an agent host that supports MCP; this
repository does not depend on it and does not vendor the skill files.
