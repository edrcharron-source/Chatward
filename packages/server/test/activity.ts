// Checks what the server keeps from a client's "listening to" activity before relaying it to every member.
// Run with: npm run test:e2e -w @chatward/server
import assert from 'node:assert/strict';
import { cleanActivity } from '../src/ws.js';

const log = (msg: string) => console.log(`  ok  ${msg}`);
try {
  assert.equal(cleanActivity(null), null, 'null clears');
  for (const bad of [undefined, 'x', 5, {}, { kind: 'game', title: 'a', artist: 'b' }, { kind: 'spotify', title: 1, artist: 'b' }, { kind: 'spotify', title: '  ', artist: 'b' }]) {
    assert.equal(cleanActivity(bad), undefined, `drops ${JSON.stringify(bad)}`);
  }
  log('malformed activity is dropped, null clears');

  assert.deepEqual(
    cleanActivity({ kind: 'spotify', title: ' Song ', artist: 'Band', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', extra: 'x' }),
    { kind: 'spotify', title: 'Song', artist: 'Band', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' },
  );
  log('a good activity keeps only its known fields');

  for (const url of ['https://evil.example/track/1', 'http://open.spotify.com/track/abc', 'https://open.spotify.com/track/abc?x=1', 'javascript:alert(1)']) {
    assert.equal(cleanActivity({ kind: 'spotify', title: 'a', artist: 'b', url })?.url, undefined, `refuses ${url}`);
  }
  log('only https track links on open.spotify.com are kept');

  assert.equal(cleanActivity({ kind: 'spotify', title: 'x'.repeat(500), artist: 'y'.repeat(500) })?.title.length, 200);
  log('long text is cut to 200 characters');
  console.log('\nActivity: all checks passed');
} catch (err) {
  console.error('\nActivity FAILED:', err);
  process.exitCode = 1;
}
