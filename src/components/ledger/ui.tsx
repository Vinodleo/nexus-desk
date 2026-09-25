import React from "react";

// Small building blocks shared by the Private Ledger screens.

export const Card: React.FC<{ className?: string; children: React.ReactNode; "aria-label"?: string }> = ({
  className = "",
  children,
  ...rest
}) => (
  <section className={`bg-surface border border-line rounded-2xl p-3.5 ${className}`} {...rest}>
    {children}
  </section>
);

export const StatTile: React.FC<{ label: string; value: React.ReactNode; valueClassName?: string }> = ({
  label,
  value,
  valueClassName = "",
}) => (
  <div className="flex-1 basis-0 min-w-0 bg-inset rounded-[10px] px-2.5 py-2">
    <div className="text-[11px] text-muted">{label}</div>
    <div className={`font-display text-lg tabular-nums truncate ${valueClassName}`}>{value}</div>
  </div>
);

export const RoundIconButton: React.FC<{
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}> = ({ label, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className="w-11 h-11 shrink-0 rounded-full border border-line bg-surface text-ink flex items-center justify-center cursor-pointer hover:bg-inset transition-colors"
  >
    {children}
  </button>
);

export const Switch: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`group relative shrink-0 w-[52px] h-8 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
      checked ? "bg-accent" : "bg-line"
    }`}
  >
    {/* The knob stretches while pressed and slides when let go, like a phone's own switches. */}
    <span
      className={`absolute top-1 w-6 h-6 rounded-full shadow-sm transition-all duration-200 group-active:w-[30px] ${
        checked ? "left-[24px] group-active:left-[18px] bg-on-accent" : "left-1 bg-surface"
      }`}
    />
  </button>
);

export const SectionHeading: React.FC<{ title: string; right?: React.ReactNode }> = ({ title, right }) => (
  <div className="flex items-baseline justify-between gap-3">
    <h2 className="m-0 font-display text-xl font-semibold text-ink">{title}</h2>
    {right}
  </div>
);
