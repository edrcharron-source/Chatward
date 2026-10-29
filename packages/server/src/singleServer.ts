// Chatward runs one server for everyone on it. The servers table keeps its single row, so channels, voice, sounds
// and MLS groups work as before; only the ways to have more than one server are gone.
import type { DB } from './db.js';
import { newId } from './db.js';

/** The server everyone is in: the oldest one. Null until the first account exists. */
export function mainServerId(db: DB): string | null {
  return (db.prepare('SELECT id FROM servers ORDER BY created_at, rowid LIMIT 1').get() as { id: string } | undefined)?.id ?? null;
}

/** Creates the server with its first text and voice channel, owned by `ownerId`. Run inside a transaction. */
export function createMainServer(db: DB, ownerId: string, name = 'Chatward'): string {
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(id, name, ownerId, now);
  db.prepare('INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, ownerId, 'owner', now);
  for (const [channel, kind] of [['general', 'text'], ['General', 'voice']] as const) {
    db.prepare('INSERT INTO channels (id, server_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId(), id, channel, kind, now);
  }
  return id;
}

/**
 * Brings a database from the multi-server releases to one server. Safe to run on every start: each step only acts
 * on rows that are not converted yet.
 * - No server yet but accounts exist: the oldest account gets the server.
 * - Several servers: the oldest is the server. The others are left untouched and no longer listed.
 * - Anyone banned from the server is turned off instead, and the ban is dropped.
 * - Every other live account becomes a member.
 * - Display names follow the account name, which is the only name now.
 */
export function ensureSingleServer(db: DB): void {
  db.transaction(() => {
    db.prepare("UPDATE users SET display_name=username WHERE deleted_at IS NULL AND display_name<>username").run();
    let serverId = mainServerId(db);
    if (!serverId) {
      const owner = db.prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at, rowid LIMIT 1').get() as
        { id: string } | undefined;
      if (!owner) return;
      serverId = createMainServer(db, owner.id);
      console.log('Created the Chatward server for the existing accounts.');
    }
    const now = Date.now();
    db.prepare(`UPDATE users SET disabled_at=? WHERE disabled_at IS NULL AND deleted_at IS NULL
      AND id IN (SELECT user_id FROM bans WHERE server_id=?) AND id NOT IN (SELECT user_id FROM members WHERE server_id=?)`)
      .run(now, serverId, serverId);
    db.prepare('DELETE FROM bans WHERE server_id=?').run(serverId);
    const added = db.prepare(`INSERT INTO members (server_id, user_id, role, joined_at)
      SELECT ?, id, 'member', ? FROM users WHERE deleted_at IS NULL AND disabled_at IS NULL
        AND id NOT IN (SELECT user_id FROM members WHERE server_id=?)`).run(serverId, now, serverId);
    if (added.changes > 0) console.log(`Added ${added.changes} account(s) to the Chatward server.`);
  })();
}
