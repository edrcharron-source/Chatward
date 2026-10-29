import { useEffect, useState, type ComponentType } from 'react';
import { signOut } from '../../state/session';
import { SETTINGS_TABS, type SettingsTabId } from '../../layout/manifest';
import AccountTab from './AccountTab';
import AppearanceTab from './AppearanceTab';
import VoiceVideoTab from './VoiceVideoTab';
import NotificationsTab from './NotificationsTab';
import PrivacyTab from './PrivacyTab';
import SecurityTab from './SecurityTab';
import './settings.css';

// Panels by tab id. The order and labels come from the layout manifest.
const PANELS: Record<SettingsTabId, ComponentType> = {
  account: AccountTab,
  appearance: AppearanceTab,
  voice: VoiceVideoTab,
  notifications: NotificationsTab,
  privacy: PrivacyTab,
  security: SecurityTab,
};

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTabId>('account');
  const current = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];
  const Panel = PANELS[current.id];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function logOut() {
    void signOut();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          {SETTINGS_TABS.map((t) => (
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
          <Panel />
        </section>

        <button type="button" className="icon settings-close" aria-label="Close settings" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
