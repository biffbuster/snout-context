// 2 cents a segment.
export function monthlyBill(messages) {
  return messages.reduce((s, m) => s + m.segments * 2, 0);
}
