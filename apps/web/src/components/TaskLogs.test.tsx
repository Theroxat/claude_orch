import { act, fireEvent, render, screen } from '@testing-library/react';
import type { LiveLogLine, TaskView } from '@orch/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskLogsButton, hasLogs } from './TaskLogs';

/** Minimal EventSource double: tests push named events into the last opened stream. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  emit(name: string, data: unknown) {
    const e = new MessageEvent(name, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(name) ?? []) fn(e);
  }
  fail(closed: boolean) {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

const task = {
  id: 't1',
  issueNumber: 42,
  title: 'Add a dark mode toggle',
  status: 'IN_PROGRESS',
  failedAttempts: 0,
} as unknown as TaskView;

let nextId = 1;
const line = (text: string, over: Partial<LiveLogLine> = {}): LiveLogLine => ({
  id: nextId++,
  ts: Date.UTC(2026, 9, 22, 12, 0, 0),
  kind: 'text',
  text,
  ...over,
});

function openLogs() {
  render(<TaskLogsButton task={task} />);
  fireEvent.click(screen.getByRole('button', { name: 'Logs of #42' }));
  const es = FakeEventSource.all.at(-1)!;
  act(() => {
    es.open();
    es.emit('meta', { assignmentId: 'a1', state: 'live', truncated: 0 });
  });
  return es;
}

/** jsdom has no layout: give the log view a fixed geometry. */
function geometry(el: HTMLElement, scrollHeight: number, clientHeight = 200) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('task logs', () => {
  it('is offered for running and finished tasks only', () => {
    expect(hasLogs(task)).toBe(true);
    expect(hasLogs({ ...task, status: 'DONE' })).toBe(true);
    expect(hasLogs({ ...task, status: 'TODO' })).toBe(false);
    expect(hasLogs({ ...task, status: 'TODO', failedAttempts: 1 })).toBe(true);
  });

  it('renders streamed lines: compact tool calls, ANSI stripped, live status', () => {
    const es = openLogs();
    expect(es.url).toBe('/api/tasks/t1/logs/stream');
    expect(screen.getByRole('dialog', { name: 'Logs of task #42' })).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    act(() =>
      es.emit('lines', {
        lines: [
          line('\u001b[32mLooking at the settings page.\u001b[0m'),
          line('pnpm test', { kind: 'tool', tool: 'Bash' }),
          line('1 failed', { kind: 'tool_result', error: true }),
        ],
      }),
    );
    const log = screen.getByRole('log');
    expect(log.textContent).toContain('Looking at the settings page.');
    expect(log.textContent).not.toContain('\u001b');
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('pnpm test', { exact: false })).toBeTruthy();
    expect(log.querySelector('[data-kind="tool_result"]')?.getAttribute('data-error')).toBe('true');

    act(() => es.emit('end', { assignmentId: 'a1', state: 'finished', truncated: 0 }));
    expect(screen.getByText('Run ended')).toBeTruthy();
  });

  it('follows new lines, pauses when the reader scrolls up, and resumes on "Jump to latest"', () => {
    const es = openLogs();
    act(() => es.emit('lines', { lines: [line('one')] }));
    const view = screen.getByTestId('log-view');
    geometry(view, 1000);
    act(() => es.emit('lines', { lines: [line('two')] }));
    expect(view.scrollTop).toBe(1000); // following the tail

    // The reader scrolls up: new lines no longer move the view.
    view.scrollTop = 100;
    fireEvent.scroll(view);
    geometry(view, 1400);
    act(() => es.emit('lines', { lines: [line('three'), line('four')] }));
    expect(view.scrollTop).toBe(100);
    const jump = screen.getByRole('button', { name: 'Jump to latest (2 new)' });

    fireEvent.click(jump);
    expect(view.scrollTop).toBe(1400);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('shows reconnects, and reopens a closed stream from the last line seen', () => {
    const es = openLogs();
    act(() => es.emit('lines', { lines: [line('kept')] }));
    const last = nextId - 1;
    act(() => es.fail(false));
    expect(screen.getByText('Reconnecting')).toBeTruthy();
    act(() => es.fail(true));
    expect(screen.getByText('Disconnected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    const again = FakeEventSource.all.at(-1)!;
    expect(again).not.toBe(es);
    expect(again.url).toBe(`/api/tasks/t1/logs/stream?after=${last}`);
    // A replayed line is not shown twice.
    act(() => {
      again.open();
      again.emit('lines', { lines: [{ ...line('kept'), id: last }] });
    });
    expect(screen.getAllByText('kept')).toHaveLength(1);
  });

  it('starts over when a new run of the task begins', () => {
    const es = openLogs();
    act(() => es.emit('lines', { lines: [line('old run')] }));
    act(() => es.emit('meta', { assignmentId: 'a2', state: 'live', truncated: 0 }));
    act(() => es.emit('lines', { lines: [line('new run')] }));
    expect(screen.queryByText('old run')).toBeNull();
    expect(screen.getByText('new run')).toBeTruthy();
  });
});
