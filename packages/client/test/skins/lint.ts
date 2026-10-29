// Blocks skin CSS from hiding, disabling or reordering action elements (docs/SKINS.md). This is the cheap first gate and
// only sees selectors that name an action element. test/skins/parity.ts runs the app and is what proves a skin keeps
// every feature, so a panel hidden as a whole is caught there, not here.

export interface Finding {
  line: number;
  selector: string;
  property: string;
  value: string;
}

// Declarations that take an action element out of play: hidden, unclickable, or moved within its container.
const BLOCKED: Array<{ property: string; value: RegExp }> = [
  { property: 'display', value: /^none$/ },
  { property: 'visibility', value: /^(hidden|collapse)$/ },
  { property: 'pointer-events', value: /^none$/ },
  { property: 'opacity', value: /^0$/ },
  { property: 'order', value: /^(?!0$)/ },
];

// An action selector names a control tag, an interactive ARIA role, the data-action attribute or the icon-button class.
const ACTION = /(^|[\s>+~,(])(button|input|select|textarea|a|summary)(?![\w-])|\[role=["']?(button|tab|menuitem|switch|checkbox|option|textbox)|\[data-action|\.icon(?![\w-])/;

const COMMENT = /\/\*[\s\S]*?\*\//g;
const RULE = /([^{}]+)\{([^{}]*)\}/g;

export function lintCss(css: string): Finding[] {
  // Comments are blanked out and their newlines kept, so line numbers still match the file.
  const source = css.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, ' '));
  const findings: Finding[] = [];
  for (const rule of source.matchAll(RULE)) {
    // A rule's prelude can carry an @-rule or @import before it; only the selector after the last ';' counts.
    const selector = rule[1].slice(rule[1].lastIndexOf(';') + 1).trim();
    if (!ACTION.test(selector)) continue;
    const line = source.slice(0, rule.index + rule[1].length).split('\n').length;
    for (const declaration of rule[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).replace(/!important/i, '').trim().toLowerCase();
      if (BLOCKED.some((b) => b.property === property && b.value.test(value))) {
        findings.push({ line, selector, property, value });
      }
    }
  }
  return findings;
}
