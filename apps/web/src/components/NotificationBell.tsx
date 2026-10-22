import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationItem } from '@orch/shared';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { fetchNotifications, fetchUnreadCount, markNotificationsRead } from '../api/endpoints';
import { useMe } from '../auth';
import { relative } from '../time';
import { Icon } from '../ui/Icon';
import { EXIT_MS, motionAllowed } from '../ui/motion';
import { EVENT_META } from '../ui/notificationMeta';
import { useChangeCount } from '../ui/presence';

const UNREAD_KEY = ['notifications', 'unread'] as const;
const LIST_KEY = ['notifications', 'list'] as const;

/** Bell with an unread badge in the header; opens the latest notifications. */
export function NotificationBell() {
  const signedIn = !!useMe().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The panel belongs to the page it was opened on: moving to another route closes it.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const open = openPath === pathname;

  const unread =
    useQuery({
      queryKey: UNREAD_KEY,
      queryFn: fetchUnreadCount,
      enabled: signedIn,
      refetchInterval: 30_000,
    }).data?.unreadCount ?? 0;
  const list = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => fetchNotifications(30),
    enabled: signedIn && open,
  });
  const changes = useChangeCount(unread);

  const markRead = useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: (r) => {
      qc.setQueryData(UNREAD_KEY, r);
      void qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });

  const close = (restoreFocus: boolean) => {
    if (restoreFocus) button.current?.focus();
    if (!motionAllowed()) {
      setOpenPath(null);
      return;
    }
    setClosing(true);
    setTimeout(() => {
      setOpenPath(null);
      setClosing(false);
    }, EXIT_MS);
  };
  const latestClose = useRef(close);
  useEffect(() => {
    latestClose.current = close;
  });

  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        latestClose.current(true);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) latestClose.current(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const follow = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    close(false);
    if (!n.url) return;
    if (n.url.startsWith('/')) navigate(n.url);
    else window.open(n.url, '_blank', 'noopener,noreferrer');
  };

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  const items = list.data?.items;
  return (
    <div className="bell" ref={root}>
      <button
        ref={button}
        type="button"
        className="ghost icon-button bell-button"
        aria-label={label}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpenPath(pathname))}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span
            key={changes}
            className="nav-badge bell-badge"
            data-changed={changes > 0 || undefined}
            aria-hidden="true"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          className="bell-panel"
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          data-closing={closing || undefined}
        >
          <div className="bell-head">
            <h2>Notifications</h2>
            <button
              type="button"
              className="ghost"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
            >
              Mark all read
            </button>
          </div>
          <div className="bell-body">
            {list.isPending && <p className="hint bell-note">Loading...</p>}
            {list.error && <p className="error bell-note">{list.error.message}</p>}
            {items?.length === 0 && (
              <p className="bell-empty">
                Nothing yet. Task results and requests that need you show up here.
              </p>
            )}
            {items && items.length > 0 && (
              <ul className="bell-list">
                {items.map((n) => {
                  const meta = EVENT_META[n.event];
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="bell-item"
                        data-unread={!n.readAt || undefined}
                        style={{ '--lamp': `var(--${meta.lamp})` } as CSSProperties}
                        onClick={() => follow(n)}
                      >
                        <span className="bell-icon" aria-hidden="true">
                          <Icon name={meta.icon} size={15} />
                        </span>
                        <span className="bell-text">
                          <span className="bell-title">{n.title}</span>
                          {n.body && <span className="bell-copy">{n.body}</span>}
                          <span className="bell-time">{relative(n.createdAt)}</span>
                        </span>
                        {!n.readAt && <span className="bell-dot" role="img" aria-label="Unread" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="bell-foot">
            <Link to="/my-server#notifications" onClick={() => close(false)}>
              Notification settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
