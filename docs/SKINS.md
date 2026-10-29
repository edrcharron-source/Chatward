# Skins

Skins change how the desktop client looks and nothing else: no behaviour, protocol, encryption or server changes.
The full plan lives in the project's "Chatward skins plan" doc. This file is the working contract.

## What a skin may use

- **Tokens.** Every colour, font, radius and shadow comes from a CSS variable in `styles/theme.css`. The colour tokens
  differ per light/dark theme; the shared block (`--font-*`, `--danger-text`, `--media-bg`, `--backdrop`, `--overlay-*`,
  `--shadow-*`, `--radius-modal`) is the same in both. Components should never hard-code a colour or font: add a token.
- **Regions.** The main window is a CSS grid on `.cw-shell`. Each panel carries a stable `data-region`:
  `servers`, `channels`, `main`, `members`. The grid's columns, rows and areas come from the layout manifest (below),
  not from a stylesheet; the components stay as they are, so keyboard and screen reader order never change.
- **Class names** already on components, for effects tokens can't express.

## Layout manifests

`layout/manifest.ts` holds the base layout (`BASE_LAYOUT`), which is today's window. A skin may change it by exporting a
partial manifest from `skins/<id>/layout.ts` (a default export). Any part it leaves out keeps the base value.

- `grid`: `columns`, `rows` and `areas`, where `areas` is rows of region ids. Every region appears exactly once.
- `mainBar`: the main-bar actions in order. Each id appears once.
- `settingsGroups`: the settings tabs in order, split into groups. A group's `label`, when given, shows above its tabs.
  Every tab appears once.

A manifest may move, reorder and regroup, and may rename group labels. It may not add, remove or repeat an id, so every
feature stays reachable. A manifest that breaks these rules is logged and the base layout is used instead. The ids are
stable: skins, tests and the feature list refer to them. Run `npm run test:layout -w @chatward/client` after changing them.

## Adding a skin

- Add `packages/client/src/renderer/src/skins/<id>/skin.css`. Every rule starts with `:root[data-skin='<id>']`, so the
  pack does nothing until that skin is chosen.
- Add one entry to `SKINS` in `skins/index.ts` (label and swatch colour). Add `skins/<id>/layout.ts` only if the skin
  moves or regroups anything; a restyle needs no manifest. The Appearance tab shows a Skins section only
  while `SKINS` has entries, so the empty list keeps the Visual check unchanged.
- The choice is the `skin` setting: one skin at a time, `''` for none, and an unknown id counts as none. It is saved
  locally and never sent to the server. The watch-party popout follows it too.

## Proving a change is visual-only

`npm run visual:capture -w @chatward/client -- <out dir> [app dir]` drives the built app in demo mode (under
`xvfb-run` on Linux) and screenshots 13 screens in dark and light. The clock, `Math.random`, time zone, locale,
window size and link previews are pinned, and the demo bots' delayed chatter is held, so two runs of the same build match.

`npm run visual:compare -w @chatward/client -- <before> <after> [diff dir]` fails if any pixel moved by more than
rasteriser noise, and writes red-on-grey diff images.

The `Visual` workflow runs both on every pull request against its base branch. A pull request that is meant to change
the look gets the `visual-change` label; the check then passes and the screenshots are uploaded for review.
