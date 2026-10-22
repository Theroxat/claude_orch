import { stripAnsi, type LiveLogLine, type TaskView } from '@orch/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { useLiveLog, type LiveLogState } from '../api/liveLog';
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
        <span className="log-body">{text || (l.kind === 'tool_result' ? '(no output)' : '')}</span>
      )}
    </li>
  );
}

function statusOf(s: LiveLogState): { label: string; tone: 'ok' | 'pending' | 'stop' | 'off' } {
  if (s.connection === 'closed') return { label: 'Disconnected', tone: 'stop' };
  if (s.connection === 'reconnecting') return { label: 'Reconnecting', tone: 'pending' };
  if (!s.meta || s.connection === 'connecting') return { label: 'Connecting', tone: 'off' };
  if (s.meta.state === 'live') return { label: 'Live', tone: 'ok' };
  if (s.meta.state === 'finished') return { label: 'Run ended', tone: 'off' };
  return { label: 'Waiting for a run', tone: 'off' };
}

/** The log viewer itself: follows the tail until the reader scrolls up. */
export function TaskLogsPanel({ log }: { log: LiveLogState }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [seen, setSeen] = useState(0);
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
      if (!atBottom) setSeen(lines.length);
    }
  };
  const jump = () => {
    setFollow(true);
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const unseen = follow ? 0 : Math.max(0, lines.length - seen);
  const status = statusOf(log);

  return (
    <div className="task-logs">
      <div className="task-logs-bar">
        <span className={`badge ${status.tone}`} data-live={status.tone === 'ok' || undefined}>
          {status.label}
        </span>
        {meta && meta.truncated > 0 && (
          <span className="hint">{meta.truncated} earlier lines not kept</span>
        )}
        <span className="task-logs-actions">
          {log.connection === 'closed' && (
            <button type="button" onClick={log.reconnect}>
              Reconnect
            </button>
          )}
          <CopyButton text={lines.map(lineText).join('\n') || undefined} label="Copy log" />
        </span>
      </div>
      <div
        ref={box}
        className="log-view"
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Task output"
        data-testid="log-view"
      >
        {lines.length === 0 ? (
          <p className="log-empty">
            {meta?.state === 'live'
              ? 'Claude has not printed anything yet.'
              : 'No output yet. It appears here while the task runs on a member machine (auto mode), and stays for 30 minutes after the run.'}
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
          {unseen > 0 ? `Jump to latest (${unseen} new)` : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}

function TaskLogsDialog({ task, onClose }: { task: TaskView; onClose: () => void }) {
  const log = useLiveLog(task.id);
  return (
    <Modal
      label={`Logs of task #${task.issueNumber}`}
      title={`Logs #${task.issueNumber}`}
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="task-logs-open"
        aria-label={`Logs of #${task.issueNumber}`}
        onClick={() => setOpen(true)}
      >
        {task.status === 'IN_PROGRESS' && <span className="lamp" aria-hidden="true" />}
        Logs
      </button>
      {open && <TaskLogsDialog task={task} onClose={() => setOpen(false)} />}
    </>
  );
}
