import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { Channel, DeviceKeys, Member, ServerFrame, User } from '@chatward/shared';
import { config } from './config.js';
import type { DB } from './db.js';

export interface AuthedRequest extends Request {
  userId: string;
}

export interface Ctx {
  db: DB;
  config: typeof config;
  /** Express middleware: 401s unless a valid Bearer token; sets req.userId */
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  signToken: (userId: string) => string;
  verifyToken: (token: string) => string | null;
  broadcastToServer: (serverId: string, frame: ServerFrame) => void;
  sendToUser: (userId: string, frame: ServerFrame) => void;
  /** callbacks fired when a user's last socket closes (e.g. voice cleanup) */
  onDisconnect: ((userId: string) => void)[];
  /** callbacks fired when a user opens a socket, including a reconnect */
  onConnect: ((userId: string) => void)[];
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
  const signToken = (userId: string) =>
    jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '30d' });
  const verifyToken = (token: string): string | null => {
    try {
      const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      const id = typeof p.sub === 'string' ? p.sub : null;
      if (!id) return null;
      return db.prepare('SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL').get(id) ? id : null;
    } catch {
      return null;
    }
  };
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization ?? '';
    const id = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
    if (!id) { res.status(401).json({ error: 'unauthorized' }); return; }
    (req as AuthedRequest).userId = id;
    next();
  };
  return { signToken, verifyToken, requireAuth };
}
