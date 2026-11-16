import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingStatus } from "../src/bookings.js";

const existing = [{ room: "Oak", start: 540, end: 600 }];

test("a free slot is confirmed", () => {
  assert.equal(bookingStatus({ room: "Oak", start: 720, end: 780 }, existing), "confirmed");
  assert.equal(bookingStatus({ room: "Elm", start: 540, end: 600 }, existing), "confirmed");
});

test("a booking that overlaps another of the same room is rejected", () => {
  assert.equal(bookingStatus({ room: "Oak", start: 570, end: 630 }, existing), "rejected");
});
