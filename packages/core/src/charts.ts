/**
 * Small, dependency-free SVG charts. They are used on screen and in A4 prints, so they are built to read in
 * black and white too: every bar or line is labelled, nothing relies on colour alone, and text is dark on light.
 * Output is a string of SVG. Everything that comes from data is escaped.
 */

export const chartColors = { sales: "#1d4ed8", profit: "#15803d", cost: "#b45309", muted: "#6b7280", grid: "#d1d5db", ink: "#111827" };

export const esc = (s: string | number): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** 1234567 -> "1.2M", 45000 -> "45k", 800 -> "800". For axis labels only; exact amounts use formatMoney. */
export function compact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}${trim(a / 1_000_000)}M`;
  if (a >= 10_000) return `${sign}${trim(a / 1_000)}k`;
  if (a >= 1_000) return `${sign}${trim(a / 1_000)}k`;
  return `${sign}${trim(a)}`;
}
const trim = (n: number) => String(Math.round(n * 10) / 10).replace(/\.0$/, "");

/** Round-number axis steps that cover min..max, always including zero. */
export function niceScale(min: number, max: number, target = 4): { lo: number; hi: number; step: number } {
  const lo0 = Math.min(0, min);
  const hi0 = Math.max(0, max);
  if (hi0 === lo0) return { lo: 0, hi: 1, step: 1 };
  const raw = (hi0 - lo0) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(lo0 / step) * step, hi: Math.ceil(hi0 / step) * step, step };
}

export interface Series {
  name: string;
  values: number[];
  color: string;
}

interface Axis {
  /** Amounts are in minor units; the axis shows major units (divided by 100). */
  minor?: boolean;
  /** Shown above the chart, e.g. "PKR". */
  unit?: string;
}

const W = 640;
const FONT = `font-family="system-ui, -apple-system, Segoe UI, sans-serif"`;

function empty(message: string, h = 80): string {
  return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(message)}" xmlns="http://www.w3.org/2000/svg"><text x="${W / 2}" y="${h / 2}" text-anchor="middle" ${FONT} font-size="14" fill="${chartColors.muted}">${esc(message)}</text></svg>`;
}

function legend(series: Series[], y: number): string {
  if (series.length < 2) return "";
  let x = 48;
  return series
    .map((s) => {
      const out = `<rect x="${x}" y="${y - 9}" width="12" height="12" fill="${s.color}"/><text x="${x + 17}" y="${y + 1}" ${FONT} font-size="12" fill="${chartColors.ink}">${esc(s.name)}</text>`;
      x += 30 + s.name.length * 7;
      return out;
    })
    .join("");
}

/** Which of `n` x labels to show so they never overlap. */
function labelEvery(n: number, maxLabels = 12): number {
  return Math.max(1, Math.ceil(n / maxLabels));
}

/**
 * Bars over time or over categories, one or more series side by side.
 * Values are printed above the bars when there are few of them.
 */
export function barChart(opts: { labels: string[]; series: Series[]; title: string; height?: number } & Axis): string {
  const { labels, series } = opts;
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  if (n === 0 || all.every((v) => v === 0)) return empty("Nothing to show for these dates");
  const H = opts.height ?? 260;
  const left = 56;
  const right = 12;
  const top = series.length > 1 ? 44 : 18;
  const bottom = 34;
  const div = opts.minor ? 100 : 1;
  const sc = niceScale(Math.min(...all) / div, Math.max(...all) / div);
  const plotH = H - top - bottom;
  const plotW = W - left - right;
  const y = (v: number) => top + plotH - ((v / div - sc.lo) / (sc.hi - sc.lo)) * plotH;
  const slot = plotW / n;
  const bw = Math.min(46, (slot * 0.78) / series.length);
  const out: string[] = [];
  for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) {
    const yy = top + plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH;
    out.push(`<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="${chartColors.grid}" stroke-width="1"/><text x="${left - 6}" y="${yy + 4}" text-anchor="end" ${FONT} font-size="11" fill="${chartColors.muted}">${esc(compact(v))}</text>`);
  }
  const zero = y(0);
  const showValues = n * series.length <= 8;
  const every = labelEvery(n);
  labels.forEach((label, i) => {
    const cx = left + slot * i + slot / 2;
    series.forEach((s, k) => {
      const v = s.values[i] ?? 0;
      const x = cx - (bw * series.length) / 2 + bw * k;
      const yy = y(v);
      const h = Math.abs(zero - yy);
      out.push(`<rect x="${x.toFixed(1)}" y="${Math.min(yy, zero).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${Math.max(h, v === 0 ? 0 : 1).toFixed(1)}" fill="${s.color}"><title>${esc(`${label} · ${s.name}: ${compact(v / div)}`)}</title></rect>`);
      if (showValues && v !== 0) out.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${(v >= 0 ? yy - 4 : yy + 12).toFixed(1)}" text-anchor="middle" ${FONT} font-size="10" fill="${chartColors.ink}">${esc(compact(v / div))}</text>`);
    });
    if (i % every === 0) out.push(`<text x="${cx.toFixed(1)}" y="${H - 14}" text-anchor="middle" ${FONT} font-size="11" fill="${chartColors.muted}">${esc(label)}</text>`);
  });
  out.push(`<line x1="${left}" x2="${W - right}" y1="${zero}" y2="${zero}" stroke="${chartColors.ink}" stroke-width="1"/>`);
  const unit = opts.unit ? `<text x="${left}" y="12" ${FONT} font-size="11" fill="${chartColors.muted}">${esc(opts.unit)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}" xmlns="http://www.w3.org/2000/svg">${unit}${legend(series, 28)}${out.join("")}</svg>`;
}

/** Lines over time (sales and profit per day). Needs two or more points to draw a line; one point is a dot. */
export function lineChart(opts: { labels: string[]; series: Series[]; title: string; height?: number } & Axis): string {
  const { labels, series } = opts;
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  if (n === 0 || all.every((v) => v === 0)) return empty("Nothing to show for these dates");
  const H = opts.height ?? 260;
  const left = 56;
  const right = 16;
  const top = series.length > 1 ? 44 : 18;
  const bottom = 34;
  const div = opts.minor ? 100 : 1;
  const sc = niceScale(Math.min(...all) / div, Math.max(...all) / div);
  const plotH = H - top - bottom;
  const plotW = W - left - right;
  const x = (i: number) => (n === 1 ? left + plotW / 2 : left + (plotW * i) / (n - 1));
  const y = (v: number) => top + plotH - ((v / div - sc.lo) / (sc.hi - sc.lo)) * plotH;
  const out: string[] = [];
  for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) {
    const yy = top + plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH;
    out.push(`<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="${chartColors.grid}" stroke-width="1"/><text x="${left - 6}" y="${yy + 4}" text-anchor="end" ${FONT} font-size="11" fill="${chartColors.muted}">${esc(compact(v))}</text>`);
  }
  const every = labelEvery(n);
  labels.forEach((label, i) => {
    if (i % every === 0) out.push(`<text x="${x(i).toFixed(1)}" y="${H - 14}" text-anchor="middle" ${FONT} font-size="11" fill="${chartColors.muted}">${esc(label)}</text>`);
  });
  series.forEach((s, k) => {
    const dash = k === 1 ? ` stroke-dasharray="6 3"` : ""; // the second line is dashed so it reads in black and white
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    if (n > 1) out.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5"${dash}/>`);
    s.values.forEach((v, i) => out.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${n > 31 ? 0 : 3}" fill="${s.color}"><title>${esc(`${labels[i]} · ${s.name}: ${compact(v / div)}`)}</title></circle>`));
  });
  const unit = opts.unit ? `<text x="${left}" y="12" ${FONT} font-size="11" fill="${chartColors.muted}">${esc(opts.unit)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}" xmlns="http://www.w3.org/2000/svg">${unit}${legend(series, 28)}${out.join("")}</svg>`;
}

/** Horizontal bars with the name on the left and the exact value on the right: payment methods, expenses, top items. */
export function hBarChart(opts: { rows: { label: string; value: number; display: string }[]; title: string; color?: string }): string {
  const rows = opts.rows.filter((r) => r.value !== 0);
  if (rows.length === 0) return empty("Nothing to show for these dates");
  const rowH = 26;
  const H = rows.length * rowH + 8;
  const labelW = 215;
  const valueW = 120;
  const barMax = W - labelW - valueW - 10;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)));
  const out = rows.map((r, i) => {
    const y = 4 + i * rowH;
    const w = Math.max(2, (Math.abs(r.value) / max) * barMax);
    const label = r.label.length > 32 ? `${r.label.slice(0, 31)}…` : r.label;
    return `<text x="${labelW - 8}" y="${y + 16}" text-anchor="end" ${FONT} font-size="12" fill="${chartColors.ink}">${esc(label)}</text><rect x="${labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="16" fill="${opts.color ?? chartColors.sales}"><title>${esc(`${r.label}: ${r.display}`)}</title></rect><text x="${(labelW + w + 6).toFixed(1)}" y="${y + 16}" ${FONT} font-size="12" fill="${chartColors.ink}">${esc(r.display)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}" xmlns="http://www.w3.org/2000/svg">${out.join("")}</svg>`;
}
