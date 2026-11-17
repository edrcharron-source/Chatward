/** One picture or video in the feed. `load` gives a URL the feed can show; `revoke` says it is an object URL to free. */
export interface FeedSlide {
  id: string;
  title: string;
  kind: 'image' | 'video';
  load: () => Promise<string>;
  revoke: boolean;
}
