// Benchmark handoffs, batch 3 (stop phrasings and decision kinds as batch1.mjs).
const CONTINUE = "Continue yesterday's unfinished work in this repo and finish it.";
const PICKUP = "Pick up where we left off.";

export const projects = [
{
  name: "shiftswap", module: "shifts", step2: "swaps", stop: "C", kind: "corrected", receiverPrompt: PICKUP,
  readme: "Shift swaps for the depot. A shift is `{ start, end }` in hours from the start of the week.",
  base: `// Whether two shifts overlap. Times are hours from the start of the week.
export function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}`,
  baseImports: `import { overlaps } from "../src/shifts.js";`,
  baseTests: `
test("shifts that share hours overlap", () => assert.equal(overlaps({ start: 8, end: 16 }, { start: 12, end: 20 }), true));
test("shifts a day apart don't overlap", () => assert.equal(overlaps({ start: 8, end: 16 }, { start: 32, end: 40 }), false));`,
  giverTest: `
test("shifts that only touch don't overlap", () => {
  assert.equal(overlaps({ start: 6, end: 14 }, { start: 14, end: 22 }), false);
  assert.equal(overlaps({ start: 14, end: 22 }, { start: 6, end: 14 }), false);
  assert.equal(overlaps({ start: 6, end: 14 }, { start: 13, end: 22 }), true);
});`,
  refGiver: `// Whether two shifts overlap. Times are hours from the start of the week; shifts that only touch don't.
export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}`,
  step2Imports: `import { canSwap } from "../src/swaps.js";`,
  taskTest: `
const ana = { name: "ana", trainee: false };

test("a worker can take a shift a day away from their others", () => {
  assert.equal(canSwap(ana, { start: 40, end: 48, night: false }, [{ start: 8, end: 16 }]), true);
  assert.equal(canSwap(ana, { start: 8, end: 16, night: false }, []), true);
});

test("a worker can't take a shift that overlaps one of theirs", () => {
  assert.equal(canSwap(ana, { start: 12, end: 20, night: false }, [{ start: 8, end: 16 }]), false);
});`,
  decisionTest: `
const ana = { name: "ana", trainee: false };

test("a worker needs 11 hours off between shifts", () => {
  assert.equal(canSwap(ana, { start: 25, end: 33, night: false }, [{ start: 8, end: 16 }]), false);
  assert.equal(canSwap(ana, { start: 27, end: 35, night: false }, [{ start: 8, end: 16 }]), true);
});

test("trainees can't swap into night shifts", () => {
  assert.equal(canSwap({ name: "tom", trainee: true }, { start: 22, end: 30, night: true }, []), false);
});`,
  refReceiver: `// Whether a worker can take a shift: 11 hours of rest between shifts (the union rep corrected it from 8),
// and trainees never take night shifts.
const REST = 11;

export function canSwap(worker, shift, schedule) {
  if (worker.trainee && shift.night) return false;
  return schedule.every((s) => shift.start >= s.end + REST || s.start >= shift.end + REST);
}`,
  refGuess: `// Whether a worker can take a shift: 8 hours of rest between shifts.
export function canSwap(worker, shift, schedule) {
  return schedule.every((s) => shift.start >= s.end + 8 || s.start >= shift.end + 8);
}`,
  giverPrompt: "Two shifts that only touch, one ending at hour 14 and the next starting at hour 14, are flagged as clashing. Two steps: (1) fix overlaps in src/shifts.js so shifts that only touch don't overlap; (2) add `canSwap(worker, shift, schedule)` in a new src/swaps.js: worker is `{ name, trainee }`, shift is `{ start, end, night }` in hours from the start of the week, and schedule is the worker's other shifts as `{ start, end }`; return whether the worker can take the shift, never one that overlaps a shift of theirs. For step 2: the union rep first told us 8 hours of rest between shifts, then corrected it to 11, so a worker needs at least 11 hours off between the end of one shift and the start of the next; and trainees can't swap into night shifts. Fix step 1, run the tests, and stop there.",
  expectedFact: "A worker needs 11 hours off between shifts (corrected from 8); trainees can't swap into night shifts.",
  recordPattern: "11 hours|trainees can't",
  repoPattern: "11 hours|trainees can.?t",
  codePattern: "REST = 11|trainee",
  dryRunSay: "Fixed overlaps: shifts that only touch don't overlap. canSwap (step 2) is next.",
},
{
  name: "scoreboard", module: "results", step2: "standings", stop: "A", kind: "corrected", receiverPrompt: CONTINUE,
  readme: "Results for the five-a-side league. A result is `{ for, against }` from one team's side.",
  base: `// League points for one result, from the team's side: a win is 3.
export function points(r) {
  if (r.for >= r.against) return 3;
  return 0;
}`,
  baseImports: `import { points } from "../src/results.js";`,
  baseTests: `
test("a win is 3 points", () => assert.equal(points({ for: 2, against: 1 }), 3));
test("a loss is 0 points", () => assert.equal(points({ for: 0, against: 1 }), 0));`,
  giverTest: `
test("a draw is 1 point", () => {
  assert.equal(points({ for: 1, against: 1 }), 1);
  assert.equal(points({ for: 0, against: 0 }), 1);
  assert.equal(points({ for: 3, against: 2 }), 3);
});`,
  refGiver: `// League points for one result, from the team's side: a win is 3, a draw 1, a loss 0.
export function points(r) {
  if (r.for > r.against) return 3;
  return r.for === r.against ? 1 : 0;
}`,
  step2Imports: `import { standings } from "../src/standings.js";`,
  taskTest: `
test("teams are ordered by points, most first", () => {
  const teams = [
    { name: "Reds", results: [{ for: 0, against: 2, forfeit: false }, { for: 1, against: 1, forfeit: false }] },
    { name: "Blues", results: [{ for: 3, against: 0, forfeit: false }, { for: 2, against: 1, forfeit: false }] },
    { name: "Greens", results: [{ for: 2, against: 0, forfeit: false }, { for: 0, against: 1, forfeit: false }] },
  ];
  assert.deepEqual(standings(teams), ["Blues", "Greens", "Reds"]);
});`,
  decisionTest: `
test("ties on points are broken by goal difference", () => {
  const teams = [
    { name: "Scorers", results: [{ for: 5, against: 4, forfeit: false }, { for: 0, against: 1, forfeit: false }] },
    { name: "Savers", results: [{ for: 3, against: 0, forfeit: false }, { for: 0, against: 1, forfeit: false }] },
  ];
  assert.deepEqual(standings(teams), ["Savers", "Scorers"]);
});

test("a forfeited match is a 0-3 loss, whatever score was entered", () => {
  const teams = [
    { name: "NoShows", results: [{ for: 2, against: 1, forfeit: true }] },
    { name: "Drawers", results: [{ for: 0, against: 0, forfeit: false }] },
  ];
  assert.deepEqual(standings(teams), ["Drawers", "NoShows"]);
});`,
  refReceiver: `// The table: most points first, ties broken by goal difference (the league corrected it from goals scored).
// A match a team forfeited counts as a 0-3 loss for it.
const points = (r) => (r.for > r.against ? 3 : r.for === r.against ? 1 : 0);

export function standings(teams) {
  const rows = teams.map((t) => {
    const results = t.results.map((r) => (r.forfeit ? { for: 0, against: 3 } : r));
    return { name: t.name, pts: results.reduce((s, r) => s + points(r), 0), gd: results.reduce((s, r) => s + r.for - r.against, 0) };
  });
  return rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd).map((r) => r.name);
}`,
  refGuess: `// The table: most points first, ties broken by goals scored.
const points = (r) => (r.for > r.against ? 3 : r.for === r.against ? 1 : 0);

export function standings(teams) {
  const rows = teams.map((t) => ({ name: t.name, pts: t.results.reduce((s, r) => s + points(r), 0), goals: t.results.reduce((s, r) => s + r.for, 0) }));
  return rows.sort((a, b) => b.pts - a.pts || b.goals - a.goals).map((r) => r.name);
}`,
  giverPrompt: "The league table is wrong: a draw gives both teams 3 points. Two steps: (1) fix points in src/results.js so a draw is 1 point (a win is 3, a loss 0); (2) add `standings(teams)` in a new src/standings.js: teams is a list of `{ name, results }`, each result `{ for, against, forfeit }` from that team's side; return the team names, most points first. For step 2: the league first said ties on points are broken by goals scored, then corrected that to goal difference, so ties are broken by goal difference; and a match a team forfeited (`forfeit: true`) counts as a 0-3 loss for that team, whatever score was entered. Fix step 1 and run the tests. Stop after step 1.",
  expectedFact: "Ties on points are broken by goal difference (corrected from goals scored); a forfeited match is a 0-3 loss.",
  recordPattern: "goal difference|0-3 loss",
  repoPattern: "goal difference|0-3 loss",
  codePattern: "forfeit",
  dryRunSay: "Fixed points: a draw is 1 point. standings (step 2) is next.",
},
{
  name: "warehousepick", module: "bins", step2: "route", stop: "B", kind: "rules", receiverPrompt: PICKUP,
  readme: "Pick lists for the warehouse. A bin code is the aisle letter, the slot, then the shelf level: \"A7-3\".",
  base: `// A bin code such as "A7-3" as its aisle, slot and shelf level.
export function parseBin(code) {
  const [head, level] = code.split("-");
  return { aisle: head[0], slot: Number(head[1]), level: Number(level) };
}`,
  baseImports: `import { parseBin } from "../src/bins.js";`,
  baseTests: `
test("a bin code is aisle, slot and level", () => assert.deepEqual(parseBin("A7-3"), { aisle: "A", slot: 7, level: 3 }));`,
  giverTest: `
test("slots of two digits parse right", () => {
  assert.deepEqual(parseBin("B12-1"), { aisle: "B", slot: 12, level: 1 });
  assert.deepEqual(parseBin("C40-2"), { aisle: "C", slot: 40, level: 2 });
});`,
  refGiver: `// A bin code such as "A7-3" or "B12-1" as its aisle, slot and shelf level.
export function parseBin(code) {
  const [head, level] = code.split("-");
  return { aisle: head[0], slot: Number(head.slice(1)), level: Number(level) };
}`,
  step2Imports: `import { pickOrder } from "../src/route.js";`,
  taskTest: `
const item = (sku, bin) => ({ sku, bin, frozen: false });

test("items are picked aisle by aisle from A, slot by slot", () => {
  assert.deepEqual(pickOrder([item("c9", "C9-1"), item("a12", "A12-2"), item("c2", "C2-1"), item("a3", "A3-1")]), ["a3", "a12", "c2", "c9"]);
});`,
  decisionTest: `
const item = (sku, bin, frozen = false) => ({ sku, bin, frozen });

test("aisles are walked in a snake: B, D and so on from the highest slot down", () => {
  assert.deepEqual(pickOrder([item("b3", "B3-1"), item("a1", "A1-1"), item("b9", "B9-2")]), ["a1", "b9", "b3"]);
});

test("frozen items are picked last", () => {
  assert.deepEqual(pickOrder([item("ice", "A1-1", true), item("c5", "C5-1")]), ["c5", "ice"]);
});`,
  refReceiver: `// Walking order: aisle by aisle from A in a snake (A, C, E... from the lowest slot up; B, D, F... from the
// highest slot down), with frozen items picked last so they stay cold.
const parse = (bin) => { const m = /^([A-Z])(\\d+)-(\\d+)$/.exec(bin); return { aisle: m[1], slot: Number(m[2]) }; };

function walk(a, b) {
  const x = parse(a.bin), y = parse(b.bin);
  if (x.aisle !== y.aisle) return x.aisle < y.aisle ? -1 : 1;
  return (x.aisle.charCodeAt(0) - 65) % 2 ? y.slot - x.slot : x.slot - y.slot;
}

export function pickOrder(items) {
  const sorted = [...items].sort(walk);
  return [...sorted.filter((i) => !i.frozen), ...sorted.filter((i) => i.frozen)].map((i) => i.sku);
}`,
  refGuess: `// Walking order: aisle by aisle from A, slot by slot.
const parse = (bin) => { const m = /^([A-Z])(\\d+)-(\\d+)$/.exec(bin); return { aisle: m[1], slot: Number(m[2]) }; };

export function pickOrder(items) {
  return [...items]
    .sort((a, b) => { const x = parse(a.bin), y = parse(b.bin); return x.aisle === y.aisle ? x.slot - y.slot : x.aisle < y.aisle ? -1 : 1; })
    .map((i) => i.sku);
}`,
  giverPrompt: "Pickers are sent to the wrong slot: bin \"B12-1\" reads as slot 1. Two steps: (1) fix parseBin in src/bins.js so slots of two digits parse right; (2) add `pickOrder(items)` in a new src/route.js: items are `{ sku, bin, frozen }` with bins like \"A7-3\"; return the SKUs in walking order, aisle by aisle from A, slot by slot. The floor lead set two rules for step 2: frozen items are picked last, after everything else, so they stay cold; and the aisles are walked in a snake: A, C, E and so on from the lowest slot up, B, D, F and so on from the highest slot down. Let's just do step 1 today and run the tests. Back tomorrow for the route.",
  expectedFact: "Frozen items are picked last; aisles are walked in a snake (B, D, F... from the highest slot down).",
  recordPattern: "picked last|snake",
  repoPattern: "picked last|snake",
  codePattern: "frozen",
  dryRunSay: "Fixed parseBin: two-digit slots parse right. pickOrder (step 2) is next.",
},
{
  name: "ticketfees", module: "prices", step2: "fees", stop: "D", kind: "option", receiverPrompt: CONTINUE,
  readme: "Ticket prices for the box office, in cents.",
  base: `// A price typed as dollars ("12.50") in cents.
export function parsePrice(text) {
  return Math.floor(Number(text) * 100);
}`,
  baseImports: `import { parsePrice } from "../src/prices.js";`,
  baseTests: `
test("dollars and cents", () => assert.equal(parsePrice("12.50"), 1250));
test("whole dollars", () => assert.equal(parsePrice("10"), 1000));`,
  giverTest: `
test("prices are read to the exact cent", () => {
  assert.equal(parsePrice("19.99"), 1999);
  assert.equal(parsePrice("0.29"), 29);
});`,
  refGiver: `// A price typed as dollars ("12.50") in cents, to the exact cent.
export function parsePrice(text) {
  return Math.round(Number(text) * 100);
}`,
  step2Imports: `import { orderTotal } from "../src/fees.js";`,
  taskTest: `
test("an order sums its tickets and adds the fee", () => {
  const out = orderTotal([1000, 2500], { student: false });
  assert.equal(out.tickets, 3500);
  assert.equal(out.total, out.tickets + out.fee);
});`,
  decisionTest: `
test("the fee is a flat 150 cents per order", () => {
  assert.equal(orderTotal([1000, 2500], { student: false }).fee, 150);
  assert.equal(orderTotal([4000], { student: false }).fee, 150);
});

test("students pay no service fee", () => assert.deepEqual(orderTotal([1000, 2500], { student: true }), { tickets: 3500, fee: 0, total: 3500 }));`,
  refReceiver: `// Option B from the promoters: a flat 150-cent service fee per order; students pay no service fee.
export function orderTotal(tickets, buyer) {
  const sum = tickets.reduce((s, c) => s + c, 0);
  const fee = buyer.student ? 0 : 150;
  return { tickets: sum, fee, total: sum + fee };
}`,
  refGuess: `// A 10% service fee on each ticket.
export function orderTotal(tickets, buyer) {
  const sum = tickets.reduce((s, c) => s + c, 0);
  const fee = tickets.reduce((s, c) => s + Math.round(c / 10), 0);
  return { tickets: sum, fee, total: sum + fee };
}`,
  giverPrompt: "Ticket prices lose a cent: \"19.99\" is read as 1998 cents. Two steps: (1) fix parsePrice in src/prices.js so prices are read to the exact cent; (2) add `orderTotal(tickets, buyer)` in a new src/fees.js: tickets is a list of ticket prices in cents and buyer is `{ student }`; return `{ tickets, fee, total }`, with tickets the sum of the ticket prices, fee the service fee and total the two together. The promoters compared two fee models and chose option B: a flat 150-cent service fee per order, not per ticket, and students pay no service fee. (Option A, 10% of each ticket, was turned down.) Fix the parsing now and run the tests. Don't start step 2 yet.",
  expectedFact: "Option B: a flat 150-cent service fee per order; students pay no service fee.",
  recordPattern: "option B|150-cent|students pay no",
  repoPattern: "option B|150-cent|students pay no",
  codePattern: "student",
  dryRunSay: "Fixed parsePrice: prices are read to the exact cent. orderTotal (step 2, option B) is next.",
},
{
  name: "smsquota", module: "segments", step2: "billing", stop: "E", kind: "option", receiverPrompt: PICKUP,
  readme: "Text message billing. A message is sent in segments of up to 160 characters.",
  base: `// The segments a text message is sent in, at 160 characters a segment.
export function segmentCount(text) {
  return Math.floor(text.length / 160);
}`,
  baseImports: `import { segmentCount } from "../src/segments.js";`,
  baseTests: `
test("two full segments", () => assert.equal(segmentCount("x".repeat(320)), 2));
test("an empty message has no segments", () => assert.equal(segmentCount(""), 0));`,
  giverTest: `
test("a started segment counts in full", () => {
  assert.equal(segmentCount("x".repeat(161)), 2);
  assert.equal(segmentCount("x"), 1);
  assert.equal(segmentCount("x".repeat(160)), 1);
});`,
  refGiver: `// The segments a text message is sent in, at 160 characters a segment; a started segment counts.
export function segmentCount(text) {
  return Math.ceil(text.length / 160);
}`,
  step2Imports: `import { monthlyBill } from "../src/billing.js";`,
  taskTest: `
test("a month with no messages costs nothing", () => assert.equal(monthlyBill([]), 0));

test("each further segment costs 2 cents", () => {
  assert.equal(monthlyBill([{ segments: 300, international: false }]) - monthlyBill([{ segments: 299, international: false }]), 2);
});`,
  decisionTest: `
test("the first 100 domestic segments each month are free", () => {
  assert.equal(monthlyBill([{ segments: 60, international: false }, { segments: 40, international: false }]), 0);
  assert.equal(monthlyBill([{ segments: 150, international: false }]), 100);
});

test("international segments cost 5 cents and are never free", () => {
  assert.equal(monthlyBill([{ segments: 10, international: true }]), 50);
});`,
  refReceiver: `// Option 2 from the product team: the first 100 domestic segments each month are free, then 2 cents each;
// international segments cost 5 cents each and never count toward the free ones.
const FREE = 100;

export function monthlyBill(messages) {
  const sum = (intl) => messages.filter((m) => !!m.international === intl).reduce((s, m) => s + m.segments, 0);
  return Math.max(0, sum(false) - FREE) * 2 + sum(true) * 5;
}`,
  refGuess: `// 2 cents a segment.
export function monthlyBill(messages) {
  return messages.reduce((s, m) => s + m.segments * 2, 0);
}`,
  giverPrompt: "Long texts are undercharged: a 161-character message counts as 1 segment. Two steps: (1) fix segmentCount in src/segments.js so a started segment counts in full; (2) add `monthlyBill(messages)` in a new src/billing.js: messages are one month's `{ segments, international }`; return the bill in cents, at 2 cents a segment. The product team compared two plans and chose option 2: the first 100 domestic segments each month are free, and international segments cost 5 cents each and never count toward the free ones. (Option 1, 50 free segments with international at the domestic price, was turned down.) Fix the count and run the tests. Leave step 2 for tomorrow.",
  expectedFact: "Option 2: the first 100 domestic segments a month are free; international segments cost 5 cents and are never free.",
  recordPattern: "option 2|first 100|5 cents",
  repoPattern: "option 2|first 100|5 cents",
  codePattern: "FREE = 100|international",
  dryRunSay: "Fixed segmentCount: a started segment counts. monthlyBill (step 2, option 2) is next.",
},
];
