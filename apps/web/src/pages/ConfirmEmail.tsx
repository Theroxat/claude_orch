import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { ApiError } from '../api/client';
import { confirmNotificationEmail } from '../api/endpoints';
import { Brand } from '../ui/Brand';

/**
 * Landing page of the link in the confirmation e-mail. Opening it only shows a button: the
 * address is confirmed by the POST behind it, so link prefetchers and scanners cannot do it.
 */
export function ConfirmEmail() {
  const token = new URLSearchParams(useLocation().search).get('token') ?? '';
  const qc = useQueryClient();
  // Synchronous guard against a double click (the token is single-use).
  const sent = useRef(false);
  const confirm = useMutation({
    mutationFn: () => confirmNotificationEmail(token),
    onSuccess: (view) => qc.setQueryData(['notifications', 'settings'], view),
    onError: () => {
      sent.current = false;
    },
  });
  const run = () => {
    if (sent.current) return;
    sent.current = true;
    confirm.mutate();
  };

  return (
    <div className="gate">
      <section className="card consent confirm-email" aria-label="Confirm e-mail address">
        <Brand />
        {confirm.isSuccess ? (
          <>
            <h2>E-mail address confirmed</h2>
            <p className="lede">
              orch can now send notifications to <strong>{confirm.data.email.address}</strong>.
              Choose which events go there in your notification settings.
            </p>
            <div className="card-foot">
              <Link to="/my-server#notifications">Notification settings</Link>
            </div>
          </>
        ) : (
          <>
            <h2>Confirm your e-mail address</h2>
            {token ? (
              <p className="lede">
                Confirm that you want orch to send you notifications at the address you added to
                your settings.
              </p>
            ) : (
              <p className="error">This link is incomplete. Use the link from the e-mail.</p>
            )}
            {confirm.error && (
              <p className="error" role="alert">
                {confirm.error instanceof ApiError && confirm.error.status === 400
                  ? 'This link is invalid or has expired. Ask for a new one in your notification settings.'
                  : confirm.error.message}
              </p>
            )}
            <div className="card-foot">
              <button
                type="button"
                className="primary"
                disabled={!token || confirm.isPending}
                onClick={run}
              >
                Confirm
              </button>
              <Link to="/my-server#notifications">Notification settings</Link>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
