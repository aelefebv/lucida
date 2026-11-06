/** The lucida mark: a lens on the accent. `public/favicon.svg` draws the same shape. */
export function LucidaMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--lc-accent)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="var(--lc-text-on-accent)" strokeWidth="3" />
      <circle cx="19" cy="13" r="2.5" fill="var(--lc-text-on-accent)" />
    </svg>
  );
}
