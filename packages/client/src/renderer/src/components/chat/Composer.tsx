import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { EmojiPickerButton, GifPickerButton, GifView } from '../media';
import ListenAlongButton from '../spotify/ListenAlongButton';
import type { Member, ReplyRef } from '@chatward/shared';
import { guestMember } from '../../state/guests';
import { cancelReply, sendMessage, sendTyping, useChat, type Gif } from '../../state/chat';
import { activeMention, mentionOptions, type MentionOption } from '../../state/mentions';
import { useSession } from '../../state/session';

const MAX_FILES = 10;
const NO_MEMBERS: Member[] = [];

interface Props {
  channelId: string;
  channelName: string;
  serverId: string;
  onSent: () => void;
}

export default function Composer({ channelId, channelName, serverId, onSent }: Props) {
  const text = useChat((s) => s.drafts[channelId] ?? '');
  const setDraft = useChat((s) => s.setDraft);
  const [files, setFiles] = useState<File[]>([]);
  const [gif, setGif] = useState<Gif | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  /** The @ the picker was closed on with Escape, so it stays closed while that @ is still being typed. */
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const members = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members ?? NO_MEMBERS);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replyTo = useChat((s) => s.replying[channelId]);
  // Picking Reply on a message puts the caret in the box, ready to type.
  useEffect(() => { if (replyTo) inputRef.current?.focus(); }, [replyTo?.messageId]);

  const addFiles = (picked: File[]) => setFiles((cur) => [...cur, ...picked].slice(0, MAX_FILES));
  const canSend = !busy && (text.trim() !== '' || files.length > 0 || gif !== null);

  // The @ picker: open while an @ is being typed before the caret and at least one name matches.
  const pos = Math.min(caret, text.length);
  const mention = activeMention(text, pos);
  const options = mention && mention.at !== closedAt ? mentionOptions(mention.query, members) : [];
  const picking = options.length > 0;
  const current = Math.min(picked, options.length - 1);

  const pick = (opt: MentionOption) => {
    if (!mention) return;
    const insert = `@${opt.name} `;
    onChange(text.slice(0, mention.at) + insert + text.slice(pos));
    const next = mention.at + insert.length;
    setCaret(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next, next);
    });
  };

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    const sentText = text;
    const sentFiles = files;
    const sentGif = gif;
    const sentReply = replyTo;
    try {
      await sendMessage(channelId, { text: sentText.trim(), files: sentFiles, gif: sentGif ?? undefined, replyTo: sentReply });
      if (sentReply && useChat.getState().replying[channelId] === sentReply) cancelReply(channelId);
      // Only remove what was sent. Anything typed, attached or picked while the send was in flight stays.
      const latest = useChat.getState().drafts[channelId] ?? '';
      if (latest.startsWith(sentText)) setDraft(channelId, latest.slice(sentText.length));
      setFiles((cur) => cur.filter((f) => !sentFiles.includes(f)));
      setGif((cur) => (cur === sentGif ? null : cur));
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking && mention) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setPicked((current + step + options.length) % options.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pick(options[current]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setClosedAt(mention.at);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      cancelReply(channelId);
    }
  };

  const onChange = (value: string) => {
    setDraft(channelId, value);
    setPicked(0);
    if (value) sendTyping(channelId);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    onChange(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      const pos = start + emoji.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div
      className={`cv-composer${dragging ? ' cv-dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {(files.length > 0 || gif) && (
        <div className="cv-chips">
          {files.map((f, i) => {
            const remove = () => setFiles((cur) => cur.filter((_, j) => j !== i));
            return f.type.startsWith('image/') ? (
              <PendingImage key={`${f.name}-${i}`} file={f} onRemove={remove} />
            ) : (
              <span key={`${f.name}-${i}`} className="cv-chip">
                {f.name}
                <button className="icon" aria-label={`Remove ${f.name}`} onClick={remove}>×</button>
              </span>
            );
          })}
          {gif && (
            <span className="cv-chip cv-gif-chip">
              <GifView gif={gif} />
              <button className="icon" aria-label="Remove GIF" onClick={() => setGif(null)}>×</button>
            </span>
          )}
        </div>
      )}
      {error && <div className="cv-error">{error}</div>}
      {replyTo && <ReplyBar channelId={channelId} replyTo={replyTo} serverId={serverId} />}
      {picking && (
        <div className="cv-mention-picker" role="listbox" aria-label="Mention someone">
          {options.map((o, i) => (
            <button
              type="button"
              key={o.everyone ? 'everyone' : o.userId}
              role="option"
              aria-selected={i === current}
              className={`cv-mention-opt${i === current ? ' cv-mention-on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setPicked(i)}
              onClick={() => pick(o)}
            >
              <span className="cv-mention-name">{o.everyone ? '@everyone' : o.name}</span>
              <span className="cv-mention-note">{o.note}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cv-row">
        <button className="icon cv-tool" title="Attach files" aria-label="Attach files" onClick={() => fileRef.current?.click()}>📎</button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(Array.from(e.target.files));
            e.target.value = '';
          }}
        />
        <textarea
          ref={inputRef}
          className="cv-input"
          rows={1}
          value={text}
          placeholder={`Message #${channelName}`}
          aria-label="Message"
          onChange={(e) => { setCaret(e.target.selectionStart); onChange(e.target.value); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <ListenAlongButton channelId={channelId} onError={setError} />
        <GifPickerButton serverId={serverId} onPick={setGif} />
        <EmojiPickerButton onPick={insertEmoji} />
        <button className="primary cv-send" disabled={!canSend} onClick={() => void submit()}>Send</button>
      </div>
    </div>
  );
}

/** A picture waiting to be sent: a small preview of it, with its name on hover and a button to take it off. */
function PendingImage({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    setBroken(false);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <span className="cv-chip cv-thumb" title={file.name}>
      {url && !broken ? (
        <img src={url} alt={file.name} draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className="cv-thumb-name">{file.name}</span>
      )}
      <button className="icon cv-thumb-x" aria-label={`Remove ${file.name}`} onClick={onRemove}>×</button>
    </span>
  );
}

/** "Replying to Name" above the message box, with the original's first words and an X to stop replying. */
function ReplyBar({ channelId, replyTo, serverId }: { channelId: string; replyTo: ReplyRef; serverId: string }) {
  const name = useSession((s) => s.servers.find((b) => b.server.id === serverId)?.members.find((m) => m.user.id === replyTo.authorId)?.user.displayName);
  const guestName = guestMember(replyTo.authorId)?.user.displayName;
  return (
    <div className="cv-replybar" role="status">
      <span className="cv-replybar-text">
        Replying to <strong>{name ?? guestName ?? 'someone'}</strong>
        <span className="cv-replybar-snippet"> {replyTo.snippet}</span>
      </span>
      <button type="button" className="icon cv-replybar-x" aria-label="Cancel reply" title="Cancel reply (Esc)" onClick={() => cancelReply(channelId)}>×</button>
    </div>
  );
}
