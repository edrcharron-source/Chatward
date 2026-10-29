import type { ReactNode } from 'react';

// Markdown-lite: code blocks, `code`, **bold**, *italic*, ~~strike~~, and bare links.
// Built as React nodes only, so message text never reaches innerHTML.
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|~~([^~\n]+)~~|(https?:\/\/[^\s<>"]+)/g;
const FENCE = /```([\s\S]*?)```/g;
const TRAILING_PUNCT = /[.,!?;:)\]]+$/;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    let end = start + m[0].length;
    if (start > last) out.push(text.slice(last, start));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{m[3]}</em>);
    else if (m[4] !== undefined) out.push(<s key={k}>{m[4]}</s>);
    else if (m[5] !== undefined) {
      // Keep sentence punctuation outside the link.
      const url = m[5].replace(TRAILING_PUNCT, '');
      end = start + url.length;
      out.push(
        <a key={k} href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>,
      );
    }
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(text: string, key: string): ReactNode[] {
  return text.split('\n').flatMap((line, i) => {
    const nodes = inline(line, `${key}-${i}`);
    return i === 0 ? nodes : [<br key={`${key}-br-${i}`} />, ...nodes];
  });
}

export default function MessageText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(FENCE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(...lines(text.slice(last, start), `t${i}`));
    // Drop the single newline right after the opening fence, if any.
    const code = m[1].replace(/^\n/, '').replace(/\n$/, '');
    out.push(
      <pre key={`c${i}`} className="cv-code-block">
        <code>{code}</code>
      </pre>,
    );
    last = start + m[0].length;
    i++;
  }
  if (last < text.length) out.push(...lines(text.slice(last), `t${i}`));
  return <>{out}</>;
}

// Emoji pieces: pictographs, skin tones, flags, keycaps, the joiner and variation selectors that build combined emoji.
const EMOJI_PART = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[‍︎️⃣]|[\u{e0020}-\u{e007f}]/gu;
const MAX_BIG_EMOJI = 30;

/** True for a message that is nothing but emoji (and spaces or line breaks), which is shown larger. */
export function isEmojiOnly(text: string): boolean {
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return false;
  if (text.replace(EMOJI_PART, '').trim() !== '') return false;
  return [...text.matchAll(/\p{Extended_Pictographic}/gu)].length <= MAX_BIG_EMOJI;
}
