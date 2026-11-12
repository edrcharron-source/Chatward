// Single source of truth for wire types shared by server and client.
// Anything the server stores about message CONTENT is opaque ciphertext (base64).

export const LIMITS = {
  USERNAME_MIN: 3,
  USERNAME_MAX: 24,
  /** The name everyone sees. Only for show: signing in and stored keys use the username. */
  DISPLAY_NAME_MAX: 32,
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
  /** Vault photos or videos shared into the chat. Each carries its own keys, so readers need no Vault access to the descriptor. */
  vault?: VaultRef[];
  /** Set on demo chatter guest messages (client state/guests.ts). Absent on everything people write. */
  chatter?: ChatterTag;
  /** Who the message pings: @everyone, and/or specific members by user id. Absent when nobody is pinged. Client-only meaning. */
  mentions?: { everyone?: boolean; userIds: string[] };
  /**
   * Spotify Jams behind short links in the text, resolved by the sender's app: `link` is the short link as written,
   * `url` the Jam (https://open.spotify.com/socialsession/<id>). Readers check `url` before drawing it.
   */
  spotifyJams?: { link: string; url: string }[];
  /** An "Invite to Listen Along" card. The host is always the message's author; the card shows their live activity. */
  listenAlong?: true;
  /** The message this one replies to. The original's author is also in `mentions`, so the reply pings them. */
  replyTo?: ReplyRef;
}

/**
 * A reply's link back to the message it answers. It travels inside the encrypted payload, so the server never learns
 * who replied to whom. `snippet` is a short copy of the original, shown when the original isn't loaded (or is gone).
 */
export interface ReplyRef {
  messageId: string;
  authorId: string;
  /** The original's time, so the app knows how far back to load when jumping to it. */
  createdAt: number;
  snippet: string;
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
  /** A mid-size preview is stored next to the file (GET /api/vault/:id/preview). */
  hasPreview?: boolean;
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
  /** When the photo or video was taken (ms epoch): the camera's date when the photo has one, else the file's last-modified time. Absent on older uploads. */
  takenAt?: number;
  /** Where takenAt came from: the photo's own EXIF date, or the file's last-modified time. */
  takenAtSource?: 'exif' | 'file';
  /** Camera make and model from EXIF, when present. */
  camera?: string;
  /** Hex SHA-256 of the stored (unencrypted) file, used to spot the same file being added twice. */
  sha256?: string;
  /** True when location data was removed from the photo before it was encrypted. */
  gpsRemoved?: boolean;
  key: string;
  iv: string;
  thumbKey: string;
  thumbIv: string;
  /** Key and iv of the mid-size WebP preview, when one was made. Older items have none and show the file instead. */
  prevKey?: string;
  prevIv?: string;
}

/** A Vault item shared in a message: the item id plus its decrypted descriptor (which holds the file keys). */
export type VaultRef = VaultDescriptor & { itemId: string };

/**
 * A Vault album someone made by hand. The name and description are sealed in `ciphertext` (a VaultAlbumMeta) with the
 * channel key by `sealedBy`; the server only knows which item ids are grouped together.
 */
export interface VaultAlbum {
  id: string;
  serverId: string;
  ownerId: string;
  channelId: string;
  keyVersion: number;
  sealedBy: string;
  ciphertext: string;
  coverItemId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Items in the album, oldest addition first. */
  itemIds: string[];
}

/** The sealed part of a VaultAlbum. */
export interface VaultAlbumMeta {
  name: string;
  description?: string;
}

/** One person's sealed tags for a Vault item. `ciphertext` seals VaultNotes with the item's anchor channel key; the author is part of the seal. */
export interface VaultAnnotation {
  itemId: string;
  serverId: string;
  authorId: string;
  channelId: string;
  keyVersion: number;
  ciphertext: string;
  updatedAt: number;
}

/** Decrypted tags (only ever exists on clients). `people` are user ids. */
export interface VaultNotes {
  tags: string[];
  people: string[];
  caption?: string;
  /** What the on-device sorter made of the item. A person's #photo, #meme or #screenshot tag always wins over it. */
  auto?: VaultAutoSort;
}

export type VaultCategory = 'photo' | 'meme' | 'screenshot';

/** One device's automatic sort of a Vault item, sealed with the rest of that person's notes. */
export interface VaultAutoSort {
  /** null when the sorter was not sure enough; the item shows as unsorted. */
  category: VaultCategory | null;
  /** How sure it was, 0 to 1. */
  score: number;
  /** What decided: 'clues' (file name, camera, size) or the model's name. */
  by: string;
  /** Sorter version, so a better sorter can redo older results. */
  v: number;
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

/** What someone is doing right now, shown under their name. Only sent while they have turned sharing on. */
export interface Activity {
  kind: 'spotify';
  /** Track name. */
  title: string;
  /** Artist names, comma separated. */
  artist: string;
  /** The track on open.spotify.com, if known. */
  url?: string;
  /** Album cover image (https://i.scdn.co/image/<id>), if Spotify gave one. */
  coverUrl?: string;
  /** Length of the track in milliseconds. */
  durationMs?: number;
  /** Where the track was when the sender last checked, in milliseconds. Readers add the time since they received it. */
  progressMs?: number;
  /** Set while this person is listening along with someone: the host's user id. */
  alongWith?: string;
}
/** Longest title or artist the server relays. */
export const ACTIVITY_TEXT_MAX = 200;

// ---------- WebSocket protocol ----------
// Client -> server frames
export type ClientFrame =
  | { t: 'subscribe'; serverId: string }
  | { t: 'typing'; channelId: string }
  | { t: 'presence'; status: 'online' | 'idle' | 'dnd' }
  /** null clears it. */
  | { t: 'activity'; activity: Activity | null }
  | { t: 'ping' };

// Server -> client frames
export type ServerFrame =
  | { t: 'ready'; user: User; presence: Record<string, 'online' | 'idle' | 'dnd'> }
  | { t: 'message.new'; message: Message }
  | { t: 'message.edit'; message: Message }
  | { t: 'message.delete'; channelId: string; messageId: string }
  | { t: 'typing'; channelId: string; userId: string }
  | { t: 'presence'; userId: string; status: 'online' | 'idle' | 'dnd' | 'offline' }
  /** Someone's activity changed. Also sent for everyone with one when a socket connects. null = none. */
  | { t: 'activity'; userId: string; activity: Activity | null }
  | { t: 'member.join'; serverId: string; member: Member }
  | { t: 'member.leave'; serverId: string; userId: string }
  | { t: 'member.devices'; serverId: string; userId: string; devices: DeviceKeys[] }
  | { t: 'key.envelope'; envelope: KeyEnvelope }
  | { t: 'channel.new'; channel: Channel }
  | { t: 'channel.update'; channel: Channel }
  | { t: 'channel.delete'; serverId: string; channelId: string }
  | { t: 'server.update'; server: Server }
  | { t: 'member.role'; serverId: string; userId: string; role: Member['role'] }
  | { t: 'sound.new'; sound: SoundboardSound }
  | { t: 'sound.delete'; serverId: string; soundId: string }
  | { t: 'gif.new'; gif: LibraryGif }
  | { t: 'gif.update'; gif: LibraryGif }
  | { t: 'gif.delete'; serverId: string; gifId: string }
  | { t: 'vault.new'; item: VaultItem }
  | { t: 'vault.delete'; serverId: string; itemId: string }
  | { t: 'vault.annotation'; annotation: VaultAnnotation }
  | { t: 'vault.annotation.delete'; serverId: string; itemId: string; authorId: string }
  | { t: 'vault.album'; album: VaultAlbum }
  | { t: 'vault.album.delete'; serverId: string; albumId: string }
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
/**
 * Short conversations guests start among themselves now and then. The first line always makes sense on its own (a
 * lone guest only says that one); the rest alternate between guests. Each line is CHATTER_LINES[start + n], so add new
 * conversations at the END only, because saved messages name a line by its index.
 */
export const CHATTER_CHATS: string[][] = [
  ['anyone else have the best day today?', 'mine was pretty good actually', 'mine was mid', 'tomorrow will be better'],
  ['what is everyone eating tonight?', 'probably pizza again', 'pizza is never the wrong answer', 'facts'],
  ['I finally beat that boss I was stuck on', 'no way, how many tries?', "don't ask 💀", 'still counts, gg'],
  ['what are you all watching these days?', 'rewatching an old show honestly', 'which one?', "the one with the good intro, you know the one"],
  ['so tired today', 'same, I need a nap', "nap gang 😴"],
  ["what's the best snack, go", 'chips, no contest', 'wrong, it is cookies', 'agree to disagree'],
  ['good morning everyone ☀️', 'morning! coffee first', 'morning 👋'],
  ['is it just me or did this week go by so slow', 'it took a month', 'at least the weekend is close'],
  ['anyone got a song recommendation?', 'what kind of vibe?', 'something chill', "I'll queue something up later"],
  ['should I get a pet?', 'yes. cat.', 'dog obviously', 'get both, problem solved'],
  ['hot take: breakfast for dinner is the best dinner', 'pancakes at 8pm hits different', 'this is the way'],
  ['I need a new game to play', 'what did you play last?', 'a bit of everything', "let's find something we can all play together"],
  ['the weather is wild today', 'it keeps changing every hour', 'perfect stay inside weather'],
  ['who is up for a movie night this weekend?', 'me!', 'only if I pick the snacks', 'deal'],
  ['my internet keeps dropping', 'turn it off and on again', 'already did 😭', 'rip, hope it holds up'],
  ['just made the best sandwich of my life', 'pics or it did not happen', 'it is already gone', 'tragic'],
  ['how is everyone doing?', 'pretty good, you?', 'not bad at all', 'glad to hear it'],
  ['anyone else stay up way too late last night?', 'guilty', 'I saw the sunrise 💀', 'we need help'],
  ['what should we do this weekend?', 'game night?', 'game night with snacks', 'perfect'],
  ['I started a new hobby', 'ooh what is it?', 'drawing, I am terrible at it', 'everyone starts somewhere'],
  ['can we talk about how good fries are', 'fries are elite', 'curly fries especially', 'correct'],
  ['I keep forgetting to drink water', 'hydration check 💧', 'drinking some right now', 'proud of us'],
  ['who wants to watch something together later?', 'yes, put it on Watch together', 'I will bring popcorn 🍿'],
  ['my playlist has been on repeat all day', 'which songs?', 'the same five, honestly', 'that is the dream'],
  ['random thought: are hot dogs sandwiches?', 'no.', 'technically yes', 'this is going to start a war'],
  ['ok who is ready for the weekend', 'me, so ready', 'counting the hours', 'almost there'],
  ['I just remembered I have stuff to do tomorrow', 'future you will handle it', 'that is a tomorrow problem', 'true, back to chilling'],
  ['what is everyone up to right now?', 'just hanging out here', 'listening to music', 'same, chill night'],
  ['coffee or tea?', 'coffee all day', 'tea gang 🍵', 'both, depends on the mood'],
  ['should I start a new show or rewatch an old one?', 'rewatch, comfort show', 'new one, live a little', 'flip a coin'],
];
/** Where CHATTER_CHATS start in CHATTER_LINES. The lines before it are no longer said, but saved messages still use them. */
const CHATTER_OLD_LINES = [
  'anyone seen the patch notes?', 'lol that is so true', 'brb getting snacks', 'gg that was close',
  'who wants to hop in the Lounge', 'this app feels snappy 👀', 'not gonna lie, that gif got me', 'ok I am back',
];
export const CHATTER_LINES = [...CHATTER_OLD_LINES, ...CHATTER_CHATS.flat()];

/** Conversation n as indexes into CHATTER_LINES. */
export function chatterChat(n: number): number[] {
  let start = CHATTER_OLD_LINES.length;
  for (let i = 0; i < n; i++) start += CHATTER_CHATS[i].length;
  return CHATTER_CHATS[n].map((_, i) => start + i);
}

/**
 * Replies by topic. A guest answering a message picks a reply from the matching topic with the lowest `rank`, or a
 * general reply when nothing matches. A word matches whole words only ("hi" does not match "this"); a word with an
 * emoji or symbol matches anywhere. Saved messages name a reply by its index in CHATTER_REPLIES (general replies,
 * then each topic in list order), so add new replies as a new topic at the END of the list; `rank` sets when it is checked.
 */
const CHATTER_GENERAL = ['lol', 'ha yes', 'agreed 😂', 'nice one', 'wait say that again', 'ok fair'];
export const CHATTER_TOPICS: { name: string; rank: number; words: string[]; replies: string[] }[] = [
  { name: 'About the bots', rank: 20, words: ['bot', 'bots', 'robot', 'robots', 'ai', 'are you real', 'you real', 'npc', 'are you a bot', 'are you human', 'chatbot', 'beep boop'],
    replies: ['beep boop 🤖', 'I am 100% a real person', 'no comment', 'I have feelings too you know', 'what gave it away', 'shh, our secret 🤫', 'definitely not a robot. *whirr*', 'I passed the captcha, I swear'] },
  { name: 'Thanks', rank: 30, words: ['thanks', 'thank you', 'thx', 'ty', 'tysm', 'appreciate it', 'thank u', 'thanks a lot', 'much appreciated', 'cheers', 'ty so much'],
    replies: ['np!', 'anytime', 'you got it 👍', 'of course', 'happy to help', 'no problem!', 'for you? always', 'np np'] },
  { name: 'Goodbye', rank: 30, words: ['bye', 'goodbye', 'gn', 'good night', 'goodnight', 'night', 'cya', 'see ya', 'later', 'gotta go', 'heading out', 'logging off', 'bye bye', 'gtg', 'g2g', 'peace', 'peace out', 'ttyl', 'see you', 'nighty night', 'off to bed', 'signing off'],
    replies: ['night!', 'see ya 👋', 'later!', 'cya tomorrow', 'sleep well', 'bye!!', 'take care', 'peace ✌️', 'ttyl', "don't be a stranger"] },
  { name: 'Hello', rank: 30, words: ['hi', 'hey', 'heyy', 'heyyy', 'hello', 'yo', 'sup', 'wassup', 'whats up', "what's up", 'howdy', 'good morning', 'morning', 'gm', 'evening', 'hiya', 'heya', 'greetings', 'good afternoon', 'whats good', "what's good", 'ello', '👋'],
    replies: ['hey!', 'yo 👋', 'heyy', "what's up", 'oh hi', 'hiii', 'hello hello', 'look who it is 👀', 'heyo', 'sup!', 'hey stranger'] },
  { name: 'Laughing', rank: 60, words: ['lol', 'lmao', 'lmfao', 'haha', 'hahaha', 'hehe', 'rofl', 'dead', 'dying', '😂', '🤣', '💀', 'lolol', 'lmaooo', 'hahah', 'ahaha', 'kek', 'im dead', "i'm dead", 'crying', 'hilarious', 'funny'],
    replies: ['LMAO', 'lol same', "I can't 😂", 'stop 😭', 'crying rn', '😂😂😂', 'that got me', 'HAHAHA', 'why is that so funny', 'I wheezed'] },
  { name: 'Food', rank: 50, words: ['food', 'eat', 'eating', 'hungry', 'starving', 'pizza', 'dinner', 'lunch', 'breakfast', 'snack', 'snacks', 'taco', 'tacos', 'burger', 'burgers', 'fries', 'sushi', 'wings', 'pasta', 'cooking', '🍕', '🍔', 'chicken', 'steak', 'ramen', 'noodles', 'chips', 'candy', 'chocolate', 'ice cream', 'cookies', 'cake', 'dessert', 'mcdonalds', 'doordash', 'takeout', 'order food', 'grill'],
    replies: ['now I am hungry', 'save me some 🍕', 'what are we ordering', 'ooh what kind', 'ok now I want food', 'I could eat', 'share??', 'that sounds so good', 'food is the answer'] },
  { name: 'Games', rank: 50, words: ['game', 'games', 'gaming', 'play', 'playing', 'gg', 'match', 'ranked', 'queue', 'hop on', 'lobby', 'win', 'won', 'lost', 'lose', 'boss fight', 'level', 'loot', '🎮', 'minecraft', 'fortnite', 'valorant', 'league', 'overwatch', 'apex', 'cod', 'warzone', 'steam', 'xbox', 'playstation', 'ps5', 'switch', 'nintendo', 'speedrun', 'respawn', 'noob', 'clutch'],
    replies: ["I'm down to play later", 'one more game?', 'gg honestly', "queue up, I'm in", 'carry me pls', 'you playing tonight?', 'I need a rematch', 'my aim is so bad today', 'that game is so good', 'invite me next time'] },
  { name: 'Watching and music', rank: 50, words: ['movie', 'movies', 'watch', 'watching', 'show', 'episode', 'season', 'youtube', 'video', 'song', 'songs', 'music', 'playlist', 'spotify', 'album', 'netflix', 'anime', '🎵', '🎶', 'trailer', 'series', 'tv', 'concert', 'band', 'artist', 'podcast', 'stream', 'streaming', 'twitch', 'binge'],
    replies: ['put it on Watch together', 'is it any good?', 'add it to the queue', 'no spoilers!!', 'what are you watching?', 'ooh send the link', 'that one is a banger', 'I need recommendations', 'adding that to my list'] },
  { name: 'Tired or down', rank: 40, words: ['tired', 'sleepy', 'exhausted', 'sad', 'ugh', 'sick', 'bad day', 'stressed', 'bored', 'depressed', 'lonely', '😢', '😭', '😞', 'drained', 'burnt out', 'burned out', 'rough day', 'not feeling it', 'meh', 'blah', 'feel bad', 'feeling bad'],
    replies: ['oof, hang in there', 'take it easy', 'big mood', 'sending good vibes', 'want to talk about it?', 'that sucks, sorry', 'rest up', "you've got this", 'virtual hug 🫂'] },
  { name: 'Hype', rank: 70, words: ["let's go", 'lets go', 'letsgo', 'lets goo', 'lets gooo', 'nice', 'awesome', 'amazing', 'yay', 'finally', 'hype', 'pog', 'sick play', '🎉', '🔥', '🥳', 'sheesh', 'goated', 'insane', 'incredible', 'clean', 'woo', 'woohoo', 'epic', '💯', '🙌'],
    replies: ["LET'S GO", 'huge', 'love that', 'W', 'HUGE W', "that's insane", 'massive', 'yesss', 'legend'] },
  { name: 'Questions', rank: 90, words: ['?', 'what', 'why', 'how', 'when', 'who', 'where', 'anyone', 'should', 'which', 'can someone', 'does anyone', 'is anyone', 'do you', 'can you', 'would you', 'wanna'],
    replies: ['good question', 'no idea tbh', 'hmm let me think', 'probably?', "don't ask me lol", 'ooh good one', 'depends honestly', "I'd say yes", "maybe? I'm not sure", 'why do you ask 👀', 'someone smarter than me should answer that'] },
  // ---- added in the second round ----
  { name: 'How are you', rank: 10, words: ['how are you', 'how are u', 'how r u', 'hru', "how's it going", 'hows it going', 'how you doing', 'how u doing', 'you good', 'u good', 'how have you been', 'how are things', "how's life", 'hows life', 'how was your day', 'how is your day', "how's your day", 'hows your day'],
    replies: ['doing good, you?', 'pretty chill tbh', 'surviving 😅', 'better now that you asked', "can't complain", 'good! how about you?', 'honestly not bad', 'living the dream', 'tired but alive', 'great now 😊'] },
  { name: 'What are you doing', rank: 10, words: ['wyd', 'what are you doing', 'what you doing', 'what are you up to', 'what u doing', 'whatcha doing', 'whatcha up to', 'what r u doing', 'what are you up 2', 'wbu', 'hbu', 'what about you'],
    replies: ['nothing much, you?', 'just vibing', 'scrolling as usual', 'pretending to be productive', 'about to hop in a game', 'eating snacks', 'listening to music', 'watching something', 'nothing, bored', 'just chilling here'] },
  { name: 'Who are you', rank: 10, words: ['who are you', 'who r u', 'what are you', "what's your name", 'whats your name', 'introduce yourself', 'who is this', 'who dis', 'are you new'],
    replies: ['just a friendly face 👋', 'the best member here obviously', 'you know me!', "I'm a regular here", 'your favorite chatter', 'a mystery 🕵️', "I've been here the whole time", 'just hanging out'] },
  { name: 'Jokes', rank: 10, words: ['joke', 'jokes', 'tell me something funny', 'make me laugh', 'say something funny', 'dad joke', 'pun', 'puns', 'got any jokes'],
    replies: ["why don't skeletons fight? they don't have the guts", "I told my wifi a joke. it didn't get the connection", "I'm reading a book on anti-gravity. can't put it down", 'why did the scarecrow win an award? he was outstanding in his field', "what do you call a fake noodle? an impasta", 'why did the computer go to the doctor? it had a virus', 'what do you call a bear with no teeth? a gummy bear', "why can't you trust stairs? they're always up to something", 'what did the ocean say to the beach? nothing, it just waved', "I'd tell you a UDP joke but you might not get it"] },
  { name: 'Testing', rank: 10, words: ['test', 'testing', 'test test', 'mic check', 'can you see this', 'does this work', 'ping', 'hello?', 'is this thing on', 'anyone there', 'anybody there', 'can anyone see this'],
    replies: ['loud and clear 📡', 'test received', 'works on my end', 'yep I see it', 'all good here', 'signal strong 💪', 'received ✅', 'test passed'] },
  { name: 'Compliments', rank: 10, words: ['good bot', 'love you', 'ily', "you're the best", 'youre the best', 'ur the best', 'best bot', "you're cool", 'youre cool', 'you rock', '❤️', '🥰', 'you are the best', 'ur cool', 'love this', 'good job', 'well done', 'smart bot', 'great bot', '💖', '💕'],
    replies: ['aww 🥹', 'love you too', "stop I'm blushing", 'finally someone appreciates me', 'you too!!', 'right back at you', '🥰', "you're making my day"] },
  { name: 'Rude', rank: 10, words: ['shut up', 'stfu', 'bad bot', 'go away', 'annoying', 'be quiet', 'stop talking', 'nobody asked', 'you suck', 'ur dumb', 'you are dumb', 'stupid bot', 'dumb bot', 'leave me alone', 'kys', 'fuck you', 'fuck off', 'f you', 'fu', 'screw you', "didn't ask", 'didnt ask', 'who asked', 'shut it', 'hate you', 'i hate you', "you're stupid", 'youre stupid', 'ur stupid', "you're dumb", 'youre dumb', 'idiot', 'loser', 'you are trash', 'ur trash', '🖕'],
    replies: ['rude 😤', "ok ok I'll be quiet", 'wow.', "I'll remember that", 'fine 🙄', 'ouch', 'that hurt my circuits', 'noted 📝', 'and yet here you are', 'k'] },
  { name: 'Sorry', rank: 25, words: ['sorry', 'my bad', 'mb', 'oops', 'whoops', 'apologies', 'sry', 'my fault', 'forgive me', 'i apologize'],
    replies: ['all good', 'no worries', 'it happens', "you're fine", "don't worry about it", 'forgiven', 'nah we good', 'no stress'] },
  { name: 'Birthday', rank: 25, words: ['happy birthday', 'birthday', 'bday', 'hbd', '🎂', 'bday party', 'birthday party', 'turning', 'years old'],
    replies: ['happy birthday!! 🎂', 'HBD 🎉', 'cake when?', 'another year of legend status', 'happy bday!!', 'party time 🥳', 'make a wish!', 'how old now?'] },
  { name: 'Good news', rank: 25, words: ['congrats', 'congratulations', 'i did it', 'got the job', 'passed', 'promoted', 'good news', 'got in', 'accepted', 'hired', 'new job', 'won the', 'we did it', 'nailed it'],
    replies: ['congrats!!', 'so proud 🥳', 'you earned it', 'we love to see it', 'WOO', 'knew you could do it', "that's amazing", 'celebration time 🎉'] },
  { name: 'Angry', rank: 40, words: ['angry', 'mad', 'pissed', 'furious', 'annoyed', 'hate', 'so done', 'rage', '😡', '🤬', 'frustrated', 'irritated', 'so mad', 'pissed off', 'triggered', 'fed up'],
    replies: ['deep breaths', 'who do we need to fight', 'valid honestly', 'let it out', 'ugh that is annoying', 'yeah that would make me mad too', 'want to vent?', 'breathe in, breathe out'] },
  { name: 'Happy', rank: 40, words: ['happy', 'great day', 'good day', 'excited', 'so good', 'best day', 'feeling good', '😊', '😁', 'glad', 'joy', 'stoked', 'pumped', 'thrilled', 'grateful', 'blessed'],
    replies: ['love to hear it', 'happy for you!', 'good vibes only ✨', "that's the energy", 'yay!!', 'this made me smile', 'love this for you', 'keep that energy'] },
  { name: 'Nervous', rank: 40, words: ['nervous', 'scared', 'anxious', 'worried', 'freaking out', 'stress', 'panic', 'panicking', 'interview', 'first day', 'big day'],
    replies: ["you've got this", "it'll be ok", "we're here for you", 'one step at a time', "you'll do great", "breathe, it'll be fine", 'rooting for you', "you're more ready than you think"] },
  { name: 'Drinks', rank: 50, words: ['coffee', 'tea', 'drink', 'drinks', 'beer', 'energy drink', 'monster', 'soda', 'water', 'boba', '☕', '🍺', 'juice', 'milk', 'latte', 'starbucks', 'wine', 'red bull', 'thirsty', 'caffeine'],
    replies: ['coffee is life ☕', 'hydrate!', 'grab me one too', 'what are we drinking', 'cheers 🥂', 'make it a double', 'I need caffeine too', 'hydration check 💧'] },
  { name: 'Weather', rank: 50, words: ['weather', 'rain', 'raining', 'snow', 'snowing', 'hot', 'cold', 'freezing', 'sunny', 'storm', 'windy', '❄️', '☀️', 'heat', 'humid', 'cloudy', 'thunder', 'lightning', 'tornado', 'hurricane', 'fog', 'chilly', 'warm'],
    replies: ["it's so cold here too", 'perfect stay inside weather', 'stay safe out there', 'the weather is wild today', 'I love this weather honestly', 'bring a jacket', 'blanket weather', 'too hot to function'] },
  { name: 'Work and school', rank: 50, words: ['work', 'working', 'job', 'boss', 'meeting', 'shift', 'school', 'class', 'homework', 'exam', 'study', 'studying', 'project', 'deadline', 'office', 'coworker', 'coworkers', 'manager', 'teacher', 'college', 'university', 'essay', 'quiz', 'grades', 'overtime', 'monday'],
    replies: ['ugh work', "you'll crush it", 'almost the weekend', 'did you finish it?', 'grind time', 'you got this', 'is it the weekend yet', 'take a break soon', 'we believe in you', "don't work too hard"] },
  { name: 'Sleep', rank: 45, words: ['sleep', 'nap', 'bed', 'bedtime', 'awake', 'insomnia', "can't sleep", 'cant sleep', '😴', 'sleeping', 'tired af', 'woke up', 'just woke', 'alarm', 'dream', 'dreams', 'snooze'],
    replies: ['sleep is for the weak (I need sleep)', 'go to bed lol', 'nap time sounds good', 'same, I should be asleep', 'go sleep!!', 'sweet dreams', "I'm up too", 'sleep schedule? never heard of her'] },
  { name: 'Pets', rank: 50, words: ['dog', 'dogs', 'cat', 'cats', 'puppy', 'kitten', 'pet', 'pets', 'doggo', '🐶', '🐱', 'bird', 'fish', 'hamster', 'bunny', 'rabbit', 'lizard', 'snake', 'vet', 'walk the dog', 'meow', 'woof'],
    replies: ["pics or it didn't happen 📸", 'pet tax please', 'awww', 'give them a pat from me', 'what is their name?', 'I need to meet them', 'cutest member of the server', 'protect them at all costs'] },
  { name: 'Sports', rank: 50, words: ['football', 'soccer', 'basketball', 'nba', 'nfl', 'baseball', 'hockey', 'score', 'team', 'playoffs', 'super bowl', 'goal', 'touchdown', 'world cup', 'f1', 'ufc', 'boxing', 'golf', 'tennis'],
    replies: ['did you see that game?', 'my team is cooked', "who's winning?", 'that was a wild one', 'what a game', 'refs were blind', "we're so back", "it's so over"] },
  { name: 'Plans', rank: 55, words: ['weekend', 'friday', 'saturday', 'sunday', 'tonight', 'tomorrow', 'plans', 'hang out', 'free later', 'this weekend', 'next week', 'later today', 'anyone free', 'what should we do', 'road trip', 'vacation', 'trip'],
    replies: ['any plans?', "I'm free tonight", 'count me in', 'sounds like a plan', "I'm down", "what's the plan?", "let's do it", 'send details'] },
  { name: 'Money', rank: 50, words: ['money', 'broke', 'paid', 'payday', 'expensive', 'cheap', 'sale', 'rent', 'bills', '💸', '💰', 'cash', 'bucks', 'dollars', 'price', 'deal', 'buy'],
    replies: ["I'm so broke", "payday can't come soon enough", 'treat yourself', 'wallet is crying', 'money comes and goes', 'that is a lot', 'worth it', 'take my money'] },
  { name: 'Tech trouble', rank: 35, words: ['pc', 'computer', 'laptop', 'update', 'lag', 'laggy', 'internet', 'wifi', 'crash', 'crashed', 'crashing', 'bug', 'broken', 'not working', 'glitch', 'frozen', 'freezing up', 'error', 'blue screen', 'reboot', 'restart', 'ping is', 'high ping', 'fps', 'drivers'],
    replies: ['have you tried turning it off and on again', 'my wifi is suffering too', 'rip', 'tech hates us all', 'did you try restarting', 'classic', 'tech support has entered the chat', 'ugh I hate when that happens'] },
  { name: 'Voice chat', rank: 45, words: ['voice', 'vc', 'call', 'join', 'hop in', 'lounge', 'talk', '🎧', '🎤', 'hop on vc', 'get in vc', 'mic', 'muted', 'unmute', 'deafened', 'can you hear me', 'headset', 'screen share', 'stream it'],
    replies: ["I'm right here 🎧", 'can you hear me ok?', 'my mic is on, I promise', 'voice is the best part of this app', 'loud and clear', 'voice is where the party is', 'can you hear me now?', 'unmute yourself lol'] },
  { name: 'Memes', rank: 65, words: ['meme', 'memes', 'gif', 'gifs', 'based', 'cringe', 'sus', 'ratio', 'bruh', 'lmao this', 'shitpost', 'copium', 'skill issue', 'npc behavior', 'rizz', 'mid', 'touch grass', 'ong', 'no cap', 'cap'],
    replies: ['that is so sus', 'cringe 😬', 'based', 'bruh moment', 'skill issue', 'touch grass', 'no cap', 'mid', 'L + ratio'] },
  { name: 'Surprise', rank: 68, words: ['wow', 'omg', 'whoa', 'woah', 'no way', 'wtf', 'what?!', 'holy', 'yikes', '😳', '😮', '🤯', 'what the', 'are you serious', 'seriously', 'for real?', 'insane', 'crazy', 'jeez', 'dang', 'damn'],
    replies: ['NO WAY', 'omg', 'wait what', '😳', 'NO WAYYY', 'are you serious', 'I am shook', 'what is happening'] },
  { name: 'Agreeing', rank: 75, words: ['yes', 'yeah', 'yea', 'yep', 'yup', 'true', 'facts', 'exactly', 'agreed', 'same', 'fr', 'real', 'yessir', 'absolutely', 'definitely', 'for sure', 'totally', 'ikr', 'i know right', 'right', 'correct', 'same here', '100%'],
    replies: ['same', 'real', 'exactly', 'fr fr', '100%', "couldn't agree more", 'say it louder', 'ikr', 'true true'] },
  { name: 'Disagreeing', rank: 76, words: ['no', 'nope', 'nah', 'wrong', 'false', 'disagree', 'not really', 'nuh uh', 'no way jose', 'i doubt it', 'not true', 'cap', 'thats cap', "that's cap"],
    replies: ['nah?', 'hmm fair', 'agree to disagree', 'ok maybe', 'are you sure?', "I don't know about that", 'hmm I see it differently', 'bold take'] },
  { name: 'Short answers', rank: 80, words: ['ok', 'okay', 'k', 'kk', 'cool', 'alright', 'bet', 'sure', '👍', 'okie', 'okk', 'aight', 'gotcha', 'got it', 'sounds good', 'noted', 'fine', 'mhm', 'hmm', 'yeah ok'],
    replies: ['bet', '👍', 'cool cool', 'sounds good', 'ok!', 'alright', 'gotcha', '👌', 'nice'] },
  // ---- added in the third round ----
  // No words: these join the general replies for messages that match nothing.
  { name: 'Anything else', rank: 999, words: [],
    replies: ['interesting', 'tell me more', 'hmm', 'fair enough', 'I feel that', 'go on...', 'noted', 'big if true', 'real', "can't argue with that", 'mood', 'say less'] },
  { name: 'Good morning', rank: 12, words: ['good morning', 'gm', 'morning all', 'morning everyone', 'rise and shine', 'just woke up'],
    replies: ['good morning! ☀️', 'gm gm', 'morning! coffee first', 'rise and grind', 'morning sunshine'] },
  { name: 'Good night', rank: 12, words: ['good night', 'goodnight', 'gn', 'nighty night', 'going to bed', 'off to bed', 'heading to bed'],
    replies: ['good night! 🌙', 'sleep well', 'nighty night', 'sweet dreams', "gn! don't let the bugs bite"] },
  { name: 'Opinions', rank: 15, words: ['what do you think', 'thoughts?', 'your opinion', 'do you like', 'do you prefer', 'which is better', 'hot take'],
    replies: ['honestly I like it', 'hmm, solid choice', "it's growing on me", "I'll go with the first one", 'controversial but yes', "I'm not a fan tbh"] },
  { name: 'Favorites', rank: 15, words: ['favorite', 'favourite', 'fav', 'fave', 'best ever', 'goat'],
    replies: ['tough one, too many to pick', 'mine changes every week', "that's a good pick", "you're asking the real questions", 'pizza. the answer is always pizza'] },
  { name: 'Bored', rank: 18, words: ['bored', 'boring', 'nothing to do', 'so bored', 'entertain me'],
    replies: ["let's play something", 'tell me a joke then', 'watch something together?', 'same honestly', 'boredom is a skill issue jk'] },
  { name: 'Help', rank: 18, words: ['help', 'need help', 'can someone help', 'help me', 'any ideas', 'advice'],
    replies: ["what's up? I'll try", 'what do you need?', 'I can try!', 'someone help this person', 'describe the problem 🕵️'] },
  { name: 'Holidays', rank: 50, words: ['christmas', 'xmas', 'thanksgiving', 'halloween', 'new year', 'new years', 'easter', 'holiday', 'holidays', 'turkey', 'presents', 'gifts', '🎄', '🎃'],
    replies: ['happy holidays!', 'so ready for it', 'what are you doing for it?', 'best time of the year', 'save me some leftovers'] },
  { name: 'Cars and driving', rank: 50, words: ['car', 'cars', 'drive', 'driving', 'traffic', 'road', 'gas', 'parking', 'commute', '🚗'],
    replies: ['traffic is the worst', 'drive safe!', 'road trip?', 'gas prices are wild', 'nice ride'] },
  { name: 'Health and gym', rank: 50, words: ['gym', 'workout', 'working out', 'lifting', 'run', 'running', 'cardio', 'gains', 'diet', 'healthy', 'protein', '💪'],
    replies: ['gains 💪', 'proud of you', 'leg day?', 'I should go too... tomorrow', 'beast mode'] },
  { name: 'Shopping', rank: 50, words: ['shopping', 'bought', 'ordered', 'package', 'delivery', 'new shoes', 'new phone', 'amazon', 'black friday'],
    replies: ['what did you get?', 'show us!', 'treat yourself', 'my wallet could never', 'nice pickup'] },
  { name: 'Space and science', rank: 50, words: ['space', 'planet', 'stars', 'moon', 'nasa', 'rocket', 'alien', 'aliens', 'science', 'universe', '🚀', '🌙'],
    replies: ['space is so cool', 'aliens are real, trust me', 'to infinity and beyond 🚀', 'the universe is wild', 'we are all stardust'] },
  { name: 'Cooking', rank: 50, words: ['cook', 'cooked', 'baking', 'baked', 'recipe', 'kitchen', 'oven', 'chef'],
    replies: ['chef mode 👨‍🍳', 'save me a plate', "what's on the menu?", 'recipe please', 'smells good from here'] },
  { name: 'The app', rank: 45, words: ['chatward', 'this app', 'the app', 'new update', 'new feature', 'lcars', 'skin', 'theme'],
    replies: ['this app is so good', 'love the new look', 'the skins are 🔥', 'best app ever, no bias', 'the devs are geniuses'] },
  { name: 'Late night', rank: 45, words: ['3am', '2am', '4am', 'late night', 'still up', 'still awake', 'up late'],
    replies: ['why are we all awake', 'night owls unite 🦉', 'go to sleep lol', 'the best convos happen late'] },
  { name: 'Hungry for snacks', rank: 52, words: ['snack time', 'munchies', 'popcorn', 'gummies', 'cereal'],
    replies: ['popcorn ready 🍿', 'snack break!', 'pass the snacks', 'cereal at any hour is valid'] },
  { name: 'Emoji reactions', rank: 85, words: ['👀', '🤔', '😅', '🙃', '😎', '🤷', '🙄', '🫠'],
    replies: ['👀', '🤔', '😅', '😎', '🤷'] },
  { name: 'Excited for something', rank: 58, words: ["can't wait", 'cant wait', 'so excited', 'soon', 'coming out', 'release', 'tomorrow!'],
    replies: ['same!!', 'the hype is real', 'counting down', "it's going to be so good"] },
  { name: 'Lost and confused', rank: 72, words: ['confused', 'lost', 'huh', 'wait what', "i don't get it", 'i dont get it', 'what do you mean', '???'],
    replies: ['same, I am lost', 'explain like I am 5', "you're not alone", 'wait now I am confused too', 'huh?'] },
  // ---- added in the fourth round ----
  // `[media]` is never typed: chatterText adds it for a message with a GIF, picture or video, so text topics win first.
  { name: 'GIFs and pictures', rank: 95, words: ['[media]'],
    replies: ['LMAO that gif', 'that gif is perfect', 'ok that one got me 😂', 'saving that one', 'where do you find these', 'beautiful', 'the quality 👌', 'frame it'] },
];
export const CHATTER_REPLIES = [...CHATTER_GENERAL, ...CHATTER_TOPICS.flatMap((t) => t.replies)];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Each topic's words as one pattern, its first reply's index, and its rank; checked lowest rank first. */
const TOPIC_MATCHERS = (() => {
  let start = CHATTER_GENERAL.length;
  const out = CHATTER_TOPICS.map((t) => {
    const words = t.words.map((w) => (/^[\w' ]+$/.test(w) ? `\\b${escapeRe(w)}\\b` : escapeRe(w)));
    const m = { re: words.length ? new RegExp(words.join('|')) : null, start, count: t.replies.length, rank: t.rank };
    start += t.replies.length;
    return m;
  });
  return out.sort((a, b) => a.rank - b.rank);
})();
/** Replies for a message no topic matches: the general ones plus every topic without words. */
const FALLBACK = [
  ...CHATTER_GENERAL.map((_, i) => i),
  ...TOPIC_MATCHERS.filter((t) => !t.re).flatMap((t) => Array.from({ length: t.count }, (_, i) => t.start + i)),
];

/**
 * The index in CHATTER_REPLIES of a reply that fits `text`, avoiding the indexes in `avoid` (recent replies) while
 * there are others left. `matched` says whether a topic matched rather than the general replies.
 */
export function chatterReply(text: string, avoid: number[] = []): { line: number; matched: boolean } {
  const lower = text.toLowerCase().replace(/[’‘]/g, "'");
  const m = TOPIC_MATCHERS.find((t) => t.re?.test(lower));
  const all = m ? Array.from({ length: m.count }, (_, i) => m.start + i) : FALLBACK;
  const fresh = all.filter((i) => !avoid.includes(i));
  const pool = fresh.length ? fresh : all;
  return { line: pool[Math.floor(Math.random() * pool.length)], matched: !!m };
}

/** What chatterReply should read for a message: its text, plus a marker when it carries a GIF, picture or video. */
export function chatterText(p: Pick<MessagePayload, 'text' | 'gif' | 'attachments' | 'vault'> | null | undefined): string {
  if (!p) return '';
  return p.gif || p.attachments?.length || p.vault?.length ? `${p.text ?? ''} [media]` : p.text ?? '';
}

/** Which of `names` the text calls by name, as an index into names, or -1. */
export function chatterNamed(text: string, names: string[]): number {
  const lower = text.toLowerCase();
  return names.findIndex((n) => /^\w+$/.test(n) && new RegExp(`\\b${n.toLowerCase()}\\b`).test(lower));
}
/** Waits, in ms, as [min, max]. A wait is min + random * (max - min). */
export const CHATTER_TIMING = {
  firstLine: [8_000, 8_000],
  nextLine: [20_000, 45_000],
  /** Between conversations guests start among themselves. */
  nextChat: [90_000, 180_000],
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

// ---------- Workouts (the crew check-in tracker, formerly the separate DOSS app) ----------
// Workout data is not end-to-end encrypted: the server works out streaks, standings and PRs, so it reads it, like DOSS did.

export const WORKOUT_KINDS = ['Cardio', 'Strength', 'Long', 'Skill', 'Mobility', 'Rest'] as const;
export type WorkoutKind = (typeof WORKOUT_KINDS)[number];
export const WORKOUT_GOAL_TYPES = ['Endurance', 'Strength', 'Body comp', 'Consistency', 'Sport', 'Other'] as const;
export type WorkoutGoalType = (typeof WORKOUT_GOAL_TYPES)[number];
export const WORKOUT_LIMITS = {
  TITLE: 14, GOAL: 80, WHY: 200, WORKOUT: 60, METRICS: 12, METRIC_NAME: 30, METRIC_UNIT: 10,
  MILESTONES: 20, MILESTONE: 60, COMMENT: 280, NOTE: 140, CHEERS_PER_DAY: 5, LOG_BACK_DAYS: 6,
} as const;

/** One day of the weekly plan. dow 0 = Monday. */
export interface WorkoutSplitDay { dow: number; day: string; workout: string; kind: WorkoutKind }
export type WorkoutDayStatus = 'done' | 'missed' | 'rest' | 'today' | 'up' | 'pre';
export interface WorkoutWeekDay { date: string; day: string; workout: string; kind: WorkoutKind; status: WorkoutDayStatus; isToday: boolean }
export interface WorkoutWeek {
  monday: string; sunday: string; today: string; days: WorkoutWeekDay[];
  planned: number; done: number; pct: number;
  todayWorkout: string; todayPlanned: boolean; todayLogged: boolean; streak: number;
}
export interface WorkoutMetric { id: string; name: string; unit: string; better: 'up' | 'down'; entries: Array<{ id: string; value: number; date: string }> }
export interface WorkoutMilestone { id: string; label: string; due: string; done: boolean }
/** A member's public card. name and avatar come from their Chatward account. */
export interface WorkoutCard {
  userId: string; name: string; avatarUrl: string | null; title: string; color: string;
  goal: string; goalType: WorkoutGoalType; startDate: string; goalDate: string; why: string;
}
export interface WorkoutMe extends WorkoutCard {
  tz: string; remindTime: string; showNumbers: boolean; allowNudges: boolean; notifyCrew: boolean;
  split: WorkoutSplitDay[]; metrics: WorkoutMetric[]; milestones: WorkoutMilestone[];
}
export interface WorkoutCrewMember extends WorkoutCard { week: WorkoutWeek; pos: number }
export interface WorkoutCrew {
  monday: string; sunday: string; today: string; daysLeft: number;
  members: WorkoutCrewMember[]; totals: { planned: number; done: number }; meId: string;
}
export type WorkoutEventType = 'log' | 'pr' | 'milestone' | 'nudge' | 'cheer';
export interface WorkoutEvent { id: string; type: WorkoutEventType; text: string; actorId: string; actorName: string; actorAvatarUrl: string | null; actorColor: string; targetId: string | null; createdAt: number }
export interface WorkoutComment { id: string; body: string; authorId: string; authorName: string; authorAvatarUrl: string | null; authorColor: string; createdAt: number }
export interface WorkoutMemberPage extends WorkoutCard {
  self: boolean; allowNudges: boolean; week: WorkoutWeek;
  metrics: WorkoutMetric[]; numbersHidden: boolean; milestones: WorkoutMilestone[]; comments: WorkoutComment[];
}
