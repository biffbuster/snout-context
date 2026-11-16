// US dollars, like "$1,234.56".
export function formatMoney(cents) {
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
