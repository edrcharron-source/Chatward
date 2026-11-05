import { useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import VaultCard from '../vault/VaultCard';
import type { Message, MessagePayload, ReplyRef, User } from '@chatward/shared';
import { AttachmentView, GifView, LinkPreviewCard } from '../media';
import { deleteMessage, editMessage, startReply, useChat } from '../../state/chat';
import { guestMember } from '../../state/guests';
import { snippetOf } from '../../state/replies';
import { jumpTo } from '../../state/search';
import MessageMenu, { type MenuItem } from './MessageMenu';
import { pings } from '../../state/mentions';
import { useSession } from '../../state/session';
import { useSettings } from '../../state/settings';
import { useConfirm } from '../confirm/ConfirmDialog';
import Avatar from './Avatar';
import MessageText, { isEmojiOnly } from './MessageText';
import ProfileTrigger from '../profile/ProfileTrigger';
import JamCards, { jamLinks } from '../spotify/JamCard';
import ListenAlongCard from '../spotify/ListenAlongCard';

interface Props {
  message: Message;
  /** undefined = not decrypted yet, null = key not available */
  payload?: MessagePayload | null;
  author?: User;
  grouped: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** The server the message is in, so GIFs in it can be saved to that server's GIF library. */
  serverId?: string;
  /** Lit up for a moment, after a jump from search or from a reply's quote. */
  flash?: boolean;
}

/** How far (px) a message must be swiped left on a touch screen to start a reply. */
const SWIPE_REPLY_PX = 64;
const SWIPE_MAX_PX = 90;
/** Right-clicks on these keep their own menu (pictures) or the normal one (text boxes). */
const OWN_MENU = 'img.media-image, img.media-gif, textarea, input';

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function MessageItem({ message, payload, author, grouped, canEdit, canDelete, serverId, flash }: Props) {
  const [editing, setEditing] = useState(false);
  const meId = useSession((s) => s.user?.id);
  // Someone else's message that pings this user (by name or @everyone) is lit up for them.
  // @everyone lights up for everyone, the sender included. A named mention pings the person named, not the sender.
  const pinged = !!payload && (!!payload.mentions?.everyone || (message.authorId !== meId && pings(payload.mentions, meId)));
  const members = useSession((s) => (serverId ? s.servers.find((b) => b.server.id === serverId)?.members : undefined));
  // The names this message pings, so they can be shown as pills.
  const mentionNames = payload?.mentions
    ? [
        ...(payload.mentions.everyone ? ['everyone'] : []),
        ...(members ?? []).filter((m) => payload.mentions?.userIds.includes(m.user.id)).map((m) => m.user.displayName),
      ]
    : undefined;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canStartEdit = canEdit && payload != null;
  const canReply = payload != null;
  const [menu, setMenu] = useState<{ doc: Document; x: number; y: number } | null>(null);

  const reply = () => {
    if (!payload) return;
    startReply(message.channelId, {
      messageId: message.id,
      authorId: author?.id ?? message.authorId,
      createdAt: message.createdAt,
      snippet: snippetOf(payload),
    });
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (editing || (e.target as Element).closest?.(OWN_MENU)) return;
    e.preventDefault();
    setMenu({ doc: e.currentTarget.ownerDocument, x: e.clientX, y: e.clientY });
  };

  // Phones: swipe a message to the left to reply to it (like other chat apps). Only touches count, not a mouse.
  const swipe = useRef<{ id: number; x: number; y: number; on: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' || !canReply || editing) return;
    swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (!s.on) {
      // Decide once: a mostly-sideways drag to the left is a swipe; anything else is the list scrolling.
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (mx > -10 || Math.abs(my) > Math.abs(mx)) { swipe.current = null; return; }
      s.on = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    setDx(Math.max(-SWIPE_MAX_PX, Math.min(0, mx)));
  };
  const endSwipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    swipe.current = null;
    if (s.on && dx <= -SWIPE_REPLY_PX && e.type === 'pointerup') {
      reply();
      navigator.vibrate?.(10);
    }
    setDx(0);
  };

  const menuItems: MenuItem[] = [
    ...(canReply ? [{ label: 'Reply', onPick: reply }] : []),
    ...(payload?.text ? [{ label: 'Copy text', onPick: () => { void navigator.clipboard?.writeText(payload.text).catch(() => {}); } }] : []),
    ...(canStartEdit ? [{ label: 'Edit', onPick: () => startEdit() }] : []),
    ...(canDelete ? [{ label: 'Delete', onPick: () => void remove(), danger: true }] : []),
  ];

  const startEdit = () => {
    setDraft(payload?.text ?? '');
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      await editMessage(message, text);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save edit');
    }
  };

  const onEditKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  const confirm = useConfirm();
  const remove = async () => {
    if (useSettings.getState().confirmDeleteMessages) {
      const r = await confirm({
        title: 'Delete this message?',
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
        checkboxLabel: "Don't ask me again",
      });
      if (!r.ok) return;
      if (r.checked) useSettings.getState().set({ confirmDeleteMessages: false });
    }
    setError(null);
    deleteMessage(message).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not delete'));
  };

  let body;
  if (payload === undefined) body = <div className="cv-muted">Decrypting…</div>;
  else if (payload === null) body = <div className="cv-muted">🔒 Waiting for this channel's key…</div>;
  else {
    // A link that became a Join Jam card doesn't also get the plain "spotify.link / Spotify" preview.
    const jamLinkSet = new Set(jamLinks(payload).map((j) => j.link));
    body = (
      <>
        {payload.text && (
          <div className={`cv-text${isEmojiOnly(payload.text) ? ' cv-text-emoji' : ''}`}>
            <MessageText text={payload.text} names={mentionNames} />
            {message.editedAt != null && <span className="cv-edited"> (edited)</span>}
          </div>
        )}
        <JamCards payload={payload} />
        {payload.listenAlong && author && <ListenAlongCard host={author} serverId={serverId} />}
        {payload.attachments?.map((a) => <AttachmentView key={a.uploadId} attachment={a} serverId={serverId} />)}
        {payload.vault?.map((v) => <VaultCard key={v.itemId} v={v} />)}
        {payload.gif && <GifView gif={payload.gif} serverId={serverId} openable />}
        {payload.linkPreviews?.filter((p) => !jamLinkSet.has(p.url)).map((p) => <LinkPreviewCard key={p.url} preview={p} />)}
      </>
    );
  }

  const swiping = dx !== 0;
  return (
    <div
      className={`cv-msg${grouped ? ' cv-grouped' : ''}${flash ? ' cv-flash' : ''}${pinged ? ' cv-pinged' : ''}${payload?.replyTo ? ' cv-is-reply' : ''}${swiping ? ' cv-swiping' : ''}`}
      data-message-id={message.id}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
      style={swiping ? { transform: `translateX(${dx}px)` } : undefined}
    >
      {swiping && (
        <span className={`cv-swipe-reply${dx <= -SWIPE_REPLY_PX ? ' cv-swipe-ready' : ''}`} style={{ right: dx }} aria-hidden="true">
          <ReplyIcon />
        </span>
      )}
      {payload?.replyTo && <ReplyQuote reply={payload.replyTo} channelId={message.channelId} serverId={serverId} />}
      {grouped ? (
        <time className="cv-time-gutter">{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
      ) : (
        author ? <ProfileTrigger user={author}><Avatar user={author} /></ProfileTrigger> : <Avatar user={author} />
      )}
      <div className="cv-msg-main">
        {!grouped && (
          <div className="cv-msg-head">
            {author
              ? <ProfileTrigger user={author} className="cv-name"><span>{author.displayName}</span></ProfileTrigger>
              : <span className="cv-name">Unknown user</span>}
            <time className="cv-time">{formatTime(message.createdAt)}</time>
          </div>
        )}
        {editing ? (
          <div className="cv-edit">
            <textarea
              className="cv-edit-input"
              value={draft}
              autoFocus
              rows={2}
              aria-label="Edit message"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKey}
            />
            <div className="cv-edit-hint muted">Enter to save · Esc to cancel</div>
          </div>
        ) : (
          body
        )}
        {error && <div className="cv-error">{error}</div>}
      </div>
      {!editing && (canReply || canStartEdit || canDelete) && (
        <div className="cv-actions">
          {canReply && (
            <button className="icon" title="Reply" aria-label="Reply" onClick={reply}><ReplyIcon /></button>
          )}
          {canStartEdit && (
            <button className="icon" title="Edit" aria-label="Edit message" onClick={startEdit}>✎</button>
          )}
          {canDelete && (
            <button className="icon" title="Delete" aria-label="Delete message" onClick={remove}>🗑</button>
          )}
        </div>
      )}
      {menu && menuItems.length > 0 && <MessageMenu doc={menu.doc} x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ReplyIcon() {
  return (
    <svg className="cv-reply-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

/**
 * The quote above a reply: who it answers and their first words. Clicking it scrolls back to the original
 * (loading older messages if needed) and lights it up. Uses the original as it is now when it's loaded,
 * so an edit shows; otherwise the copy the reply carries.
 */
function ReplyQuote({ reply, channelId, serverId }: { reply: ReplyRef; channelId: string; serverId?: string }) {
  const original = useChat((s) => s.payloads[reply.messageId]);
  const loaded = useChat((s) => s.channels[channelId]?.messages.some((m) => m.id === reply.messageId) ?? false);
  const meId = useSession((s) => s.user?.id);
  const person = useSession((s) => (serverId ? s.servers.find((b) => b.server.id === serverId)?.members.find((m) => m.user.id === reply.authorId)?.user : undefined))
    ?? guestMember(reply.authorId)?.user;
  const snippet = loaded && original && !original.chatter ? snippetOf(original) : reply.snippet;
  const name = person?.displayName ?? 'Someone';
  return (
    <button
      type="button"
      className={`cv-reply-quote${reply.authorId === meId ? ' cv-reply-me' : ''}`}
      title="Jump to the original message"
      aria-label={`Reply to ${name}: ${snippet}. Jump to the original message`}
      onClick={() => jumpTo({ channelId, id: reply.messageId, createdAt: reply.createdAt })}
    >
      <span className="cv-reply-spine" aria-hidden="true" />
      {person && <Avatar user={person} size={16} />}
      <span className="cv-reply-name">{reply.authorId === meId ? `@${name}` : name}</span>
      <span className="cv-reply-snippet">{snippet}</span>
    </button>
  );
}
