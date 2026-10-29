import { Fragment, useEffect, useState, type ComponentType } from 'react';
import { signOut } from '../../state/session';
import { SETTINGS_TABS, type SettingsTabId } from '../../layout/manifest';
import { useLayout } from '../../layout/useLayout';
import AccountTab from './AccountTab';
import AppearanceTab from './AppearanceTab';
import VoiceVideoTab from './VoiceVideoTab';
import NotificationsTab from './NotificationsTab';
import PrivacyTab from './PrivacyTab';
import SecurityTab from './SecurityTab';
import './settings.css';

// Panels and labels by tab id. The order and grouping come from the active layout.
const PANELS: Record<SettingsTabId, ComponentType> = {
  account: AccountTab,
  appearance: AppearanceTab,
  voice: VoiceVideoTab,
  notifications: NotificationsTab,
  privacy: PrivacyTab,
  security: SecurityTab,
};
const LABELS = Object.fromEntries(SETTINGS_TABS.map((t) => [t.id, t.label])) as Record<SettingsTabId, string>;

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const layout = useLayout();
  const [tab, setTab] = useState<SettingsTabId>(() => layout.settingsGroups[0].tabs[0]);
  const Panel = PANELS[tab];

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
          {layout.settingsGroups.map((group) => (
            <Fragment key={group.id}>
              {group.label && <div className="settings-group-label" role="presentation">{group.label}</div>}
              {group.tabs.map((id) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id}
                  className={tab === id ? 'active' : undefined} onClick={() => setTab(id)}>
                  {LABELS[id]}
                </button>
              ))}
            </Fragment>
          ))}
          <div className="spacer" />
          <button type="button" className="danger" onClick={logOut}>Log out</button>
        </nav>

        <section className="settings-body" role="tabpanel" aria-label={LABELS[tab]}>
          <h2>{LABELS[tab]}</h2>
          <Panel />
        </section>

        <button type="button" className="icon settings-close" aria-label="Close settings" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
