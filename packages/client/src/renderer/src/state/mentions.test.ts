import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Member } from '@chatward/shared';
import { activeMention, mentionOptions, parseMentions, pings } from './mentions';

const member = (id: string, displayName: string): Member => ({
  user: { id, username: displayName.toLowerCase().replace(/\s/g, ''), displayName, avatarUrl: null, profile: {} as never },
  role: 'member',
  devices: [],
});
const members = [member('u1', 'Ed'), member('u2', 'Eddie'), member('u3', 'Candy Man')];

test('parses a single mention and does not match a longer name', () => {
  assert.deepEqual(parseMentions('hey @Ed look', members), { userIds: ['u1'] });
  assert.deepEqual(parseMentions('hey @Eddie', members), { userIds: ['u2'] });
});

test('matches names with spaces and ignores case', () => {
  assert.deepEqual(parseMentions('yo @candy man!', members), { userIds: ['u3'] });
});

test('@everyone pings everyone and is not a member name', () => {
  assert.deepEqual(parseMentions('@everyone dinner', members), { everyone: true, userIds: [] });
});

test('no @ means no mentions, and an email is not a mention', () => {
  assert.equal(parseMentions('just text', members), undefined);
  assert.equal(parseMentions('mail ed@Ed.com', members), undefined);
});

test('pings() honours @everyone and direct mentions', () => {
  assert.equal(pings({ everyone: true, userIds: [] }, 'u9'), true);
  assert.equal(pings({ userIds: ['u1'] }, 'u1'), true);
  assert.equal(pings({ userIds: ['u1'] }, 'u2'), false);
  assert.equal(pings(undefined, 'u1'), false);
});

test('activeMention finds the @ before the caret', () => {
  assert.deepEqual(activeMention('hi @Ca', 6), { at: 3, query: 'Ca' });
  assert.equal(activeMention('mail a@b', 8), null);
  assert.equal(activeMention('no at here', 5), null);
});

test('mentionOptions puts @everyone first and prefix matches before others', () => {
  const opts = mentionOptions('e', members);
  assert.equal(opts[0].everyone, true);
  assert.deepEqual(opts.slice(1).map((o) => o.name), ['Ed', 'Eddie']);
  assert.deepEqual(mentionOptions('man', members).map((o) => o.name), ['Candy Man']);
});
