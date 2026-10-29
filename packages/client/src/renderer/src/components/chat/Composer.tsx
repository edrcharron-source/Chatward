import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { EmojiPickerButton, GifPickerButton, GifView } from '../media';
import { sendMessage, sendTyping, useChat, type Gif } from '../../state/chat';

const MAX_FILES = 10;

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = (picked: File[]) => setFiles((cur) => [...cur, ...picked].slice(0, MAX_FILES));
  const canSend = !busy && (text.trim() !== '' || files.length > 0 || gif !== null);

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    const sentText = text;
    const sentFiles = files;
    const sentGif = gif;
    try {
      await sendMessage(channelId, { text: sentText.trim(), files: sentFiles, gif: sentGif ?? undefined });
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onChange = (value: string) => {
    setDraft(channelId, value);
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
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="cv-chip">
              {f.name}
              <button
                className="icon"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
              >×</button>
            </span>
          ))}
          {gif && (
            <span className="cv-chip cv-gif-chip">
              <GifView gif={gif} />
              <button className="icon" aria-label="Remove GIF" onClick={() => setGif(null)}>×</button>
            </span>
          )}
        </div>
      )}
      {error && <div className="cv-error">{error}</div>}
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
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <GifPickerButton serverId={serverId} onPick={setGif} />
        <EmojiPickerButton onPick={insertEmoji} />
        <button className="primary cv-send" disabled={!canSend} onClick={() => void submit()}>Send</button>
      </div>
    </div>
  );
}
