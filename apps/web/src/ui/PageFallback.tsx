/** Shown on a cold load while a page chunk downloads. */
export function PageFallback() {
  return (
    <p className="page-loading">
      <span className="spinner" aria-hidden="true" /> Loading...
    </p>
  );
}
