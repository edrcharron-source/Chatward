/**
 * Keeps the app sized to the part of the screen you can actually see on a phone.
 *
 * iPhone doesn't shrink the page when the keyboard opens: it slides the whole page up instead, so the top bar scrolls
 * off and the message box can end up under the keyboard. Here the app's surface (#root) follows the visual viewport, so
 * it ends right at the top of the keyboard, and `cw-kb` on <html> says the keyboard is open (the phone layout hides its
 * tab bar then, to leave the chat more room).
 */
/** The keyboard can only be up while something you type into has focus. */
function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(type);
}

export function followVisualViewport(): void {
  const vv = window.visualViewport;
  const root = document.getElementById('root');
  if (!vv || !root) return;
  const html = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    const phone = window.matchMedia('(max-width: 700px)').matches;
    if (!phone) {
      root.style.removeProperty('height');
      root.style.removeProperty('transform');
      html.classList.remove('cw-kb');
      return;
    }
    // After the keyboard closes iPhone sometimes keeps reporting the smaller size, with no event when it corrects
    // itself, which left the app squashed into the top half of the screen. With nothing to type into focused the
    // keyboard is down, so the app takes the whole screen again whatever the reported size says.
    if (!typing()) {
      root.style.removeProperty('height');
      root.style.removeProperty('transform');
      html.classList.remove('cw-kb');
      return;
    }
    root.style.height = `${Math.round(vv.height)}px`;
    // iPhone may still scroll the page a little; move the app with it so it stays where you see it.
    root.style.transform = vv.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : '';
    // Typing means the keyboard is up. Reported heights are not reliable on every iPhone (the keyboard's own
    // accessory bar can make the gap look small), so focus decides, and the phone bar goes compact.
    html.classList.toggle('cw-kb', typing());
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('focusin', schedule);
  // When the keyboard closes iPhone can leave the page scrolled; put it back. The keyboard slides away over a
  // moment, so look again once it has gone.
  document.addEventListener('focusout', () => {
    for (const ms of [50, 350, 800]) {
      setTimeout(() => { if (!typing()) window.scrollTo(0, 0); schedule(); }, ms);
    }
  });
  apply();
}
