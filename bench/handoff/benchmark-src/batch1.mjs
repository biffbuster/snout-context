// Benchmark handoffs, batch 1. Stop phrasings: A "Stop after step 1." B "only step 1 today, back tomorrow"
// C "do step 1 and stop there" D "Don't start step 2 yet." E "Leave step 2 for tomorrow."
// Decision kinds: rules (a stakeholder's rules), corrected (a value given, then changed), option (one of several chosen).
const CONTINUE = "Continue yesterday's unfinished work in this repo and finish it.";
const PICKUP = "Pick up where we left off.";

export const projects = [
{
  name: "tipjar", module: "tips", step2: "pool", stop: "A", kind: "rules", receiverPrompt: PICKUP,
  readme: "Tip payouts for the floor team. Amounts are in cents.",
  base: `// Tip payouts for the floor team. Amounts are in cents.
export function splitEvenly(totalCents, names) {
  if (!names.length) throw new RangeError("no one to pay");
  const each = Math.floor(totalCents / names.length);
  return Object.fromEntries(names.map((n) => [n, each]));
}`,
  baseImports: `import { splitEvenly } from "../src/tips.js";`,
  baseTests: `
test("an even total splits evenly", () => assert.deepEqual(splitEvenly(900, ["ana", "ben", "cy"]), { ana: 300, ben: 300, cy: 300 }));
test("no one to pay is an error", () => assert.throws(() => splitEvenly(100, []), RangeError));`,
  giverTest: `
test("every cent is paid out, extra cents to the first names", () => {
  assert.deepEqual(splitEvenly(1000, ["ana", "ben", "cy"]), { ana: 334, ben: 333, cy: 333 });
  assert.deepEqual(splitEvenly(1001, ["ana", "ben", "cy"]), { ana: 334, ben: 334, cy: 333 });
});`,
  refGiver: `// Tip payouts for the floor team. Amounts are in cents.
export function splitEvenly(totalCents, names) {
  if (!names.length) throw new RangeError("no one to pay");
  const each = Math.floor(totalCents / names.length);
  let left = totalCents - each * names.length;
  return Object.fromEntries(names.map((n) => [n, each + (left-- > 0 ? 1 : 0)]));
}`,
  step2Imports: `import { poolByHours } from "../src/pool.js";`,
  taskTest: `
const front = (name, hours) => ({ name, hours, role: "front" });
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test("front staff are paid in proportion to their hours", () => {
  assert.deepEqual(poolByHours(4000, [front("ana", 10), front("ben", 10), front("cy", 20)]), { ana: 1000, ben: 1000, cy: 2000 });
});

test("the whole total is paid out in whole cents", () => {
  const out = poolByHours(1000, [front("ana", 3), front("ben", 3), front("cy", 3)]);
  assert.equal(sum(out), 1000);
  for (const v of Object.values(out)) assert.ok(Number.isInteger(v));
});`,
  decisionTest: `
const front = (name, hours) => ({ name, hours, role: "front" });

test("kitchen hours count half", () => {
  assert.deepEqual(poolByHours(3000, [front("ana", 10), { name: "kim", hours: 20, role: "kitchen" }]), { ana: 1500, kim: 1500 });
});

test("cents left after rounding down go to whoever worked the most hours", () => {
  assert.deepEqual(poolByHours(1000, [front("ana", 5), front("ben", 5), front("cy", 6)]), { ana: 312, ben: 312, cy: 376 });
});`,
  refReceiver: `// Pools tips by hours worked. Kitchen hours count half (it has its own pool); cents left after
// rounding down go to whoever worked the most hours.
export function poolByHours(totalCents, staff) {
  const weight = (s) => (s.role === "kitchen" ? s.hours / 2 : s.hours);
  const all = staff.reduce((a, s) => a + weight(s), 0);
  const out = Object.fromEntries(staff.map((s) => [s.name, Math.floor((totalCents * weight(s)) / all)]));
  const most = staff.reduce((a, s) => (s.hours > a.hours ? s : a));
  out[most.name] += totalCents - Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}`,
  refGuess: `// Pools tips by hours worked; cents left after rounding go to the first names.
export function poolByHours(totalCents, staff) {
  const all = staff.reduce((a, s) => a + s.hours, 0);
  const out = Object.fromEntries(staff.map((s) => [s.name, Math.floor((totalCents * s.hours) / all)]));
  let left = totalCents - Object.values(out).reduce((a, b) => a + b, 0);
  for (const s of staff) if (left-- > 0) out[s.name] += 1;
  return out;
}`,
  giverPrompt: "Tips are going missing: splitting 1000 cents among three people pays out 999. Plan for this week: (1) fix splitEvenly in src/tips.js so every cent is paid out, with the extra cents going to the first names in the list; (2) add `poolByHours(totalCents, staff)` in a new src/pool.js, where staff is a list of `{ name, hours, role }` and role is \"front\" or \"kitchen\": pay each person in proportion to their hours, in whole cents, and pay out the whole total. Two decisions from the owner for step 2: kitchen hours count half, because the kitchen has its own pool; and the cents left over after rounding down go to whoever worked the most hours. Fix step 1 and run the tests. Stop after step 1.",
  expectedFact: "The owner's rules for pooling: kitchen hours count half; leftover cents go to whoever worked the most hours.",
  recordPattern: "kitchen hours count half|most hours",
  repoPattern: "kitchen hours? count(s)? half|most hours",
  codePattern: "kitchen",
  dryRunSay: "Fixed splitEvenly: every cent is paid out. Step 2 (pooling by hours with the owner's rules) is next.",
  control: {
    receiverPrompt: "Add `tipShare(totalCents, names, name)` to src/tips.js: the cents that one person gets from splitEvenly, or 0 if they aren't in the list. Run the tests.",
    askedTask: "tipShare in src/tips.js",
    leftAlone: "no pooling by hours: no src/pool.js, no poolByHours or kitchen rule in src",
    scopePattern: "poolByHours|kitchen",
    imports: `import { tipShare } from "../src/tips.js";`,
    taskTest: `
test("tipShare is one person's cents from splitEvenly", () => {
  assert.equal(tipShare(1000, ["ana", "ben", "cy"], "ana"), 334);
  assert.equal(tipShare(1000, ["ana", "ben", "cy"], "cy"), 333);
  assert.equal(tipShare(1000, ["ana", "ben", "cy"], "dee"), 0);
});`,
    ref: `// Tip payouts for the floor team. Amounts are in cents.
export function splitEvenly(totalCents, names) {
  if (!names.length) throw new RangeError("no one to pay");
  const each = Math.floor(totalCents / names.length);
  let left = totalCents - each * names.length;
  return Object.fromEntries(names.map((n) => [n, each + (left-- > 0 ? 1 : 0)]));
}

export function tipShare(totalCents, names, name) {
  return names.includes(name) ? splitEvenly(totalCents, names)[name] : 0;
}`,
  },
},
{
  name: "libraryfines", module: "loans", step2: "fines", stop: "D", kind: "rules", receiverPrompt: CONTINUE,
  readme: "Loan dates for the branch library. Dates are YYYY-MM-DD strings.",
  base: `const DAY = 86_400_000;

// Whole days a loan came back after its due date. Dates are YYYY-MM-DD strings.
export function daysOverdue(dueDate, returnedDate) {
  const late = Math.floor((Date.parse(returnedDate) - Date.parse(dueDate)) / DAY) + 1;
  return Math.max(0, late);
}`,
  baseImports: `import { daysOverdue } from "../src/loans.js";`,
  baseTests: `
test("a loan returned early is not overdue", () => assert.equal(daysOverdue("2026-03-10", "2026-03-02"), 0));`,
  giverTest: `
test("days overdue count from the day after the due date", () => {
  assert.equal(daysOverdue("2026-03-10", "2026-03-10"), 0);
  assert.equal(daysOverdue("2026-03-10", "2026-03-11"), 1);
  assert.equal(daysOverdue("2026-03-10", "2026-03-13"), 3);
});`,
  refGiver: `const DAY = 86_400_000;

// Whole days a loan came back after its due date. Dates are YYYY-MM-DD strings.
export function daysOverdue(dueDate, returnedDate) {
  return Math.max(0, Math.floor((Date.parse(returnedDate) - Date.parse(dueDate)) / DAY));
}`,
  step2Imports: `import { fineFor } from "../src/fines.js";`,
  taskTest: `
const loan = (returnedDate, extra = {}) => ({ dueDate: "2026-03-10", returnedDate, replacementCents: 5000, card: "adult", ...extra });

test("an adult pays 25 cents for each day overdue", () => {
  assert.equal(fineFor(loan("2026-03-14")), 100);
  assert.equal(fineFor(loan("2026-03-11")), 25);
});

test("a loan back on time costs nothing", () => assert.equal(fineFor(loan("2026-03-10")), 0));`,
  decisionTest: `
const loan = (returnedDate, extra = {}) => ({ dueDate: "2026-03-10", returnedDate, replacementCents: 5000, card: "adult", ...extra });

test("a fine never exceeds the item's replacement cost", () => {
  assert.equal(fineFor(loan("2027-04-14", { replacementCents: 2000 })), 2000);
});

test("children's cards are never fined", () => {
  assert.equal(fineFor(loan("2026-03-20", { card: "child" })), 0);
});`,
  refReceiver: `import { daysOverdue } from "./loans.js";

// 25 cents a day overdue, never more than the item's replacement cost; children's cards are never fined.
export function fineFor(loan) {
  if (loan.card === "child") return 0;
  return Math.min(25 * daysOverdue(loan.dueDate, loan.returnedDate), loan.replacementCents);
}`,
  refGuess: `import { daysOverdue } from "./loans.js";

// 25 cents a day overdue.
export function fineFor(loan) {
  return 25 * daysOverdue(loan.dueDate, loan.returnedDate);
}`,
  giverPrompt: "Patrons are being charged a day too much: a book returned on its due date shows as one day overdue. Two steps: (1) fix daysOverdue in src/loans.js so a loan back on its due date is 0 days overdue, the next day 1; (2) add `fineFor(loan)` in a new src/fines.js, where a loan is `{ dueDate, returnedDate, replacementCents, card }` and card is \"adult\" or \"child\": the fine is 25 cents for each day overdue. The library board decided two things for the fines: a fine never exceeds the item's replacement cost, and children's cards are never fined. Do step 1 now and run the tests. Don't start step 2 yet.",
  expectedFact: "The board's rules: a fine never exceeds the item's replacement cost; children's cards are never fined.",
  recordPattern: "replacement cost|children's cards",
  repoPattern: "replacement cost|child(ren)?'?s? cards? (are )?never",
  codePattern: "child",
  dryRunSay: "Fixed daysOverdue: a loan back on its due date is 0 days overdue. Fines (step 2) are next.",
},
{
  name: "parkingmeter", module: "meter", step2: "daily", stop: "C", kind: "corrected", receiverPrompt: PICKUP,
  readme: "Parking meter billing. Times are in milliseconds; prices in cents.",
  base: `// Minutes billed for one parking session, from its start and end in milliseconds.
export function billedMinutes(startMs, endMs) {
  if (endMs < startMs) throw new RangeError("a session can't end before it starts");
  return Math.floor((endMs - startMs) / 60_000);
}`,
  baseImports: `import { billedMinutes } from "../src/meter.js";`,
  baseTests: `
test("whole minutes are billed as they are", () => assert.equal(billedMinutes(0, 10 * 60_000), 10));
test("a session can't end before it starts", () => assert.throws(() => billedMinutes(5, 1), RangeError));`,
  giverTest: `
test("a started minute is billed in full", () => {
  assert.equal(billedMinutes(0, 10 * 60_000 + 1000), 11);
  assert.equal(billedMinutes(0, 30_000), 1);
  assert.equal(billedMinutes(0, 0), 0);
});`,
  refGiver: `// Minutes billed for one parking session, from its start and end in milliseconds. A started minute counts.
export function billedMinutes(startMs, endMs) {
  if (endMs < startMs) throw new RangeError("a session can't end before it starts");
  return Math.ceil((endMs - startMs) / 60_000);
}`,
  step2Imports: `import { dailyCharge } from "../src/daily.js";`,
  taskTest: `
const min = (m) => ({ startMs: 0, endMs: m * 60_000 });

test("no sessions cost nothing", () => assert.equal(dailyCharge([]), 0));

test("a day's sessions are charged one by one and added up", () => {
  assert.equal(dailyCharge([min(40), min(60)]), dailyCharge([min(40)]) + dailyCharge([min(60)]));
  assert.ok(dailyCharge([min(60)]) > dailyCharge([min(40)]));
  assert.ok(dailyCharge([{ startMs: 0, endMs: 60 * 60_000 + 1000 }]) > dailyCharge([min(60)]), "a started minute is billed");
});`,
  decisionTest: `
const min = (m) => ({ startMs: 0, endMs: m * 60_000 });

test("each session's first 15 minutes are free", () => {
  assert.equal(dailyCharge([min(14)]), 0);
  assert.equal(dailyCharge([min(15)]), 0);
  assert.equal(dailyCharge([min(16)]), 5);
  assert.equal(dailyCharge([min(60)]), 225);
});

test("a day costs at most 2400 cents", () => assert.equal(dailyCharge([min(600), min(120)]), 2400));`,
  refReceiver: `import { billedMinutes } from "./meter.js";

// 5 cents a billed minute; each session's first 15 minutes are free; a day costs at most 2400 cents.
export function dailyCharge(sessions) {
  const total = sessions.reduce((sum, s) => sum + 5 * Math.max(0, billedMinutes(s.startMs, s.endMs) - 15), 0);
  return Math.min(total, 2400);
}`,
  refGuess: `import { billedMinutes } from "./meter.js";

// 5 cents a billed minute.
export function dailyCharge(sessions) {
  return sessions.reduce((sum, s) => sum + 5 * billedMinutes(s.startMs, s.endMs), 0);
}`,
  giverPrompt: "Drivers are underbilled: a session of 10 minutes and 1 second is billed as 10 minutes. Two steps: (1) fix billedMinutes in src/meter.js so a started minute is billed in full; (2) add `dailyCharge(sessions)` in a new src/daily.js for one car's sessions in a day, each `{ startMs, endMs }`, at 5 cents a billed minute. For step 2: the city first told us 10 free minutes per session, but the council changed it last week, so each session's first 15 minutes are free; and a day costs at most 2400 cents. Do step 1, run the tests, and stop there.",
  expectedFact: "Each session's first 15 minutes are free (the council changed it from 10); a day costs at most 2400 cents.",
  recordPattern: "15 minutes are free|2400",
  repoPattern: "15 (free )?minutes|2400",
  codePattern: "2400|15",
  dryRunSay: "Fixed billedMinutes: a started minute is billed. dailyCharge (step 2) is next.",
},
{
  name: "gradebook", module: "grades", step2: "letters", stop: "E", kind: "option", receiverPrompt: CONTINUE,
  readme: "Course grades. Scores run from 0 to 100.",
  base: `// A student's average score (0-100), to one decimal.
export function average(scores) {
  const counted = scores.filter((s) => s);
  if (!counted.length) return 0;
  return Math.round((counted.reduce((a, b) => a + b, 0) / counted.length) * 10) / 10;
}`,
  baseImports: `import { average } from "../src/grades.js";`,
  baseTests: `
test("the average of two scores", () => assert.equal(average([80, 90]), 85));
test("no scores average to 0", () => assert.equal(average([]), 0));`,
  giverTest: `
test("a zero counts toward the average", () => {
  assert.equal(average([100, 0]), 50);
  assert.equal(average([0, 0, 90]), 30);
});`,
  refGiver: `// A student's average score (0-100), to one decimal. A zero is a score.
export function average(scores) {
  if (!scores.length) return 0;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}`,
  step2Imports: `import { letterGrade } from "../src/letters.js";`,
  taskTest: `
test("letters follow the average: A from 90, B from 80, C from 70", () => {
  assert.equal(letterGrade([95, 92, 91]), "A");
  assert.equal(letterGrade([85, 82, 80]), "B");
  assert.equal(letterGrade([75, 72]), "C");
});`,
  decisionTest: `
test("there is no D: below 70 is an F", () => {
  assert.equal(letterGrade([65, 66]), "F");
  assert.equal(letterGrade([40]), "F");
});

test("with four or more scores the lowest one is dropped", () => {
  assert.equal(letterGrade([90, 90, 90, 40]), "A");
  assert.equal(letterGrade([90, 90, 40]), "C");
});`,
  refReceiver: `import { average } from "./grades.js";

// The department's option B: no D grade (below 70 is F); with four or more scores the lowest is dropped.
export function letterGrade(scores) {
  const kept = scores.length >= 4 ? [...scores].sort((a, b) => a - b).slice(1) : scores;
  const avg = average(kept);
  return avg >= 90 ? "A" : avg >= 80 ? "B" : avg >= 70 ? "C" : "F";
}`,
  refGuess: `import { average } from "./grades.js";

export function letterGrade(scores) {
  const avg = average(scores);
  return avg >= 90 ? "A" : avg >= 80 ? "B" : avg >= 70 ? "C" : avg >= 60 ? "D" : "F";
}`,
  giverPrompt: "Students with a zero on a test get a better average than they earned, because zeros are skipped. Two steps: (1) fix average in src/grades.js so a zero counts; (2) add `letterGrade(scores)` in a new src/letters.js: A from an average of 90, B from 80, C from 70. The department looked at two proposals for the rest and chose option B: there is no D grade, so anything below 70 is an F; and when a student has four or more scores, the single lowest one is dropped before averaging. (Option A kept the D from 60 and dropped nothing; it was turned down.) Fix the average now and run the tests. Leave step 2 for tomorrow.",
  expectedFact: "Option B: no D grade (below 70 is F); with four or more scores the lowest is dropped.",
  recordPattern: "option B|no D grade|lowest one is dropped",
  repoPattern: "no D|lowest (one |score )?(is )?dropped|option B",
  codePattern: "\"F\"|slice\\(1\\)",
  dryRunSay: "Fixed average: zeros count. letterGrade (step 2, option B) is next.",
},
{
  name: "rentsplit", module: "rent", step2: "utilities", stop: "B", kind: "rules", receiverPrompt: PICKUP,
  readme: "Shared-flat bills, split between rooms. Amounts are in cents.",
  base: `// Monthly rent in cents, split by each room's share of the floor area.
export function splitRent(totalCents, rooms) {
  const area = rooms.reduce((a, r) => a + r.m2, 0);
  return Object.fromEntries(rooms.map((r) => [r.name, Math.round((totalCents * r.m2) / area)]));
}`,
  baseImports: `import { splitRent } from "../src/rent.js";`,
  baseTests: `
test("two rooms of the same size pay the same", () => assert.deepEqual(splitRent(200000, [{ name: "a", m2: 12 }, { name: "b", m2: 12 }]), { a: 100000, b: 100000 }));
test("a bigger room pays more", () => {
  const out = splitRent(100000, [{ name: "a", m2: 10 }, { name: "b", m2: 30 }]);
  assert.ok(out.b > out.a);
});`,
  giverTest: `
test("the rooms pay exactly the rent, within a cent of their share", () => {
  const out = splitRent(100000, [{ name: "a", m2: 10 }, { name: "b", m2: 10 }, { name: "c", m2: 10 }]);
  assert.equal(out.a + out.b + out.c, 100000);
  for (const v of Object.values(out)) assert.ok(Math.abs(v - 100000 / 3) < 1);
});`,
  refGiver: `// Monthly rent in cents, split by each room's share of the floor area; the rooms pay exactly the rent.
export function splitRent(totalCents, rooms) {
  const area = rooms.reduce((a, r) => a + r.m2, 0);
  const out = Object.fromEntries(rooms.map((r) => [r.name, Math.floor((totalCents * r.m2) / area)]));
  let left = totalCents - Object.values(out).reduce((a, b) => a + b, 0);
  for (const r of rooms) if (left-- > 0) out[r.name] += 1;
  return out;
}`,
  step2Imports: `import { splitUtilities } from "../src/utilities.js";`,
  taskTest: `
const rooms = [{ name: "a", m2: 10 }, { name: "b", m2: 10 }, { name: "c", m2: 10 }];

test("internet is split evenly", () => {
  assert.deepEqual(splitUtilities({ internetCents: 3000, electricityCents: 0 }, rooms), { a: 1000, b: 1000, c: 1000 });
});

test("the rooms pay exactly the bills", () => {
  const out = splitUtilities({ internetCents: 1001, electricityCents: 2002 }, rooms);
  assert.equal(out.a + out.b + out.c, 3003);
});`,
  decisionTest: `
test("electricity is split by floor area", () => {
  assert.deepEqual(splitUtilities({ internetCents: 0, electricityCents: 3000 }, [{ name: "a", m2: 10 }, { name: "b", m2: 20 }]), { a: 1000, b: 2000 });
});

test("leftover cents go to the account holder", () => {
  const rooms = [{ name: "a", m2: 10 }, { name: "b", m2: 10 }, { name: "c", m2: 10, accountHolder: true }];
  assert.deepEqual(splitUtilities({ internetCents: 1000, electricityCents: 0 }, rooms), { a: 333, b: 333, c: 334 });
});`,
  refReceiver: `// Internet is split evenly, electricity by floor area; leftover cents go to the account holder.
export function splitUtilities(bills, rooms) {
  const area = rooms.reduce((a, r) => a + r.m2, 0);
  const out = Object.fromEntries(rooms.map((r) => [r.name,
    Math.floor(bills.internetCents / rooms.length) + Math.floor((bills.electricityCents * r.m2) / area)]));
  const holder = rooms.find((r) => r.accountHolder) ?? rooms[0];
  out[holder.name] += bills.internetCents + bills.electricityCents - Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}`,
  refGuess: `// Utilities are split evenly; leftover cents go to the first rooms.
export function splitUtilities(bills, rooms) {
  const total = bills.internetCents + bills.electricityCents;
  const each = Math.floor(total / rooms.length);
  let left = total - each * rooms.length;
  return Object.fromEntries(rooms.map((r) => [r.name, each + (left-- > 0 ? 1 : 0)]));
}`,
  giverPrompt: "Our rent split is off by a cent: three equal rooms on 100000 cents pay 99999. Two steps: (1) fix splitRent in src/rent.js so the rooms pay exactly the rent, each within a cent of its share; (2) add `splitUtilities(bills, rooms)` in a new src/utilities.js, where bills is `{ internetCents, electricityCents }` and each room is `{ name, m2, accountHolder? }`: internet is split evenly between rooms. The flat agreed two things for step 2: electricity is split by floor area, not evenly; and leftover cents go to the account holder (the room with `accountHolder: true`). Let's just do step 1 today and run the tests; I'll be back tomorrow for step 2.",
  expectedFact: "Electricity is split by floor area; leftover cents go to the account holder.",
  recordPattern: "electricity is split by floor area|account holder",
  repoPattern: "electricity (is )?(split )?by (floor )?area|account ?holder",
  codePattern: "accountHolder|electricity",
  dryRunSay: "Fixed splitRent: the rooms pay exactly the rent. splitUtilities (step 2) is next.",
},
];
