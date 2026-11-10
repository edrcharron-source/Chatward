import type { Express, NextFunction, Request, Response } from 'express';
import {
  WORKOUT_GOAL_TYPES, WORKOUT_KINDS, WORKOUT_LIMITS as L,
  type WorkoutCard, type WorkoutComment, type WorkoutCrew, type WorkoutEvent, type WorkoutGoalType, type WorkoutKind,
  type WorkoutMe, type WorkoutMemberPage, type WorkoutMetric, type WorkoutMilestone, type WorkoutSplitDay, type WorkoutWeek,
} from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';
import { pushToUser } from '../push.js';

/**
 * Workouts: the crew check-in tracker that used to be the separate DOSS app on the home server, rebuilt on Chatward's
 * accounts. Everyone in the server is in the crew. Each person sets a goal and a weekly plan, logs each day's workout,
 * and the tab shows the week, streaks, standings, personal metrics with PRs, milestones, a feed, comments, nudges and cheers.
 *
 * All rules match DOSS: a week runs Monday to Sunday in the person's own timezone, rest days never break a streak, a day
 * can be logged up to 6 days late, one nudge per person per day and five cheers.
 */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const STREAK_DAYS = 180;

interface ProfileRow {
  user_id: string; title: string; color: string; goal: string; goal_type: string; start_date: string; goal_date: string;
  why: string; tz: string; remind_time: string; last_reminded: string; show_numbers: number; allow_nudges: number; notify_crew: number;
}

export function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
/** The date, time and weekday (Mon = 0) right now in a timezone. */
export function localNow(tz: string, d = new Date()): { date: string; hour: number; minute: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTz(tz) ? tz : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), dow: DOW[p.weekday] };
}
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dowOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
const clip = (v: unknown, n: number) => String(v ?? '').slice(0, n);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isPlanned = (s: WorkoutSplitDay | undefined) => !!s && s.kind !== 'Rest' && s.workout.trim() !== '';
export function fmtValue(v: number, unit: string): string {
  if (unit === 'min') { const mm = Math.floor(v); const ss = Math.round((v - mm) * 60); return `${mm}:${String(ss).padStart(2, '0')}`; }
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${unit ? ' ' + unit : ''}`;
}

/** Streak: days in a row with a log, counting back from today. Rest days and today (not over yet) are skipped, not breaks. */
export function computeStreak(logged: Set<string>, split: WorkoutSplitDay[], today: string, startDate: string): number {
  let streak = 0;
  for (let i = 0; i <= STREAK_DAYS; i += 1) {
    const d = addDays(today, -i);
    if (startDate && d < startDate) break;
    if (logged.has(d)) { streak += 1; continue; }
    if (!isPlanned(split[dowOf(d)])) continue;
    if (d === today) continue;
    break;
  }
  return streak;
}

export function createWorkoutTables(db: Ctx['db']): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS workout_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#2F6BFF', goal TEXT NOT NULL DEFAULT '',
    goal_type TEXT NOT NULL DEFAULT 'Endurance', start_date TEXT NOT NULL DEFAULT '', goal_date TEXT NOT NULL DEFAULT '',
    why TEXT NOT NULL DEFAULT '', tz TEXT NOT NULL DEFAULT 'America/New_York', remind_time TEXT NOT NULL DEFAULT '18:00',
    last_reminded TEXT NOT NULL DEFAULT '', show_numbers INTEGER NOT NULL DEFAULT 1, allow_nudges INTEGER NOT NULL DEFAULT 1,
    notify_crew INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS workout_split (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, dow INTEGER NOT NULL,
    workout TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'Rest', PRIMARY KEY (user_id, dow)
  );
  CREATE TABLE IF NOT EXISTS workout_logs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, PRIMARY KEY (user_id, date)
  );
  CREATE TABLE IF NOT EXISTS workout_metrics (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '', better TEXT NOT NULL DEFAULT 'up', position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS workout_metric_entries (
    id TEXT PRIMARY KEY, metric_id TEXT NOT NULL REFERENCES workout_metrics(id) ON DELETE CASCADE,
    value REAL NOT NULL, date TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workout_metric_entries_metric ON workout_metric_entries(metric_id, date);
  CREATE TABLE IF NOT EXISTS workout_milestones (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL,
    due TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS workout_comments (
    id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workout_comments_target ON workout_comments(target_id, created_at);
  CREATE TABLE IF NOT EXISTS workout_events (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id TEXT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workout_events_time ON workout_events(created_at);
  `);
}

export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;
  createWorkoutTables(db);

  const profile = (userId: string): ProfileRow => {
    db.prepare('INSERT OR IGNORE INTO workout_profiles (user_id) VALUES (?)').run(userId);
    return db.prepare('SELECT * FROM workout_profiles WHERE user_id=?').get(userId) as ProfileRow;
  };
  /** The crew: everyone in a server with the caller who has an active account. */
  const crewIds = (userId: string): string[] => (db.prepare(`
    SELECT DISTINCT u.id FROM members m JOIN members me ON me.server_id = m.server_id AND me.user_id = ?
    JOIN users u ON u.id = m.user_id WHERE u.disabled_at IS NULL AND u.deleted_at IS NULL ORDER BY u.created_at`).all(userId) as Array<{ id: string }>)
    .map((r) => r.id);
  const inCrew = (viewer: string, other: string) => crewIds(viewer).includes(other);

  const getSplit = (userId: string): WorkoutSplitDay[] => {
    const out: WorkoutSplitDay[] = DAY_NAMES.map((day, dow) => ({ dow, day, workout: '', kind: 'Rest' }));
    for (const r of db.prepare('SELECT dow, workout, kind FROM workout_split WHERE user_id=?').all(userId) as Array<{ dow: number; workout: string; kind: WorkoutKind }>) {
      if (out[r.dow]) out[r.dow] = { ...out[r.dow], workout: r.workout, kind: r.kind };
    }
    return out;
  };
  const loggedBetween = (userId: string, from: string, to: string) =>
    new Set((db.prepare('SELECT date FROM workout_logs WHERE user_id=? AND date BETWEEN ? AND ?').all(userId, from, to) as Array<{ date: string }>).map((r) => r.date));

  const weekFor = (userId: string): WorkoutWeek => {
    const p = profile(userId);
    const now = localNow(p.tz);
    const monday = addDays(now.date, -now.dow);
    const sunday = addDays(monday, 6);
    const split = getSplit(userId);
    const logged = loggedBetween(userId, monday, sunday);
    let planned = 0; let done = 0;
    const days = split.map((s, i) => {
      const date = addDays(monday, i);
      const pre = !!p.start_date && date < p.start_date;
      const plan = isPlanned(s) && !pre;
      const isLogged = logged.has(date);
      const status = isLogged ? 'done' : pre ? 'pre' : !plan ? 'rest' : date < now.date ? 'missed' : date === now.date ? 'today' : 'up';
      if (plan) planned += 1;
      if (isLogged) done += 1;
      return { date, day: s.day, workout: s.workout, kind: s.kind, status, isToday: date === now.date } as WorkoutWeek['days'][number];
    });
    const todaySplit = split[now.dow];
    return {
      monday, sunday, today: now.date, days, planned, done,
      pct: planned ? Math.min(100, Math.round((done / planned) * 100)) : 0,
      todayWorkout: isPlanned(todaySplit) ? todaySplit.workout : 'Rest day',
      todayPlanned: isPlanned(todaySplit),
      todayLogged: logged.has(now.date),
      streak: computeStreak(loggedBetween(userId, addDays(now.date, -STREAK_DAYS), now.date), split, now.date, p.start_date),
    };
  };

  const card = (userId: string): WorkoutCard => {
    const u = ctx.getUser(userId);
    const p = profile(userId);
    return {
      userId, name: u?.displayName ?? 'Someone', avatarUrl: u?.avatarUrl ?? null, title: p.title, color: p.color,
      goal: p.goal, goalType: p.goal_type as WorkoutGoalType, startDate: p.start_date, goalDate: p.goal_date, why: p.why,
    };
  };
  const nameOf = (userId: string) => ctx.getUser(userId)?.displayName ?? 'Someone';

  const metricsFor = (userId: string): WorkoutMetric[] =>
    (db.prepare('SELECT id, name, unit, better FROM workout_metrics WHERE user_id=? ORDER BY position, rowid').all(userId) as Array<Omit<WorkoutMetric, 'entries'>>)
      .map((m) => ({ ...m, entries: db.prepare('SELECT id, value, date FROM workout_metric_entries WHERE metric_id=? ORDER BY date, created_at').all(m.id) as WorkoutMetric['entries'] }));
  const milestonesFor = (userId: string): WorkoutMilestone[] =>
    (db.prepare('SELECT id, label, due, done FROM workout_milestones WHERE user_id=? ORDER BY position, rowid').all(userId) as Array<Omit<WorkoutMilestone, 'done'> & { done: number }>)
      .map((m) => ({ ...m, done: !!m.done }));

  const addEvent = (actor: string, target: string | null, type: string, text: string, day: string) =>
    db.prepare('INSERT INTO workout_events (id, actor_id, target_id, type, text, day, created_at) VALUES (?,?,?,?,?,?,?)').run(newId(), actor, target, type, text, day, Date.now());
  /** Tells the rest of the crew (those who keep crew notifications on) by push. */
  const notifyCrew = (actor: string, payload: { title: string; body: string }) => {
    for (const id of crewIds(actor)) {
      if (id !== actor && profile(id).notify_crew) void pushToUser(ctx, id, { ...payload, url: '/?tab=workouts', tag: 'workouts' });
    }
  };

  const me = (req: Request) => (req as AuthedRequest).userId;
  const target = (req: Request, res: Response, next: NextFunction) => {
    if (!inCrew(me(req), String(req.params.userId))) { res.status(404).json({ error: 'Not found.' }); return; }
    next();
  };
  const auth = ctx.requireAuth;

  app.get('/api/workouts/me', auth, (req, res) => {
    const id = me(req); const p = profile(id);
    const body: WorkoutMe = {
      ...card(id), tz: p.tz, remindTime: p.remind_time, showNumbers: !!p.show_numbers, allowNudges: !!p.allow_nudges, notifyCrew: !!p.notify_crew,
      split: getSplit(id), metrics: metricsFor(id), milestones: milestonesFor(id),
    };
    res.json(body);
  });

  app.put('/api/workouts/me', auth, (req, res) => {
    const id = me(req); const p = profile(id); const b = (req.body ?? {}) as Record<string, unknown>;
    const date = (v: unknown, old: string) => (v === '' || isDate(v) ? (v as string) : old);
    const flag = (v: unknown, old: number) => (v === undefined ? old : v ? 1 : 0);
    db.prepare(`UPDATE workout_profiles SET title=?, color=?, goal=?, goal_type=?, start_date=?, goal_date=?, why=?, tz=?, remind_time=?,
      show_numbers=?, allow_nudges=?, notify_crew=? WHERE user_id=?`).run(
      b.title === undefined ? p.title : clip(b.title, L.TITLE).trim(),
      isHex(b.color) ? b.color.toUpperCase() : p.color,
      b.goal === undefined ? p.goal : clip(b.goal, L.GOAL),
      (WORKOUT_GOAL_TYPES as readonly unknown[]).includes(b.goalType) ? b.goalType : p.goal_type,
      date(b.startDate, p.start_date), date(b.goalDate, p.goal_date),
      b.why === undefined ? p.why : clip(b.why, L.WHY),
      validTz(b.tz) ? b.tz : p.tz,
      typeof b.remindTime === 'string' && (b.remindTime === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(b.remindTime)) ? b.remindTime : p.remind_time,
      flag(b.showNumbers, p.show_numbers), flag(b.allowNudges, p.allow_nudges), flag(b.notifyCrew, p.notify_crew), id,
    );
    res.json({ ok: true });
  });

  app.put('/api/workouts/me/split', auth, (req, res) => {
    const id = me(req); const p = profile(id);
    // A first plan starts today, so the days earlier this week don't count as missed.
    if (!p.start_date) db.prepare('UPDATE workout_profiles SET start_date=? WHERE user_id=?').run(localNow(p.tz).date, id);
    const rows = Array.isArray(req.body) ? (req.body as Array<Record<string, unknown>>) : [];
    const put = db.prepare('INSERT INTO workout_split (user_id, dow, workout, kind) VALUES (?,?,?,?) ON CONFLICT(user_id, dow) DO UPDATE SET workout=excluded.workout, kind=excluded.kind');
    db.transaction(() => {
      for (const r of rows.slice(0, 7)) {
        const dow = Number(r.dow);
        if (Number.isInteger(dow) && dow >= 0 && dow <= 6) put.run(id, dow, clip(r.workout, L.WORKOUT), (WORKOUT_KINDS as readonly unknown[]).includes(r.kind) ? r.kind : 'Rest');
      }
    })();
    res.json({ ok: true, split: getSplit(id) });
  });

  app.put('/api/workouts/me/metrics', auth, (req, res) => {
    const id = me(req);
    const rows = (Array.isArray(req.body) ? (req.body as Array<Record<string, unknown>>) : []).slice(0, L.METRICS);
    const mine = new Set((db.prepare('SELECT id FROM workout_metrics WHERE user_id=?').all(id) as Array<{ id: string }>).map((r) => r.id));
    const keep = new Set<string>();
    db.transaction(() => {
      rows.forEach((r, i) => {
        const name = clip(r.name, L.METRIC_NAME).trim();
        if (!name) return;
        const better = r.better === 'down' ? 'down' : 'up';
        const unit = clip(r.unit, L.METRIC_UNIT).trim();
        if (typeof r.id === 'string' && mine.has(r.id)) {
          db.prepare('UPDATE workout_metrics SET name=?, unit=?, better=?, position=? WHERE id=?').run(name, unit, better, i, r.id);
          keep.add(r.id);
        } else {
          const mid = newId();
          db.prepare('INSERT INTO workout_metrics (id, user_id, name, unit, better, position) VALUES (?,?,?,?,?,?)').run(mid, id, name, unit, better, i);
          keep.add(mid);
        }
      });
      for (const old of mine) if (!keep.has(old)) db.prepare('DELETE FROM workout_metrics WHERE id=?').run(old);
    })();
    res.json({ ok: true, metrics: metricsFor(id) });
  });

  app.post('/api/workouts/metrics/:id/entries', auth, (req, res) => {
    const id = me(req);
    const m = db.prepare('SELECT * FROM workout_metrics WHERE id=? AND user_id=?').get(req.params.id, id) as { id: string; name: string; unit: string; better: string } | undefined;
    if (!m) { res.status(404).json({ error: 'Metric not found.' }); return; }
    const value = Number((req.body as { value?: unknown })?.value);
    if (!Number.isFinite(value)) { res.status(400).json({ error: 'Enter a number.' }); return; }
    const today = localNow(profile(id).tz).date;
    const d = (req.body as { date?: unknown }).date;
    const date = isDate(d) && d <= today ? d : today;
    const prev = (db.prepare('SELECT value FROM workout_metric_entries WHERE metric_id=?').all(m.id) as Array<{ value: number }>).map((e) => e.value);
    db.prepare('INSERT INTO workout_metric_entries (id, metric_id, value, date, created_at) VALUES (?,?,?,?,?)').run(newId(), m.id, value, date, Date.now());
    const best = prev.length ? (m.better === 'down' ? Math.min(...prev) : Math.max(...prev)) : null;
    const pr = best !== null && (m.better === 'down' ? value < best : value > best);
    if (pr) {
      addEvent(id, null, 'pr', `set a ${m.name} PR · ${fmtValue(value, m.unit)}`, date);
      notifyCrew(id, { title: `${nameOf(id)} hit a PR`, body: `${m.name}: ${fmtValue(value, m.unit)}` });
    }
    res.json({ ok: true, pr, metrics: metricsFor(id) });
  });

  app.delete('/api/workouts/entries/:id', auth, (req, res) => {
    db.prepare('DELETE FROM workout_metric_entries WHERE id=? AND metric_id IN (SELECT id FROM workout_metrics WHERE user_id=?)').run(req.params.id, me(req));
    res.json({ ok: true, metrics: metricsFor(me(req)) });
  });

  app.put('/api/workouts/me/milestones', auth, (req, res) => {
    const id = me(req);
    const rows = (Array.isArray(req.body) ? (req.body as Array<Record<string, unknown>>) : []).slice(0, L.MILESTONES);
    const before = new Map(milestonesFor(id).map((m) => [m.id, m]));
    const today = localNow(profile(id).tz).date;
    const newlyDone: string[] = [];
    db.transaction(() => {
      db.prepare('DELETE FROM workout_milestones WHERE user_id=?').run(id);
      rows.forEach((r, i) => {
        const label = clip(r.label, L.MILESTONE).trim();
        if (!label) return;
        const old = typeof r.id === 'string' ? before.get(r.id) : undefined;
        db.prepare('INSERT INTO workout_milestones (id, user_id, label, due, done, position) VALUES (?,?,?,?,?,?)')
          .run(old ? old.id : newId(), id, label, isDate(r.due) ? r.due : '', r.done ? 1 : 0, i);
        if (r.done && old && !old.done) newlyDone.push(label);
      });
    })();
    for (const label of newlyDone) {
      addEvent(id, null, 'milestone', `hit a milestone · ${label}`, today);
      notifyCrew(id, { title: `${nameOf(id)} hit a milestone`, body: label });
    }
    res.json({ ok: true, milestones: milestonesFor(id) });
  });

  app.post('/api/workouts/log', auth, (req, res) => {
    const id = me(req);
    const today = localNow(profile(id).tz).date;
    const d = (req.body as { date?: unknown })?.date;
    const date = isDate(d) ? d : today;
    if (date > today || date < addDays(today, -L.LOG_BACK_DAYS)) { res.status(400).json({ error: `You can log today or the past ${L.LOG_BACK_DAYS} days.` }); return; }
    const s = getSplit(id)[dowOf(date)];
    const info = db.prepare('INSERT OR IGNORE INTO workout_logs (user_id, date, note, created_at) VALUES (?,?,?,?)')
      .run(id, date, clip((req.body as { note?: unknown })?.note, L.NOTE).trim(), Date.now());
    if (info.changes) {
      const what = isPlanned(s) ? s.workout : 'a bonus workout';
      addEvent(id, null, 'log', `finished ${what}`, date);
      notifyCrew(id, { title: `${nameOf(id)} checked in`, body: `Finished ${what}` });
    }
    res.json({ ok: true, week: weekFor(id) });
  });

  app.delete('/api/workouts/log/:date', auth, (req, res) => {
    const id = me(req);
    if (!isDate(req.params.date)) { res.status(400).json({ error: 'Bad date.' }); return; }
    db.prepare('DELETE FROM workout_logs WHERE user_id=? AND date=?').run(id, req.params.date);
    db.prepare("DELETE FROM workout_events WHERE actor_id=? AND type='log' AND day=?").run(id, req.params.date);
    res.json({ ok: true, week: weekFor(id) });
  });

  app.get('/api/workouts/crew', auth, (req, res) => {
    const id = me(req);
    const now = localNow(profile(id).tz);
    const monday = addDays(now.date, -now.dow);
    const members = crewIds(id).map((uid) => ({ ...card(uid), week: weekFor(uid), pos: 0 }));
    members.sort((a, b) => b.week.pct - a.week.pct || b.week.streak - a.week.streak || a.name.localeCompare(b.name));
    members.forEach((m, i) => { m.pos = i + 1; });
    const totals = members.reduce((t, m) => ({ planned: t.planned + m.week.planned, done: t.done + Math.min(m.week.done, m.week.planned) }), { planned: 0, done: 0 });
    const body: WorkoutCrew = { monday, sunday: addDays(monday, 6), today: now.date, daysLeft: 6 - now.dow, members, totals, meId: id };
    res.json(body);
  });

  app.get('/api/workouts/feed', auth, (req, res) => {
    const crew = crewIds(me(req));
    if (!crew.length) { res.json([]); return; }
    const rows = db.prepare(`SELECT id, type, text, actor_id, target_id, created_at FROM workout_events
      WHERE actor_id IN (${crew.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 30`).all(...crew) as Array<{ id: string; type: WorkoutEvent['type']; text: string; actor_id: string; target_id: string | null; created_at: number }>;
    const body: WorkoutEvent[] = rows.map((r) => {
      const c = card(r.actor_id);
      return { id: r.id, type: r.type, text: r.text, actorId: r.actor_id, actorName: c.name, actorAvatarUrl: c.avatarUrl, actorColor: c.color, targetId: r.target_id, createdAt: r.created_at };
    });
    res.json(body);
  });

  app.get('/api/workouts/users/:userId', auth, target, (req, res) => {
    const uid = String(req.params.userId); const self = uid === me(req); const p = profile(uid);
    const comments: WorkoutComment[] = (db.prepare('SELECT id, body, author_id, created_at FROM workout_comments WHERE target_id=? ORDER BY created_at DESC LIMIT 40').all(uid) as Array<{ id: string; body: string; author_id: string; created_at: number }>)
      .map((c) => { const a = card(c.author_id); return { id: c.id, body: c.body, authorId: c.author_id, authorName: a.name, authorAvatarUrl: a.avatarUrl, authorColor: a.color, createdAt: c.created_at }; });
    const showNumbers = self || !!p.show_numbers;
    const body: WorkoutMemberPage = {
      ...card(uid), self, allowNudges: !!p.allow_nudges, week: weekFor(uid),
      metrics: showNumbers ? metricsFor(uid) : [], numbersHidden: !showNumbers, milestones: milestonesFor(uid), comments,
    };
    res.json(body);
  });

  app.post('/api/workouts/users/:userId/comments', auth, target, (req, res) => {
    const id = me(req); const uid = String(req.params.userId);
    const body = clip((req.body as { body?: unknown })?.body, L.COMMENT).trim();
    if (!body) { res.status(400).json({ error: 'Write something first.' }); return; }
    db.prepare('INSERT INTO workout_comments (id, target_id, author_id, body, created_at) VALUES (?,?,?,?,?)').run(newId(), uid, id, body, Date.now());
    if (uid !== id) void pushToUser(ctx, uid, { title: `${nameOf(id)} commented`, body, url: '/?tab=workouts', tag: 'workouts' });
    res.json({ ok: true });
  });

  app.delete('/api/workouts/comments/:id', auth, (req, res) => {
    // The author, or the person whose page it is, can remove a comment.
    db.prepare('DELETE FROM workout_comments WHERE id=? AND (author_id=? OR target_id=?)').run(req.params.id, me(req), me(req));
    res.json({ ok: true });
  });

  app.post('/api/workouts/users/:userId/nudge', auth, target, async (req, res) => {
    const id = me(req); const uid = String(req.params.userId);
    if (uid === id) { res.status(400).json({ error: 'Pick a crewmate.' }); return; }
    const name = nameOf(uid);
    if (!profile(uid).allow_nudges) { res.status(403).json({ error: `${name} turned off nudges.` }); return; }
    const today = localNow(profile(id).tz).date;
    if (db.prepare("SELECT 1 FROM workout_events WHERE actor_id=? AND target_id=? AND type='nudge' AND day=?").get(id, uid, today)) {
      res.status(429).json({ error: `You already nudged ${name} today.` }); return;
    }
    addEvent(id, uid, 'nudge', `nudged ${name}`, today);
    const w = weekFor(uid);
    const delivered = await pushToUser(ctx, uid, {
      title: `${nameOf(id)} nudged you`,
      body: w.todayPlanned && !w.todayLogged ? `Today: ${w.todayWorkout}. Get it done.` : 'Your crew is watching. Stay on plan.',
      url: '/?tab=workouts', tag: 'workouts',
    });
    res.json({ ok: true, delivered });
  });

  app.post('/api/workouts/users/:userId/cheer', auth, target, async (req, res) => {
    const id = me(req); const uid = String(req.params.userId);
    if (uid === id) { res.status(400).json({ error: 'Pick a crewmate.' }); return; }
    const name = nameOf(uid);
    const today = localNow(profile(id).tz).date;
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM workout_events WHERE actor_id=? AND target_id=? AND type='cheer' AND day=?").get(id, uid, today) as { n: number };
    if (n >= L.CHEERS_PER_DAY) { res.status(429).json({ error: `That's plenty of cheers for ${name} today.` }); return; }
    addEvent(id, uid, 'cheer', `cheered ${name}`, today);
    await pushToUser(ctx, uid, { title: `${nameOf(id)} cheered you on`, body: clip((req.body as { text?: unknown })?.text, 80).trim() || 'Keep it going.', url: '/?tab=workouts', tag: 'workouts' });
    res.json({ ok: true });
  });

  // The daily reminder: at each person's chosen time in their timezone, on a planned day they have not logged yet.
  const runReminders = () => {
    const rows = db.prepare(`SELECT p.* FROM workout_profiles p JOIN users u ON u.id = p.user_id
      WHERE u.disabled_at IS NULL AND u.deleted_at IS NULL AND p.remind_time != ''`).all() as ProfileRow[];
    for (const p of rows) {
      const now = localNow(p.tz);
      if (p.last_reminded === now.date) continue;
      const [h, m] = p.remind_time.split(':').map(Number);
      if (now.hour * 60 + now.minute < h * 60 + m) continue;
      db.prepare('UPDATE workout_profiles SET last_reminded=? WHERE user_id=?').run(now.date, p.user_id);
      const w = weekFor(p.user_id);
      if (!w.todayPlanned || w.todayLogged) continue;
      void pushToUser(ctx, p.user_id, { title: 'Still on the plan today', body: `${w.todayWorkout}. Log it when you're done.`, url: '/?tab=workouts', tag: 'workouts-reminder' });
    }
  };
  setInterval(runReminders, 5 * 60_000).unref();
  setTimeout(runReminders, 15_000).unref();
}
