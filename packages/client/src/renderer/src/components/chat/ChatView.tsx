import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Channel, Member } from '@chatward/shared';
import { useSession } from '../../state/session';
import { loadHistory, useChat } from '../../state/chat';
import { isGuest, useGuestMembers, useGuests, type GuestMessage } from '../../state/guests';
import Composer from './Composer';
import MessageItem from './MessageItem';
import './chat.css';

const GROUP_MS = 5 * 60_000;
const TYPING_MS = 5_000;
const NEAR_BOTTOM_PX = 120;
const NEAR_TOP_PX = 80;
const NO_MEMBERS: Member[] = [];
const NO_GUEST_MESSAGES: GuestMessage[] = [];

function typingLabel(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing…`;
  return 'Several people are typing…';
}

export default function ChatView({ channel }: { channel: Channel }) {
  const chat = useChat((s) => s.channels[channel.id]);
  const payloads = useChat((s) => s.payloads);
  const typing = useChat((s) => s.typing[channel.id]);
  const me = useSession((s) => s.user);
  const accounts = useSession((s) => s.servers.find((b) => b.server.id === channel.serverId)?.members ?? NO_MEMBERS);
  const guests = useGuestMembers(channel.serverId);
  const members = guests.length ? [...accounts, ...guests] : accounts;
  const guestMessages = useGuests((s) => s.messages[channel.id] ?? NO_GUEST_MESSAGES);
  const [now, setNow] = useState(() => Date.now());

  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Scroll bookkeeping: remember the first message and height so a prepended page keeps the view in place.
  const prev = useRef<{ channelId: string; firstId?: string; height: number }>({ channelId: channel.id, height: 0 });

  // Guest lines are shown among the channel's messages but are not part of its history.
  const guestPayloads = new Map(guestMessages.map((g) => [g.message.id, g.payload]));
  const messages = guestMessages.length
    ? [...(chat?.messages ?? []), ...guestMessages.map((g) => g.message)].sort((a, b) => a.createdAt - b.createdAt)
    : chat?.messages ?? [];
  // From history only, so a guest line never looks like a prepended older page.
  const firstId = chat?.messages[0]?.id;
  const myRole = members.find((m) => m.user.id === me?.id)?.role;
  const memberOf = (id: string) => members.find((m) => m.user.id === id);

  useEffect(() => {
    stick.current = true;
    useSession.getState().clearUnread(channel.id);
    // The failure is kept in the channel's store entry, so it shows here and the reconnect retry can clear it.
    loadHistory(channel.id).catch(() => {});

    // Reading the channel clears its unread count, including when the window regains focus.
    // The chat may be drawn in a popped-out window, so watch that window rather than the main one.
    const doc = listRef.current?.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    const markRead = () => { if (!doc.hidden) useSession.getState().clearUnread(channel.id); };
    doc.addEventListener('visibilitychange', markRead);
    win.addEventListener('focus', markRead);
    return () => {
      doc.removeEventListener('visibilitychange', markRead);
      win.removeEventListener('focus', markRead);
    };
  }, [channel.id]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const p = prev.current;
    if (p.channelId !== channel.id) {
      el.scrollTop = el.scrollHeight;
    } else if (p.firstId !== undefined && firstId !== p.firstId) {
      // Older page prepended: keep the reader's position.
      el.scrollTop += el.scrollHeight - p.height;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prev.current = { channelId: channel.id, firstId, height: el.scrollHeight };
  }, [channel.id, firstId, messages.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < NEAR_TOP_PX && chat?.hasMore) {
      loadHistory(channel.id, 'older').catch(() => {});
    }
  };

  const names = Object.entries(typing ?? {})
    .filter(([id, t]) => id !== me?.id && now - t < TYPING_MS)
    .map(([id]) => memberOf(id)?.user.displayName ?? 'Someone');

  return (
    <div className="cv-root">
      <header className="cv-header">
        <span className="cv-hash">#</span>
        <span className="cv-title">{channel.name}</span>
      </header>

      <div className="cv-list" ref={listRef} onScroll={onScroll}>
        {chat?.hasMore === false && chat.loaded && (
          <div className="cv-start">This is the start of #{channel.name}</div>
        )}
        {chat?.loadingOlder && <div className="cv-hint muted">Loading older messages…</div>}
        {(chat?.error || chat?.olderError) && (
          <div className="cv-error">
            {chat.error ?? chat.olderError}
            <button
              className="cv-retry"
              disabled={chat.loading}
              onClick={() => loadHistory(channel.id, chat.loaded ? 'older' : 'initial').catch(() => {})}
            >
              Retry
            </button>
          </div>
        )}
        {chat?.loaded && messages.length === 0 && <div className="cv-empty muted">No messages yet. Say hi 👋</div>}
        {messages.map((m, i) => {
          const before = messages[i - 1];
          const grouped = !!before && before.authorId === m.authorId && m.createdAt - before.createdAt < GROUP_MS;
          const canDelete = !isGuest(m.authorId) && (m.authorId === me?.id || myRole === 'owner' || myRole === 'admin');
          return (
            <MessageItem
              key={m.id}
              message={m}
              payload={guestPayloads.get(m.id) ?? payloads[m.id]}
              author={memberOf(m.authorId)?.user}
              grouped={grouped}
              canEdit={m.authorId === me?.id}
              canDelete={canDelete}
              serverId={channel.serverId}
            />
          );
        })}
      </div>

      <div className="cv-typing muted" aria-live="polite">{typingLabel(names)}</div>
      <Composer channelId={channel.id} channelName={channel.name} serverId={channel.serverId} onSent={() => { stick.current = true; }} />
    </div>
  );
}
