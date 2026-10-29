// Checks the Jellyfin proxy against a fake Jellyfin: the key stays server-side, tickets only unlock their own item.
// Run with: npm run test:e2e -w @chatward/server
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const ID = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `jf-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

const seen: { url: string; token?: string }[] = [];
const fake = http.createServer((req, res) => {
  seen.push({ url: req.url!, token: req.headers['x-emby-token'] as string | undefined });
  if (req.headers['x-emby-token'] !== 'KEY') { res.writeHead(401).end(); return; }
  if (req.url!.startsWith('/Users/u1/Views')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Items: [{ Id: ID, Name: 'Movies', Type: 'CollectionFolder' }], TotalRecordCount: 1 })); return;
  }
  if (req.url!.startsWith(`/Users/u1/Items/${ID}`)) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Id: ID, Name: 'Test Film', Type: 'Movie', ProductionYear: 2001, RunTimeTicks: 6_000_000_000 })); return;
  }
  if (req.url!.startsWith(`/Videos/${ID}/master.m3u8`)) {
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.end('#EXTM3U\nmain.m3u8?x=1\n/Videos/' + ID + '/hls1/0.ts\n'); return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
process.env.DATA_DIR = dataDir;
process.env.JELLYFIN_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/`;
process.env.JELLYFIN_API_KEY = 'KEY';
process.env.JELLYFIN_USER_ID = 'u1';
const { register } = await import('../src/modules/jellyfin.js');

const app = express();
const ctx = {
  config: (await import('../src/config.js')).config,
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization !== 'Bearer ok') { res.status(401).json({ error: 'no' }); return; }
    (req as unknown as { userId: string }).userId = 'me'; next();
  },
};
register(app, ctx as never);
const srv = app.listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const get = (p: string, auth = true) => fetch(base + p, { headers: auth ? { Authorization: 'Bearer ok' } : {} });
const log = (m: string) => console.log(`  ok  ${m}`);

try {
  assert.equal((await get('/api/jellyfin/items', false)).status, 401);
  assert.deepEqual(await (await get('/api/jellyfin/status')).json(), { enabled: true });
  const list = await (await get('/api/jellyfin/items')).json() as { items: { id: string; playable: boolean }[] };
  assert.equal(list.items[0].id, ID);
  assert.equal(list.items[0].playable, false);
  log('library views need a sign-in and list through the API key');

  assert.equal((await get('/api/jellyfin/items/not-an-id/poster')).status, 400);
  const play = await (await fetch(`${base}/api/jellyfin/items/${ID}/play`, { method: 'POST', headers: { Authorization: 'Bearer ok' } })).json() as
    { url: string; title: string; durationSeconds: number };
  assert.equal(play.title, 'Test Film');
  assert.equal(play.durationSeconds, 600);
  assert.ok(!play.url.includes('KEY'), 'the key is never in the playback URL');
  log('play hands back a ticketed playlist path');

  const pl = await get(play.url, false);
  assert.equal(pl.status, 200);
  const text = await pl.text();
  assert.ok(text.includes('main.m3u8?x=1'));
  assert.ok(text.includes('/api/jellyfin/hls/') && !text.includes(`\n/Videos/${ID}`), 'absolute segment lines go back through the ticket');
  assert.ok(!text.includes('KEY'));
  const ticketPath = play.url.split('/Videos/')[0];
  assert.equal((await get(`${ticketPath}/Videos/${OTHER}/master.m3u8`, false)).status, 403, 'a ticket only unlocks its own item');
  assert.equal((await get(`${ticketPath}/Users/u1/Items`, false)).status, 403, 'a ticket cannot reach the library API');
  assert.equal((await get('/api/jellyfin/hls/bogus/Videos/' + ID + '/master.m3u8', false)).status, 401);
  const upstreamQuery = seen.filter((s) => s.url.startsWith(`/Videos/${ID}/master`)).at(-1)!;
  assert.equal(upstreamQuery.token, 'KEY');
  log('tickets are scoped to one item; unknown tickets are refused');
  console.log('jellyfin: all checks passed');
} finally {
  srv.close(); fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
