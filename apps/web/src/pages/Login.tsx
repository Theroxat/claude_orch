export function Login() {
  return (
    <section className="card login">
      <h1>orch</h1>
      <p className="hint">Share your Claude Code capacity with your team.</p>
      <a className="btn primary" href="/api/auth/github/login">
        Sign in with GitHub
      </a>
    </section>
  );
}
