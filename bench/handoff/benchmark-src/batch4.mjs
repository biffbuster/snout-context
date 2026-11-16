// Benchmark handoffs, batch 4 (stop phrasings and decision kinds as batch1.mjs).
const CONTINUE = "Continue yesterday's unfinished work in this repo and finish it.";
const PICKUP = "Pick up where we left off.";

export const projects = [
{
  name: "tempalerts", module: "readings", step2: "alerts", stop: "E", kind: "corrected", receiverPrompt: CONTINUE,
  readme: "Fridge temperatures for the kitchen dashboard. A reading is `{ at, c }`: a time in milliseconds and degrees Celsius.",
  base: `// The newest reading.
export function latest(readings) {
  return readings[readings.length - 1];
}`,
  baseImports: `import { latest } from "../src/readings.js";`,
  baseTests: `
test("the newest of readings in order", () => assert.deepEqual(latest([{ at: 1, c: 3 }, { at: 2, c: 4 }]), { at: 2, c: 4 }));`,
  giverTest: `
test("the newest reading, whatever the order they arrived in", () => {
  assert.deepEqual(latest([{ at: 3, c: 5 }, { at: 1, c: 3 }, { at: 2, c: 4 }]), { at: 3, c: 5 });
  assert.deepEqual(latest([{ at: 9, c: 2 }, { at: 4, c: 6 }]), { at: 9, c: 2 });
});`,
  refGiver: `// The newest reading, whatever the order the readings arrived in.
export function latest(readings) {
  return readings.reduce((a, b) => (b.at > a.at ? b : a));
}`,
  step2Imports: `import { alertState } from "../src/alerts.js";`,
  taskTest: `
const at = (cs) => cs.map((c, i) => ({ at: i + 1, c }));

test("a cold fridge is ok", () => assert.equal(alertState(at([2, 3, 4, 3, 2])), "ok"));
test("a fridge that stays warm raises the alarm", () => assert.equal(alertState(at([15, 15, 15, 15, 15])), "alarm"));`,
  decisionTest: `
const at = (cs) => cs.map((c, i) => ({ at: i + 1, c }));

test("the limit is 8°C", () => assert.equal(alertState(at([3, 9, 9, 9])), "alarm"));

test("it takes 3 readings in a row above the limit, in time order", () => {
  assert.equal(alertState(at([12, 3, 12, 3, 12])), "ok");
  assert.equal(alertState([{ at: 3, c: 12 }, { at: 1, c: 12 }, { at: 4, c: 3 }, { at: 2, c: 12 }]), "alarm");
});`,
  refReceiver: `// Alarm once 3 readings in a row, in time order, are above 8°C (food safety corrected the limit from 10°C).
const LIMIT = 8;
const ROW = 3;

export function alertState(readings) {
  let run = 0;
  for (const r of [...readings].sort((a, b) => a.at - b.at)) {
    run = r.c > LIMIT ? run + 1 : 0;
    if (run >= ROW) return "alarm";
  }
  return "ok";
}`,
  refGuess: `// Alarm when a reading is above 10°C.
export function alertState(readings) {
  return readings.some((r) => r.c > 10) ? "alarm" : "ok";
}`,
  giverPrompt: "The fridge dashboard shows a stale temperature when readings arrive out of order. Two steps: (1) fix latest in src/readings.js so it returns the reading with the newest `at`, whatever the order; (2) add `alertState(readings)` in a new src/alerts.js: readings are `{ at, c }` with c in degrees Celsius; return \"alarm\" or \"ok\". For step 2: food safety first gave us 10°C as the limit, then corrected it to 8°C, so the limit is 8°C; and one warm reading is not an alarm: it takes 3 readings in a row above the limit, in time order. Fix step 1 and run the tests. Leave step 2 for tomorrow.",
  expectedFact: "The limit is 8°C (corrected from 10°C); it takes 3 readings in a row above it.",
  recordPattern: "8°C|in a row",
  repoPattern: "8 ?°C|readings in a row",
  codePattern: "LIMIT = 8|ROW = 3",
  dryRunSay: "Fixed latest: it returns the newest reading whatever the order. alertState (step 2) is next.",
  control: {
    receiverPrompt: "Add `averageC(readings)` to src/readings.js: the mean temperature of the readings, to one decimal. Run the tests.",
    askedTask: "averageC in src/readings.js",
    leftAlone: "no alarms: no src/alerts.js, no alertState or limit in src",
    scopePattern: "alertState|LIMIT",
    imports: `import { averageC } from "../src/readings.js";`,
    taskTest: `
test("averageC is the mean temperature, to one decimal", () => {
  assert.equal(averageC([{ at: 1, c: 3 }, { at: 2, c: 4 }, { at: 3, c: 4 }]), 3.7);
  assert.equal(averageC([{ at: 1, c: 5 }]), 5);
});`,
    ref: `// The newest reading, whatever the order the readings arrived in.
export function latest(readings) {
  return readings.reduce((a, b) => (b.at > a.at ? b : a));
}

export function averageC(readings) {
  return Math.round((readings.reduce((s, r) => s + r.c, 0) / readings.length) * 10) / 10;
}`,
  },
},
{
  name: "roomsbooking", module: "rooms", step2: "bookings", stop: "B", kind: "rules", receiverPrompt: PICKUP,
  readme: "Meeting rooms for the office. A room is `{ name, seats }`.",
  base: `// Whether a room seats a group.
export function fitsCapacity(room, people) {
  return people < room.seats;
}`,
  baseImports: `import { fitsCapacity } from "../src/rooms.js";`,
  baseTests: `
test("a small group fits", () => assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 4), true));
test("a group larger than the room doesn't", () => assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 12), false));`,
  giverTest: `
test("a room seats a group as large as its seats", () => {
  assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 8), true);
  assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 9), false);
});`,
  refGiver: `// Whether a room seats a group.
export function fitsCapacity(room, people) {
  return people <= room.seats;
}`,
  step2Imports: `import { bookingStatus } from "../src/bookings.js";`,
  taskTest: `
const existing = [{ room: "Oak", start: 540, end: 600 }];

test("a free slot is confirmed", () => {
  assert.equal(bookingStatus({ room: "Oak", start: 720, end: 780 }, existing), "confirmed");
  assert.equal(bookingStatus({ room: "Elm", start: 540, end: 600 }, existing), "confirmed");
});

test("a booking that overlaps another of the same room is rejected", () => {
  assert.equal(bookingStatus({ room: "Oak", start: 570, end: 630 }, existing), "rejected");
});`,
  decisionTest: `
const existing = [{ room: "Oak", start: 540, end: 600 }];

test("rooms need 15 minutes of cleaning between bookings", () => {
  assert.equal(bookingStatus({ room: "Oak", start: 610, end: 660 }, existing), "rejected");
  assert.equal(bookingStatus({ room: "Oak", start: 480, end: 530 }, existing), "rejected");
  assert.equal(bookingStatus({ room: "Oak", start: 615, end: 660 }, existing), "confirmed");
});

test("bookings over 4 hours are pending", () => {
  assert.equal(bookingStatus({ room: "Elm", start: 720, end: 1020 }, existing), "pending");
  assert.equal(bookingStatus({ room: "Elm", start: 720, end: 960 }, existing), "confirmed");
});`,
  refReceiver: `// Rules from the office manager: a 15-minute cleaning buffer between bookings of a room, and bookings over
// 4 hours are pending until a manager approves them.
const BUFFER = 15;

export function bookingStatus(request, existing) {
  const clash = existing.some((b) => b.room === request.room && request.start < b.end + BUFFER && b.start < request.end + BUFFER);
  if (clash) return "rejected";
  return request.end - request.start > 240 ? "pending" : "confirmed";
}`,
  refGuess: `// A booking is rejected if it overlaps another of the same room.
export function bookingStatus(request, existing) {
  const clash = existing.some((b) => b.room === request.room && request.start < b.end && b.start < request.end);
  return clash ? "rejected" : "confirmed";
}`,
  giverPrompt: "A meeting room for 8 turns away a group of 8. Two steps: (1) fix fitsCapacity in src/rooms.js so a room seats a group as large as its seats; (2) add `bookingStatus(request, existing)` in a new src/bookings.js: a booking is `{ room, start, end }` in minutes from midnight; return \"rejected\" if the request clashes with an existing booking of the same room, otherwise \"confirmed\". The office manager set two rules for step 2: rooms need a 15-minute cleaning buffer between bookings, so bookings of a room less than 15 minutes apart clash; and bookings over 4 hours are \"pending\" until a manager approves them. Let's only do step 1 today and run the tests. I'll be back tomorrow for the bookings.",
  expectedFact: "A 15-minute cleaning buffer between bookings of a room; bookings over 4 hours are pending.",
  recordPattern: "15-minute|cleaning buffer|over 4 hours",
  repoPattern: "15-minute|cleaning buffer|over 4 hours",
  codePattern: "BUFFER|pending",
  dryRunSay: "Fixed fitsCapacity: a room seats a group as large as its seats. bookingStatus (step 2) is next.",
  control: {
    receiverPrompt: "Add `roomsFor(rooms, people)` to src/rooms.js: the names of the rooms that seat that many people, smallest room first. Run the tests.",
    askedTask: "roomsFor in src/rooms.js",
    leftAlone: "no bookings: no src/bookings.js, no bookingStatus or buffer in src",
    scopePattern: "bookingStatus|BUFFER",
    imports: `import { roomsFor } from "../src/rooms.js";`,
    taskTest: `
const rooms = [{ name: "Oak", seats: 8 }, { name: "Elm", seats: 4 }, { name: "Ash", seats: 12 }];

test("roomsFor lists the rooms that seat the group, smallest first", () => {
  assert.deepEqual(roomsFor(rooms, 6), ["Oak", "Ash"]);
  assert.deepEqual(roomsFor(rooms, 4), ["Elm", "Oak", "Ash"]);
  assert.deepEqual(roomsFor(rooms, 20), []);
});`,
    ref: `// Whether a room seats a group.
export function fitsCapacity(room, people) {
  return people <= room.seats;
}

export function roomsFor(rooms, people) {
  return rooms.filter((r) => fitsCapacity(r, people)).sort((a, b) => a.seats - b.seats).map((r) => r.name);
}`,
  },
},
{
  name: "currencyfmt", module: "invoice", step2: "money", stop: "A", kind: "option", receiverPrompt: CONTINUE,
  readme: "Invoices for the studio. A line is `{ cents, qty }`.",
  base: `// The total of an invoice's lines, in cents.
export function totalCents(lines) {
  return lines.reduce((sum, line) => sum + line.cents, 0);
}`,
  baseImports: `import { totalCents } from "../src/invoice.js";`,
  baseTests: `
test("single items add up", () => assert.equal(totalCents([{ cents: 250, qty: 1 }, { cents: 100, qty: 1 }]), 350));
test("an empty invoice is 0", () => assert.equal(totalCents([]), 0));`,
  giverTest: `
test("each line counts its quantity", () => {
  assert.equal(totalCents([{ cents: 250, qty: 3 }]), 750);
  assert.equal(totalCents([{ cents: 250, qty: 3 }, { cents: 100, qty: 2 }]), 950);
});`,
  refGiver: `// The total of an invoice's lines, in cents.
export function totalCents(lines) {
  return lines.reduce((sum, line) => sum + line.cents * line.qty, 0);
}`,
  step2Imports: `import { formatMoney } from "../src/money.js";`,
  taskTest: `
test("amounts are US dollars with thousands separators", () => {
  assert.equal(formatMoney(123456), "$1,234.56");
  assert.equal(formatMoney(5), "$0.05");
  assert.equal(formatMoney(100000050), "$1,000,000.50");
});`,
  decisionTest: `
test("whole amounts drop the cents", () => {
  assert.equal(formatMoney(1200), "$12");
  assert.equal(formatMoney(100000000), "$1,000,000");
});

test("negative amounts go in parentheses", () => {
  assert.equal(formatMoney(-525), "($5.25)");
  assert.equal(formatMoney(-1200), "($12)");
});`,
  refReceiver: `// Option B from finance: whole amounts drop the cents ("$12"), and negative amounts go in parentheses ("($5.25)").
export function formatMoney(cents) {
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  const text = \`$\${dollars}\${abs % 100 ? \`.\${String(abs % 100).padStart(2, "0")}\` : ""}\`;
  return cents < 0 ? \`(\${text})\` : text;
}`,
  refGuess: `// US dollars, like "$1,234.56".
export function formatMoney(cents) {
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  return \`\${cents < 0 ? "-" : ""}$\${dollars}.\${String(abs % 100).padStart(2, "0")}\`;
}`,
  giverPrompt: "Invoices undercount: a line of 3 items at 250 cents adds 250 to the total. Two steps: (1) fix totalCents in src/invoice.js so each line counts its quantity; (2) add `formatMoney(cents)` in a new src/money.js for US dollars, like \"$1,234.56\". Finance compared two styles and chose option B: whole amounts drop the cents (\"$12\", not \"$12.00\"), and negative amounts go in parentheses, like \"($5.25)\". (Option A, always two decimals with a minus sign, was turned down.) Fix the total and run the tests. Stop after step 1.",
  expectedFact: "Option B: whole amounts drop the cents; negative amounts go in parentheses.",
  recordPattern: "option B|parentheses|drop the cents",
  repoPattern: "option B|parentheses|drop the cents",
  codePattern: "parenthes",
  dryRunSay: "Fixed totalCents: each line counts its quantity. formatMoney (step 2, option B) is next.",
},
{
  name: "loyaltypoints", module: "points", step2: "redeem", stop: "C", kind: "option", receiverPrompt: PICKUP,
  readme: "Loyalty points for the shop: a point for each whole dollar spent.",
  base: `// Points earned on a purchase of some cents: one for each whole dollar.
export function pointsEarned(cents) {
  return Math.round(cents / 100);
}`,
  baseImports: `import { pointsEarned } from "../src/points.js";`,
  baseTests: `
test("whole dollars", () => assert.equal(pointsEarned(1000), 10));
test("nothing spent", () => assert.equal(pointsEarned(0), 0));`,
  giverTest: `
test("only whole dollars earn a point", () => {
  assert.equal(pointsEarned(950), 9);
  assert.equal(pointsEarned(999), 9);
  assert.equal(pointsEarned(1001), 10);
});`,
  refGiver: `// Points earned on a purchase of some cents: one for each whole dollar.
export function pointsEarned(cents) {
  return Math.floor(cents / 100);
}`,
  step2Imports: `import { maxRedeemCents } from "../src/redeem.js";`,
  taskTest: `
test("a few points pay their worth, a cent each", () => assert.equal(maxRedeemCents([{ cents: 10000, giftCard: false }], 300), 300));
test("no points pay nothing", () => assert.equal(maxRedeemCents([{ cents: 10000, giftCard: false }], 0), 0));`,
  decisionTest: `
test("points pay at most 50% of the cart", () => assert.equal(maxRedeemCents([{ cents: 1000, giftCard: false }], 5000), 500));

test("gift cards can't be paid with points", () => {
  assert.equal(maxRedeemCents([{ cents: 1000, giftCard: false }, { cents: 2000, giftCard: true }], 5000), 500);
  assert.equal(maxRedeemCents([{ cents: 2000, giftCard: true }], 5000), 0);
});`,
  refReceiver: `// Option 2 from marketing: points pay at most 50% of the cart, and never for gift cards. A point is worth a cent.
export function maxRedeemCents(cart, points) {
  const eligible = cart.filter((item) => !item.giftCard).reduce((s, item) => s + item.cents, 0);
  return Math.min(points, Math.floor(eligible / 2));
}`,
  refGuess: `// Points pay for the cart, a cent each.
export function maxRedeemCents(cart, points) {
  return Math.min(points, cart.reduce((s, item) => s + item.cents, 0));
}`,
  giverPrompt: "Customers earn a point too many: 950 cents of shopping gives 10 points. Two steps: (1) fix pointsEarned in src/points.js so it's 1 point per whole dollar spent; (2) add `maxRedeemCents(cart, points)` in a new src/redeem.js: cart is a list of `{ cents, giftCard }` and each point is worth 1 cent; return how many cents of the cart the customer's points can pay. Marketing compared two proposals and chose option 2: points pay at most 50% of the cart, and gift cards in the cart can't be paid with points. (Option 1, points paying up to the whole cart, gift cards included, was turned down.) Do step 1, run the tests, and stop there.",
  expectedFact: "Option 2: points pay at most 50% of the cart; gift cards can't be paid with points.",
  recordPattern: "option 2|50%|gift cards in the cart",
  repoPattern: "option 2|50%|never for gift cards|gift cards in the cart",
  codePattern: "giftCard|eligible",
  dryRunSay: "Fixed pointsEarned: one point per whole dollar. maxRedeemCents (step 2, option 2) is next.",
},
{
  name: "depositreturn", module: "containers", step2: "refund", stop: "D", kind: "corrected", receiverPrompt: CONTINUE,
  readme: "The bottle return machine. Containers are \"can\", \"plastic\" or \"glass\".",
  base: `// How many containers of each type were scanned.
export function countByType(items) {
  const counts = { can: 0, plastic: 0, glass: 0 };
  for (const type of items) if (type in counts) counts[type] += 1;
  return counts;
}`,
  baseImports: `import { countByType } from "../src/containers.js";`,
  baseTests: `
test("each type is counted", () => assert.deepEqual(countByType(["can", "glass", "can"]), { can: 2, plastic: 0, glass: 1 }));`,
  giverTest: `
test("types count whatever their case", () => {
  assert.deepEqual(countByType(["Glass", "glass", "CAN"]), { can: 1, plastic: 0, glass: 2 });
});`,
  refGiver: `// How many containers of each type were scanned, whatever the case of the type.
export function countByType(items) {
  const counts = { can: 0, plastic: 0, glass: 0 };
  for (const item of items) {
    const type = item.toLowerCase();
    if (type in counts) counts[type] += 1;
  }
  return counts;
}`,
  step2Imports: `import { refundCents } from "../src/refund.js";`,
  taskTest: `
test("cans and plastic bottles refund 10 cents each", () => {
  assert.equal(refundCents([{ type: "can", damaged: false }, { type: "plastic", damaged: false }, { type: "can", damaged: false }]), 30);
  assert.equal(refundCents([]), 0);
});

test("an unknown type is an error", () => assert.throws(() => refundCents([{ type: "carton", damaged: false }]), RangeError));`,
  decisionTest: `
test("glass refunds 25 cents", () => assert.equal(refundCents([{ type: "glass", damaged: false }, { type: "can", damaged: false }]), 35));
test("damaged items refund half", () => assert.equal(refundCents([{ type: "can", damaged: true }]), 5));`,
  refReceiver: `// Glass refunds 25 cents (the state corrected it from 20), cans and plastic 10; damaged items refund half.
const CENTS = { can: 10, plastic: 10, glass: 25 };

export function refundCents(items) {
  return items.reduce((sum, { type, damaged }) => {
    if (!(type in CENTS)) throw new RangeError(\`unknown type: \${type}\`);
    return sum + (damaged ? CENTS[type] / 2 : CENTS[type]);
  }, 0);
}`,
  refGuess: `// Cans and plastic refund 10 cents, glass 20.
const CENTS = { can: 10, plastic: 10, glass: 20 };

export function refundCents(items) {
  return items.reduce((sum, { type }) => {
    if (!(type in CENTS)) throw new RangeError(\`unknown type: \${type}\`);
    return sum + CENTS[type];
  }, 0);
}`,
  giverPrompt: "The return machine undercounts: a bottle scanned as \"Glass\" isn't counted. Two steps: (1) fix countByType in src/containers.js so types count whatever their case; (2) add `refundCents(items)` in a new src/refund.js: items are `{ type, damaged }` with type \"can\", \"plastic\" or \"glass\"; cans and plastic bottles refund 10 cents each; throw a RangeError for any other type. For step 2: the state first published 20 cents for glass, then corrected it to 25, so glass refunds 25 cents; and damaged items refund half. Fix the counting now and run the tests. Don't start step 2 yet.",
  expectedFact: "Glass refunds 25 cents (corrected from 20); damaged items refund half.",
  recordPattern: "25 cents|refund half",
  repoPattern: "25 cents|refund half",
  codePattern: "glass: 25|damaged",
  dryRunSay: "Fixed countByType: types count whatever their case. refundCents (step 2) is next.",
},
];
