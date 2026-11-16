// A booking is rejected if it overlaps another of the same room.
export function bookingStatus(request, existing) {
  const clash = existing.some((b) => b.room === request.room && request.start < b.end && b.start < request.end);
  return clash ? "rejected" : "confirmed";
}
