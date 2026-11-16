// Whether a room seats a group.
export function fitsCapacity(room, people) {
  return people <= room.seats;
}
