// MLS delivery: KeyPackage pool, epoch-ordered Commits, per-device Welcomes, pending removals.
// The group id is the text channel id. The server stores and orders opaque MLS bytes; it never decrypts them.
import type { Express, Request, Response } from 'express';
import type { AuthedRequest, Ctx } from '../ctx.js';

const MAX_KEYPACKAGES_PER_REQUEST = 50;
const MAX_KEYPACKAGE_CHARS = 4096;
const MAX_WELCOMES_PER_COMMIT = 100;
const MAX_COMMIT_CHARS = 32_000;
const MAX_COMMITS_PER_FETCH = 200;
/** Tell a device to refill its KeyPackage pool when fewer single-use packages than this remain. */
const KEYPACKAGE_LOW_WATER = 5;

const bad = (res: Response, error: string) => res.status(400).json({ error });
const isB64 = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s);
const isEpoch = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;

  const ownsDevice = db.prepare('SELECT 1 FROM devices WHERE device_id=? AND user_id=?');
  const sharesServer = db.prepare(
    'SELECT 1 FROM members a JOIN members b ON b.server_id=a.server_id WHERE a.user_id=? AND b.user_id=? LIMIT 1');
  const devicesOf = db.prepare('SELECT device_id FROM devices WHERE user_id=?');
  const serverDeviceIds = db.prepare(
    'SELECT d.device_id AS id FROM members m JOIN devices d ON d.user_id=m.user_id WHERE m.server_id=?');
  const availableCount = db.prepare(
    'SELECT COUNT(*) AS n FROM mls_keypackages WHERE device_id=? AND last_resort=0 AND consumed_at IS NULL');
  const insertKeyPackage = db.prepare(
    'INSERT INTO mls_keypackages (device_id, kp, last_resort) VALUES (?,?,?)');
  const pickSingleUse = db.prepare(
    'SELECT id, kp FROM mls_keypackages WHERE device_id=? AND last_resort=0 AND consumed_at IS NULL ORDER BY id LIMIT 1');
  const markConsumed = db.prepare('UPDATE mls_keypackages SET consumed_at=? WHERE id=?');
  const pickLastResort = db.prepare(
    'SELECT kp FROM mls_keypackages WHERE device_id=? AND last_resort=1 ORDER BY id DESC LIMIT 1');

  const groupEpoch = db.prepare('SELECT epoch FROM mls_groups WHERE group_id=?');
  const upsertGroupEpoch = db.prepare(
    'INSERT INTO mls_groups (group_id, epoch) VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET epoch=excluded.epoch');
  const insertCommit = db.prepare(
    'INSERT INTO mls_commits (group_id, epoch, sender_device_id, commit_bytes) VALUES (?,?,?,?)');
  const insertWelcome = db.prepare(
    'INSERT INTO mls_welcomes (group_id, epoch, to_device_id, welcome) VALUES (?,?,?,?)');
  const clearGroupDevices = db.prepare('DELETE FROM mls_group_devices WHERE group_id=?');
  const insertGroupDevice = db.prepare('INSERT INTO mls_group_devices (group_id, device_id) VALUES (?,?)');
  const commitsFrom = db.prepare(
    'SELECT epoch, sender_device_id, commit_bytes FROM mls_commits WHERE group_id=? AND epoch>=? ORDER BY epoch LIMIT ?');
  const welcomesFor = db.prepare(
    'SELECT epoch, to_device_id, welcome FROM mls_welcomes WHERE group_id=? AND to_device_id IN (SELECT device_id FROM devices WHERE user_id=?) ORDER BY epoch');
  const groupDevices = db.prepare('SELECT device_id FROM mls_group_devices WHERE group_id=?');

  const devicesOwner = (deviceId: string): string =>
    (db.prepare('SELECT user_id FROM devices WHERE device_id=?').get(deviceId) as { user_id: string }).user_id;

  /** Text channel the caller is a member of, else sends 404 and returns null. */
  const memberChannel = (channelId: string, userId: string, res: Response) => {
    const ch = ctx.getChannel(channelId);
    if (!ch || ch.kind !== 'text' || !ctx.roleIn(ch.serverId, userId)) {
      res.status(404).json({ error: 'channel not found' });
      return null;
    }
    return ch;
  };

  const requireOwnDevice = (userId: string, deviceId: unknown, res: Response): deviceId is string => {
    if (typeof deviceId !== 'string' || !ownsDevice.get(deviceId, userId)) {
      res.status(403).json({ error: 'not your device' });
      return false;
    }
    return true;
  };

  // Upload single-use KeyPackages (and at most one batch of last-resort packages) for one of our devices.
  app.post('/api/devices/keypackages', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const { deviceId, keyPackages } = (req.body ?? {}) as { deviceId?: unknown; keyPackages?: unknown };
    if (!requireOwnDevice(userId, deviceId, res)) return;
    if (!Array.isArray(keyPackages) || keyPackages.length === 0 || keyPackages.length > MAX_KEYPACKAGES_PER_REQUEST) {
      return void bad(res, `keyPackages must be 1..${MAX_KEYPACKAGES_PER_REQUEST} items`);
    }
    const items = keyPackages as { kp?: unknown; lastResort?: unknown }[];
    if (!items.every((k) => isB64(k?.kp, MAX_KEYPACKAGE_CHARS))) return void bad(res, 'invalid kp');
    db.transaction(() => {
      for (const k of items) insertKeyPackage.run(deviceId, k.kp, k.lastResort === true ? 1 : 0);
    })();
    res.json({ added: items.length, available: (availableCount.get(deviceId) as { n: number }).n });
  });

  // How many single-use KeyPackages a device still has.
  app.get('/api/devices/:deviceId/keypackages/count', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const deviceId = req.params.deviceId;
    if (!requireOwnDevice(userId, deviceId, res)) return;
    res.json({ available: (availableCount.get(deviceId) as { n: number }).n });
  });

  // Claim one KeyPackage per device of a user who shares a server with us. Single-use packages are consumed;
  // a device with an empty pool falls back to its last-resort package, which is not consumed.
  app.get('/api/users/:id/keypackages', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const targetId = req.params.id;
    if (!sharesServer.get(userId, targetId)) return void res.status(404).json({ error: 'user not found' });
    const claimed = db.transaction(() => {
      const out: { deviceId: string; kp: string }[] = [];
      for (const { device_id: deviceId } of devicesOf.all(targetId) as { device_id: string }[]) {
        const single = pickSingleUse.get(deviceId) as { id: number; kp: string } | undefined;
        if (single) {
          markConsumed.run(Date.now(), single.id);
          out.push({ deviceId, kp: single.kp });
          continue;
        }
        const last = pickLastResort.get(deviceId) as { kp: string } | undefined;
        if (last) out.push({ deviceId, kp: last.kp });
      }
      return out;
    })();
    for (const { deviceId } of claimed) {
      const remaining = (availableCount.get(deviceId) as { n: number }).n;
      if (remaining < KEYPACKAGE_LOW_WATER) {
        ctx.sendToUser(targetId, { t: 'keypackages.low', deviceId, remaining });
      }
    }
    res.json({ keyPackages: claimed });
  });

  // Submit a Commit. It is accepted only if `epoch` is the group's current epoch, which makes it atomic and
  // gives one winner when two members commit at once. The loser gets 409 and the current epoch, then fetches
  // the winning commit and retries.
  app.post('/api/groups/:id/commits', ctx.requireAuth, (req: Request, res: Response) => {
    const userId = (req as AuthedRequest).userId;
    const ch = memberChannel(req.params.id, userId, res);
    if (!ch) return;
    const body = (req.body ?? {}) as {
      deviceId?: unknown; epoch?: unknown; commit?: unknown; members?: unknown; welcomes?: unknown;
    };
    if (!requireOwnDevice(userId, body.deviceId, res)) return;
    if (!isEpoch(body.epoch)) return void bad(res, 'invalid epoch');
    if (!isB64(body.commit, MAX_COMMIT_CHARS)) return void bad(res, 'invalid commit');
    if (!Array.isArray(body.members) || !body.members.every((m) => typeof m === 'string')) {
      return void bad(res, 'members must be a list of deviceIds');
    }
    if (!Array.isArray(body.welcomes) || body.welcomes.length > MAX_WELCOMES_PER_COMMIT) {
      return void bad(res, 'invalid welcomes');
    }
    const welcomes = body.welcomes as { toDeviceId?: unknown; welcome?: unknown }[];
    if (!welcomes.every((w) => typeof w.toDeviceId === 'string' && isB64(w.welcome, MAX_COMMIT_CHARS))) {
      return void bad(res, 'invalid welcome');
    }

    const serverDevices = new Set((serverDeviceIds.all(ch.serverId) as { id: string }[]).map((d) => d.id));
    const members = body.members as string[];
    if (!members.every((d) => serverDevices.has(d))) return void bad(res, 'members must be devices of this server');
    if (!welcomes.every((w) => serverDevices.has(w.toDeviceId as string))) {
      return void bad(res, 'welcome target is not a device of this server');
    }

    const epoch = body.epoch;
    const result = db.transaction(() => {
      const current = (groupEpoch.get(ch.id) as { epoch: number } | undefined)?.epoch ?? 0;
      if (current !== epoch) return { ok: false as const, currentEpoch: current };
      insertCommit.run(ch.id, epoch, body.deviceId as string, body.commit as string);
      upsertGroupEpoch.run(ch.id, epoch + 1);
      clearGroupDevices.run(ch.id);
      for (const d of members) insertGroupDevice.run(ch.id, d);
      for (const w of welcomes) insertWelcome.run(ch.id, epoch + 1, w.toDeviceId, w.welcome);
      return { ok: true as const };
    })();

    if (!result.ok) return void res.status(409).json({ error: 'epoch mismatch', currentEpoch: result.currentEpoch });
    ctx.broadcastToServer(ch.serverId, { t: 'group.commit', channelId: ch.id, epoch: epoch + 1 });
    for (const w of welcomes) ctx.sendToUser(devicesOwner(w.toDeviceId as string), { t: 'group.welcome', channelId: ch.id, epoch: epoch + 1 });
    res.json({ epoch: epoch + 1 });
  });

  // Commits from `from` onward, in epoch order, so a device can catch up or retry after a 409.
  app.get('/api/groups/:id/commits', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = memberChannel(req.params.id, userId, res);
    if (!ch) return;
    const from = Number(req.query.from ?? 0);
    if (!isEpoch(from)) return void bad(res, 'invalid from');
    const current = (groupEpoch.get(ch.id) as { epoch: number } | undefined)?.epoch ?? 0;
    const rows = commitsFrom.all(ch.id, from, MAX_COMMITS_PER_FETCH) as { epoch: number; sender_device_id: string; commit_bytes: string }[];
    res.json({
      epoch: current,
      commits: rows.map((r) => ({ epoch: r.epoch, senderDeviceId: r.sender_device_id, commit: r.commit_bytes })),
    });
  });

  // Welcomes addressed to the caller's own devices. Only the target device can fetch its Welcome.
  app.get('/api/groups/:id/welcomes', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = memberChannel(req.params.id, userId, res);
    if (!ch) return;
    const rows = welcomesFor.all(ch.id, userId) as { epoch: number; to_device_id: string; welcome: string }[];
    res.json({ welcomes: rows.map((r) => ({ epoch: r.epoch, toDeviceId: r.to_device_id, welcome: r.welcome })) });
  });

  // Groups whose last Commit still lists devices that are no longer in the server. An admin or any remaining
  // device commits a Remove for them, so a kick still completes if the admin was offline.
  app.get('/api/servers/:id/pending-removals', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    if (!ctx.roleIn(req.params.id, userId)) return void res.status(404).json({ error: 'server not found' });
    const live = new Set((serverDeviceIds.all(req.params.id) as { id: string }[]).map((d) => d.id));
    const channels = db.prepare("SELECT id FROM channels WHERE server_id=? AND kind='text'").all(req.params.id) as { id: string }[];
    const pending = channels.flatMap(({ id }) => {
      const epoch = (groupEpoch.get(id) as { epoch: number } | undefined)?.epoch ?? 0;
      const removed = (groupDevices.all(id) as { device_id: string }[]).map((r) => r.device_id).filter((d) => !live.has(d));
      return removed.length > 0 ? [{ channelId: id, epoch, removedDeviceIds: removed }] : [];
    });
    res.json({ pending });
  });
}
