# Chatward web app (iPhone)

The server can also serve Chatward as a web app. It's the desktop app's page built for a browser, and an iPhone can add it to the home screen, where it opens full screen like a normal app.

## How it is built and served

- `npm run build:web -w @chatward/client` builds `packages/client/out/web` (`vite.web.config.ts`).
- The server serves that folder at `/` when `CHATWARD_WEB_DIR` points at it (`packages/server/src/web.ts`). The Docker image (`deploy/Dockerfile.server`) builds it and sets `CHATWARD_WEB_DIR=/app/web`, so `update-home.sh` deploys it with the server. Nothing changes in Caddy: it already passes everything except `/rtc` to the server.
- The page is same-origin with the API, so no CORS is needed. Its files get their own Content-Security-Policy, which only lets the page connect to this server.

## How it differs from the desktop app

- **Keys** (device keys and the message vault) live in the browser's IndexedDB. Each value is encrypted with an AES-GCM key that the browser created as non-extractable, which stands in for Windows safeStorage. Each browser or home-screen app is its own device. If Safari's website data is cleared, that device is gone and the app signs in as a new device.
- **Server address:** always the address the page was opened from, so the sign-in screen has no server field and no demo mode.
- **Not available:** screen sharing on iPhone (Safari can't share a screen), Spotify, and installer updates (the page updates with the server).
- **Phone layout:** at 700px wide or narrower, the tabs layout shows one tab at a time with the tab bar along the bottom, and the member list, your status and the call controls in a "People" drawer. The message box is one rounded bar (+ to attach, GIF, emoji and a send arrow), and GIF and emoji open as one full-width panel under it, where the keyboard was, with Emoji / GIFs / Klipy tabs. `npm run phone:shots -w @chatward/client -- <out dir>` (under xvfb-run on Linux) takes phone-size screenshots of it in each skin.

## Installing on an iPhone

Open the server address in Safari, tap Share, then **Add to Home Screen**.

## Notifications (Web Push)

- On iPhone, notifications only work in the app added to the home screen (iOS 16.4 or later). Turn them on in **Workouts → My plan → Reminders and privacy → Turn on notifications**.
- The server makes a VAPID key pair on first start and saves it as `vapid.json` in the data folder. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` to use your own, and set `VAPID_SUBJECT` (a `mailto:` or `https:` address) for Apple.
- A push only says who did what, for example "Caleb sent a message" in #general. Message text is end-to-end encrypted, so the server can't read it and never sends it. Chat pushes go only to people with no open connection, at most one per channel every 3 minutes.
- Workouts pushes: nudges, cheers, comments, the crew's check-ins, PRs and milestones (these can be turned off), and the daily reminder.

## Workouts (formerly DOSS)

The Workouts tab is the crew check-in tracker that used to run as the separate DOSS app (`~/summit-crew` on lebserver), now built on Chatward accounts. Everyone in the server is in the crew. It covers a goal with a countdown, a weekly plan, a daily "Log it" (or a late log up to 6 days back), week %, streaks that rest days never break, standings, your own numbers with automatic PRs and sparklines, milestones, a feed, comments, nudges (one a day) and cheers (five a day).

Workout data is stored on the server unencrypted, as it was in DOSS, because the server works out the streaks, standings and PRs. Chat, the Vault and calls stay end-to-end encrypted. Tables: `workout_*` and `push_subscriptions`, created at startup by `modules/workouts.ts` and `push.ts`.
