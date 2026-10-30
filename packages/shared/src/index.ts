// Single source of truth for wire types shared by server and client.
// Anything the server stores about message CONTENT is opaque ciphertext (base64).

export const LIMITS = {
  USERNAME_MIN: 3,
  USERNAME_MAX: 24,
  PASSWORD_MIN: 8,
  MESSAGE_CIPHERTEXT_MAX: 16_000,
  UPLOAD_MAX_BYTES: 12 * 1024 * 1024, // encrypted image/file blob
  AVATAR_MAX_BYTES: 512 * 1024,
  SOUND_MAX_BYTES: 1024 * 1024,
  SOUND_MAX_SECONDS: 10,
  /** One GIF in a server's shared GIF library. */
  LIBRARY_GIF_MAX_BYTES: 10 * 1024 * 1024,
  LIBRARY_GIF_NAME_MAX: 40,
  LIBRARY_GIF_TAGS_MAX: 5,
  LIBRARY_GIF_TAG_MAX: 20,
  /** Longest clip the GIF maker turns into a GIF. */
  GIF_MAKER_MAX_SECONDS: 15,
  HISTORY_PAGE: 50,
  BIO_MAX: 190,
  PRONOUNS_MAX: 40,
  BANNER_MAX_BYTES: 1024 * 1024,
  SERVER_NAME_MAX: 64,
  CHANNEL_NAME_MAX: 32,
} as const;

export const VOICE_BITRATES_KBPS = [8, 16, 32, 64, 96, 128] as const;
export const DEFAULT_VOICE_BITRATE_KBPS = 64;

/** Public profile fields, shown in the profile card. Colors are #rrggbb or null. */
export interface UserProfile {
  bio: string;
  pronouns: string;
  accentColor: string | null;
  /** Used behind the banner, or as the banner itself when there is no banner image. */
  bannerColor: string | null;
  bannerUrl: string | null; // e.g. /api/banners/<id>
  createdAt: number; // ms epoch, shown as "member since"
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null; // e.g. /api/avatars/<id>
  profile: UserProfile;
}

/** A device's public keys (base64, raw). Server only relays these. */
export interface DeviceKeys {
  deviceId: string;
  /** ECDH P-256 public key, raw, base64 */
  ecdhPublic: string;
  /** ECDSA P-256 public key, raw, base64 (signs key envelopes) */
  signPublic: string;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  kind: 'text' | 'voice';
  /** Voice channels only: Opus publish bitrate in kbps (one of VOICE_BITRATES_KBPS). Absent/ignored for text. */
  bitrateKbps?: number;
}

export interface Member {
  user: User;
  role: 'owner' | 'admin' | 'member';
  devices: DeviceKeys[];
}

/** Per-channel symmetric key, wrapped for one device. */
export interface KeyEnvelope {
  channelId: string;
  keyVersion: number;
  toDeviceId: string;
  fromDeviceId: string;
  /** ephemeral-static ECDH + AES-GCM wrap; opaque to server */
  wrapped: string;
  signature: string;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  createdAt: number; // ms epoch
  editedAt: number | null;
  keyVersion: number;
  /** base64(iv || AES-GCM ciphertext) of JSON MessagePayload */
  ciphertext: string;
}

/** Decrypted message body (only ever exists on clients). */
export interface MessagePayload {
  text: string;
  attachments?: Attachment[];
  /** A library GIF carries `libraryId` and empty urls; the file is fetched from the server's GIF library. */
  gif?: { url: string; previewUrl: string; title: string; provider: 'klipy' | 'tenor' | 'library'; libraryId?: string };
  linkPreviews?: LinkPreview[];
  /** Set on demo chatter guest messages (client state/guests.ts). Absent on everything people write. */
  chatter?: ChatterTag;
}

/**
 * line: one of the sender's guests says CHATTER_LINES[line] (or CHATTER_REPLIES[line] for a reply).
 * roster: the sender's guests right now. remove: asks `host` to send guest `guest` away.
 * `session` is one run of the sender's app, so a restarted app can tell its old guests from its new ones.
 */
export type ChatterTag =
  | { kind: 'line'; session: string; roster: number[]; guest: number; line: number; reply: boolean }
  | { kind: 'roster'; session: string; roster: number[] }
  | { kind: 'remove'; host: string; guest: number };

export interface Attachment {
  uploadId: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** base64 AES-GCM key + iv for the encrypted blob */
  key: string;
  iv: string;
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string; // data: URL embedded by sender (no third-party fetch by viewers)
  siteName?: string;
  embed?: { kind: 'youtube' | 'twitter'; id: string };
}

/** A Vault photo or video as the server sees it. `ciphertext` seals a VaultDescriptor with the anchor channel's key. */
export interface VaultItem {
  id: string;
  serverId: string;
  ownerId: string;
  createdAt: number;
  /** Bytes on disk for the file plus its thumbnail. */
  size: number;
  /** The text channel whose key sealed `ciphertext`. */
  channelId: string;
  keyVersion: number;
  /** base64(iv || AES-GCM ciphertext) of JSON VaultDescriptor */
  ciphertext: string;
}

/** Decrypted Vault item details (only ever exists on clients). `key`/`iv` open the file, `thumbKey`/`thumbIv` the thumbnail. */
export interface VaultDescriptor {
  name: string;
  mime: string;
  kind: 'image' | 'video';
  size: number;
  width?: number;
  height?: number;
  durationSec?: number;
  key: string;
  iv: string;
  thumbKey: string;
  thumbIv: string;
}

export interface SoundboardSound {
  id: string;
  serverId: string;
  ownerId: string;
  name: string;
  emoji: string;
  url: string; // /api/sounds/<id>/file (plain audio, small; not E2EE in v1)
  durationMs: number;
}

/** A GIF in a server's shared library. Plain GIF bytes on the server (not E2EE), like soundboard sounds. */
export interface LibraryGif {
  id: string;
  serverId: string;
  ownerId: string;
  name: string;
  tags: string[];
  width: number;
  height: number;
  size: number;
  /** How many times it has been picked, for the "Most used" sort. */
  uses: number;
  createdAt: number;
}

// ---------- WebSocket protocol ----------
// Client -> server frames
export type ClientFrame =
  | { t: 'subscribe'; serverId: string }
  | { t: 'typing'; channelId: string }
  | { t: 'presence'; status: 'online' | 'idle' | 'dnd' }
  | { t: 'ping' };

// Server -> client frames
export type ServerFrame =
  | { t: 'ready'; user: User; presence: Record<string, 'online' | 'idle' | 'dnd'> }
  | { t: 'message.new'; message: Message }
  | { t: 'message.edit'; message: Message }
  | { t: 'message.delete'; channelId: string; messageId: string }
  | { t: 'typing'; channelId: string; userId: string }
  | { t: 'presence'; userId: string; status: 'online' | 'idle' | 'dnd' | 'offline' }
  | { t: 'member.join'; serverId: string; member: Member }
  | { t: 'member.leave'; serverId: string; userId: string }
  | { t: 'member.devices'; serverId: string; userId: string; devices: DeviceKeys[] }
  | { t: 'key.envelope'; envelope: KeyEnvelope }
  | { t: 'channel.new'; channel: Channel }
  | { t: 'channel.update'; channel: Channel }
  | { t: 'channel.delete'; serverId: string; channelId: string }
  | { t: 'server.update'; server: Server }
  | { t: 'server.delete'; serverId: string }
  | { t: 'member.role'; serverId: string; userId: string; role: Member['role'] }
  | { t: 'sound.new'; sound: SoundboardSound }
  | { t: 'sound.delete'; serverId: string; soundId: string }
  | { t: 'gif.new'; gif: LibraryGif }
  | { t: 'gif.update'; gif: LibraryGif }
  | { t: 'gif.delete'; serverId: string; gifId: string }
  | { t: 'vault.new'; item: VaultItem }
  | { t: 'vault.delete'; serverId: string; itemId: string }
  | { t: 'sound.play'; serverId: string; channelId: string; soundId: string; userId: string }
  | { t: 'voice.state'; serverId: string; channelId: string; userIds: string[] }
  | { t: 'voice.kicked'; channelId: string }
  | { t: 'voice.moved'; channelId: string }
  | { t: 'watch.sync'; channelId: string; authorId: string; keyVersion: number; ciphertext: string; ts: number }
  | { t: 'user.update'; user: User }
  /** Sent to the account's own devices when a device it has not seen before signs in. */
  | { t: 'device.added'; deviceId: string; createdAt: number }
  | { t: 'group.commit'; channelId: string; epoch: number }
  | { t: 'group.welcome'; channelId: string; epoch: number }
  | { t: 'keypackages.low'; deviceId: string; remaining: number }
  | { t: 'pong' };

// ---------- Demo chatter ----------
// The demo's chatter bots, shared by the offline demo and the guests in client state/guests.ts.
// A guest message names a line by its index: the text shown always comes from the app's own copy.
export const CHATTER_LINES = [
  'anyone seen the patch notes?', 'lol that is so true', 'brb getting snacks', 'gg that was close',
  'who wants to hop in the Lounge', 'this app feels snappy 👀', 'not gonna lie, that gif got me', 'ok I am back',
];
export const CHATTER_REPLIES = ['lol', 'ha yes', 'agreed 😂', 'nice one', 'wait say that again', 'ok fair'];
/** Waits, in ms, as [min, max]. A wait is min + random * (max - min). */
export const CHATTER_TIMING = {
  firstLine: [8_000, 8_000],
  nextLine: [20_000, 45_000],
  lineTyping: [1_500, 3_000],
  replyPause: [1_500, 3_000],
  replyTyping: [1_200, 2_000],
  firstClip: [600, 1_800],
  nextClip: [1_500, 6_000],
  firstChurn: [45_000, 45_000],
  nextChurn: [40_000, 70_000],
} as const;
/** The guests a server can have at once. Guest n uses the demo's nth chatter profile. */
export const GUESTS_MAX = 3;

/** A random clip number out of count, never the same as last twice in a row. */
export function chatterClip(count: number, last: number): number {
  const pick = Math.floor(Math.random() * count);
  if (count > 1 && pick === last) return (pick + 1 + Math.floor(Math.random() * (count - 1))) % count;
  return pick;
}

export function chatterWait([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

// ---------- Auto-update ----------
/** GET /api/version (public, no auth). Clients compare their own version against these. */
export interface VersionInfo {
  serverVersion: string;
  /** Clients older than this must update before they can connect. */
  minClientVersion: string;
  /** Version of the newest desktop build uploaded to this server, or null if none yet. */
  latestClientVersion: string | null;
}

/** Desktop updater state, pushed from the Electron main process to the renderer. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'none' }
  | { state: 'error'; message: string };

/** Compares dotted numeric versions: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Jellyfin library browsing. The Chatward server proxies Jellyfin, so clients never see its address or API key.
export interface JellyfinItem {
  id: string;
  name: string;
  /** Movie, Series, Season, Episode or Folder (a library view). */
  kind: string;
  year: number | null;
  runtimeSeconds: number | null;
  overview: string;
  /** Path to the poster on the Chatward server, or null when the item has none. Needs the Authorization header. */
  posterUrl: string | null;
  /** true for things that play (Movie, Episode); false for containers to open with `parentId`. */
  playable: boolean;
}
export interface JellyfinPlayback {
  /** Master playlist path on the Chatward server. Already carries its own ticket, so a plain <video>/hls.js can load it. */
  url: string;
  title: string;
  durationSeconds: number | null;
  /** Epoch ms when the ticket stops working. Ask again to continue. */
  expiresAt: number;
}
