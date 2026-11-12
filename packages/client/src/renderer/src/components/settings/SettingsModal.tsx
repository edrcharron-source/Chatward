import { useEffect, useState } from 'react';
import { signOut } from '../../state/session';
import AccountTab from './AccountTab';
import AppearanceTab from './AppearanceTab';
import VoiceVideoTab from './VoiceVideoTab';
import NotificationsTab from './NotificationsTab';
import PrivacyTab from './PrivacyTab';
import SecurityTab from './SecurityTab';
import { usePhone } from '../../web/usePhone';
import PixelIcon, { type PixelIconName } from '../icons/PixelIcon';
import { SheetRow } from '../phone/Sheet';
import './settings.css';
import '../phone/phone.css';

const TABS = [
  { id: 'account', label: 'Account', Panel: AccountTab, icon: 'user' as PixelIconName },
  { id: 'appearance', label: 'Appearance', Panel: AppearanceTab, icon: 'palette' as PixelIconName },
  { id: 'voice', label: 'Voice & Video', Panel: VoiceVideoTab, icon: 'mic' as PixelIconName },
  { id: 'notifications', label: 'Notifications', Panel: NotificationsTab, icon: 'bell' as PixelIconName },
  { id: 'privacy', label: 'Privacy', Panel: PrivacyTab, icon: 'eye' as PixelIconName },
  { id: 'security', label: 'Security', Panel: SecurityTab, icon: 'lock' as PixelIconName },
] as const;

export type SettingsTabId = (typeof TABS)[number]['id'];

export default function SettingsModal({ onClose, initialTab = 'account' }: { onClose: () => void; initialTab?: SettingsTabId }) {
  const phone = usePhone();
  if (phone) return <PhoneSettings onClose={onClose} initialTab={initialTab} />;
  return <DesktopSettings onClose={onClose} initialTab={initialTab} />;
}

/**
 * Settings on a phone: a full-screen page with a list of sections, like the iPhone Settings app. Tapping one opens it,
 * and Back returns to the list. Opened straight on a section (Notifications from the welcome card), Back still works.
 */
function PhoneSettings({ onClose, initialTab }: { onClose: () => void; initialTab: SettingsTabId }) {
  // Opening on the first section means "Settings" in general, so the list shows first.
  const [tab, setTab] = useState<SettingsTabId | null>(initialTab === 'account' ? null : initialTab);
  const current = tab ? TABS.find((t) => t.id === tab) ?? null : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (tab) setTab(null); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, tab]);
  return (
    <div className="cw-page" role="dialog" aria-modal="true" aria-label={current ? current.label : 'Settings'}>
      <header className="cw-page-head">
        {current
          ? <button type="button" className="cw-page-back" onClick={() => setTab(null)}>‹ Settings</button>
          : <span />}
        <strong>{current ? current.label : 'Settings'}</strong>
        <button type="button" className="cw-sheet-done" onClick={onClose}>Done</button>
      </header>
      <div className="cw-page-body settings-body">
        {current ? <current.Panel /> : (
          <>
            <div className="cw-row-group">
              {TABS.map((t) => (
                <SheetRow key={t.id} icon={<PixelIcon name={t.icon} size={18} />} label={t.label} onClick={() => setTab(t.id)} />
              ))}
            </div>
            <div className="cw-row-group">
              <SheetRow label="Log out" danger chevron={false} onClick={() => void signOut()} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DesktopSettings({ onClose, initialTab }: { onClose: () => void; initialTab: SettingsTabId }) {
  const [tab, setTab] = useState<SettingsTabId>(initialTab);
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

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
