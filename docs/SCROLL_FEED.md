# Scroll feed (reels-style vault feed)

Tracking issue: #494.

## What it is

- A **Scroll!** button at the top of the window, followed by one random emoji from the standard Unicode set.
- Its look comes from each skin's tokens, with one version per skin, and it must pass the skins parity check.
- A vertical, full-height feed of vault pictures and videos, in a random order that differs per user.
- Each item has likes and comments. Likes and comments are stored on the server; GIF comments come from the existing GIF integration.
- Works in demo mode with mock vault media.

## Plan

1. Server: likes and comments per vault item, stored in the server database, with a small REST API.
2. Client: `components/scroll/` with the feed view, the Scroll button, and a seeded shuffle per user.
3. Skins: one button style per skin in `skins/<id>/skin.css`, checked by the parity inventory.
4. Demo: mock vault media so the feed can be tested in demo mode.
5. Verify: screenshots of the button in every skin, next to the existing top bar.

Status: planning only. No code yet in this commit.
