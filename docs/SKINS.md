# Skins

Skins change how the desktop client looks and nothing else: no behaviour, protocol, encryption or server changes.
The full plan lives in the project's "Chatward skins plan" doc. This file is the working contract.

## What a skin may use

- **Tokens.** Every colour, font, radius and shadow comes from a CSS variable in `styles/theme.css`. The colour tokens
  differ per light/dark theme; the shared block (`--font-*`, `--danger-text`, `--media-bg`, `--backdrop`, `--overlay-*`,
  `--shadow-*`, `--radius-modal`) is the same in both. Components should never hard-code a colour or font: add a token.
- **Regions.** The main window is a CSS grid in `styles/layout.css`. Each panel carries a stable `data-region`:
  `servers`, `channels`, `main`, `members`. A layout skin moves panels by redefining `grid-template-columns` and
  `grid-template-areas` on `.cw-shell`; the components stay as they are, so keyboard and screen reader order never change.
- **Class names** already on components, for effects tokens can't express.

## Proving a change is visual-only

`npm run visual:capture -w @chatward/client -- <out dir> [app dir]` drives the built app in demo mode (under
`xvfb-run` on Linux) and screenshots 13 screens in dark and light. The clock, `Math.random`, time zone, locale,
window size and link previews are pinned, and the demo bots' delayed chatter is held, so two runs of the same build match.

`npm run visual:compare -w @chatward/client -- <before> <after> [diff dir]` fails if any pixel moved by more than
rasteriser noise, and writes red-on-grey diff images.

The `Visual` workflow runs both on every pull request against its base branch. A pull request that is meant to change
the look gets the `visual-change` label; the check then passes and the screenshots are uploaded for review.
