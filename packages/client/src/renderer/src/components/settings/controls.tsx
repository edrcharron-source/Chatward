import type { ReactNode } from 'react';

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="setting-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Toggle({ label, hint, checked, onChange }: {
  label: ReactNode; hint?: string; checked: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <label className="setting-row">
      <span className="setting-text">
        <span>{label}</span>
        {hint && <small className="muted">{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Slider({ label, value, min, max, step, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="setting-row">
      <span className="setting-text"><span>{label}</span></span>
      <span className="slider">
        <input type="range" min={min} max={max} step={step} value={value} aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))} />
        <output className="muted">{format(value)}</output>
      </span>
    </label>
  );
}
