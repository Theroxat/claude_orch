/** Wordmark: three tracks joining into one line, with a lit signal at the junction. */
export function Brand({ large }: { large?: boolean }) {
  return (
    <span className={`brand${large ? ' large' : ''}`}>
      <svg className="brand-mark" viewBox="0 0 34 22" aria-hidden="true" focusable="false">
        <path className="track" d="M2 4c9 0 11 7 20 7M2 18c9 0 11-7 20-7M2 11h22" />
        <circle className="signal" cx="28.5" cy="11" r="3.5" />
      </svg>
      <span className="brand-name">orch</span>
    </span>
  );
}
