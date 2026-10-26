import { useState } from 'react';
import { LOCALES, LOCALE_NAMES, setLocale, useLocale, useT, type Locale } from '../i18n/index.ts';

/**
 * Two-position lever (EN | FR) next to the theme toggle. Each option is named in its own
 * language, so someone who cannot read the current one still finds theirs.
 */
export function LanguageSwitcher() {
  const t = useT();
  const locale = useLocale();
  const [loading, setLoading] = useState<Locale | null>(null);
  const choose = (l: Locale) => {
    if (l === locale || loading) return;
    setLoading(l);
    void setLocale(l)
      .catch(() => undefined)
      .finally(() => setLoading(null));
  };
  return (
    <div className="lang-switch" role="group" aria-label={t('layout.language.label')}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          className="lang-option"
          lang={l}
          aria-pressed={l === locale}
          aria-label={LOCALE_NAMES[l]}
          title={LOCALE_NAMES[l]}
          aria-busy={loading === l || undefined}
          onClick={() => choose(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
