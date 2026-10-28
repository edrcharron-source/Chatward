import { useState, type KeyboardEvent } from 'react';
import type { Message, MessagePayload, User } from '@chatward/shared';
import { AttachmentView, GifView, LinkPreviewCard } from '../media';
import { deleteMessage, editMessage } from '../../state/chat';
import Avatar from './Avatar';
import MessageText from './MessageText';
import ProfileTrigger from '../profile/ProfileTrigger';

interface Props {
  message: Message;
  /** undefined = not decrypted yet, null = key not available */
  payload?: MessagePayload | null;
  author?: User;
  grouped: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function MessageItem({ message, payload, author, grouped, canEdit, canDelete }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canStartEdit = canEdit && payload != null;

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

  const remove = () => {
    if (!window.confirm('Delete this message?')) return;
    setError(null);
    deleteMessage(message).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not delete'));
  };

  let body;
  if (payload === undefined) body = <div className="cv-muted">Decrypting…</div>;
  else if (payload === null) body = <div className="cv-muted">🔒 Waiting for this channel's key…</div>;
  else {
    body = (
      <>
        {payload.text && (
          <div className="cv-text">
            <MessageText text={payload.text} />
            {message.editedAt != null && <span className="cv-edited"> (edited)</span>}
          </div>
        )}
        {payload.attachments?.map((a) => <AttachmentView key={a.uploadId} attachment={a} />)}
        {payload.gif && <GifView gif={payload.gif} />}
        {payload.linkPreviews?.map((p) => <LinkPreviewCard key={p.url} preview={p} />)}
      </>
    );
  }

  return (
    <div className={`cv-msg${grouped ? ' cv-grouped' : ''}`}>
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
      {!editing && (canStartEdit || canDelete) && (
        <div className="cv-actions">
          {canStartEdit && (
            <button className="icon" title="Edit" aria-label="Edit message" onClick={startEdit}>✎</button>
          )}
          {canDelete && (
            <button className="icon" title="Delete" aria-label="Delete message" onClick={remove}>🗑</button>
          )}
        </div>
      )}
    </div>
  );
}
