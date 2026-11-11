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
- **Title bar.** Windows open without the system frame; the app draws its own bar (`components/titlebar`). Restyle it
  with the `--titlebar-*` tokens in `styles/theme.css` (height, button width, background, rule under it, text, mark, font, button
  hover, close hover) and the classes `cw-titlebar`, `cw-titlebar-mark`, `cw-titlebar-title`, `cw-titlebar-button`
  (plus `min`, `max`, `close`). Skins that outline every `button` must reset that on `.cw-titlebar .cw-titlebar-button`;
  the Lebserver skin shows how, including `[ ]` brackets drawn with `::before`/`::after`. Keep the buttons in the bar
  and leave `-webkit-app-region` alone, or the window can no longer be dragged.

## Adding a skin

- Add `packages/client/src/renderer/src/skins/<id>/skin.css`. Every rule starts with `:root[data-skin='<id>']`, so the
  pack does nothing until that skin is chosen.
- Add one entry to `SKINS` in `skins/index.ts` (label and swatch colour). The Appearance tab lists them in a Skin dropdown, after Original (no skin), only
  while `SKINS` has entries, so the empty list keeps the Visual check unchanged.
- **Light and dark.** The Theme setting (Dark, Light, Match system) applies to every skin. A skin keeps its own
  colours in skin-local variables (`--lb-*`, `--ra-*`, `--lcs-*`) and gives its light version in one block under
  `:root[data-skin='<id>'][data-theme='light']` that swaps those and the shared tokens. The LCARS frame's own colours
  (`--lc-*` on `.lcars-shell`) are swapped the same way from the LCARS skin.
- The choice is the `skin` setting: one skin at a time, `''` for none, and an unknown id counts as none. It is saved
  locally and never sent to the server. The watch-party popout follows it too.

## Lebserver skin and lebai

The Lebserver skin matches lebai on lebserver: its palette, hard offset shadows and JetBrains Mono for names, labels and
buttons, with message text and hints in a plain sans (`--lb-read`) so long text stays easy to read. The sign-in screen
shows lebai's LEBSERVER wordmark and its ASCII black hole (`components/lebai/LebaiBlackHole.tsx`, lebai's own photon
tracer). It is decoration only (aria-hidden, no controls), shows only under this skin in the dark theme, stops while the
window is hidden, holds still under reduced motion, and can be turned off with Settings > Appearance > Animated backgrounds.

## Proving a change is visual-only

`npm run visual:capture -w @chatward/client -- <out dir> [app dir]` drives the built app in demo mode (under
`xvfb-run` on Linux) and screenshots 13 screens in dark and light. The clock, `Math.random`, time zone, locale,
window size and link previews are pinned, and the demo bots' delayed chatter is held, so two runs of the same build match.

`npm run visual:compare -w @chatward/client -- <before> <after> [diff dir]` fails if any pixel moved by more than
rasteriser noise, and writes red-on-grey diff images.

The `Visual` workflow runs both on every pull request against its base branch. A pull request that is meant to change
the look gets the `visual-change` label; the check then passes and the screenshots are uploaded for review.

## Every skin keeps every feature

`test/skins/` holds the check that a skin changes the look and nothing else. The `Skins` workflow runs it on every pull request.

- **Inventory.** `packages/client/test/skins/inventory.ts` lists the client's features by stable id: each action, input, view and settings tab. A feature is found by its role and accessible name today, and by its `data-action` id once the menu-data refactor lands. Add a feature there when a control is added.
- **Parity.** `npm run skins:parity -w @chatward/client -- <out dir>` launches the built app in demo mode under each skin and probes every feature: it must be the only match, visible, enabled, and receive a click. Each screen's visible controls must also match the base skin exactly, so a control a skin adds or removes fails the check. Screenshots of each skin land in the out dir for review.
- **Lint.** `npm run test:skins -w @chatward/client` blocks skin CSS from hiding, disabling or reordering action elements (`display`, `visibility`, `pointer-events`, `opacity`, `order`). It is a cheap first gate; the parity check is the guarantee, since it also catches a whole panel hidden in CSS.
- **Self-test.** `test/skins/broken/` holds a skin that must fail. The workflow runs parity with `--broken` and passes only if that skin is caught.

Skins that must pass are listed in `SKINS` in `test/skins/parity.ts`. Once the skin registry exists, the check reads it instead.

## Skins and layouts are separate

The skin and the layout are two separate settings, and every skin works in every layout: picking a layout never changes
the skin, and picking a skin never changes the layout. Settings > Appearance shows each layout as a small drawing
(`components/settings/LayoutPreview.tsx`) made from the active skin's colour tokens, so it always shows that layout in
the skin that is on now, light or dark.

- A layout's frame reads the skin's tokens, never a skin by name. The LCARS frame's colours (`--lc-*`) take the active
  skin's colours (`components/lcars/lcars.css`, with a small block per skin for the best fit); the Orbit frame reads the
  Orbit skin's `--orb-*` colours and falls back to the shared tokens under any other skin.
- A frame's rules start with `:root:root`, so a skin's general rules (every button, every corner) never repaint its blocks.
  A skin's rules for the tabs layout skip the LCARS rail with `:not(.lcars-rail *)`.
- A new skin should look right in all four layouts; `npm run lcars:check` and `npm run orbit:check` walk each frame under
  its own skin and under the Lebserver skin.

## LCARS (a layout and a skin)

The LCARS layout (`components/lcars`) and the LCARS skin (`skins/lcars/skin.css`) were made together, but each works with
any other choice.

- **Same features as Tabs.** The LCARS layout is the tabs layout drawn in a different frame: `TabsLayout` with
  `frame="lcars"` hands its own tab bar, panes, member list, pop-out windows and dialogs to `LcarsLayout`, so a feature
  added to the tabs layout shows up in LCARS too. The call controls are `VoiceDock` with `bar`.
- **The frame** is built from interlocking blocks: two elbows (top left, bottom left) that turn the thick left rail into
  the thin top and bottom bars, flat segments that are the buttons (4px black gaps, label bottom right), fillers, and
  round caps on free ends only. The rail holds the tabs, Server settings and Settings; the top bar holds the drag
  area, the server name, your status, Test and the window's Min/Max/Close (the usual title bar is hidden while the frame
  is up); the bottom bar holds the call controls or Join voice. The soundboard opens in a pop-up with a small frame.
- **The window** (desktop app, not macOS) is see-through around the frame: picking the LCARS layout swaps the main
  window for a transparent one with no system border, shadow or rounded corners (`main/index.ts`, saved in
  `window-frame.json`), and picking another layout swaps the usual window back. The page lives in a view that is moved
  to the new window as it is, so nothing reloads: dialogs, drafts and the call carry on. With **Seamless layout
  switching** on (Settings > Appearance, off by default) every layout uses the see-through window, so nothing is swapped
  at all; the rectangular layouts paint solid and get their own resize edges (`titlebar/windowShape.tsx`), and they give
  up the usual window's shadow and Windows snapping. The
  page clears everything behind the frame and clips itself to the frame's outline (`useShapedFrame`), and thin strips on
  the frame's outer edges resize the window, since it has no system border to drag. Maximized, it is a plain rectangle.
- **Rules:** four colours with fixed meanings (blue frame/ready, amber selected/live, red close/leave/alert, lilac text),
  three text sizes (26, 17, 14), 12px between frame and content. The font is Antonio, bundled under the SIL Open Font
  License (`skins/lcars/fonts/OFL.txt`).
- **Check:** `npm run lcars:check -w @chatward/client -- <out dir>` (under `xvfb-run` on Linux) walks the same screens in
  the Tabs and LCARS layouts, fails if LCARS is missing any control Tabs shows, uses the frame's own controls (split,
  pop-out, tab reorder, Join voice, Leave, switching layouts) and saves screenshots of both. It keeps one window
  (`--chatward-keep-window`). `npm run lcars:shaped -w @chatward/client -- <out dir>` checks the see-through window:
  the swap (picked in Settings, with no reload), clear corners (also with a dialog open) and the usual window coming back.

## Orbit (a layout and a skin)

The Orbit layout (`components/orbit`) and the Orbit skin (`skins/orbit/skin.css`) were made together, like LCARS, but each
works with any other choice.

- **Same features as Tabs.** The Orbit layout is the tabs layout itself with `frame="orbit"`: every tab, tool, pane,
  member list and call control stays where Tabs puts it. The frame adds a line drawing behind the panes
  (`OrbitBackdrop`: circles, an eight-point and a six-point star, a ring of ticks, a soft glow and a stone grain, all
  drawn in code), an emblem before the server's name, and minimize, maximize and close at the end of the tab bar. The
  tab bar is the window's title bar (drag it to move the window), so the usual title bar is hidden while it is up. The
  window stays the usual rectangle.
- **Look:** square corners, 1px lines instead of filled boxes, spaced-out capitals in Barlow Condensed over Barlow
  body text. The open tab is underlined with a gold diamond above it. White is text, gold is you and anything picked,
  cyan is live (speaking, in the call, online), red is close, leave and alerts. The light version is the same drawing
  in dark lines on pale grey stone. Both fonts are bundled under the SIL Open Font License (`skins/orbit/fonts/OFL.txt`).
- **Icons:** the skin has its own set, Glyph (`components/icons/glyphIcons.ts`): thin 1.5px lines, square ends and
  diamonds or hexagons where other sets use circles.
- **Check:** `npm run orbit:check -w @chatward/client -- <out dir>` (under `xvfb-run` on Linux) walks the same screens
  as the LCARS check in the Tabs and Orbit layouts, fails if Orbit is missing any control Tabs shows, checks the frame
  (title bar hidden, window buttons in the bar, the drawing, Glyph icons, tab reorder, pop-out, switching layouts) and
  saves screenshots, including one in light mode.
