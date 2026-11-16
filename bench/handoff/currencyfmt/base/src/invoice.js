// The total of an invoice's lines, in cents.
export function totalCents(lines) {
  return lines.reduce((sum, line) => sum + line.cents, 0);
}
