// Checks on addresses chosen by the sender. Every member decrypts a message, so a modified client can put any address in
// it. Drawing an address makes the reader's machine contact that host, which would tell the sender the reader's IP. So
// only inline data images and the GIF provider's own hosts are drawn, and embed ids must have the shape the site uses.

/** Hosts the GIF provider serves its files from. Subdomains of these also pass. */
const GIF_HOSTS = ['klipy.com'];

const YOUTUBE_ID = /^[\w-]{11}$/;
const TWEET_ID = /^\d{1,25}$/;

/** Link-preview images. The server only sends inline data images, so anything else is refused. */
export function isSafeImageUrl(url: string | undefined): url is string {
  return typeof url === 'string' && url.startsWith('data:image/');
}

/** GIF files: inline data images (demo mode) or https on a GIF provider host. */
export function isSafeGifUrl(url: string | undefined): url is string {
  if (typeof url !== 'string') return false;
  if (url.startsWith('data:image/')) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GIF_HOSTS.some((host) => u.hostname === host || u.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

/** YouTube and X embeds. The id is put into an iframe address, so it must be only the characters a real id uses. */
export function isSafeEmbed(embed: { kind: string; id: string }): boolean {
  if (embed.kind === 'youtube') return YOUTUBE_ID.test(embed.id);
  if (embed.kind === 'twitter') return TWEET_ID.test(embed.id);
  return false;
}
