import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { UsageDayPoint } from '@orch/shared';
import { useT } from '../i18n/index.ts';
import { formatDay, formatTokens } from '../usageFormat';

const H = 232;
const PAD = { top: 10, right: 8, bottom: 26, left: 46 };
const FALLBACK_W = 640;

/** Round the top of the axis up to 1, 2, 2.5 or 5 x 10^n so the ticks are readable. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const f = max / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * pow;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(FALLBACK_W);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setW(next);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Top-rounded bar anchored on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Weighted tokens per day as bars. One series, one color; hover, touch or the arrow keys read a
 * day into the line above the plot (a fixed place, so nothing floats over the data). The same
 * numbers are available as a table next to the chart.
 */
export function UsageChart({ series }: { series: UsageDayPoint[] }) {
  const t = useT();
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = series.length;
  const max = niceMax(Math.max(0, ...series.map((d) => d.weighted)));
  const innerW = Math.max(10, width - PAD.left - PAD.right);
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, n);
  const barW = Math.max(2, slot - (n > 45 ? 2 : 4));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 76))));

  const total = series.reduce((s, d) => s + d.weighted, 0);
  const peak = series.reduce((best, d) => (d.weighted > best.weighted ? d : best), series[0]!);
  const at = active === null ? null : series[active];

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    setActive(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent) => {
    const last = n - 1;
    const next =
      e.key === 'ArrowLeft'
        ? Math.max(0, (active ?? last + 1) - 1)
        : e.key === 'ArrowRight'
          ? Math.min(last, (active ?? -1) + 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (e.key === 'Escape') setActive(null);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <div className="usage-chart" ref={box}>
      <p className="chart-readout" aria-live="polite" data-active={at ? true : undefined}>
        {at ? (
          <>
            <strong>{formatDay(at.day, true)}</strong>
            <span>
              {t('usage.chart.readout', { tokens: formatTokens(at.weighted), count: at.runs })}
              {at.failed > 0 && `, ${t('usage.runs.failed', { count: at.failed })}`}
            </span>
          </>
        ) : (
          <>
            <strong>{t('usage.chart.total', { tokens: formatTokens(total) })}</strong>
            <span>
              {total > 0
                ? t('usage.chart.peak', {
                    tokens: formatTokens(peak.weighted),
                    day: formatDay(peak.day, true),
                  })
                : t('usage.chart.nothing')}
            </span>
          </>
        )}
      </p>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="group"
        aria-label={t('usage.chart.aria', { count: n })}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        // A touch ends with a pointerleave: keep the tapped day readable until focus moves away.
        onPointerLeave={(e) => e.pointerType !== 'touch' && setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className={t === 0 ? 'axis' : 'grid'}
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
            />
            <text className="tick" x={PAD.left - 8} y={y(t)} textAnchor="end" dy="0.32em">
              {formatTokens(t)}
            </text>
          </g>
        ))}
        {series.map((d, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const h = d.weighted > 0 ? Math.max(2, (d.weighted / max) * innerH) : 0;
          return (
            <g key={d.day}>
              {h > 0 && (
                <path
                  className="bar"
                  d={barPath(x, PAD.top + innerH - h, barW, h)}
                  style={{ '--i': i / n } as CSSProperties}
                  data-dim={active !== null && active !== i ? true : undefined}
                  data-failed={d.failed > 0 || undefined}
                />
              )}
              {i % labelEvery === 0 && (
                <text
                  className="tick"
                  x={x + barW / 2}
                  y={H - 8}
                  textAnchor={i === 0 ? 'start' : 'middle'}
                >
                  {formatDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
        {active !== null && (
          <line
            className="cursor"
            x1={PAD.left + active * slot + slot / 2}
            x2={PAD.left + active * slot + slot / 2}
            y1={PAD.top}
            y2={PAD.top + innerH}
          />
        )}
        <rect
          className="hit"
          x={PAD.left}
          y={0}
          width={innerW}
          height={H - PAD.bottom}
          onPointerMove={pick}
          onPointerDown={pick}
        />
      </svg>
    </div>
  );
}
