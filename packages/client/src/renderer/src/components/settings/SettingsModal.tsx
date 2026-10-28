import { useEffect, useState } from 'react';
import { useSession } from '../../state/session';
import { useVoice } from '../../state/voice';
import AccountTab from './AccountTab';
import AppearanceTab from './AppearanceTab';
import VoiceVideoTab from './VoiceVideoTab';
import NotificationsTab from './NotificationsTab';
import PrivacyTab from './PrivacyTab';
import SecurityTab from './SecurityTab';
import './settings.css';

const TABS = [
  { id: 'account', label: 'Account', Panel: AccountTab },
  { id: 'appearance', label: 'Appearance', Panel: AppearanceTab },
  { id: 'voice', label: 'Voice & Video', Panel: VoiceVideoTab },
  { id: 'notifications', label: 'Notifications', Panel: NotificationsTab },
  { id: 'privacy', label: 'Privacy', Panel: PrivacyTab },
  { id: 'security', label: 'Security', Panel: SecurityTab },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('account');
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function logOut() {
    try { await useVoice.getState().leave(); } catch { /* leaving is best effort */ }
    useSession.getState().logout();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              className={tab === t.id ? 'active' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          <div className="spacer" />
          <button type="button" className="danger" onClick={logOut}>Log out</button>
        </nav>

        <section className="settings-body" role="tabpanel" aria-label={current.label}>
          <h2>{current.label}</h2>
          <current.Panel />
        </section>

        <button type="button" className="icon settings-close" aria-label="Close settings" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
