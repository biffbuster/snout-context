/** SVG charts drawn from data, sized to their container. No library. */
import { h, s } from "./dom.js";

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
  area?: boolean;
  dashed?: boolean;
}

interface LineOpts {
  height?: number;
  labels: string[];
  fmt: (n: number) => string;
  xfmt?: (label: string, i: number) => string;
  marks?: { i: number; label: string }[];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** A line chart with an optional soft area, gridlines, x labels and a hover readout. */
export function lineChart(series: Series[], o: LineOpts): HTMLElement {
  const box = h("div.chart");
  const tip = h("div.tip");
  box.append(tip);
  const draw = () => {
    const W = Math.max(280, box.clientWidth || 600);
    const H = o.height ?? 240;
    const pad = { l: 44, r: 12, t: 12, b: 26 };
    const n = Math.max(1, o.labels.length);
    const max = niceMax(Math.max(0, ...series.flatMap((x) => x.values)));
    const x = (i: number) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
    const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img" });
    for (let k = 0; k <= 3; k++) {
      const v = (max * k) / 3;
      svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: pad.l - 8, y: y(v) + 4, class: "axis", "text-anchor": "end" }, o.fmt(v)));
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - pad.l) / 80))));
    for (let i = 0; i < n; i += every) {
      svg.append(s("line", { x1: x(i), x2: x(i), y1: pad.t, y2: H - pad.b, class: "grid v" }), s("text", { x: x(i), y: H - 6, class: "axis", "text-anchor": "middle" }, o.xfmt ? o.xfmt(o.labels[i]!, i) : o.labels[i]!));
    }
    for (const m of o.marks ?? []) svg.append(s("line", { x1: x(m.i), x2: x(m.i), y1: pad.t, y2: H - pad.b, class: "mark" }), s("text", { x: x(m.i) + 4, y: pad.t + 10, class: "axis mark-l" }, m.label));
    let gid = 0;
    for (const sr of series) {
      if (!sr.values.length) continue;
      const pts = sr.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      if (sr.area) {
        const id = `g${Math.random().toString(36).slice(2, 8)}${gid++}`;
        svg.append(s("defs", null, s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s("stop", { offset: "0", "stop-color": sr.color, "stop-opacity": 0.22 }), s("stop", { offset: "1", "stop-color": sr.color, "stop-opacity": 0.02 }))));
        svg.append(s("path", { d: `M${x(0)},${y(0)} L${pts.join(" L")} L${x(sr.values.length - 1)},${y(0)} Z`, fill: `url(#${id})` }));
      }
      svg.append(s("polyline", { points: pts.join(" "), fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-dasharray": sr.dashed ? "4 4" : null }));
    }
    const cursor = s("line", { class: "cursor", y1: pad.t, y2: H - pad.b, x1: -10, x2: -10 });
    svg.append(cursor);
    svg.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e as MouseEvent).clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
      cursor.setAttribute("x1", String(x(i)));
      cursor.setAttribute("x2", String(x(i)));
      tip.replaceChildren(h("b", null, o.xfmt ? o.xfmt(o.labels[i]!, i) : o.labels[i]!), ...series.map((sr) => h("div", null, h("i", { style: { background: sr.color } as Partial<CSSStyleDeclaration> }), `${sr.label}: `, h("b.num", null, o.fmt(sr.values[i] ?? 0)))));
      tip.style.display = "block";
      const left = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(r.width - 180, Math.max(0, left + 12))}px`;
    });
    svg.addEventListener("mouseleave", () => {
      tip.style.display = "none";
      cursor.setAttribute("x1", "-10");
      cursor.setAttribute("x2", "-10");
    });
    box.querySelector("svg")?.remove();
    box.prepend(svg);
  };
  observe(box, draw);
  return box;
}

const observers = new WeakMap<Element, ResizeObserver>();
function observe(el: HTMLElement, draw: () => void): void {
  let last = -1;
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w === last) return;
    last = w;
    draw();
  });
  ro.observe(el);
  observers.set(el, ro);
  requestAnimationFrame(() => {
    if (last === -1) draw();
  });
}

/** A meter of small vertical ticks: the filled share in `color`, the rest muted. */
export function ticks(share: number, color = "var(--accent)", count = 28, title?: string): HTMLElement {
  const n = Math.max(0, Math.min(count, Math.round(share * count)));
  return h("div.ticks", { title: title ?? null, role: "meter", "aria-valuenow": Math.round(share * 100), "aria-valuemin": 0, "aria-valuemax": 100 }, Array.from({ length: count }, (_, i) => h("i", { style: i < n ? ({ background: color } as Partial<CSSStyleDeclaration>) : null })));
}

/** A horizontal bar split into parts. */
export function stack(parts: { value: number; color: string; label: string }[], height = 10): HTMLElement {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  return h("div.stack", { style: { height: `${height}px` } as Partial<CSSStyleDeclaration> }, parts.filter((p) => p.value > 0).map((p) => h("i", { title: p.label, style: { width: `${(p.value / total) * 100}%`, background: p.color } as Partial<CSSStyleDeclaration> })));
}

/** Vertical bars, one per label. */
export function bars(values: number[], labels: string[], o: { height?: number; fmt: (n: number) => string; color?: string; xfmt?: (l: string) => string }): HTMLElement {
  const box = h("div.chart");
  const tip = h("div.tip");
  box.append(tip);
  const draw = () => {
    const W = Math.max(240, box.clientWidth || 500);
    const H = o.height ?? 180;
    const pad = { l: 44, r: 8, t: 10, b: 24 };
    const n = Math.max(1, values.length);
    const max = niceMax(Math.max(0, ...values));
    const bw = (W - pad.l - pad.r) / n;
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg" });
    for (let k = 0; k <= 2; k++) {
      const v = (max * k) / 2;
      const yy = pad.t + (1 - v / max) * (H - pad.t - pad.b);
      svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: "grid" }), s("text", { x: pad.l - 8, y: yy + 4, class: "axis", "text-anchor": "end" }, o.fmt(v)));
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 70))));
    values.forEach((v, i) => {
      const bh = (v / max) * (H - pad.t - pad.b);
      const r = s("rect", { x: pad.l + i * bw + bw * 0.18, y: H - pad.b - bh, width: Math.max(1, bw * 0.64), height: Math.max(0, bh), rx: Math.min(4, bw * 0.2), fill: o.color ?? "var(--accent)", class: "bar" });
      r.addEventListener("mouseenter", () => {
        tip.replaceChildren(h("b", null, o.xfmt ? o.xfmt(labels[i]!) : labels[i]!), h("div", null, o.fmt(v)));
        tip.style.display = "block";
        tip.style.left = `${Math.min(W - 160, pad.l + i * bw)}px`;
      });
      r.addEventListener("mouseleave", () => (tip.style.display = "none"));
      svg.append(r);
      if (i % every === 0) svg.append(s("text", { x: pad.l + i * bw + bw / 2, y: H - 6, class: "axis", "text-anchor": "middle" }, o.xfmt ? o.xfmt(labels[i]!) : labels[i]!));
    });
    box.querySelector("svg")?.remove();
    box.prepend(svg);
  };
  observe(box, draw);
  return box;
}

/** A tiny line, for table cells. */
export function spark(values: number[], color = "var(--accent)", w = 90, hgt = 24): SVGElement {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(hgt - 2 - (v / max) * (hgt - 4)).toFixed(1)}`);
  return s("svg", { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: "spark" }, s("polyline", { points: pts.join(" "), fill: "none", stroke: color, "stroke-width": 1.6 }));
}
