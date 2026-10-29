export const BUILD = __CHATWARD_BUILD__;

/**
 * "Test build: develop @ 1a2b3c4, built 29 Oct 01:30 UTC". Only test installers get a label: a release needs none, and a
 * dev build's commit would change every screenshot the visual check takes.
 */
export function buildLabel(): string {
  if (BUILD.channel !== 'test') return '';
  const when = new Date(BUILD.builtAt);
  const built = Number.isNaN(when.getTime())
    ? ''
    : `, built ${when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
  return `Test build: ${BUILD.branch} @ ${BUILD.commit}${built}`;
}
