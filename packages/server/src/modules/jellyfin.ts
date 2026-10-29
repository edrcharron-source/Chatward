import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { Express, Response } from 'express';
import type { JellyfinItem, JellyfinPlayback } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { perMember } from '../userLimit.js';

// Chatward proxies Jellyfin so it never faces the internet: the API key stays on this server, library calls need a
// signed-in member, and video is served under short-lived tickets that only unlock one item's /Videos/{id}/ files.

const TICKET_TTL_MS = 12 * 60 * 60_000;
const MAX_TICKETS_PER_USER = 8;
const UPSTREAM_TIMEOUT_MS = 15_000;
const ID_RE = /^[0-9a-f]{32}$/i;
// Jellyfin may return plain or dashed GUIDs; normalise to the dashless form it accepts everywhere.
const normId = (id: string) => id.replace(/-/g, '');
const SEGMENT_PATH_RE = /^[A-Za-z0-9_.\-/]+$/;
const SECRET_PARAMS = ['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token'];

interface Ticket { userId: string; itemId: string; expires: number }
const tickets = new Map<string, Ticket>();

function pruneTickets(): void {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expires <= now) tickets.delete(k);
}

type RawItem = {
  Id: string; Name?: string; Type?: string; ProductionYear?: number; RunTimeTicks?: number; Overview?: string;
  ImageTags?: { Primary?: string }; IsFolder?: boolean;
};

const toItem = (r: RawItem): JellyfinItem => ({
  id: normId(r.Id),
  name: r.Name ?? '(untitled)',
  kind: r.Type ?? 'Folder',
  year: r.ProductionYear ?? null,
  runtimeSeconds: r.RunTimeTicks ? Math.round(r.RunTimeTicks / 10_000_000) : null,
  overview: (r.Overview ?? '').slice(0, 600),
  posterUrl: r.ImageTags?.Primary ? `/api/jellyfin/items/${normId(r.Id)}/poster` : null,
  playable: r.Type === 'Movie' || r.Type === 'Episode' || r.Type === 'Video',
});

export function register(app: Express, ctx: Ctx): void {
  const { url: base, apiKey, userId: jfUser } = ctx.config.jellyfin;
  const enabled = Boolean(base && apiKey && jfUser);

  app.get('/api/jellyfin/status', ctx.requireAuth, (_req, res) => res.json({ enabled }));
  if (!enabled) return;

  const upstream = (path: string, params: Record<string, string | number | undefined> = {}, init: { range?: string; signal?: AbortSignal } = {}) => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    // Jellyfin 12 only accepts the key in this Authorization header; older versions also read X-Emby-Token, so send both.
    const headers: Record<string, string> = { Authorization: `MediaBrowser Token="${apiKey}"`, 'X-Emby-Token': apiKey };
    if (init.range) headers.Range = init.range;
    return fetch(u, { headers, signal: init.signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  };
  const fail = (res: Response, e: unknown) => {
    console.error('Jellyfin request failed:', e instanceof Error ? e.message : e);
    if (!res.headersSent) res.status(502).json({ error: 'Jellyfin is not answering' });
  };

  // Library views (Movies, Shows, ...) when parentId is absent, otherwise the children of parentId. `q` searches everything.
  app.get('/api/jellyfin/items', ctx.requireAuth, perMember(60_000, 120), async (req, res) => {
    const parentId = typeof req.query.parentId === 'string' ? normId(req.query.parentId) : '';
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const start = Math.max(0, Math.floor(Number(req.query.start) || 0));
    if (parentId && !ID_RE.test(parentId)) { res.status(400).json({ error: 'invalid parentId' }); return; }
    try {
      const r = q || parentId
        ? await upstream(`/Users/${jfUser}/Items`, {
            ParentId: parentId, SearchTerm: q, Recursive: q ? 'true' : undefined,
            IncludeItemTypes: q ? 'Movie,Series,Episode' : undefined,
            SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: start, Limit: 60,
            Fields: 'Overview,ProductionYear,RunTimeTicks',
          })
        : await upstream(`/Users/${jfUser}/Views`);
      if (!r.ok) { res.status(502).json({ error: 'Jellyfin refused the request' }); return; }
      const body = await r.json() as { Items?: RawItem[]; TotalRecordCount?: number };
      res.json({ items: (body.Items ?? []).map(toItem), total: body.TotalRecordCount ?? 0 });
    } catch (e) { fail(res, e); }
  });

  // Posters are fetched with the Authorization header, same as avatars, then shown as object URLs.
  app.get('/api/jellyfin/items/:id/poster', ctx.requireAuth, perMember(60_000, 600), async (req, res) => {
    const id = normId(req.params.id);
    if (!ID_RE.test(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const r = await upstream(`/Items/${id}/Images/Primary`, { maxWidth: 300, quality: 80 });
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !r.body || !/^image\/(jpeg|png|webp)$/.test(type)) { res.status(404).json({ error: 'no poster' }); return; }
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      Readable.fromWeb(r.body as never).pipe(res);
    } catch (e) { fail(res, e); }
  });

  // Starts playback: checks the item exists, then hands back an HLS playlist path with a ticket in it.
  app.post('/api/jellyfin/items/:id/play', ctx.requireAuth, perMember(60_000, 30), async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const id = normId(req.params.id);
    if (!ID_RE.test(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const r = await upstream(`/Users/${jfUser}/Items/${id}`);
      if (!r.ok) { res.status(404).json({ error: 'not found' }); return; }
      const item = toItem(await r.json() as RawItem);
      if (!item.playable) { res.status(400).json({ error: 'not something that plays' }); return; }
      pruneTickets();
      const mine = [...tickets.entries()].filter(([, t]) => t.userId === userId);
      if (mine.length >= MAX_TICKETS_PER_USER) tickets.delete(mine[0][0]);
      const ticket = crypto.randomBytes(24).toString('base64url');
      const expires = Date.now() + TICKET_TTL_MS;
      tickets.set(ticket, { userId, itemId: id, expires });
      const qs = new URLSearchParams({
        MediaSourceId: id, PlaySessionId: crypto.randomUUID().replace(/-/g, ''), DeviceId: 'chatward',
        VideoCodec: 'h264', AudioCodec: 'aac', TranscodingMaxAudioChannels: '2', SegmentContainer: 'ts',
        MaxStreamingBitrate: '12000000',
      });
      const out: JellyfinPlayback = {
        url: `/api/jellyfin/hls/${ticket}/Videos/${id}/master.m3u8?${qs}`,
        title: item.name, durationSeconds: item.runtimeSeconds, expiresAt: expires,
      };
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // The ticket is the credential (a <video> element cannot send headers), so it lives in the path and relative segment
  // URLs inside the playlist inherit it. It only reaches /Videos/{its item}/..., and the API key is added here.
  app.get('/api/jellyfin/hls/:ticket/*', async (req, res) => {
    const t = tickets.get(req.params.ticket);
    if (!t || t.expires <= Date.now()) { res.status(401).json({ error: 'ticket expired' }); return; }
    const rest = (req.params as Record<string, string>)[0];
    const m = /^Videos\/([0-9a-f]{32})\/(.+)$/i.exec(rest);
    if (!m || normId(m[1]) !== t.itemId || !SEGMENT_PATH_RE.test(m[2]) || m[2].split('/').includes('..')) {
      res.status(403).json({ error: 'not allowed' }); return;
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string' && !SECRET_PARAMS.includes(k.toLowerCase())) params[k] = v;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const r = await upstream(`/Videos/${m[1]}/${m[2]}`, params, {
        range: typeof req.headers.range === 'string' ? req.headers.range : undefined,
        signal: abort.signal,
      });
      if (!r.body) { res.status(r.status).end(); return; }
      res.status(r.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = r.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      if (/mpegurl/i.test(r.headers.get('content-type') ?? '') ) {
        // Absolute /Videos/ lines would skip the ticket, so point them back through it.
        const text = (await r.text()).replace(/^\/Videos\//gm, `/api/jellyfin/hls/${req.params.ticket}/Videos/`);
        res.removeHeader('content-length');
        res.send(text);
        return;
      }
      Readable.fromWeb(r.body as never).on('error', () => res.destroy()).pipe(res);
    } catch (e) { if (!abort.signal.aborted) fail(res, e); }
  });
}
