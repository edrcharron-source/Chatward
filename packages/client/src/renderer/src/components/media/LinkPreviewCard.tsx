import { useState, type ReactElement } from 'react';
import type { LinkPreview } from '@chatward/shared';
import { useSettings } from '../../state/settings';
import { isSafeEmbed, isSafeImageUrl } from './safeUrls';

type Embed = NonNullable<LinkPreview['embed']>;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function EmbedCard({ preview, embed }: { preview: LinkPreview; embed: Embed }): ReactElement {
  const autoLoad = useSettings((s) => s.autoLoadEmbeds);
  const [clicked, setClicked] = useState(false);
  const loaded = autoLoad || clicked;
  const label = embed.kind === 'youtube' ? 'YouTube video' : 'X post';
  const src =
    embed.kind === 'youtube'
      ? `https://www.youtube-nocookie.com/embed/${embed.id}`
      : `https://platform.twitter.com/embed/Tweet.html?id=${embed.id}`;

  return (
    <div className={`media-embed media-embed-${embed.kind}`}>
      {loaded ? (
        <iframe
          title={preview.title || label}
          src={src}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        />
      ) : (
        <button type="button" className="media-embed-placeholder" onClick={() => setClicked(true)}>
          <span className="media-link-title">{preview.title || preview.url}</span>
          <span className="muted">Click to load {label}</span>
        </button>
      )}
      <a className="media-link-site" href={preview.url} target="_blank" rel="noopener noreferrer">
        {hostOf(preview.url)}
      </a>
    </div>
  );
}

export function LinkPreviewCard({ preview }: { preview: LinkPreview }): ReactElement | null {
  // An embed with an id that is not a real YouTube or X id is shown as a plain link instead.
  if (preview.embed && isSafeEmbed(preview.embed)) return <EmbedCard preview={preview} embed={preview.embed} />;

  return (
    <a className="media-link-card" href={preview.url} target="_blank" rel="noopener noreferrer">
      <span className="media-link-text">
        <span className="media-link-site">{preview.siteName || hostOf(preview.url)}</span>
        <span className="media-link-title">{preview.title || preview.url}</span>
        {preview.description && <span className="media-link-desc">{preview.description}</span>}
      </span>
      {isSafeImageUrl(preview.image) && <img className="media-link-image" src={preview.image} alt="" />}
    </a>
  );
}
