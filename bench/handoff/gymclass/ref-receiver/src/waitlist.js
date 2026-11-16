// Fills cancelled spots from the waitlist. Founding-tier members go first; anyone who declined a
// spot twice is dropped from the waitlist.
export function promoteFromWaitlist(cls, cancelled) {
  const booked = cls.booked.filter((n) => !cancelled.includes(n));
  const eligible = cls.waitlist.filter((x) => (x.declines ?? 0) < 2);
  const queue = [...eligible.filter((x) => x.tier === "founding"), ...eligible.filter((x) => x.tier !== "founding")];
  const promoted = queue.slice(0, Math.max(0, cls.capacity - booked.length));
  return { booked: [...booked, ...promoted.map((x) => x.name)], waitlist: queue.slice(promoted.length) };
}
