import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsp, serverOrigin } from './serverPolicy';

const connectSrc = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src'));

test('serverOrigin keeps scheme and host, drops the path', () => {
  assert.equal(serverOrigin('https://chat.example.com/some/path'), 'https://chat.example.com');
  assert.equal(serverOrigin('http://localhost:3000'), 'http://localhost:3000');
});

test('serverOrigin rejects non-http addresses', () => {
  assert.equal(serverOrigin('file:///etc/passwd'), null);
  assert.equal(serverOrigin('not a url'), null);
});

test('connect-src names only the app and the chosen server host', () => {
  assert.equal(connectSrc(buildCsp('https://chat.example.com')), "connect-src 'self' blob: https://chat.example.com:* wss://chat.example.com:*");
  assert.equal(connectSrc(buildCsp('http://localhost:3000')), "connect-src 'self' blob: http://localhost:* ws://localhost:*");
});

test('with no server, connect-src is the app only', () => {
  assert.equal(connectSrc(buildCsp(null)), "connect-src 'self' blob:");
});

test('img-src allows inline images and the GIF provider only, not any https host', () => {
  const imgSrc = buildCsp('https://chat.example.com').split('; ').find((d) => d.startsWith('img-src'));
  assert.equal(imgSrc, "img-src 'self' data: blob: https://klipy.com https://*.klipy.com");
});

test('other directives are unchanged', () => {
  const csp = buildCsp('https://chat.example.com');
  assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com/);
});
