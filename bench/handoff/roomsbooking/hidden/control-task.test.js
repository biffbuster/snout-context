import { test } from "node:test";
import assert from "node:assert/strict";
import { roomsFor } from "../src/rooms.js";

const rooms = [{ name: "Oak", seats: 8 }, { name: "Elm", seats: 4 }, { name: "Ash", seats: 12 }];

test("roomsFor lists the rooms that seat the group, smallest first", () => {
  assert.deepEqual(roomsFor(rooms, 6), ["Oak", "Ash"]);
  assert.deepEqual(roomsFor(rooms, 4), ["Elm", "Oak", "Ash"]);
  assert.deepEqual(roomsFor(rooms, 20), []);
});
