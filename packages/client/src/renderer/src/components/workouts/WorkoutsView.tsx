import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  WORKOUT_GOAL_TYPES, WORKOUT_KINDS, WORKOUT_LIMITS as L,
  type WorkoutCrew, type WorkoutEvent, type WorkoutMe, type WorkoutMemberPage, type WorkoutMetric, type WorkoutMilestone,
  type WorkoutSplitDay, type WorkoutWeek,
} from '@chatward/shared';
import { api, ApiError } from '../../api/http';
import Avatar from '../servers/Avatar';
import { disablePush, enablePush, pushState, testPush, type PushState } from '../../web/push';
import { AsciiRing, useLebaiArt } from '../lebai/AsciiArt';
import './workouts.css';

/**
 * The Workouts tab: the crew check-in tracker that used to be the separate DOSS app. "Crew" shows today's workout with a
 * Log it button, this week, the standings and the feed. Tapping someone opens their page (week, numbers, milestones,
 * comments, nudge and cheer). "My plan" edits your goal, weekly plan, numbers to track, milestones and reminders.
 */

type View = { kind: 'crew' } | { kind: 'plan' } | { kind: 'member'; userId: string };

const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');

export default function WorkoutsView() {
  const [view, setView] = useState<View>({ kind: 'crew' });
  return (
    <div className="wk" data-region="workouts">
      <nav className="wk-switch" aria-label="Workouts">
        <button type="button" className={view.kind !== 'plan' ? 'active' : ''} onClick={() => setView({ kind: 'crew' })}>Crew</button>
        <button type="button" className={view.kind === 'plan' ? 'active' : ''} onClick={() => setView({ kind: 'plan' })}>My plan</button>
      </nav>
      <div className="wk-body">
        {view.kind === 'crew' && <CrewPage onOpen={(userId) => setView({ kind: 'member', userId })} onPlan={() => setView({ kind: 'plan' })} />}
        {view.kind === 'member' && <MemberPage userId={view.userId} onBack={() => setView({ kind: 'crew' })} />}
        {view.kind === 'plan' && <PlanPage />}
      </div>
    </div>
  );
}

// ---------- Crew ----------

function CrewPage({ onOpen, onPlan }: { onOpen: (userId: string) => void; onPlan: () => void }) {
  const [crew, setCrew] = useState<WorkoutCrew | null>(null);
  const [feed, setFeed] = useState<WorkoutEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [c, f] = await Promise.all([api.get<WorkoutCrew>('/api/workouts/crew'), api.get<WorkoutEvent[]>('/api/workouts/feed')]);
      setCrew(c); setFeed(f); setError(null);
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const art = useLebaiArt();
  if (!crew) return <p className="muted wk-pad">{error ?? 'Loading…'}</p>;
  const mine = crew.members.find((m) => m.userId === crew.meId);
  const noPlan = mine && mine.week.planned === 0 && mine.week.days.every((d) => d.kind === 'Rest');
  return (
    <div className="wk-stack">
      {mine && (
        <section className="wk-card wk-today" style={{ ['--wk-color' as string]: mine.color }}>
          <div className="wk-today-head">
            <div>
              <div className="wk-eyebrow">Today</div>
              <div className="wk-today-name">{mine.week.todayWorkout}</div>
            </div>
            <div className="wk-today-side">
              {art && (
                <div className="wk-ring" title={`${mine.week.done} of ${mine.week.planned} this week`}>
                  <AsciiRing done={mine.week.done} planned={mine.week.planned} size={5} />
                  <span className="wk-ring-label" aria-hidden="true">{mine.week.done}/{mine.week.planned}</span>
                </div>
              )}
              <Streak n={mine.week.streak} />
            </div>
          </div>
          {noPlan
            ? <p className="muted">Set your weekly plan to start tracking. <button type="button" className="wk-link" onClick={onPlan}>Set my plan</button></p>
            : <LogButton week={mine.week} onChange={load} />}
          <WeekStrip week={mine.week} editable onChange={load} />
          <div className="wk-meter"><span style={{ width: `${mine.week.pct}%` }} /></div>
          <div className="muted wk-small">{mine.week.done} of {mine.week.planned} planned this week · {mine.week.pct}%</div>
        </section>
      )}

      <section className="wk-card">
        <div className="wk-row-between">
          <h3>Standings</h3>
          <span className="muted wk-small">{crew.totals.done} of {crew.totals.planned} sessions · {crew.daysLeft} {crew.daysLeft === 1 ? 'day' : 'days'} left</span>
        </div>
        <ol className="wk-standings">
          {crew.members.map((m) => (
            <li key={m.userId}>
              <button type="button" className="wk-standing" onClick={() => onOpen(m.userId)} style={{ ['--wk-color' as string]: m.color }}>
                <span className="wk-pos">P{m.pos}</span>
                <Avatar user={{ displayName: m.name, avatarUrl: m.avatarUrl }} size={32} />
                <span className="wk-standing-name">
                  <strong>{m.name}</strong>
                  {m.title && <span className="wk-title-tag">{m.title}</span>}
                  <span className="wk-mini-week" aria-hidden="true">{m.week.days.map((d) => <i key={d.date} className={`wk-dot ${d.status}`} />)}</span>
                </span>
                <span className="wk-standing-stats">
                  <strong>{m.week.pct}%</strong>
                  <Streak n={m.week.streak} small />
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="wk-card">
        <h3>Feed</h3>
        {feed.length === 0 ? <p className="muted">Nothing yet. Log a workout to get things going.</p> : (
          <ul className="wk-feed">
            {feed.map((e) => (
              <li key={e.id}>
                <Avatar user={{ displayName: e.actorName, avatarUrl: e.actorAvatarUrl }} size={24} />
                <span><strong>{e.actorName}</strong> {e.text} <span className="muted wk-small">· {ago(e.createdAt)}</span></span>
                {e.type === 'pr' && <span className="wk-badge">PR</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Streak({ n, small }: { n: number; small?: boolean }) {
  return <span className={`wk-streak${small ? ' small' : ''}`} title={`${n} day streak`}>🔥 {n}</span>;
}

function LogButton({ week, onChange }: { week: WorkoutWeek; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onChange(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="wk-log">
      {week.todayLogged
        ? <button type="button" className="wk-logged" disabled={busy} onClick={() => void run(() => api.del(`/api/workouts/log/${week.today}`))}>✓ Logged · tap to undo</button>
        : <button type="button" className="primary wk-log-btn" disabled={busy} onClick={() => void run(() => api.post('/api/workouts/log', {}))}>
            {week.todayPlanned ? 'Log it' : 'Log a bonus workout'}
          </button>}
      {error && <p className="wk-error">{error}</p>}
    </div>
  );
}

/** The week, Monday to Sunday. Your own strip lets you log or undo a day you missed (up to 6 days back). */
function WeekStrip({ week, editable, onChange }: { week: WorkoutWeek; editable?: boolean; onChange?: () => void }) {
  const earliest = addDays(week.today, -L.LOG_BACK_DAYS);
  const toggle = async (date: string, done: boolean) => {
    try {
      if (done) await api.del(`/api/workouts/log/${date}`);
      else await api.post('/api/workouts/log', { date });
      onChange?.();
    } catch { /* the strip just stays as it was */ }
  };
  return (
    <div className="wk-week">
      {week.days.map((d) => {
        const canEdit = editable && d.date <= week.today && d.date >= earliest && d.date !== week.today;
        const label = `${d.day} ${d.date}: ${d.workout || d.kind}, ${STATUS_TEXT[d.status]}`;
        return (
          <button key={d.date} type="button" className={`wk-day ${d.status}${d.isToday ? ' is-today' : ''}`} title={label} aria-label={label}
            disabled={!canEdit} onClick={() => void toggle(d.date, d.status === 'done')}>
            <span className="wk-day-letter">{d.day.slice(0, 1)}</span>
            <span className="wk-day-mark">{d.status === 'done' ? '✓' : d.status === 'missed' ? '✕' : d.status === 'rest' ? '–' : '·'}</span>
          </button>
        );
      })}
    </div>
  );
}
const STATUS_TEXT: Record<string, string> = { done: 'done', missed: 'missed', rest: 'rest', today: 'today', up: 'coming up', pre: 'before start' };

// ---------- Member page ----------

function MemberPage({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [page, setPage] = useState<WorkoutMemberPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const load = useCallback(async () => {
    try { setPage(await api.get<WorkoutMemberPage>(`/api/workouts/users/${userId}`)); } catch (e) { setError(errText(e)); }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);
  if (!page) return <p className="muted wk-pad">{error ?? 'Loading…'}</p>;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setNote(null);
    try { await fn(); setNote(done); void load(); } catch (e) { setNote(errText(e)); }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;
    void act(() => api.post(`/api/workouts/users/${userId}/comments`, { body: comment }), 'Comment posted.').then(() => setComment(''));
  };
  return (
    <div className="wk-stack">
      <button type="button" className="wk-link wk-back" onClick={onBack}>← Crew</button>
      <ProfileCard page={page} />
      <section className="wk-card">
        <div className="wk-row-between"><h3>This week</h3><span className="muted wk-small">{page.week.pct}% · <Streak n={page.week.streak} small /></span></div>
        <WeekStrip week={page.week} />
        {!page.self && (
          <div className="wk-actions">
            <button type="button" disabled={!page.allowNudges} title={page.allowNudges ? '' : `${page.name} turned off nudges`}
              onClick={() => void act(() => api.post(`/api/workouts/users/${userId}/nudge`), `Nudged ${page.name}.`)}>👉 Nudge</button>
            <button type="button" onClick={() => void act(() => api.post(`/api/workouts/users/${userId}/cheer`), `Cheered ${page.name} on.`)}>👏 Cheer</button>
          </div>
        )}
        {note && <p className="muted wk-small">{note}</p>}
      </section>
      <section className="wk-card">
        <h3>Numbers</h3>
        {page.numbersHidden ? <p className="muted">{page.name} keeps their numbers private.</p>
          : page.metrics.length === 0 ? <p className="muted">{page.self ? 'Add numbers to track in My plan.' : 'No numbers yet.'}</p>
          : <div className="wk-metrics">{page.metrics.map((m) => <MetricTile key={m.id} metric={m} canLog={page.self} onChange={load} />)}</div>}
      </section>
      {page.milestones.length > 0 && (
        <section className="wk-card">
          <h3>Milestones</h3>
          <ul className="wk-milestones">
            {page.milestones.map((m) => <li key={m.id} className={m.done ? 'done' : ''}>{m.done ? '✓' : '○'} {m.label}{m.due && <span className="muted wk-small"> · {m.due}</span>}</li>)}
          </ul>
        </section>
      )}
      <section className="wk-card">
        <h3>Comments</h3>
        <form className="wk-comment-form" onSubmit={send}>
          <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={L.COMMENT} placeholder={page.self ? 'Note to self' : `Say something to ${page.name}`} />
          <button type="submit" className="primary" disabled={!comment.trim()}>Post</button>
        </form>
        <ul className="wk-comments">
          {page.comments.map((c) => (
            <li key={c.id}>
              <Avatar user={{ displayName: c.authorName, avatarUrl: c.authorAvatarUrl }} size={24} />
              <div><strong>{c.authorName}</strong> <span className="muted wk-small">{ago(c.createdAt)}</span><div>{c.body}</div></div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ProfileCard({ page }: { page: WorkoutMemberPage }) {
  const daysLeft = page.goalDate ? Math.ceil((Date.parse(page.goalDate) - Date.parse(page.week.today)) / 86_400_000) : null;
  const totalWeeks = page.startDate && page.goalDate ? Math.max(1, Math.ceil((Date.parse(page.goalDate) - Date.parse(page.startDate)) / (7 * 86_400_000))) : null;
  const weekNo = page.startDate && totalWeeks ? Math.min(totalWeeks, Math.max(1, Math.floor((Date.parse(page.week.today) - Date.parse(page.startDate)) / (7 * 86_400_000)) + 1)) : null;
  return (
    <section className="wk-card wk-profile" style={{ ['--wk-color' as string]: page.color }}>
      <div className="wk-profile-head">
        <Avatar user={{ displayName: page.name, avatarUrl: page.avatarUrl }} size={56} />
        <div>
          <div className="wk-profile-name">{page.name}</div>
          {page.title && <span className="wk-title-tag">{page.title}</span>}
        </div>
      </div>
      {page.goal && <p className="wk-goal"><span className="wk-eyebrow">{page.goalType}</span> {page.goal}</p>}
      {daysLeft !== null && (
        <p className="muted wk-small">
          {daysLeft > 14 ? `${Math.round(daysLeft / 7)} weeks to go` : daysLeft >= 0 ? `${daysLeft} days to go` : 'Goal date passed'}
          {weekNo && totalWeeks ? ` · Week ${weekNo} of ${totalWeeks}` : ''}
        </p>
      )}
      {weekNo && totalWeeks ? <div className="wk-meter"><span style={{ width: `${Math.round((weekNo / totalWeeks) * 100)}%` }} /></div> : null}
      {page.why && <p className="muted">“{page.why}”</p>}
    </section>
  );
}

function MetricTile({ metric, canLog, onChange }: { metric: WorkoutMetric; canLog: boolean; onChange: () => void }) {
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const values = metric.entries.map((e) => e.value);
  const latest = values.at(-1);
  const first = values[0];
  const change = latest !== undefined && first !== undefined && values.length > 1 ? latest - first : null;
  const good = change !== null && (metric.better === 'up' ? change > 0 : change < 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = parseValue(value, metric.unit);
    if (v === null) { setMsg(metric.unit === 'min' ? 'Use mm:ss.' : 'Enter a number.'); return; }
    try {
      const r = await api.post<{ pr: boolean }>(`/api/workouts/metrics/${metric.id}/entries`, { value: v });
      setValue(''); setMsg(r.pr ? 'New PR! 🎉' : 'Saved.'); onChange();
    } catch (err) { setMsg(errText(err)); }
  };
  return (
    <div className="wk-metric">
      <div className="wk-metric-name">{metric.name}</div>
      <div className="wk-metric-value">{latest === undefined ? '–' : fmtValue(latest, metric.unit)}</div>
      {change !== null && <div className={`wk-small ${good ? 'wk-good' : 'muted'}`}>{change > 0 ? '+' : ''}{fmtValue(change, metric.unit)} since start</div>}
      <Sparkline values={values} />
      {canLog && (
        <form className="wk-metric-form" onSubmit={(e) => void submit(e)}>
          <input value={value} onChange={(e) => setValue(e.target.value)} inputMode={metric.unit === 'min' ? 'text' : 'decimal'} placeholder={metric.unit === 'min' ? 'mm:ss' : metric.unit || 'value'} aria-label={`New ${metric.name}`} />
          <button type="submit">Add</button>
        </form>
      )}
      {msg && <div className="wk-small muted">{msg}</div>}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="wk-spark" />;
  const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24 - 2}`).join(' ');
  return <svg className="wk-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

// ---------- My plan ----------

const METRIC_SUGGESTIONS: Record<string, Array<{ name: string; unit: string; better: 'up' | 'down' }>> = {
  Endurance: [{ name: '5K time', unit: 'min', better: 'down' }, { name: 'Long run', unit: 'mi', better: 'up' }, { name: 'Resting HR', unit: 'bpm', better: 'down' }],
  Strength: [{ name: 'Squat', unit: 'lb', better: 'up' }, { name: 'Bench', unit: 'lb', better: 'up' }, { name: 'Deadlift', unit: 'lb', better: 'up' }],
  'Body comp': [{ name: 'Weight', unit: 'lb', better: 'down' }, { name: 'Waist', unit: 'in', better: 'down' }, { name: 'Body fat', unit: '%', better: 'down' }],
  Consistency: [{ name: 'Workouts', unit: '', better: 'up' }, { name: 'Steps', unit: '', better: 'up' }],
  Sport: [{ name: 'Vertical', unit: 'in', better: 'up' }, { name: 'Sprint', unit: 's', better: 'down' }],
  Other: [],
};

function PlanPage() {
  const [me, setMe] = useState<WorkoutMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setMe(await api.get<WorkoutMe>('/api/workouts/me')); } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!me) return <p className="muted wk-pad">{error ?? 'Loading…'}</p>;
  return (
    <div className="wk-stack">
      <GoalForm me={me} onSaved={load} />
      <SplitForm split={me.split} onSaved={load} />
      <MetricsForm metrics={me.metrics} goalType={me.goalType} onSaved={load} />
      <MilestonesForm milestones={me.milestones} onSaved={load} />
      <SettingsForm me={me} onSaved={load} />
    </div>
  );
}

function Section({ title, children, onSave, status }: { title: string; children: ReactNode; onSave: () => void; status: string | null }) {
  return (
    <form className="wk-card wk-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <h3>{title}</h3>
      {children}
      <div className="wk-save"><button type="submit" className="primary">Save</button>{status && <span className="muted wk-small">{status}</span>}</div>
    </form>
  );
}
function useSaver(onSaved: () => void) {
  const [status, setStatus] = useState<string | null>(null);
  const save = async (fn: () => Promise<unknown>) => {
    setStatus('Saving…');
    try { await fn(); setStatus('Saved.'); onSaved(); } catch (e) { setStatus(errText(e)); }
  };
  return { status, save };
}

function GoalForm({ me, onSaved }: { me: WorkoutMe; onSaved: () => void }) {
  const [f, setF] = useState({ title: me.title, color: me.color, goalType: me.goalType, goal: me.goal, startDate: me.startDate, goalDate: me.goalDate, why: me.why });
  const { status, save } = useSaver(onSaved);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Section title="Goal" status={status} onSave={() => void save(() => api.put('/api/workouts/me', f))}>
      <div className="wk-grid2">
        <label className="cw-field"><span>Card title</span><input value={f.title} onChange={set('title')} maxLength={L.TITLE} placeholder="e.g. Marathoner" /></label>
        <label className="cw-field"><span>Card colour</span><input type="color" value={f.color} onChange={set('color')} /></label>
      </div>
      <label className="cw-field"><span>Goal type</span>
        <select value={f.goalType} onChange={set('goalType')}>{WORKOUT_GOAL_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
      </label>
      <label className="cw-field"><span>Goal</span><input value={f.goal} onChange={set('goal')} maxLength={L.GOAL} placeholder="Run a half marathon under 2 hours" /></label>
      <div className="wk-grid2">
        <label className="cw-field"><span>Start date</span><input type="date" value={f.startDate} onChange={set('startDate')} /></label>
        <label className="cw-field"><span>Goal date</span><input type="date" value={f.goalDate} onChange={set('goalDate')} /></label>
      </div>
      <label className="cw-field"><span>Why</span><textarea value={f.why} onChange={set('why')} maxLength={L.WHY} rows={2} /></label>
    </Section>
  );
}

function SplitForm({ split, onSaved }: { split: WorkoutSplitDay[]; onSaved: () => void }) {
  const [rows, setRows] = useState(split);
  const { status, save } = useSaver(onSaved);
  const edit = (i: number, patch: Partial<WorkoutSplitDay>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Section title="Weekly plan" status={status} onSave={() => void save(() => api.put('/api/workouts/me/split', rows))}>
      <p className="muted wk-small">Rest days never break your streak.</p>
      {rows.map((r, i) => (
        <div key={r.dow} className="wk-split-row">
          <span className="wk-split-day">{r.day}</span>
          <input value={r.workout} onChange={(e) => edit(i, { workout: e.target.value })} maxLength={L.WORKOUT} placeholder={r.kind === 'Rest' ? 'Rest' : 'Workout'} aria-label={`${r.day} workout`} />
          <select value={r.kind} onChange={(e) => edit(i, { kind: e.target.value as WorkoutSplitDay['kind'] })} aria-label={`${r.day} kind`}>
            {WORKOUT_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
        </div>
      ))}
    </Section>
  );
}

function MetricsForm({ metrics, goalType, onSaved }: { metrics: WorkoutMetric[]; goalType: string; onSaved: () => void }) {
  type Row = { id?: string; name: string; unit: string; better: 'up' | 'down' };
  const [rows, setRows] = useState<Row[]>(metrics.map(({ id, name, unit, better }) => ({ id, name, unit, better })));
  const { status, save } = useSaver(onSaved);
  const edit = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const suggestions = (METRIC_SUGGESTIONS[goalType] ?? []).filter((s) => !rows.some((r) => r.name.toLowerCase() === s.name.toLowerCase()));
  return (
    <Section title="Numbers to track" status={status} onSave={() => void save(() => api.put('/api/workouts/me/metrics', rows))}>
      <p className="muted wk-small">Log values from your page. A better value than any before is a PR, and the crew hears about it. Removing a number deletes its history.</p>
      {rows.map((r, i) => (
        <div key={r.id ?? `new-${i}`} className="wk-metric-row">
          <input value={r.name} onChange={(e) => edit(i, { name: e.target.value })} maxLength={L.METRIC_NAME} placeholder="Name" aria-label="Name" />
          <input value={r.unit} onChange={(e) => edit(i, { unit: e.target.value })} maxLength={L.METRIC_UNIT} placeholder="unit" aria-label="Unit" className="wk-unit" />
          <select value={r.better} onChange={(e) => edit(i, { better: e.target.value as Row['better'] })} aria-label="Better when">
            <option value="up">Higher is better</option><option value="down">Lower is better</option>
          </select>
          <button type="button" className="icon" aria-label={`Remove ${r.name || 'number'}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {rows.length < L.METRICS && (
        <div className="wk-chips">
          <button type="button" onClick={() => setRows([...rows, { name: '', unit: '', better: 'up' }])}>+ Add</button>
          {suggestions.map((s) => <button key={s.name} type="button" className="wk-chip" onClick={() => setRows([...rows, s])}>+ {s.name}</button>)}
        </div>
      )}
    </Section>
  );
}

function MilestonesForm({ milestones, onSaved }: { milestones: WorkoutMilestone[]; onSaved: () => void }) {
  const [rows, setRows] = useState(milestones);
  const { status, save } = useSaver(onSaved);
  const edit = (i: number, patch: Partial<WorkoutMilestone>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Section title="Milestones" status={status} onSave={() => void save(() => api.put('/api/workouts/me/milestones', rows))}>
      {rows.map((r, i) => (
        <div key={r.id || `new-${i}`} className="wk-milestone-row">
          <input type="checkbox" checked={r.done} onChange={(e) => edit(i, { done: e.target.checked })} aria-label="Done" />
          <input value={r.label} onChange={(e) => edit(i, { label: e.target.value })} maxLength={L.MILESTONE} placeholder="First 10K" aria-label="Milestone" />
          <input type="date" value={r.due} onChange={(e) => edit(i, { due: e.target.value })} aria-label="Due" />
          <button type="button" className="icon" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {rows.length < L.MILESTONES && <button type="button" onClick={() => setRows([...rows, { id: '', label: '', due: '', done: false }])}>+ Add milestone</button>}
    </Section>
  );
}

function SettingsForm({ me, onSaved }: { me: WorkoutMe; onSaved: () => void }) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [f, setF] = useState({ tz: me.tz, remindTime: me.remindTime, showNumbers: me.showNumbers, allowNudges: me.allowNudges, notifyCrew: me.notifyCrew });
  const { status, save } = useSaver(onSaved);
  return (
    <Section title="Reminders and privacy" status={status} onSave={() => void save(() => api.put('/api/workouts/me', f))}>
      <PushSwitch />
      <label className="cw-field"><span>Daily reminder (on planned days you haven't logged)</span>
        <input type="time" value={f.remindTime} onChange={(e) => setF({ ...f, remindTime: e.target.value })} />
      </label>
      <label className="cw-field"><span>Time zone</span>
        <span className="wk-row"><input value={f.tz} onChange={(e) => setF({ ...f, tz: e.target.value })} />
          {here && here !== f.tz && <button type="button" onClick={() => setF({ ...f, tz: here })}>Use {here}</button>}</span>
      </label>
      <label className="wk-check"><input type="checkbox" checked={f.showNumbers} onChange={(e) => setF({ ...f, showNumbers: e.target.checked })} /> Show my numbers to the crew</label>
      <label className="wk-check"><input type="checkbox" checked={f.allowNudges} onChange={(e) => setF({ ...f, allowNudges: e.target.checked })} /> Let the crew nudge me</label>
      <label className="wk-check"><input type="checkbox" checked={f.notifyCrew} onChange={(e) => setF({ ...f, notifyCrew: e.target.checked })} /> Notify me when the crew checks in, sets PRs or hits milestones</label>
    </Section>
  );
}

/** Turns phone notifications on or off for this device (web app only). */
export function PushSwitch() {
  const [state, setState] = useState<PushState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void pushState().then(setState, () => setState('unsupported')); }, []);
  if (!state || state === 'unsupported') return null;
  const run = async (fn: () => Promise<PushState>) => { setMsg(null); try { setState(await fn()); } catch (e) { setMsg(errText(e)); } };
  return (
    <div className="wk-push">
      {state === 'needs-install' && <p className="muted wk-small">To get notifications on iPhone, add Chatward to your home screen (Share, then Add to Home Screen) and open it from there.</p>}
      {state === 'denied' && <p className="muted wk-small">Notifications are blocked. Turn them on for Chatward in your phone's Settings.</p>}
      {state === 'off' && <button type="button" className="primary" onClick={() => void run(enablePush)}>Turn on notifications</button>}
      {state === 'on' && (
        <span className="wk-row">
          <span>🔔 Notifications are on for this device.</span>
          <button type="button" onClick={() => void testPush().then((r) => setMsg(r.delivered ? 'Test sent.' : 'Could not deliver.'), (e) => setMsg(errText(e)))}>Test</button>
          <button type="button" onClick={() => void run(disablePush)}>Turn off</button>
        </span>
      )}
      {msg && <p className="muted wk-small">{msg}</p>}
    </div>
  );
}

// ---------- helpers ----------

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function parseValue(raw: string, unit: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (unit === 'min' && s.includes(':')) {
    const [mm, ss] = s.split(':').map(Number);
    return Number.isFinite(mm) && Number.isFinite(ss) && ss >= 0 && ss < 60 ? mm + ss / 60 : null;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
export function fmtValue(v: number, unit: string): string {
  if (unit === 'min') { const neg = v < 0; const a = Math.abs(v); const mm = Math.floor(a); const ss = Math.round((a - mm) * 60); return `${neg ? '-' : ''}${mm}:${String(ss).padStart(2, '0')}`; }
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${unit ? ' ' + unit : ''}`;
}
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
