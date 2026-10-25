import { useSearchParams } from 'react-router';
import { useT } from '../i18n/index.ts';
import { safeReturnPath } from '../returnPath';
import { Brand } from '../ui/Brand';
import { Icon } from '../ui/Icon';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';

export function Login() {
  const t = useT();
  const [params] = useSearchParams();
  const next = safeReturnPath(params.get('next'));
  const href = '/api/auth/github/login' + (next ? `?next=${encodeURIComponent(next)}` : '');
  return (
    <div className="gate">
      <div className="gate-tools">
        <LanguageSwitcher />
      </div>
      <section className="login">
        <h1>
          <Brand large />
        </h1>
        <p className="lede">{t('login.lede')}</p>
        <a className="btn primary big" href={href}>
          <Icon name="github" size={18} />
          {t('login.signIn')}
        </a>
        <ul className="login-facts">
          <li>
            <span className="lamp route" aria-hidden="true" />
            {t('login.facts.issues')}
          </li>
          <li>
            <span className="lamp proceed" aria-hidden="true" />
            {t('login.facts.machines')}
          </li>
          <li>
            <span className="lamp caution" aria-hidden="true" />
            {t('login.facts.review')}
          </li>
        </ul>
      </section>
    </div>
  );
}
