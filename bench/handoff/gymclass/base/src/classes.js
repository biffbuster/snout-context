// Spots left in a class, and whether it takes no more bookings.
export function spotsLeft(cls) {
  return cls.capacity - cls.booked.length;
}

export function isFull(cls) {
  return cls.booked.length > cls.capacity;
}
