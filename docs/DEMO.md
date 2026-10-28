# Demo mode (offline, no server)

Goal: Ed installs `Chatward-Setup.exe`, clicks **Try demo** on the login screen, and can use the whole app with NO server, NO Docker, NO network. Everything lives in the renderer process; nothing is persisted except settings.

## Mechanism (no changes to feature code paths where avoidable)
- Demo server address is the sentinel `http://demo.chatward.local`. `src/demo/index.ts` exports `isDemo()` (true iff `useSession.getState().serverUrl` is the sentinel), `enterDemo()` (sets serverUrl, installs interceptors, fakes register/login so the user lands in the shell as "You") and `exitDemo()` (restores, logs out).
- `installDemoNetwork()` wraps `window.fetch` and `window.WebSocket`: requests to the sentinel host are answered by an in-memory backend implementing the REST routes in `docs/CONTRACT.md` (auth, me, avatar, servers/channels/invites, messages, uploads, soundboard, gifs, linkpreview, voice-state) and a fake `/ws` that pushes `ServerFrame`s. Everything else passes through. Pure TS, no new native deps.
- Seed data: server "Demo Squad" with text channels #general, #memes, #watch-party, voice channels "Lounge" and "Gaming". 3–4 bot members (Avery, Blake, Casey, Dev) with generated avatars (SVG data → PNG blob) and presence. Bots post scripted messages with realistic timing (some with emoji, an image attachment, a link, a GIF placeholder card), react to the user's messages with a short reply, and "type". Two bots sit in the Lounge voice channel; others join/leave occasionally (drives join/leave sounds).
- Crypto: demo messages are NOT encrypted (nothing leaves the PC). `crypto/index.ts` gets small `if (isDemo()) return demo...` branches so encrypt/decrypt are base64(JSON) pass-through, `syncChannelKeys/handleEnvelope` are no-ops, `voiceKey` returns a fixed key, `safetyNumber` returns a deterministic fake. Keep each hook to one line so the MLS PR rebases trivially.
- GIFs: `/api/gifs/*` returns a handful of bundled local placeholder results (small inline SVG/animated CSS cards via data URLs), not `disabled`.
- Link previews: `/api/linkpreview` returns canned previews for youtube/x/any URL without any network.
- Watch party: stub `/api/channels/:id/watch` (keeps state in memory; bots occasionally pause/seek). Embed itself needs internet; note this in UI when offline.
- Soundboard: seed 3 generated clips (WebAudio-rendered to WAV blobs) with names/emoji; user can upload their own (kept in memory).
- UI: a persistent slim banner "Demo mode — nothing is sent anywhere. [Exit demo]" at the top of the shell.

## Demo voice (separate piece)
`state/voice.ts` `join` branches on `isDemo()` to `demoVoice.join()` (file `src/demo/voice.ts`): no LiveKit, no token.
- Real microphone via getUserMedia using the selected input device, through the existing `voiceAudio` mic graph (mic → micGain → mixIn). A **local loopback** option (default ON in demo, toggle in the dock) routes the processed mic to the speakers so the user hears themselves with real mic gain/device/output settings; level meter visible on the self tile.
- Fake participants (the two bots in the channel): synthesized voice-like audio (a looped, pitch-varying vocal-ish WebAudio signal gated to "speaking" in bursts) so the per-user volume sliders (0–300%), master volume, deafen and output-device selection are audible and testable. Speaking rings follow the bursts. Join/leave of bots plays the join/leave tones.
- Mute/deafen work for real (mute silences the loopback; deafen silences everything).
- Camera: real `getUserMedia` video shown on the self tile (camera off by default, selected device respected). Screen/window share: real `ScreenPicker` → `getDisplayMedia` → shown as a screen tile locally (and a bot "watching" label). No publishing anywhere.
- Soundboard in demo voice: sounds mix into `voiceAudio.mixIn` and into the loopback so the user hears what others would hear.
- `VoiceChannelView`/`VoiceDock` currently read participants from the LiveKit `room`; add a small adapter so participants come from the demo store when `isDemo()`.

## Packaging
Demo is the same app and installer (a "Try demo" button on AuthScreen), so `Chatward-Setup.exe` from the Release works for both. The Release notes must say so.
