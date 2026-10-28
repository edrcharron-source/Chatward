import rateLimit from 'express-rate-limit';
import type { AuthedRequest } from './ctx.js';

// A per-member limit for routes any signed-in member could spam. Mount it after requireAuth, so every request
// already has a user id to count against. Each member gets their own count, not a share of their IP's.
export const perMember = (windowMs: number, limit: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => (req as AuthedRequest).userId,
  });
