// Notification sounds, synthesised with WebAudio (no asset files).
// Owner: settings-notify. Subscribes to frames; plays message and voice join/leave tones; returns unsubscribe.
import type { Message } from '@chatward/shared';
import { onFrame } from '../api/ws';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { useVoice } from '../state/voice';

export type SoundKind = 'message' | 'join' | 'leave';

interface Note { freq: number; start: number; dur: number }

const TONES: Record<SoundKind, Note[]> = {
  message: [{ freq: 880, start: 0, dur: 0.12 }, { freq: 1320, start: 0.08, dur: 0.16 }],
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

function onNewMessage(m: Message) {
  const { messageSounds, mutedChannels } = useSettings.getState();
  const { user, activeChannelId } = useSession.getState();
  if (!messageSounds || m.authorId === user?.id) return;
  if (mutedChannels.includes(m.channelId)) return;
  // The channel is on screen and the window has focus: the user already sees it.
  if (m.channelId === activeChannelId && document.hasFocus()) return;
  playSound('message');
}

// Last known occupants per voice channel, so each voice.state frame can be diffed.
const occupants: Record<string, string[]> = {};

function onVoiceState(channelId: string, userIds: string[]) {
  const prev = occupants[channelId] ?? [];
  occupants[channelId] = userIds;

  const { voiceJoinLeaveSounds } = useSettings.getState();
  const { user } = useSession.getState();
  if (!voiceJoinLeaveSounds || useVoice.getState().channelId !== channelId) return;

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
    if (f.t === 'message.new') onNewMessage(f.message);
    else if (f.t === 'voice.state') onVoiceState(f.channelId, f.userIds);
  });
}
