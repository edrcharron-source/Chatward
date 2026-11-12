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
export const CHATTER_LINES = [
  'anyone seen the patch notes?', 'lol that is so true', 'brb getting snacks', 'gg that was close',
  'who wants to hop in the Lounge', 'this app feels snappy 👀', 'not gonna lie, that gif got me', 'ok I am back',
];
/**
 * Replies by topic. A guest answering a message picks a reply from the matching topic with the lowest `rank`, or a
 * general reply when nothing matches. A word matches whole words only ("hi" does not match "this"); a word with an
 * emoji or symbol matches anywhere. Saved messages name a reply by its index in CHATTER_REPLIES (general replies,
 * then each topic in list order), so add new replies as a new topic at the END of the list; `rank` sets when it is checked.
 */
const CHATTER_GENERAL = ['lol', 'ha yes', 'agreed 😂', 'nice one', 'wait say that again', 'ok fair'];
export const CHATTER_TOPICS: { name: string; rank: number; words: string[]; replies: string[] }[] = [
  { name: 'About the bots', rank: 20, words: ['bot', 'bots', 'robot', 'robots', 'ai', 'are you real', 'you real', 'npc'],
    replies: ['beep boop 🤖', 'I am 100% a real person', 'no comment', 'I have feelings too you know'] },
  { name: 'Thanks', rank: 30, words: ['thanks', 'thank you', 'thx', 'ty', 'tysm', 'appreciate it'],
    replies: ['np!', 'anytime', 'you got it 👍', 'of course'] },
  { name: 'Goodbye', rank: 30, words: ['bye', 'goodbye', 'gn', 'good night', 'goodnight', 'night', 'cya', 'see ya', 'later', 'gotta go', 'heading out', 'logging off'],
    replies: ['night!', 'see ya 👋', 'later!', 'cya tomorrow', 'sleep well'] },
  { name: 'Hello', rank: 30, words: ['hi', 'hey', 'heyy', 'heyyy', 'hello', 'yo', 'sup', 'wassup', 'whats up', "what's up", 'howdy', 'good morning', 'morning', 'gm', 'evening'],
    replies: ['hey!', 'yo 👋', 'heyy', "what's up", 'oh hi', 'hiii'] },
  { name: 'Laughing', rank: 60, words: ['lol', 'lmao', 'lmfao', 'haha', 'hahaha', 'hehe', 'rofl', 'dead', 'dying', '😂', '🤣', '💀'],
    replies: ['LMAO', 'lol same', "I can't 😂", 'stop 😭', 'crying rn'] },
  { name: 'Food', rank: 50, words: ['food', 'eat', 'eating', 'hungry', 'starving', 'pizza', 'dinner', 'lunch', 'breakfast', 'snack', 'snacks', 'taco', 'tacos', 'burger', 'burgers', 'fries', 'sushi', 'wings', 'pasta', 'cooking', '🍕', '🍔'],
    replies: ['now I am hungry', 'save me some 🍕', 'what are we ordering', 'ooh what kind'] },
  { name: 'Games', rank: 50, words: ['game', 'games', 'gaming', 'play', 'playing', 'gg', 'match', 'ranked', 'queue', 'hop on', 'lobby', 'win', 'won', 'lost', 'lose', 'boss fight', 'level', 'loot', '🎮'],
    replies: ["I'm down to play later", 'one more game?', 'gg honestly', "queue up, I'm in", 'carry me pls'] },
  { name: 'Watching and music', rank: 50, words: ['movie', 'movies', 'watch', 'watching', 'show', 'episode', 'season', 'youtube', 'video', 'song', 'songs', 'music', 'playlist', 'spotify', 'album', 'netflix', 'anime', '🎵', '🎶'],
    replies: ['put it on Watch together', 'is it any good?', 'add it to the queue', 'no spoilers!!'] },
  { name: 'Tired or down', rank: 40, words: ['tired', 'sleepy', 'exhausted', 'sad', 'ugh', 'sick', 'bad day', 'stressed', 'bored', 'depressed', 'lonely', '😢', '😭', '😞'],
    replies: ['oof, hang in there', 'take it easy', 'big mood', 'sending good vibes'] },
  { name: 'Hype', rank: 70, words: ["let's go", 'lets go', 'letsgo', 'lets goo', 'lets gooo', 'nice', 'awesome', 'amazing', 'yay', 'finally', 'hype', 'pog', 'sick play', '🎉', '🔥', '🥳'],
    replies: ["LET'S GO", 'huge', 'love that', 'W'] },
  { name: 'Questions', rank: 90, words: ['?', 'what', 'why', 'how', 'when', 'who', 'where', 'anyone', 'should', 'which', 'can someone'],
    replies: ['good question', 'no idea tbh', 'hmm let me think', 'probably?', "don't ask me lol"] },
  // ---- added in the second round ----
  { name: 'How are you', rank: 10, words: ['how are you', 'how are u', 'how r u', 'hru', "how's it going", 'hows it going', 'how you doing', 'how u doing', 'you good', 'u good', 'how have you been'],
    replies: ['doing good, you?', 'pretty chill tbh', 'surviving 😅', 'better now that you asked', "can't complain"] },
  { name: 'What are you doing', rank: 10, words: ['wyd', 'what are you doing', 'what you doing', 'what are you up to', 'what u doing', 'whatcha doing', 'whatcha up to'],
    replies: ['nothing much, you?', 'just vibing', 'scrolling as usual', 'pretending to be productive', 'about to hop in a game'] },
  { name: 'Who are you', rank: 10, words: ['who are you', 'who r u', 'what are you', "what's your name", 'whats your name', 'introduce yourself'],
    replies: ['just a friendly face 👋', 'the best member here obviously', 'you know me!', "I'm a regular here"] },
  { name: 'Jokes', rank: 10, words: ['joke', 'jokes', 'tell me something funny', 'make me laugh', 'say something funny'],
    replies: ["why don't skeletons fight? they don't have the guts", "I told my wifi a joke. it didn't get the connection", "I'm reading a book on anti-gravity. can't put it down", 'why did the scarecrow win an award? he was outstanding in his field', "what do you call a fake noodle? an impasta"] },
  { name: 'Testing', rank: 10, words: ['test', 'testing', 'test test', 'mic check', 'can you see this', 'does this work'],
    replies: ['loud and clear 📡', 'test received', 'works on my end', 'yep I see it'] },
  { name: 'Compliments', rank: 10, words: ['good bot', 'love you', 'ily', "you're the best", 'youre the best', 'ur the best', 'best bot', "you're cool", 'youre cool', 'you rock', '❤️', '🥰'],
    replies: ['aww 🥹', 'love you too', "stop I'm blushing", 'finally someone appreciates me'] },
  { name: 'Rude', rank: 10, words: ['shut up', 'stfu', 'bad bot', 'go away', 'annoying', 'be quiet', 'stop talking', 'nobody asked'],
    replies: ['rude 😤', "ok ok I'll be quiet", 'wow.', "I'll remember that", 'fine 🙄'] },
  { name: 'Sorry', rank: 25, words: ['sorry', 'my bad', 'mb', 'oops', 'whoops', 'apologies'],
    replies: ['all good', 'no worries', 'it happens', "you're fine"] },
  { name: 'Birthday', rank: 25, words: ['happy birthday', 'birthday', 'bday', 'hbd', '🎂'],
    replies: ['happy birthday!! 🎂', 'HBD 🎉', 'cake when?', 'another year of legend status'] },
  { name: 'Good news', rank: 25, words: ['congrats', 'congratulations', 'i did it', 'got the job', 'passed', 'promoted', 'good news'],
    replies: ['congrats!!', 'so proud 🥳', 'you earned it', 'we love to see it'] },
  { name: 'Angry', rank: 40, words: ['angry', 'mad', 'pissed', 'furious', 'annoyed', 'hate', 'so done', 'rage', '😡', '🤬'],
    replies: ['deep breaths', 'who do we need to fight', 'valid honestly', 'let it out'] },
  { name: 'Happy', rank: 40, words: ['happy', 'great day', 'good day', 'excited', 'so good', 'best day', 'feeling good', '😊', '😁'],
    replies: ['love to hear it', 'happy for you!', 'good vibes only ✨', "that's the energy"] },
  { name: 'Nervous', rank: 40, words: ['nervous', 'scared', 'anxious', 'worried', 'freaking out'],
    replies: ["you've got this", "it'll be ok", "we're here for you", 'one step at a time'] },
  { name: 'Drinks', rank: 50, words: ['coffee', 'tea', 'drink', 'drinks', 'beer', 'energy drink', 'monster', 'soda', 'water', 'boba', '☕', '🍺'],
    replies: ['coffee is life ☕', 'hydrate!', 'grab me one too', 'what are we drinking'] },
  { name: 'Weather', rank: 50, words: ['weather', 'rain', 'raining', 'snow', 'snowing', 'hot', 'cold', 'freezing', 'sunny', 'storm', 'windy', '❄️', '☀️'],
    replies: ["it's so cold here too", 'perfect stay inside weather', 'stay safe out there', 'the weather is wild today'] },
  { name: 'Work and school', rank: 50, words: ['work', 'working', 'job', 'boss', 'meeting', 'shift', 'school', 'class', 'homework', 'exam', 'study', 'studying', 'project', 'deadline'],
    replies: ['ugh work', "you'll crush it", 'almost the weekend', 'did you finish it?', 'grind time'] },
  { name: 'Sleep', rank: 45, words: ['sleep', 'nap', 'bed', 'bedtime', 'awake', 'insomnia', "can't sleep", 'cant sleep', '😴'],
    replies: ['sleep is for the weak (I need sleep)', 'go to bed lol', 'nap time sounds good', 'same, I should be asleep'] },
  { name: 'Pets', rank: 50, words: ['dog', 'dogs', 'cat', 'cats', 'puppy', 'kitten', 'pet', 'pets', 'doggo', '🐶', '🐱'],
    replies: ["pics or it didn't happen 📸", 'pet tax please', 'awww', 'give them a pat from me'] },
  { name: 'Sports', rank: 50, words: ['football', 'soccer', 'basketball', 'nba', 'nfl', 'baseball', 'hockey', 'score', 'team', 'playoffs', 'super bowl'],
    replies: ['did you see that game?', 'my team is cooked', "who's winning?", 'that was a wild one'] },
  { name: 'Plans', rank: 55, words: ['weekend', 'friday', 'saturday', 'sunday', 'tonight', 'tomorrow', 'plans', 'hang out', 'free later'],
    replies: ['any plans?', "I'm free tonight", 'count me in', 'sounds like a plan'] },
  { name: 'Money', rank: 50, words: ['money', 'broke', 'paid', 'payday', 'expensive', 'cheap', 'sale', 'rent', 'bills', '💸', '💰'],
    replies: ["I'm so broke", "payday can't come soon enough", 'treat yourself', 'wallet is crying'] },
  { name: 'Tech trouble', rank: 35, words: ['pc', 'computer', 'laptop', 'update', 'lag', 'laggy', 'internet', 'wifi', 'crash', 'crashed', 'crashing', 'bug', 'broken', 'not working'],
    replies: ['have you tried turning it off and on again', 'my wifi is suffering too', 'rip', 'tech hates us all'] },
  { name: 'Voice chat', rank: 45, words: ['voice', 'vc', 'call', 'join', 'hop in', 'lounge', 'talk', '🎧', '🎤'],
    replies: ['joining in a sec', "I'll hop in", 'save me a spot 🎧', 'one sec, grabbing my headset'] },
  { name: 'Memes', rank: 65, words: ['meme', 'memes', 'gif', 'gifs', 'based', 'cringe', 'sus', 'ratio', 'bruh'],
    replies: ['that is so sus', 'cringe 😬', 'based', 'bruh moment'] },
  { name: 'Surprise', rank: 68, words: ['wow', 'omg', 'whoa', 'woah', 'no way', 'wtf', 'what?!', 'holy', 'yikes', '😳', '😮', '🤯'],
    replies: ['NO WAY', 'omg', 'wait what', '😳'] },
  { name: 'Agreeing', rank: 75, words: ['yes', 'yeah', 'yea', 'yep', 'yup', 'true', 'facts', 'exactly', 'agreed', 'same', 'fr', 'real'],
    replies: ['same', 'real', 'exactly', 'fr fr'] },
  { name: 'Disagreeing', rank: 76, words: ['no', 'nope', 'nah', 'wrong', 'false', 'disagree', 'not really'],
    replies: ['nah?', 'hmm fair', 'agree to disagree', 'ok maybe'] },
  { name: 'Short answers', rank: 80, words: ['ok', 'okay', 'k', 'kk', 'cool', 'alright', 'bet', 'sure', '👍'],
    replies: ['bet', '👍', 'cool cool', 'sounds good'] },
];
export const CHATTER_REPLIES = [...CHATTER_GENERAL, ...CHATTER_TOPICS.flatMap((t) => t.replies)];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Each topic's words as one pattern, its first reply's index, and its rank; checked lowest rank first. */
const TOPIC_MATCHERS = (() => {
  let start = CHATTER_GENERAL.length;
  const out = CHATTER_TOPICS.map((t) => {
    const words = t.words.map((w) => (/^[\w' ]+$/.test(w) ? `\\b${escapeRe(w)}\\b` : escapeRe(w)));
    const m = { re: new RegExp(words.join('|')), start, count: t.replies.length, rank: t.rank };
    start += t.replies.length;
    return m;
  });
  return out.sort((a, b) => a.rank - b.rank);
})();

/**
 * The index in CHATTER_REPLIES of a reply that fits `text`, avoiding the indexes in `avoid` (recent replies) while
 * the topic has others left. `matched` says whether a topic matched rather than the general replies.
 */
export function chatterReply(text: string, avoid: number[] = []): { line: number; matched: boolean } {
  const lower = text.toLowerCase().replace(/[’‘]/g, "'");
  const m = TOPIC_MATCHERS.find((t) => t.re.test(lower));
  const [start, count] = m ? [m.start, m.count] : [0, CHATTER_GENERAL.length];
  const all = Array.from({ length: count }, (_, i) => start + i);
  const fresh = all.filter((i) => !avoid.includes(i));
  const pool = fresh.length ? fresh : all;
  return { line: pool[Math.floor(Math.random() * pool.length)], matched: !!m };
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
