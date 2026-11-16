// Option B from finance: whole amounts drop the cents ("$12"), and negative amounts go in parentheses ("($5.25)").
export function formatMoney(cents) {
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `$${dollars}${abs % 100 ? `.${String(abs % 100).padStart(2, "0")}` : ""}`;
  return cents < 0 ? `(${text})` : text;
}
