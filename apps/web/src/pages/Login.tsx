import { useSearchParams } from 'react-router';
import { safeReturnPath } from '../returnPath';
import { Brand } from '../ui/Brand';
import { Icon } from '../ui/Icon';

export function Login() {
  const [params] = useSearchParams();
  const next = safeReturnPath(params.get('next'));
  const href = '/api/auth/github/login' + (next ? `?next=${encodeURIComponent(next)}` : '');
  return (
    <div className="gate">
      <section className="login">
        <h1>
          <Brand large />
        </h1>
        <p className="lede">Share your Claude Code capacity with your team.</p>
        <a className="btn primary big" href={href}>
          <Icon name="github" size={18} />
          Sign in with GitHub
        </a>
        <ul className="login-facts">
          <li>
            <span className="lamp route" aria-hidden="true" />
            Tasks are GitHub issues in a shared pool.
          </li>
          <li>
            <span className="lamp proceed" aria-hidden="true" />
            Each one runs on a teammate&apos;s machine, with their own Claude subscription.
          </li>
          <li>
            <span className="lamp caution" aria-hidden="true" />
            orch pushes a branch and opens the pull request for review.
          </li>
        </ul>
      </section>
    </div>
  );
}
