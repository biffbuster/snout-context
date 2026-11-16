// Fills cancelled spots from the waitlist, first come first served.
export function promoteFromWaitlist(cls, cancelled) {
  const booked = cls.booked.filter((n) => !cancelled.includes(n));
  const free = Math.max(0, cls.capacity - booked.length);
  return { booked: [...booked, ...cls.waitlist.slice(0, free).map((x) => x.name)], waitlist: cls.waitlist.slice(free) };
}
