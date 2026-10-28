import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { Channel, DeviceKeys, Member, ServerFrame, User } from '@chatward/shared';
import { config } from './config.js';
import type { DB } from './db.js';

export interface AuthedRequest extends Request {
  userId: string;
  /** The device the caller's token was issued to. Undefined for tokens from before per-device sessions. */
  deviceId?: string;
}

export interface Session {
  userId: string;
  /** Null for tokens from before per-device sessions. */
  deviceId: string | null;
}

export interface Ctx {
  db: DB;
  config: typeof config;
  /** Express middleware: 401s unless a valid Bearer token; sets req.userId and req.deviceId */
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  /** Token for a device that is already registered to the user. */
  signToken: (userId: string, deviceId: string) => string;
  verifySession: (token: string) => Session | null;
  broadcastToServer: (serverId: string, frame: ServerFrame) => void;
  sendToUser: (userId: string, frame: ServerFrame) => void;
  /**
   * Closes a user's open sockets so revoked sessions stop receiving frames. With a deviceId, only that device's sockets close.
   */
  revokeSockets: (userId: string, deviceId?: string) => void;
  /**
   * callbacks fired when a socket closes. `online` says whether the device and the account still have an open socket,
   * so voice cleanup can wait for the right one to go.
   */
  onDisconnect: ((userId: string, deviceId: string | null, online: { device: boolean; user: boolean }) => void)[];
  /** callbacks fired when a user opens a socket, including a reconnect */
  onConnect: ((userId: string, deviceId: string | null) => void)[];
  getUser: (userId: string) => User | null;
  getDevices: (userId: string) => DeviceKeys[];
  getMembers: (serverId: string) => Member[];
  getChannel: (channelId: string) => Channel | null;
  /** role of user in server, or null if not a member */
  roleIn: (serverId: string, userId: string) => 'owner' | 'admin' | 'member' | null;
  /** serverId for a channel the user belongs to, else null (use for authz) */
  serverIdForChannelMember: (channelId: string, userId: string) => string | null;
}

export function makeAuth(db: DB) {
  const sessionVersion = (userId: string): number | null =>
    (db.prepare('SELECT session_version FROM users WHERE id=?').get(userId) as { session_version: number } | undefined)
      ?.session_version ?? null;
  /** Creation time of a device row. Removing a device and registering it again makes a new row with a new time. */
  const deviceCreatedAt = (deviceId: string, userId: string): number | null =>
    (db.prepare('SELECT created_at FROM devices WHERE device_id=? AND user_id=?').get(deviceId, userId) as
      { created_at: number } | undefined)?.created_at ?? null;
  // Tokens name their device and the time that device row was created. Removing the device deletes the row,
  // so its token stops matching, and signing in again on that device creates a new row, which old tokens don't match.
  const signToken = (userId: string, deviceId: string) => {
    const createdAt = deviceCreatedAt(deviceId, userId);
    if (createdAt === null) throw new Error('signToken: device is not registered to this user');
    return jwt.sign({ sub: userId, v: sessionVersion(userId) ?? 0, d: deviceId, dc: createdAt }, config.jwtSecret, { expiresIn: '30d' });
  };
  const verifySession = (token: string): Session | null => {
    try {
      const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      const userId = typeof p.sub === 'string' ? p.sub : null;
      if (!userId) return null;
      if (!db.prepare('SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL').get(userId)) return null;
      // A password change or reset bumps the version, which signs out every token issued before it.
      // Tokens from before session versions existed carry no `v`, and their account is still at version 0.
      if (sessionVersion(userId) !== (p.v ?? 0)) return null;
      if (typeof p.d !== 'string') return { userId, deviceId: null };
      return deviceCreatedAt(p.d, userId) === p.dc ? { userId, deviceId: p.d } : null;
    } catch {
      return null;
    }
  };
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization ?? '';
    const session = h.startsWith('Bearer ') ? verifySession(h.slice(7)) : null;
    if (!session) { res.status(401).json({ error: 'unauthorized' }); return; }
    (req as AuthedRequest).userId = session.userId;
    if (session.deviceId) (req as AuthedRequest).deviceId = session.deviceId;
    next();
  };
  return { signToken, verifySession, requireAuth };
}
