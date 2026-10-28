// In-memory state for the demo. Rebuilt from scratch every time demo mode is entered.
import type { Channel, Member, Message, MessagePayload, Server, SoundboardSound, User } from '@chatward/shared';
import { demoEncode } from '../codec';
import { gifDataUrl, sunsetSvg, toneWav } from './assets';

export interface World {
  you: User;
  server: Server;
  channels: Channel[];
  members: Member[];
  messages: Record<string, Message[]>; // channelId -> oldest first
  sounds: SoundboardSound[];
  blobs: Map<string, { bytes: Uint8Array; mime: string }>; // uploads and sound files
  voice: Record<string, string[]>; // voice channelId -> userIds
  watch: Record<string, { ciphertext: string; keyVersion: number; authorId: string; ts: number }>;
  bots: { user: User; hue: number }[];
  nextId: number;
}

export const YOU_ID = 'demo-you';
export const SERVER_ID = 'demo-srv';
const HOUR = 3_600_000;

const BOT_SEEDS = [
  { id: 'demo-avery', name: 'Avery', hue: 200 },
  { id: 'demo-blake', name: 'Blake', hue: 320 },
  { id: 'demo-casey', name: 'Casey', hue: 40 },
  { id: 'demo-dev', name: 'Dev', hue: 150 },
];

export function createWorld(): World {
  const you: User = { id: YOU_ID, username: 'you', displayName: 'You', avatarUrl: `/api/avatars/${YOU_ID}` };
  const bots = BOT_SEEDS.map((b) => ({
    user: { id: b.id, username: b.name.toLowerCase(), displayName: b.name, avatarUrl: `/api/avatars/${b.id}` },
    hue: b.hue,
  }));
  const server: Server = { id: SERVER_ID, name: 'Demo Squad', ownerId: YOU_ID };
  const channels: Channel[] = [
    { id: 'demo-ch-general', serverId: SERVER_ID, name: 'general', kind: 'text' },
    { id: 'demo-ch-memes', serverId: SERVER_ID, name: 'memes', kind: 'text' },
    { id: 'demo-ch-watch', serverId: SERVER_ID, name: 'watch-party', kind: 'text' },
    { id: 'demo-vc-lounge', serverId: SERVER_ID, name: 'Lounge', kind: 'voice' },
    { id: 'demo-vc-gaming', serverId: SERVER_ID, name: 'Gaming', kind: 'voice' },
  ];
  const members: Member[] = [you, ...bots.map((b) => b.user)].map((user) => ({
    user,
    role: user.id === YOU_ID ? 'owner' : 'member',
    devices: [],
  }));

  const world: World = {
    you, server, channels, members, messages: {}, sounds: [], blobs: new Map(), voice: {}, watch: {}, bots, nextId: 1,
  };
  seedMessages(world);
  seedSounds(world);
  world.voice = { 'demo-vc-lounge': ['demo-avery', 'demo-blake'], 'demo-vc-gaming': [] };
  return world;
}

export function newId(world: World, prefix: string): string {
  return `${prefix}-${world.nextId++}`;
}

export function makeMessage(world: World, channelId: string, authorId: string, payload: MessagePayload, createdAt = Date.now()): Message {
  return {
    id: newId(world, 'm'),
    channelId,
    authorId,
    createdAt,
    editedAt: null,
    keyVersion: 1,
    ciphertext: demoEncode(payload),
  };
}

function seedMessages(world: World) {
  const sunsetId = 'up-demo-sunset';
  world.blobs.set(sunsetId, { bytes: sunsetSvg(), mime: 'image/svg+xml' });
  const sunsetBytes = world.blobs.get(sunsetId)!.bytes.byteLength;

  const script: { channel: string; author: string; ago: number; payload: MessagePayload }[] = [
    { channel: 'demo-ch-general', author: 'demo-avery', ago: 3 * HOUR, payload: { text: 'morning all. who is up for a game tonight?' } },
    { channel: 'demo-ch-general', author: 'demo-blake', ago: 3 * HOUR - 60_000, payload: { text: 'yes, after 8. bring the good mic this time 🎤' } },
    { channel: 'demo-ch-general', author: 'demo-casey', ago: 2 * HOUR, payload: { text: 'I made this for the server banner, what do you think?' } },
    {
      channel: 'demo-ch-general', author: 'demo-casey', ago: 2 * HOUR - 20_000,
      payload: { text: '', attachments: [{ uploadId: sunsetId, name: 'sunset.svg', mime: 'image/svg+xml', size: sunsetBytes, width: 640, height: 400, key: '', iv: '' }] },
    },
    { channel: 'demo-ch-general', author: 'demo-dev', ago: 90 * 60_000, payload: { text: 'banner is 🔥. shipping it' } },
    {
      channel: 'demo-ch-memes', author: 'demo-blake', ago: 80 * 60_000,
      payload: { text: 'when the build finally passes', gif: { url: gifDataUrl('SHIPPED', 120), previewUrl: gifDataUrl('SHIPPED', 120), title: 'celebration', provider: 'klipy' } },
    },
    { channel: 'demo-ch-memes', author: 'demo-avery', ago: 60 * 60_000, payload: { text: 'this is the one: https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
    {
      channel: 'demo-ch-memes', author: 'demo-dev', ago: 40 * 60_000,
      payload: { text: 'the link preview should show above', linkPreviews: [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Demo video', siteName: 'YouTube', embed: { kind: 'youtube', id: 'dQw4w9WgXcQ' } }] },
    },
    { channel: 'demo-ch-watch', author: 'demo-casey', ago: 30 * 60_000, payload: { text: 'start the watch party whenever. I will sync to whatever you pick.' } },
    { channel: 'demo-ch-watch', author: 'demo-avery', ago: 5 * 60_000, payload: { text: 'pasting a link here soon 👀' } },
  ];

  const now = Date.now();
  for (const s of script) {
    const list = (world.messages[s.channel] ??= []);
    list.push(makeMessage(world, s.channel, s.author, s.payload, now - s.ago));
  }
}

function seedSounds(world: World) {
  const clips = [
    { name: 'Airhorn', emoji: '📯', freq: 330, ms: 700 },
    { name: 'Ding', emoji: '🔔', freq: 880, ms: 400 },
    { name: 'Boop', emoji: '🐸', freq: 196, ms: 300 },
  ];
  clips.forEach((c, i) => {
    const id = `demo-snd-${i + 1}`;
    world.blobs.set(id, { bytes: toneWav(c.freq, c.ms), mime: 'audio/wav' });
    world.sounds.push({ id, serverId: SERVER_ID, ownerId: YOU_ID, name: c.name, emoji: c.emoji, url: `/api/sounds/${id}/file`, durationMs: c.ms });
  });
}
