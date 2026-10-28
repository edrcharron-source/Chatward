// MLS delivery: KeyPackage pool, epoch-ordered Commits, per-device Welcomes.
// The group id is the text channel id. The server stores and orders opaque MLS bytes; it never decrypts them.
import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { perMember } from '../userLimit.js';

const MAX_KEYPACKAGES_PER_REQUEST = 50;
const MAX_KEYPACKAGE_CHARS = 4096;
const MAX_WELCOMES_PER_COMMIT = 100;
const MAX_COMMIT_CHARS = 32_000;
const MAX_COMMITS_PER_FETCH = 200;
/** Tell a device to refill its KeyPackage pool when fewer single-use packages than this remain. */
const KEYPACKAGE_LOW_WATER = 5;
// A device gets at most one keypackages.low frame a minute, so repeated claims cannot make its app resync in a loop.
const LOW_NOTICE_GAP_MS = 60_000;
const lowNoticeSentAt = new Map<string, number>();
// An entry older than the gap no longer blocks a notice, so it is dropped. Otherwise a device that stops claiming keeps its entry.
setInterval(() => {
  const cutoff = Date.now() - LOW_NOTICE_GAP_MS;
  for (const [deviceId, sentAt] of lowNoticeSentAt) if (sentAt < cutoff) lowNoticeSentAt.delete(deviceId);
}, 10 * 60_000).unref();
/** Identifies a stored KeyPackage without sending it back: SHA-256 of its wire string, base64. Clients compute the same. */
const keyPackageId = (kp: string): string => crypto.createHash('sha256').update(kp).digest('base64');

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
  const deleteUnclaimedKeyPackages = db.prepare('DELETE FROM mls_keypackages WHERE device_id=? AND consumed_at IS NULL');
  const pickSingleUse = db.prepare(
    'SELECT id, kp FROM mls_keypackages WHERE device_id=? AND last_resort=0 AND consumed_at IS NULL ORDER BY id LIMIT 1');
  const markConsumed = db.prepare('UPDATE mls_keypackages SET consumed_at=? WHERE id=?');
  const pickLastResort = db.prepare(
    'SELECT kp FROM mls_keypackages WHERE device_id=? AND last_resort=1 ORDER BY id DESC LIMIT 1');
  const anyKeyPackage = db.prepare('SELECT 1 FROM mls_keypackages WHERE device_id=? LIMIT 1');
  const serversOfUser = db.prepare('SELECT server_id FROM members WHERE user_id=?');

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
  const dropCommitsFrom = db.prepare('DELETE FROM mls_commits WHERE group_id=? AND epoch>=?');
  const dropWelcomesAfter = db.prepare('DELETE FROM mls_welcomes WHERE group_id=? AND epoch>?');
  // A Commit at epoch e comes with Welcomes at e+1, so these are the Welcomes a reset from `epoch` would drop.
  const welcomeForDeviceAfter = db.prepare(
    'SELECT 1 FROM mls_welcomes WHERE group_id=? AND epoch>? AND to_device_id=? LIMIT 1');
  // Copies the device's keys into the seen list. A device that is later deleted leaves no devices row, but its
  // Commits must still verify for peers who catch up, so the seen list keeps its own copy.
  const insertSeenDevice = db.prepare(
    'INSERT OR IGNORE INTO mls_group_seen_devices (group_id, device_id, user_id, ecdh_public, sign_public) '
    + 'SELECT ?, device_id, user_id, ecdh_public, sign_public FROM devices WHERE device_id=?');
  const seenDevices = db.prepare(
    'SELECT device_id AS deviceId, user_id AS userId, ecdh_public AS ecdhPublic, sign_public AS signPublic '
    + 'FROM mls_group_seen_devices WHERE group_id=? AND sign_public IS NOT NULL');
  const recordAck = db.prepare(
    'INSERT INTO mls_group_acks (group_id, device_id, epoch) VALUES (?,?,?) '
    + 'ON CONFLICT(group_id, device_id) DO UPDATE SET epoch=MAX(epoch, excluded.epoch)');
  // The user who sent the Commit at an epoch, if there is one. A Commit moves its own sender forward, so that user's
  // acks and later Commits prove nothing about the others.
  const commitSenderUser = db.prepare(
    'SELECT s.user_id AS userId FROM mls_commits c JOIN mls_group_seen_devices s '
    + 'ON s.group_id=c.group_id AND s.device_id=c.sender_device_id WHERE c.group_id=? AND c.epoch=?');
  // Someone else built on the Commit at `epoch`: a device of another user acked a later epoch, or another user sent a
  // later Commit. Either one is only possible if that Commit applied, so it must not be dropped.
  const someoneAheadOf = db.prepare(
    'SELECT 1 FROM mls_group_acks a JOIN mls_group_devices g ON g.group_id=a.group_id AND g.device_id=a.device_id '
    + 'JOIN mls_group_seen_devices s ON s.group_id=a.group_id AND s.device_id=a.device_id '
    + 'WHERE a.group_id=? AND a.epoch>? AND s.user_id IS NOT ? '
    + 'UNION ALL SELECT 1 FROM mls_commits c JOIN mls_group_seen_devices s '
    + 'ON s.group_id=c.group_id AND s.device_id=c.sender_device_id '
    + 'WHERE c.group_id=? AND c.epoch>? AND s.user_id IS NOT ? LIMIT 1');

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
  const uploadKeyPackages = (replace: boolean) => (req: Request, res: Response) => {
    const userId = (req as AuthedRequest).userId;
    const { deviceId, keyPackages } = (req.body ?? {}) as { deviceId?: unknown; keyPackages?: unknown };
    if (!requireOwnDevice(userId, deviceId, res)) return;
    if (!Array.isArray(keyPackages) || keyPackages.length === 0 || keyPackages.length > MAX_KEYPACKAGES_PER_REQUEST) {
      return void bad(res, `keyPackages must be 1..${MAX_KEYPACKAGES_PER_REQUEST} items`);
    }
    const items = keyPackages as { kp?: unknown; lastResort?: unknown }[];
    if (!items.every((k) => isB64(k?.kp, MAX_KEYPACKAGE_CHARS))) return void bad(res, 'invalid kp');
    // A device that has never had KeyPackages can't be added to any group yet. Peers synced when it joined
    // and found nothing to claim, so tell them now. Their sync then claims these packages and adds the device.
    const firstUpload = !anyKeyPackage.get(deviceId);
    db.transaction(() => {
      // A replace drops the packages nobody has claimed yet (for example ones a client found it cannot use), then adds the new ones.
      if (replace) deleteUnclaimedKeyPackages.run(deviceId);
      for (const k of items) insertKeyPackage.run(deviceId, k.kp, k.lastResort === true ? 1 : 0);
    })();
    if (firstUpload) {
      const devices = ctx.getDevices(userId);
      for (const { server_id } of serversOfUser.all(userId) as { server_id: string }[]) {
        ctx.broadcastToServer(server_id, { t: 'member.devices', serverId: server_id, userId, devices });
      }
    }
    res.json({ added: items.length, available: (availableCount.get(deviceId) as { n: number }).n });
  };
  app.post('/api/devices/keypackages', ctx.requireAuth, uploadKeyPackages(false));
  // Same as the upload, but first removes this device's unclaimed packages. Used when the client finds its pool unusable.
  app.post('/api/devices/keypackages/replace', ctx.requireAuth, uploadKeyPackages(true));

  // How many single-use KeyPackages a device still has, and which last-resort package the server would hand out
  // (its id, or null if it has none). A client compares the id with its own copy to see whether the two agree.
  app.get('/api/devices/:deviceId/keypackages/count', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const deviceId = req.params.deviceId;
    if (!requireOwnDevice(userId, deviceId, res)) return;
    const lastResort = pickLastResort.get(deviceId) as { kp: string } | undefined;
    res.json({
      available: (availableCount.get(deviceId) as { n: number }).n,
      lastResort: lastResort ? keyPackageId(lastResort.kp) : null,
    });
  });

  // Claim one KeyPackage per device of a user who shares a server with us. Single-use packages are consumed;
  // a device with an empty pool falls back to its last-resort package, which is not consumed.
  app.get('/api/users/:id/keypackages', ctx.requireAuth, perMember(60_000, 20), (req, res) => {
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
      const now = Date.now();
      if (remaining < KEYPACKAGE_LOW_WATER && now - (lowNoticeSentAt.get(deviceId) ?? 0) >= LOW_NOTICE_GAP_MS) {
        lowNoticeSentAt.set(deviceId, now);
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
      for (const d of [...members, body.deviceId as string, ...welcomes.map((w) => w.toDeviceId as string)]) insertSeenDevice.run(ch.id, d);
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
      // A full chunk means there may be more Commits after it: the client asks again from the last epoch it applied.
      more: rows.length === MAX_COMMITS_PER_FETCH,
    });
  });

  // Drop a Commit that a member cannot apply, and every Commit after it, so the group can move on from `epoch`.
  // The server cannot check MLS signatures, so a bad Commit is only found by the devices that try to apply it.
  // The caller must be a member of the channel and name one of its own devices, and it keeps its own state.
  app.post('/api/groups/:id/reset', ctx.requireAuth, (req: Request, res: Response) => {
    const userId = (req as AuthedRequest).userId;
    const ch = memberChannel(req.params.id, userId, res);
    if (!ch) return;
    const body = (req.body ?? {}) as { deviceId?: unknown; epoch?: unknown };
    if (!requireOwnDevice(userId, body.deviceId, res)) return;
    if (!isEpoch(body.epoch)) return void bad(res, 'invalid epoch');
    const epoch = body.epoch;
    const deviceId = body.deviceId as string;
    const result = db.transaction(() => {
      const current = (groupEpoch.get(ch.id) as { epoch: number } | undefined)?.epoch ?? 0;
      if (epoch > current) return { ok: false as const, currentEpoch: current };
      if (epoch < current) {
        // A Commit that added this device is not junk: the device must join from its Welcome, not drop the Commit.
        if (welcomeForDeviceAfter.get(ch.id, epoch, deviceId)) return { ok: false as const, addedCaller: true as const, currentEpoch: current };
        // Commits that some device already applied are not junk: dropping them would fork that device off the group.
        const senderUser = (commitSenderUser.get(ch.id, epoch) as { userId: string | null } | undefined)?.userId ?? null;
        if (someoneAheadOf.get(ch.id, epoch, senderUser, ch.id, epoch, senderUser)) return { ok: false as const, appliedBy: true as const, currentEpoch: current };
        dropCommitsFrom.run(ch.id, epoch);
        dropWelcomesAfter.run(ch.id, epoch);
        upsertGroupEpoch.run(ch.id, epoch);
      }
      return { ok: true as const };
    })();
    if (!result.ok && 'addedCaller' in result) {
      return void res.status(409).json({ error: 'a commit added this device; join from its welcome', currentEpoch: result.currentEpoch });
    }
    if (!result.ok && 'appliedBy' in result) {
      return void res.status(409).json({ error: 'a member already applied a later commit', currentEpoch: result.currentEpoch });
    }
    if (!result.ok) return void res.status(409).json({ error: 'epoch is ahead of the group', currentEpoch: result.currentEpoch });
    res.json({ epoch });
  });

  // Every device that has ever been in this group, with its registered keys. Clients check Commits against this list,
  // so a Commit from someone who has since left still verifies. Public keys only.
  app.get('/api/groups/:id/devices', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = memberChannel(req.params.id, userId, res);
    if (!ch) return;
    res.json({ devices: seenDevices.all(ch.id) });
  });

  // A device reports the epoch it has reached. Only its own devices, and never past the group's current epoch.
  app.post('/api/groups/:id/epoch', ctx.requireAuth, (req: Request, res: Response) => {
    const userId = (req as AuthedRequest).userId;
    const ch = memberChannel(req.params.id, userId, res);
    if (!ch) return;
    const body = (req.body ?? {}) as { deviceId?: unknown; epoch?: unknown };
    if (!requireOwnDevice(userId, body.deviceId, res)) return;
    if (!isEpoch(body.epoch)) return void bad(res, 'invalid epoch');
    const current = (groupEpoch.get(ch.id) as { epoch: number } | undefined)?.epoch ?? 0;
    if (body.epoch > current) return void res.status(409).json({ error: 'epoch is ahead of the group', currentEpoch: current });
    recordAck.run(ch.id, body.deviceId as string, body.epoch);
    res.json({ epoch: body.epoch });
  });

  // Welcomes addressed to the caller's own devices. Only the target device can fetch its Welcome.
  app.get('/api/groups/:id/welcomes', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = memberChannel(req.params.id, userId, res);
    if (!ch) return;
    const rows = welcomesFor.all(ch.id, userId) as { epoch: number; to_device_id: string; welcome: string }[];
    res.json({ welcomes: rows.map((r) => ({ epoch: r.epoch, toDeviceId: r.to_device_id, welcome: r.welcome })) });
  });

}
