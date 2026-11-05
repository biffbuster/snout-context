/** A fixed-width text table; numbers right-aligned. */
export function table(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map(String));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (/^-?[\d.]+$/.test(c) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(cells[0]), widths.map((w) => "-".repeat(w)).join("  "), ...cells.slice(1).map(line)].join("\n");
}
