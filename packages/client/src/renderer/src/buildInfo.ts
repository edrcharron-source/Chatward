export const BUILD = __CHATWARD_BUILD__;

/** "Test build: develop @ 1a2b3c4, built 29 Oct 01:30 UTC". Empty for a release, which needs no label. */
export function buildLabel(): string {
  if (BUILD.channel === 'release') return '';
  const when = new Date(BUILD.builtAt);
  const built = Number.isNaN(when.getTime())
    ? ''
    : `, built ${when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
  return `${BUILD.channel === 'test' ? 'Test build' : 'Dev build'}: ${BUILD.branch} @ ${BUILD.commit}${built}`;
}
