import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { config } from './config.js';

export type DB = Database.Database;

export function newId(): string {
  // time-sortable: 9 base36 chars of ms epoch + 10 random hex chars
  return Date.now().toString(36).padStart(9, '0') + crypto.randomBytes(5).toString('hex');
}

export function openDb(): DB {
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const seenDevicesExisted = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mls_group_seen_devices'").get() !== undefined;
  const readsExisted = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_reads'").get() !== undefined;
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_path TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ecdh_public TEXT NOT NULL,
    sign_public TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','voice')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bans (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    key_version INTEGER NOT NULL,
    ciphertext TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
  CREATE TABLE IF NOT EXISTS key_envelopes (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    key_version INTEGER NOT NULL,
    to_device_id TEXT NOT NULL,
    from_device_id TEXT NOT NULL,
    wrapped TEXT NOT NULL,
    signature TEXT NOT NULL,
    PRIMARY KEY (channel_id, key_version, to_device_id)
  );
  -- One outstanding owner-issued reset code per account. Only its hash is stored; a used or expired code is deleted.
  CREATE TABLE IF NOT EXISTS password_resets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    issued_by TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sounds (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    mime TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mls_keypackages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    kp TEXT NOT NULL,
    last_resort INTEGER NOT NULL DEFAULT 0,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mls_kp_device ON mls_keypackages(device_id, last_resort, consumed_at);
  CREATE TABLE IF NOT EXISTS mls_groups (
    group_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mls_commits (
    group_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    sender_device_id TEXT NOT NULL,
    commit_bytes TEXT NOT NULL,
    PRIMARY KEY (group_id, epoch)
  );
  CREATE TABLE IF NOT EXISTS mls_welcomes (
    group_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    to_device_id TEXT NOT NULL,
    welcome TEXT NOT NULL,
    PRIMARY KEY (group_id, epoch, to_device_id)
  );
  CREATE TABLE IF NOT EXISTS mls_group_devices (
    group_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    PRIMARY KEY (group_id, device_id)
  );
  -- Every device that has ever been in a group. Unlike mls_group_devices this is never trimmed, so a Commit from
  -- someone who has since left can still be checked against that device's registered key. The user and public keys
  -- are copied here, not read from devices, because a deleted device has no devices row left to read.
  CREATE TABLE IF NOT EXISTS mls_group_seen_devices (
    group_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    user_id TEXT,
    ecdh_public TEXT,
    sign_public TEXT,
    PRIMARY KEY (group_id, device_id)
  );
  -- The highest epoch each device has confirmed it reached. A reset may not drop a Commit someone else built on.
  CREATE TABLE IF NOT EXISTS mls_group_acks (
    group_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    PRIMARY KEY (group_id, device_id)
  );
  -- Where each member has read up to in a text channel. Unread counts are computed from it, so messages sent while away still count.
  CREATE TABLE IF NOT EXISTS channel_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );
  -- Users removed from a voice call whose removal was still being enforced when its window ended. Rejoin is refused
  -- until a fresh join token for the room clears the row.
  CREATE TABLE IF NOT EXISTS voice_removals (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  `);
  // Read positions start with the release that added channel_reads. Everything already in a channel counts as read,
  // so upgrading does not flag all old history as unread.
  if (!readsExisted) {
    db.exec(`
    INSERT OR IGNORE INTO channel_reads (user_id, channel_id, last_read_id)
      SELECT mb.user_id, c.id, MAX(m.id) FROM members mb
      JOIN channels c ON c.server_id=mb.server_id AND c.kind='text'
      JOIN messages m ON m.channel_id=c.id
      GROUP BY mb.user_id, c.id;
    `);
  }
  // Groups created before mls_group_seen_devices existed: seed it from the devices the server already recorded.
  if (!seenDevicesExisted) {
    db.exec(`
    INSERT OR IGNORE INTO mls_group_seen_devices (group_id, device_id, user_id, ecdh_public, sign_public)
      SELECT s.group_id, d.device_id, d.user_id, d.ecdh_public, d.sign_public FROM (
        SELECT group_id, sender_device_id AS device_id FROM mls_commits
        UNION SELECT group_id, to_device_id FROM mls_welcomes
        UNION SELECT group_id, device_id FROM mls_group_devices
      ) s JOIN devices d ON d.device_id=s.device_id;
    `);
  }
  // Seen devices written before the key copy existed: fill it in from devices while the row still exists.
  // A device deleted before this runs has no keys left to copy, so its rows stay empty and are skipped on read.
  const seenCols = new Set((db.pragma('table_info(mls_group_seen_devices)') as { name: string }[]).map((c) => c.name));
  if (!seenCols.has('ecdh_public')) {
    db.exec(`
    ALTER TABLE mls_group_seen_devices ADD COLUMN user_id TEXT;
    ALTER TABLE mls_group_seen_devices ADD COLUMN ecdh_public TEXT;
    ALTER TABLE mls_group_seen_devices ADD COLUMN sign_public TEXT;
    UPDATE mls_group_seen_devices SET
      user_id=(SELECT d.user_id FROM devices d WHERE d.device_id=mls_group_seen_devices.device_id),
      ecdh_public=(SELECT d.ecdh_public FROM devices d WHERE d.device_id=mls_group_seen_devices.device_id),
      sign_public=(SELECT d.sign_public FROM devices d WHERE d.device_id=mls_group_seen_devices.device_id);
    `);
  }
  // Profile columns were added after the first release; existing databases get them here.
  const userCols = new Set((db.pragma('table_info(users)') as { name: string }[]).map((c) => c.name));
  const profileCols: Record<string, string> = {
    bio: "TEXT NOT NULL DEFAULT ''",
    pronouns: "TEXT NOT NULL DEFAULT ''",
    accent_color: 'TEXT',
    banner_color: 'TEXT',
    banner_path: 'TEXT',
  };
  for (const [col, def] of Object.entries(profileCols)) {
    if (!userCols.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  }
  // Deleted accounts keep their row so old messages still point at a user. This marks them as gone.
  if (!userCols.has('deleted_at')) db.exec('ALTER TABLE users ADD COLUMN deleted_at INTEGER');
  // Bumped on every password change or reset. Tokens carry the version they were issued at, so older ones stop working.
  if (!userCols.has('session_version')) db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  // Upload cleanup: `tracked` marks uploads from clients that report which message they were attached to.
  // Older uploads stay tracked=0 and are never swept, since the server cannot see inside message ciphertext.
  const uploadCols = new Set((db.pragma('table_info(uploads)') as { name: string }[]).map((c) => c.name));
  const uploadColumns: Record<string, string> = {
    tracked: 'INTEGER NOT NULL DEFAULT 0',
    message_id: 'TEXT',
  };
  for (const [col, def] of Object.entries(uploadColumns)) {
    if (!uploadCols.has(col)) db.exec(`ALTER TABLE uploads ADD COLUMN ${col} ${def}`);
  }
  // When a device last had a socket open. Devices added after this are replayed to it on its next connect.
  const deviceCols = new Set((db.pragma('table_info(devices)') as { name: string }[]).map((c) => c.name));
  if (!deviceCols.has('last_seen')) db.exec('ALTER TABLE devices ADD COLUMN last_seen INTEGER');
  // The id a client chose for a message it sends. A repeat of the same id from the same author returns the first copy.
  const messageCols = new Set((db.pragma('table_info(messages)') as { name: string }[]).map((c) => c.name));
  if (!messageCols.has('client_id')) db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
  // Voice removal rows: when the removal happened, and whether LiveKit has not yet confirmed it. Rows from before this
  // existed were only written for unconfirmed removals, so they default to pending.
  const removalCols = new Set((db.pragma('table_info(voice_removals)') as { name: string }[]).map((c) => c.name));
  if (!removalCols.has('removed_at')) db.exec('ALTER TABLE voice_removals ADD COLUMN removed_at INTEGER NOT NULL DEFAULT 0');
  if (!removalCols.has('pending')) db.exec('ALTER TABLE voice_removals ADD COLUMN pending INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client ON messages(author_id, client_id) WHERE client_id IS NOT NULL');
  return db;
}
