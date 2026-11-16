// Rules from the office manager: a 15-minute cleaning buffer between bookings of a room, and bookings over
// 4 hours are pending until a manager approves them.
const BUFFER = 15;

export function bookingStatus(request, existing) {
  const clash = existing.some((b) => b.room === request.room && request.start < b.end + BUFFER && b.start < request.end + BUFFER);
  if (clash) return "rejected";
  return request.end - request.start > 240 ? "pending" : "confirmed";
}
