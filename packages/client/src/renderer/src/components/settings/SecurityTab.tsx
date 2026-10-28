import { useEffect, useMemo, useState } from 'react';
import type { Member } from '@chatward/shared';
import { safetyNumber } from '../../crypto';
import { useSession } from '../../state/session';
import { Section } from './controls';

export default function SecurityTab() {
  const servers = useSession((s) => s.servers);

  // Each person once, even if they share several servers with you.
  const people = useMemo(() => {
    const seen = new Map<string, Member>();
    for (const b of servers) for (const m of b.members) if (!seen.has(m.user.id)) seen.set(m.user.id, m);
    return [...seen.values()];
  }, [servers]);

  const [numbers, setNumbers] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    (async () => {
      const out: Record<string, string> = {};
      for (const m of people) out[m.user.id] = m.devices.length ? await safetyNumber(m.devices) : '';
      if (active) setNumbers(out);
    })().catch(() => {});
    return () => { active = false; };
  }, [people]);

  return (
    <Section title="Safety numbers">
      <p className="muted">
        Compare a safety number with a friend over a call or in person. If they match, nobody is intercepting your chats.
      </p>
      {people.length === 0 && <p className="muted">Join a server to see member safety numbers.</p>}
      {people.map((m) => (
        <div key={m.user.id} className="setting-section">
          <strong>{m.user.displayName}</strong>
          <div className="safety-number" aria-label={`Safety number for ${m.user.displayName}`}>
            {numbers[m.user.id] || (m.devices.length ? '…' : 'No devices registered')}
          </div>
        </div>
      ))}
    </Section>
  );
}
