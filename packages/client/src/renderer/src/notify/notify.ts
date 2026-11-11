// Notification sounds, synthesised with WebAudio (no asset files).
// Owner: settings-notify. Subscribes to frames; plays message and voice join/leave tones; returns unsubscribe.
import type { Message, MessagePayload } from '@chatward/shared';
import { onFrame } from '../api/ws';
import { decryptMessage } from '../crypto';
import { pings } from '../state/mentions';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { useVoice } from '../state/voice';
import { popoutHasFocus } from '../components/tabs/PopoutWindow';

export type SoundKind = 'message' | 'mention' | 'join' | 'leave';

interface Note { freq: number; start: number; dur: number }

const TONES: Record<SoundKind, Note[]> = {
  message: [{ freq: 880, start: 0, dur: 0.12 }, { freq: 1320, start: 0.08, dur: 0.16 }],
  // A ping: three quick rising notes, so it sounds different from a plain message.
  mention: [{ freq: 659.25, start: 0, dur: 0.1 }, { freq: 987.77, start: 0.09, dur: 0.1 }, { freq: 1318.51, start: 0.18, dur: 0.2 }],
  join: [{ freq: 523.25, start: 0, dur: 0.12 }, { freq: 783.99, start: 0.1, dur: 0.18 }],
  leave: [{ freq: 783.99, start: 0, dur: 0.12 }, { freq: 523.25, start: 0.1, dur: 0.18 }],
};

let ctx: AudioContext | null = null;

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** Plays a tone at the configured notification volume and output device. Ignores the on/off toggles, so settings can preview. */
export function playSound(kind: SoundKind) {
  ctx ??= new AudioContext();
  const c = ctx;
  if (c.state === 'suspended') void c.resume();
  void (c as SinkContext).setSinkId?.(useSettings.getState().outputDeviceId || 'default')?.catch(() => {});

  const out = c.createGain();
  out.gain.value = useSettings.getState().soundVolume * 0.25;
  out.connect(c.destination);

  const t0 = c.currentTime;
  for (const n of TONES[kind]) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    env.gain.setValueAtTime(0, t0 + n.start);
    env.gain.linearRampToValueAtTime(1, t0 + n.start + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + n.start + n.dur);
    osc.connect(env).connect(out);
    osc.start(t0 + n.start);
    osc.stop(t0 + n.start + n.dur + 0.02);
  }
}

function onNewMessage(m: Message, payload: MessagePayload | null) {
  const { messageSounds, silenceAll } = useSettings.getState();
  const { user, activeChannelId, theaterChatId, myStatus } = useSession.getState();
  if (m.authorId === user?.id) return;
  // Silence all: nothing sounds and nothing flashes.
  if (silenceAll) return;
  // Do Not Disturb: the user asked not to be interrupted, so stay silent and don't flash either.
  if (myStatus === 'dnd') return;
  // Someone pinged this user (by name or @everyone): it plays the ping tone.
  const pinged = pings(payload?.mentions, user?.id);
  // Flash the taskbar when the app is in the background, even if sounds are off. A popped-out tab counts as the app.
  const focused = document.hasFocus() || popoutHasFocus();
  if (!focused) window.chatward?.flashWindow();
  if (!messageSounds) return;
  // The channel is on screen and the window has focus: the user already sees it.
  if (m.channelId === activeChannelId && focused) return;
  // The chat shown alongside theater mode is on screen, so it needs no ping.
  if (m.channelId === theaterChatId) return;
  playSound(pinged ? 'mention' : 'message');
}

// Last known occupants per voice channel, so each voice.state frame can be diffed.
const occupants: Record<string, string[]> = {};

function onVoiceState(channelId: string, userIds: string[]) {
  const prev = occupants[channelId] ?? [];
  occupants[channelId] = userIds;

  const { voiceJoinLeaveSounds, silenceAll } = useSettings.getState();
  const { user, myStatus } = useSession.getState();
  if (!voiceJoinLeaveSounds || silenceAll || myStatus === 'dnd' || useVoice.getState().channelId !== channelId) return;

  // Our own join or leave also changes the list. Stay silent for that transition.
  const me = user?.id;
  if (me && prev.includes(me) !== userIds.includes(me)) return;

  const joined = userIds.some((id) => id !== me && !prev.includes(id));
  const left = prev.some((id) => id !== me && !userIds.includes(id));
  if (joined) playSound('join');
  else if (left) playSound('leave');
}

export function installNotifications(): () => void {
  for (const b of useSession.getState().servers) {
    for (const c of b.channels) occupants[c.id] = useSession.getState().voiceOccupants[c.id] ?? [];
  }
  return onFrame((f) => {
    // demo chatter guests (state/guests.ts) talk often, so their messages make no sound or flash
    if (f.t === 'message.new') void decryptMessage(f.message).catch(() => null).then((p) => { if (!p?.chatter) onNewMessage(f.message, p); });
    else if (f.t === 'voice.state') onVoiceState(f.channelId, f.userIds);
  });
}
