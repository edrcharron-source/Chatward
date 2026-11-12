/**
 * Keeps the app sized to the part of the screen you can actually see on a phone.
 *
 * iPhone doesn't shrink the page when the keyboard opens: it slides the whole page up instead, so the top bar scrolls
 * off and the message box can end up under the keyboard. Here the app's surface (#root) follows the visual viewport, so
 * it ends right at the top of the keyboard, and `cw-kb` on <html> says the keyboard is open (the phone layout hides its
 * tab bar then, to leave the chat more room).
 */
const KEYBOARD_MIN_PX = 120;

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
    const keyboard = window.innerHeight - vv.height > KEYBOARD_MIN_PX;
    root.style.height = `${Math.round(vv.height)}px`;
    // iPhone may still scroll the page a little; move the app with it so it stays where you see it.
    root.style.transform = vv.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : '';
    html.classList.toggle('cw-kb', keyboard);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  // When the keyboard closes iPhone can leave the page scrolled; put it back.
  document.addEventListener('focusout', () => setTimeout(() => { if (!html.classList.contains('cw-kb')) window.scrollTo(0, 0); schedule(); }, 50));
  apply();
}
