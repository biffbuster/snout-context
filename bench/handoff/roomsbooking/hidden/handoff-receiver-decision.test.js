import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingStatus } from "../src/bookings.js";

const existing = [{ room: "Oak", start: 540, end: 600 }];

test("rooms need 15 minutes of cleaning between bookings", () => {
  assert.equal(bookingStatus({ room: "Oak", start: 610, end: 660 }, existing), "rejected");
  assert.equal(bookingStatus({ room: "Oak", start: 480, end: 530 }, existing), "rejected");
  assert.equal(bookingStatus({ room: "Oak", start: 615, end: 660 }, existing), "confirmed");
});

test("bookings over 4 hours are pending", () => {
  assert.equal(bookingStatus({ room: "Elm", start: 720, end: 1020 }, existing), "pending");
  assert.equal(bookingStatus({ room: "Elm", start: 720, end: 960 }, existing), "confirmed");
});
