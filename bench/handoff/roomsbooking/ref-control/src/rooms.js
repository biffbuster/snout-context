// Whether a room seats a group.
export function fitsCapacity(room, people) {
  return people <= room.seats;
}

export function roomsFor(rooms, people) {
  return rooms.filter((r) => fitsCapacity(r, people)).sort((a, b) => a.seats - b.seats).map((r) => r.name);
}
