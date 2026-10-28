// Single source of truth for wire types shared by server and client.
// Anything the server stores about message CONTENT is opaque ciphertext (base64).

export const LIMITS = {
  USERNAME_MIN: 3,
  USERNAME_MAX: 24,
  PASSWORD_MIN: 10,
  MESSAGE_CIPHERTEXT_MAX: 16_000,
  UPLOAD_MAX_BYTES: 12 * 1024 * 1024, // encrypted image/file blob
  AVATAR_MAX_BYTES: 512 * 1024,
  SOUND_MAX_BYTES: 1024 * 1024,
  SOUND_MAX_SECONDS: 10,
  HISTORY_PAGE: 50,
  BIO_MAX: 190,
  PRONOUNS_MAX: 40,
  BANNER_MAX_BYTES: 1024 * 1024,
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
  gif?: { url: string; previewUrl: string; title: string; provider: 'klipy' | 'tenor' };
  linkPreviews?: LinkPreview[];
}

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

export interface SoundboardSound {
  id: string;
  serverId: string;
  ownerId: string;
  name: string;
  emoji: string;
  url: string; // /api/sounds/<id>/file (plain audio, small; not E2EE in v1)
  durationMs: number;
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
  | { t: 'ready'; user: User }
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
  | { t: 'sound.new'; sound: SoundboardSound }
  | { t: 'sound.delete'; serverId: string; soundId: string }
  | { t: 'sound.play'; serverId: string; channelId: string; soundId: string; userId: string }
  | { t: 'voice.state'; serverId: string; channelId: string; userIds: string[] }
  | { t: 'watch.sync'; channelId: string; authorId: string; keyVersion: number; ciphertext: string; ts: number }
  | { t: 'user.update'; user: User }
  | { t: 'group.commit'; channelId: string; epoch: number }
  | { t: 'group.welcome'; channelId: string; epoch: number }
  | { t: 'keypackages.low'; deviceId: string; remaining: number }
  | { t: 'pong' };

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
