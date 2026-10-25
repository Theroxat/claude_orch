import { stripAnsi, type LiveLogLine, type TaskView } from '@orch/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { useLiveLog, type LiveLogState } from '../api/liveLog';
import { useT, type MessageKey } from '../i18n/index.ts';
import { Modal } from '../ui/Modal';
import { CopyButton } from './CopyButton';

/** Distance from the bottom (px) under which the view keeps following new lines. */
const FOLLOW_SLACK = 24;

/** Tasks whose run may have output: running now, or ran (finished, failed and back in To do). */
export function hasLogs(task: TaskView): boolean {
  return (
    task.status === 'IN_PROGRESS' ||
    task.status === 'IN_REVIEW' ||
    task.status === 'DONE' ||
    (task.failedAttempts ?? 0) > 0
  );
}

const clock = (ts: number) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
};

/** Plain-text form of a line, for copying. */
export function lineText(l: LiveLogLine): string {
  const what = l.kind === 'tool' ? `${l.tool ?? 'tool'} ${l.text}` : l.text;
  return `${clock(l.ts)} ${l.kind}${l.error ? ' (error)' : ''}  ${stripAnsi(what)}`;
}

function Line({ l }: { l: LiveLogLine }) {
  const t = useT();
  const text = stripAnsi(l.text);
  return (
    <li className="log-line" data-kind={l.kind} data-error={l.error || undefined}>
      <time className="log-time" dateTime={new Date(l.ts).toISOString()}>
        {clock(l.ts)}
      </time>
      {l.kind === 'tool' ? (
        <span className="log-body">
          <span className="log-tool">{stripAnsi(l.tool ?? 'tool')}</span>
          {text && <span className="log-args"> {text}</span>}
        </span>
      ) : (
        <span className="log-body">
          {text || (l.kind === 'tool_result' ? t('backlog.logs.noOutputLine') : '')}
        </span>
      )}
    </li>
  );
}

function statusOf(s: LiveLogState): { label: MessageKey; tone: 'ok' | 'pending' | 'stop' | 'off' } {
  if (s.connection === 'closed') return { label: 'backlog.logs.disconnected', tone: 'stop' };
  if (s.connection === 'reconnecting')
    return { label: 'backlog.logs.reconnecting', tone: 'pending' };
  if (!s.meta || s.connection === 'connecting')
    return { label: 'backlog.logs.connecting', tone: 'off' };
  if (s.meta.state === 'live') return { label: 'backlog.logs.live', tone: 'ok' };
  if (s.meta.state === 'finished') return { label: 'backlog.logs.runEnded', tone: 'off' };
  return { label: 'backlog.logs.waiting', tone: 'off' };
}

/** The log viewer itself: follows the tail until the reader scrolls up. */
export function TaskLogsPanel({ log }: { log: LiveLogState }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  /** Id of the last line shown when the reader scrolled up (counts survive the client cap). */
  const [seenId, setSeenId] = useState(0);
  const { lines, meta } = log;

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    if (atBottom !== follow) {
      setFollow(atBottom);
      if (!atBottom) setSeenId(lines.at(-1)?.id ?? 0);
    }
  };
  const jump = () => {
    setFollow(true);
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  let unseen = 0;
  if (!follow)
    for (let i = lines.length - 1; i >= 0 && (lines[i] as LiveLogLine).id > seenId; i--) unseen++;
  const status = statusOf(log);

  return (
    <div className="task-logs">
      <div className="task-logs-bar">
        <span
          className={`badge ${status.tone}`}
          data-live={status.tone === 'ok' || undefined}
          role="status"
        >
          {t(status.label)}
        </span>
        {meta && meta.truncated > 0 && (
          <span className="hint">{t('backlog.logs.truncated', { count: meta.truncated })}</span>
        )}
        <span className="task-logs-actions">
          {log.connection === 'closed' && (
            <button type="button" onClick={log.reconnect}>
              {t('backlog.logs.reconnect')}
            </button>
          )}
          <CopyButton
            text={lines.map(lineText).join('\n') || undefined}
            label={t('backlog.logs.copy')}
          />
        </span>
      </div>
      <div
        ref={box}
        className="log-view"
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label={t('backlog.logs.output')}
        data-testid="log-view"
      >
        {lines.length === 0 ? (
          <p className="log-empty">
            {meta?.state === 'live' ? t('backlog.logs.liveEmpty') : t('backlog.logs.empty')}
          </p>
        ) : (
          <ol className="log-lines" role="log" aria-live="off">
            {lines.map((l) => (
              <Line key={l.id} l={l} />
            ))}
          </ol>
        )}
      </div>
      {!follow && (
        <button type="button" className="log-jump primary" onClick={jump}>
          {unseen > 0 ? t('backlog.logs.jumpNew', { count: unseen }) : t('backlog.logs.jump')}
        </button>
      )}
    </div>
  );
}

function TaskLogsDialog({ task, onClose }: { task: TaskView; onClose: () => void }) {
  const t = useT();
  const log = useLiveLog(task.id);
  return (
    <Modal
      label={t('backlog.logs.dialogLabel', { number: String(task.issueNumber) })}
      title={t('backlog.logs.dialogTitle', { number: String(task.issueNumber) })}
      onClose={onClose}
      side
    >
      <p className="hint task-logs-title">{task.title}</p>
      <TaskLogsPanel log={log} />
    </Modal>
  );
}

/** "Logs" button for a task card; opens the live log sheet. */
export function TaskLogsButton({ task }: { task: TaskView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="task-logs-open"
        aria-label={t('backlog.logs.openLabel', { number: String(task.issueNumber) })}
        onClick={() => setOpen(true)}
      >
        {task.status === 'IN_PROGRESS' && <span className="lamp" aria-hidden="true" />}
        {t('backlog.logs.open')}
      </button>
      {open && <TaskLogsDialog task={task} onClose={() => setOpen(false)} />}
    </>
  );
}
