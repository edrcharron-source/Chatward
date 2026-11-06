import type { ReactNode } from 'react';
import './layoutPreview.css';

type Layout = 'tabs' | 'classic' | 'lcars' | 'orbit';

/**
 * A small drawing of a layout for the layout picker in Settings > Appearance. It is drawn in code from the active skin's
 * colour tokens (and the LCARS frame's --lc-* colours), so it always shows the layout in the skin that is on now, light or
 * dark, with no pictures to keep up to date. Like the app it shows one text chat: the tab bar, the chat with a few messages,
 * the composer and the member list. Decoration only, so screen readers skip it; the choice's name says which layout it is.
 */
export default function LayoutPreview({ layout }: { layout: Layout }) {
  return (
    <svg className={`lp lp-${layout}`} viewBox="0 0 160 100" aria-hidden="true" focusable="false">
      {DRAW[layout]}
    </svg>
  );
}

// A few chat messages: an avatar and two lines of text each, from (x, y) with the given width.
function Messages({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g>
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${x} ${y + i * 15})`}>
          <circle className="lp-avatar" cx="3.5" cy="3.5" r="3.5" />
          <rect className="lp-name" x="10" y="0.5" width={14 + i * 4} height="2.5" rx="1" />
          <rect className="lp-line" x="10" y="5" width={w - 14 - i * 9} height="2.5" rx="1" />
        </g>
      ))}
    </g>
  );
}

// The member list: a heading and a few people, the first one online.
function Members({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className="lp-quiet" x="0" y="0" width="12" height="2" rx="1" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i} transform={`translate(0 ${6 + i * 8})`}>
          <circle className={i < 2 ? 'lp-live' : 'lp-avatar'} cx="2.5" cy="2.5" r="2.5" />
          <rect className="lp-line" x="7" y="1.5" width={12 - (i % 2) * 3} height="2" rx="1" />
        </g>
      ))}
    </g>
  );
}

const Composer = ({ x, y, w }: { x: number; y: number; w: number }) => (
  <g>
    <rect className="lp-field" x={x} y={y} width={w} height="7" rx="2" />
    <rect className="lp-accent" x={x + w - 11} y={y + 1.5} width="9" height="4" rx="1" />
  </g>
);

const DRAW: Record<Layout, ReactNode> = {
  // Tabs: a bar along the top with the tabs (the open one picked out) and the tools at the end.
  tabs: (
    <>
      <rect className="lp-ground" width="160" height="100" />
      <rect className="lp-bar" width="160" height="14" />
      <rect className="lp-strong" x="5" y="5.5" width="16" height="3" rx="1" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} className={i === 0 ? 'lp-tab lp-tab-on' : 'lp-tab'} x={27 + i * 17} y="3.5" width="14" height="7" rx="1.5" />
      ))}
      <rect className="lp-tab" x="130" y="3.5" width="12" height="7" rx="1.5" />
      <rect className="lp-tab" x="145" y="3.5" width="10" height="7" rx="1.5" />
      <rect className="lp-side" x="122" y="14" width="38" height="86" />
      <Messages x={6} y={22} w={100} />
      <Composer x={6} y={86} w={110} />
      <Members x={127} y={20} />
    </>
  ),
  // Classic: the same tabs stacked down a sidebar on the left, each one named, with the tools at the bottom.
  classic: (
    <>
      <rect className="lp-ground" width="160" height="100" />
      <rect className="lp-bar" width="36" height="100" />
      <rect className="lp-strong" x="5" y="5" width="18" height="3" rx="1" />
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <rect className={i === 0 ? 'lp-tab lp-tab-on' : 'lp-tab'} x="4" y={13 + i * 9} width="28" height="7" rx="1.5" />
          <rect className="lp-quiet" x="8" y={15.5 + i * 9} width={10 + (i % 3) * 3} height="2" rx="1" />
        </g>
      ))}
      {[0, 1, 2].map((i) => (
        <rect key={i} className="lp-tab" x="4" y={71 + i * 9} width="28" height="7" rx="1.5" />
      ))}
      <rect className="lp-side" x="124" y="0" width="36" height="100" />
      <Messages x={42} y={10} w={74} />
      <Composer x={42} y={86} w={76} />
      <Members x={129} y={8} />
    </>
  ),
  // LCARS: a thick rail down the left that sweeps into thin bars along the top and bottom; the tabs are blocks in
  // the rail, the open one lit, Close at the top right and the call controls along the bottom.
  lcars: (
    <>
      <rect className="lp-lc-ground" width="160" height="100" />
      <path className="lp-lc-frame" d="M0 18 A18 18 0 0 1 18 0 H70 V7 H36 A6 6 0 0 0 30 13 V24 H0 Z" />
      <rect className="lp-lc-frame" x="74" y="0" width="40" height="7" />
      <rect className="lp-lc-alert" x="141" y="0" width="16" height="7" />
      <path className="lp-lc-alert" d="M157 0 A3.5 3.5 0 0 1 157 7 Z" />
      <rect className="lp-lc-live" x="117" y="0" width="21" height="7" />
      <rect className="lp-lc-live" x="0" y="26" width="30" height="9" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} className="lp-lc-frame" x="0" y={37 + i * 10} width="30" height="8" />
      ))}
      <path className="lp-lc-frame" d="M0 78 H30 V87 A6 6 0 0 0 36 93 H70 V100 H18 A18 18 0 0 1 0 82 Z" />
      <rect className="lp-lc-frame" x="74" y="93" width="54" height="7" />
      <rect className="lp-lc-frame" x="131" y="93" width="22" height="7" />
      <path className="lp-lc-frame" d="M153 93 A3.5 3.5 0 0 1 153 100 Z" />
      <rect className="lp-ground" x="38" y="11" width="122" height="78" rx="4" />
      <rect className="lp-side" x="126" y="11" width="34" height="78" />
      <Messages x={43} y={18} w={76} />
      <Composer x={43} y={78} w={78} />
      <Members x={130} y={17} />
    </>
  ),
  // Orbit: tabs as spaced-out words in a thin top bar (the open one underlined with a small diamond) over a faint line
  // drawing of circles and a star, with the member list behind a thin line on the right.
  orbit: (
    <>
      <rect className="lp-ground" width="160" height="100" />
      <g className="lp-orb-drawing">
        <circle cx="70" cy="58" r="34" />
        <circle cx="70" cy="58" r="22" />
        <path d="M70 24 L76 52 L104 58 L76 64 L70 92 L64 64 L36 58 L64 52 Z" />
      </g>
      <line className="lp-orb-rule" x1="0" y1="14.5" x2="160" y2="14.5" />
      <path className="lp-orb-mark" d="M7 7 L9.5 4.5 L12 7 L9.5 9.5 Z" />
      <rect className="lp-strong" x="15" y="5.5" width="13" height="3" rx="0.5" />
      <line className="lp-orb-rule" x1="32" y1="3" x2="32" y2="11" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} className={i === 0 ? 'lp-strong' : 'lp-quiet'} x={37 + i * 15} y="6" width="10" height="2" rx="0.5" />
      ))}
      <path className="lp-orb-mark" d="M42 2.5 L43.2 3.7 L42 4.9 L40.8 3.7 Z" />
      <rect className="lp-strong" x="37" y="12.5" width="10" height="1.5" />
      <rect className="lp-orb-box" x="128" y="4" width="12" height="7" />
      <rect className="lp-orb-box" x="143" y="4" width="12" height="7" />
      <line className="lp-orb-rule" x1="122.5" y1="15" x2="122.5" y2="100" />
      <Messages x={6} y={22} w={100} />
      <rect className="lp-orb-box" x="6" y="86" width="110" height="7" />
      <Members x={127} y={20} />
    </>
  ),
};
