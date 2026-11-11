import { useEffect, useState } from 'react';

/** Narrow screens (phones) get the phone layout: one view at a time, tabs along the bottom, people in a drawer. */
const QUERY = '(max-width: 700px)';

export function isPhoneWidth(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhoneWidth);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
