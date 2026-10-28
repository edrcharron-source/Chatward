// Public half of the key that signs Chatward installers. Publishing it is safe.
// The private half lives only in the UPDATE_SIGNING_KEY GitHub secret (see docs/UPDATES.md).
// Empty until that key is created, so this build refuses all updates.
export const UPDATE_PUBLIC_KEY_PEM = '';
