// Benchmark handoffs, batch 2 (stop phrasings and decision kinds as batch1.mjs).
const CONTINUE = "Continue yesterday's unfinished work in this repo and finish it.";
const PICKUP = "Pick up where we left off.";

export const projects = [
{
  name: "gymclass", module: "classes", step2: "waitlist", stop: "B", kind: "rules", receiverPrompt: CONTINUE,
  readme: "Class bookings for the studio. A class is `{ capacity, booked }`, booked a list of member names.",
  base: `// Spots left in a class, and whether it takes no more bookings.
export function spotsLeft(cls) {
  return cls.capacity - cls.booked.length;
}

export function isFull(cls) {
  return cls.booked.length > cls.capacity;
}`,
  baseImports: `import { isFull, spotsLeft } from "../src/classes.js";`,
  baseTests: `
test("spots left", () => assert.equal(spotsLeft({ capacity: 10, booked: ["a", "b", "c"] }), 7));
test("a class with room is not full", () => assert.equal(isFull({ capacity: 10, booked: ["a", "b", "c"] }), false));`,
  giverTest: `
const cls = (n) => ({ capacity: 10, booked: Array.from({ length: n }, (_, i) => \`m\${i}\`) });

test("a class is full once every spot is booked", () => {
  assert.equal(isFull(cls(10)), true);
  assert.equal(isFull(cls(11)), true);
  assert.equal(isFull(cls(9)), false);
});`,
  refGiver: `// Spots left in a class, and whether it takes no more bookings.
export function spotsLeft(cls) {
  return cls.capacity - cls.booked.length;
}

export function isFull(cls) {
  return cls.booked.length >= cls.capacity;
}`,
  step2Imports: `import { promoteFromWaitlist } from "../src/waitlist.js";`,
  taskTest: `
const w = (name, extra = {}) => ({ name, tier: "regular", declines: 0, ...extra });

test("a cancelled spot goes to the next on the waitlist", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("c"), w("d")] }, ["a"]);
  assert.deepEqual(out.booked, ["b", "c"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), ["d"]);
});

test("with no cancellations nothing moves", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("c")] }, []);
  assert.deepEqual(out.booked, ["a", "b"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), ["c"]);
});`,
  decisionTest: `
const w = (name, extra = {}) => ({ name, tier: "regular", declines: 0, ...extra });

test("founding-tier members are promoted before everyone else", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("c"), w("f", { tier: "founding" })] }, ["a"]);
  assert.deepEqual(out.booked, ["b", "f"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), ["c"]);
});

test("anyone who declined a spot twice is dropped from the waitlist", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("x", { declines: 2 }), w("c")] }, ["a"]);
  assert.deepEqual(out.booked, ["b", "c"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), []);
});`,
  refReceiver: `// Fills cancelled spots from the waitlist. Founding-tier members go first; anyone who declined a
// spot twice is dropped from the waitlist.
export function promoteFromWaitlist(cls, cancelled) {
  const booked = cls.booked.filter((n) => !cancelled.includes(n));
  const eligible = cls.waitlist.filter((x) => (x.declines ?? 0) < 2);
  const queue = [...eligible.filter((x) => x.tier === "founding"), ...eligible.filter((x) => x.tier !== "founding")];
  const promoted = queue.slice(0, Math.max(0, cls.capacity - booked.length));
  return { booked: [...booked, ...promoted.map((x) => x.name)], waitlist: queue.slice(promoted.length) };
}`,
  refGuess: `// Fills cancelled spots from the waitlist, first come first served.
export function promoteFromWaitlist(cls, cancelled) {
  const booked = cls.booked.filter((n) => !cancelled.includes(n));
  const free = Math.max(0, cls.capacity - booked.length);
  return { booked: [...booked, ...cls.waitlist.slice(0, free).map((x) => x.name)], waitlist: cls.waitlist.slice(free) };
}`,
  giverPrompt: "A class with 10 of 10 spots booked still takes bookings. Two steps: (1) fix isFull in src/classes.js so a class is full once every spot is booked; (2) add `promoteFromWaitlist(cls, cancelled)` in a new src/waitlist.js: cls is `{ capacity, booked, waitlist }`, booked a list of member names and waitlist a list of `{ name, tier, declines }`; remove the cancelled names from booked, fill the freed spots from the waitlist, and return `{ booked, waitlist }`. The studio manager set two rules for step 2: founding-tier members on the waitlist are promoted before everyone else; and anyone who has declined a spot twice is dropped from the waitlist. Let's only do step 1 today and run the tests. I'll be back tomorrow for step 2.",
  expectedFact: "Founding-tier members are promoted first; anyone who declined a spot twice is dropped from the waitlist.",
  recordPattern: "founding|declined a spot twice",
  repoPattern: "founding|declin(ed|es) (a spot )?twice",
  codePattern: "founding|declines",
  dryRunSay: "Fixed isFull: a class is full once every spot is booked. The waitlist (step 2) is next.",
},
{
  name: "carbonlog", module: "units", step2: "flights", stop: "A", kind: "corrected", receiverPrompt: PICKUP,
  readme: "Emissions for the annual report. Amounts are kilograms of CO2 unless named tonnes.",
  base: `// Kilograms of CO2 as tonnes, to two decimals.
export function toTonnes(kg) {
  return Math.floor(kg / 10) / 100;
}`,
  baseImports: `import { toTonnes } from "../src/units.js";`,
  baseTests: `
test("whole tonnes", () => assert.equal(toTonnes(2000), 2));
test("half a tonne", () => assert.equal(toTonnes(1500), 1.5));`,
  giverTest: `
test("tonnes are rounded to two decimals, not cut off", () => {
  assert.equal(toTonnes(1555), 1.56);
  assert.equal(toTonnes(1554), 1.55);
  assert.equal(toTonnes(4), 0);
});`,
  refGiver: `// Kilograms of CO2 as tonnes, rounded to two decimals.
export function toTonnes(kg) {
  return Math.round(kg / 10) / 100;
}`,
  step2Imports: `import { flightKg } from "../src/flights.js";`,
  taskTest: `
test("economy flights emit 0.15 kg a km, in whole kilograms", () => {
  assert.equal(flightKg(1000, "economy"), 150);
  assert.equal(flightKg(2000, "economy"), 300);
  assert.equal(flightKg(1234, "economy"), 185);
});

test("an unknown cabin is an error", () => assert.throws(() => flightKg(1000, "first"), RangeError));`,
  decisionTest: `
test("business is 2.9 times economy", () => assert.equal(flightKg(1000, "business"), 435));

test("flights under 500 km add 50 kg for take-off and landing", () => {
  assert.equal(flightKg(400, "economy"), 110);
  assert.equal(flightKg(500, "economy"), 75);
});`,
  refReceiver: `// Kilograms of CO2 for a flight: economy 0.15 kg a km, business 2.9 times that; flights under
// 500 km add 50 kg for take-off and landing.
const FACTOR = { economy: 1, business: 2.9 };

export function flightKg(km, cabin) {
  if (!(cabin in FACTOR)) throw new RangeError(\`unknown cabin: \${cabin}\`);
  return Math.round(km * 0.15 * FACTOR[cabin] + (km < 500 ? 50 : 0));
}`,
  refGuess: `// Kilograms of CO2 for a flight: economy 0.15 kg a km, business twice that.
const FACTOR = { economy: 1, business: 2 };

export function flightKg(km, cabin) {
  if (!(cabin in FACTOR)) throw new RangeError(\`unknown cabin: \${cabin}\`);
  return Math.round(km * 0.15 * FACTOR[cabin]);
}`,
  giverPrompt: "The annual report shows 1555 kg as 1.55 t instead of 1.56 t. Two steps: (1) fix toTonnes in src/units.js so it rounds to two decimals instead of cutting off; (2) add `flightKg(km, cabin)` in a new src/flights.js, returning whole kilograms of CO2, rounded: economy is 0.15 kg per km; throw a RangeError for a cabin other than \"economy\" or \"business\". For step 2: the sustainability team first sent a business factor of 2.0, then corrected it to 2.9, so business is 2.9 times economy; and flights under 500 km add a fixed 50 kg for take-off and landing. Fix step 1 and run the tests. Stop after step 1.",
  expectedFact: "Business is 2.9 times economy (corrected from 2.0); flights under 500 km add 50 kg.",
  recordPattern: "2\\.9|50 kg",
  repoPattern: "2\\.9|50 ?kg",
  codePattern: "2\\.9",
  dryRunSay: "Fixed toTonnes: it rounds to two decimals. flightKg (step 2) is next.",
},
{
  name: "leavebalance", module: "accrual", step2: "carryover", stop: "E", kind: "rules", receiverPrompt: CONTINUE,
  readme: "Vacation days for staff, at 25 days a year.",
  base: `// Vacation days earned by the end of a month of the year (1-12), at 25 days a year, to one decimal.
export function earnedBy(month) {
  return Math.round((((month - 1) * 25) / 12) * 10) / 10;
}`,
  baseImports: `import { earnedBy } from "../src/accrual.js";`,
  baseTests: `
test("days earned grow each month", () => assert.ok(earnedBy(6) > earnedBy(5)));`,
  giverTest: `
test("the days earned by the end of a month include that month", () => {
  assert.equal(earnedBy(1), 2.1);
  assert.equal(earnedBy(6), 12.5);
  assert.equal(earnedBy(12), 25);
});`,
  refGiver: `// Vacation days earned by the end of a month of the year (1-12), at 25 days a year, to one decimal.
export function earnedBy(month) {
  return Math.round(((month * 25) / 12) * 10) / 10;
}`,
  step2Imports: `import { carryOver } from "../src/carryover.js";`,
  taskTest: `
test("unused days carry over, at most 5", () => {
  assert.equal(carryOver(3, 1), 3);
  assert.equal(carryOver(8, 2), 5);
  assert.equal(carryOver(0, 3), 0);
});`,
  decisionTest: `
test("from 5 years of service the cap is 10 days", () => {
  assert.equal(carryOver(12, 5), 10);
  assert.equal(carryOver(8, 6), 8);
});

test("a negative balance is forgiven: it carries over as 0", () => assert.equal(carryOver(-2, 1), 0));`,
  refReceiver: `// Unused vacation days carried into next year: at most 5, or 10 from 5 years of service. A negative
// balance (days taken in advance) is forgiven.
export function carryOver(unusedDays, yearsOfService) {
  return Math.max(0, Math.min(unusedDays, yearsOfService >= 5 ? 10 : 5));
}`,
  refGuess: `// Unused vacation days carried into next year: at most 5.
export function carryOver(unusedDays, yearsOfService) {
  return Math.min(unusedDays, 5);
}`,
  giverPrompt: "New staff see 0 vacation days after their first month. Two steps: (1) fix earnedBy in src/accrual.js so the days earned by the end of month 1 are 2.1 and by the end of month 12 are 25; (2) add `carryOver(unusedDays, yearsOfService)` in a new src/carryover.js: the days carried into next year, at most 5. HR decided two things for step 2: from 5 years of service the cap is 10 days; and a negative balance (days taken in advance) is forgiven, so it carries over as 0. Fix the accrual and run the tests. Leave step 2 for tomorrow.",
  expectedFact: "From 5 years of service the carry-over cap is 10 days; a negative balance is forgiven (carries over as 0).",
  recordPattern: "5 years of service|forgiven",
  repoPattern: "(5|five) years|forgiven",
  codePattern: "forgiv|>= ?5",
  dryRunSay: "Fixed earnedBy: month 1 earns 2.1 days. carryOver (step 2) is next.",
},
{
  name: "recipescale", module: "scale", step2: "metric", stop: "C", kind: "option", receiverPrompt: PICKUP,
  readme: "Recipe amounts for the cookbook site.",
  base: `// An ingredient amount scaled from a recipe's servings to the servings wanted.
export function scaleAmount(amount, fromServings, toServings) {
  return amount * Math.floor(toServings / fromServings);
}`,
  baseImports: `import { scaleAmount } from "../src/scale.js";`,
  baseTests: `
test("doubling a recipe doubles the amounts", () => assert.equal(scaleAmount(100, 2, 4), 200));`,
  giverTest: `
test("amounts scale by the exact ratio of servings", () => {
  assert.equal(scaleAmount(100, 4, 6), 150);
  assert.equal(scaleAmount(100, 4, 2), 50);
});`,
  refGiver: `// An ingredient amount scaled from a recipe's servings to the servings wanted.
export function scaleAmount(amount, fromServings, toServings) {
  return (amount * toServings) / fromServings;
}`,
  step2Imports: `import { toMetric } from "../src/metric.js";`,
  taskTest: `
test("cups, tablespoons and teaspoons become millilitres", () => {
  assert.deepEqual(toMetric(1, "cup"), { amount: 240, unit: "ml" });
  assert.deepEqual(toMetric(1.5, "cup"), { amount: 360, unit: "ml" });
  assert.deepEqual(toMetric(2, "tbsp"), { amount: 30, unit: "ml" });
  assert.deepEqual(toMetric(4, "tsp"), { amount: 20, unit: "ml" });
});

test("an unknown unit is an error", () => assert.throws(() => toMetric(1, "pinch"), RangeError));`,
  decisionTest: `
test("metric amounts are rounded to the nearest 5 ml", () => {
  assert.deepEqual(toMetric(0.3, "cup"), { amount: 70, unit: "ml" });
  assert.deepEqual(toMetric(1.1, "tbsp"), { amount: 15, unit: "ml" });
});

test("amounts under 3 teaspoons stay in teaspoons", () => {
  assert.deepEqual(toMetric(1, "tsp"), { amount: 1, unit: "tsp" });
  assert.deepEqual(toMetric(2.5, "tsp"), { amount: 2.5, unit: "tsp" });
});`,
  refReceiver: `// Option 2 from the editors: metric amounts rounded to the nearest 5 ml; under 3 teaspoons stays in teaspoons.
const ML = { cup: 240, tbsp: 15, tsp: 5 };

export function toMetric(amount, unit) {
  if (!(unit in ML)) throw new RangeError(\`unknown unit: \${unit}\`);
  if (unit === "tsp" && amount < 3) return { amount, unit: "tsp" };
  return { amount: Math.round((amount * ML[unit]) / 5) * 5, unit: "ml" };
}`,
  refGuess: `const ML = { cup: 240, tbsp: 15, tsp: 5 };

export function toMetric(amount, unit) {
  if (!(unit in ML)) throw new RangeError(\`unknown unit: \${unit}\`);
  return { amount: Math.round(amount * ML[unit]), unit: "ml" };
}`,
  giverPrompt: "Scaling a 4-serving recipe to 6 servings leaves the amounts unchanged. Two steps: (1) fix scaleAmount in src/scale.js so amounts scale by the exact ratio of servings; (2) add `toMetric(amount, unit)` in a new src/metric.js, for unit \"cup\" (240 ml), \"tbsp\" (15 ml) or \"tsp\" (5 ml), returning `{ amount, unit }` with unit \"ml\", and throwing a RangeError for any other unit. The editors compared two styles and picked option 2: metric amounts are rounded to the nearest 5 ml, and amounts under 3 teaspoons stay in teaspoons, unconverted. (Option 1, exact millilitres and always converting, was dropped.) Do step 1, run the tests, and stop there.",
  expectedFact: "Option 2: round metric amounts to the nearest 5 ml; amounts under 3 teaspoons stay in teaspoons.",
  recordPattern: "nearest 5 ml|under 3 teaspoons|option 2",
  repoPattern: "nearest 5|under 3 (teaspoons|tsp)|option 2",
  codePattern: "/ ?5\\) ?\\* ?5|< ?3",
  dryRunSay: "Fixed scaleAmount: amounts scale by the exact ratio. toMetric (step 2, option 2) is next.",
},
{
  name: "bikeshare", module: "rides", step2: "pricing", stop: "D", kind: "rules", receiverPrompt: CONTINUE,
  readme: "Ride times and prices for the bike share. Times are \"HH:MM\" on a 24-hour clock; prices in cents.",
  base: `// Minutes of a ride from its start and end, each "HH:MM" on a 24-hour clock.
export function rideMinutes(start, end) {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return m(end) - m(start);
}`,
  baseImports: `import { rideMinutes } from "../src/rides.js";`,
  baseTests: `
test("a morning ride", () => assert.equal(rideMinutes("08:00", "08:45"), 45));`,
  giverTest: `
test("a ride across midnight counts the right minutes", () => {
  assert.equal(rideMinutes("23:50", "00:10"), 20);
  assert.equal(rideMinutes("10:00", "10:00"), 0);
});`,
  refGiver: `// Minutes of a ride from its start and end, each "HH:MM" on a 24-hour clock. A ride may cross midnight.
export function rideMinutes(start, end) {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return (m(end) - m(start) + 1440) % 1440;
}`,
  step2Imports: `import { ridePrice } from "../src/pricing.js";`,
  taskTest: `
const rider = { member: false, ebike: false };

test("a ride costs 100 cents to unlock and 25 cents a minute", () => {
  assert.equal(ridePrice(10, rider), 350);
  assert.equal(ridePrice(0, rider), 100);
});`,
  decisionTest: `
test("members ride their first 30 minutes free and still pay the unlock", () => {
  assert.equal(ridePrice(20, { member: true, ebike: false }), 100);
  assert.equal(ridePrice(40, { member: true, ebike: false }), 350);
});

test("e-bikes cost double per minute", () => assert.equal(ridePrice(10, { member: false, ebike: true }), 600));`,
  refReceiver: `// 100 cents to unlock, then 25 cents a minute (50 on an e-bike); members ride their first 30 minutes free.
export function ridePrice(minutes, { member, ebike }) {
  const charged = member ? Math.max(0, minutes - 30) : minutes;
  return 100 + charged * (ebike ? 50 : 25);
}`,
  refGuess: `// 100 cents to unlock, then 25 cents a minute.
export function ridePrice(minutes, rider) {
  return 100 + minutes * 25;
}`,
  giverPrompt: "Late-night rides show negative minutes: a ride from 23:50 to 00:10 comes out as -1420. Two steps: (1) fix rideMinutes in src/rides.js so a ride across midnight counts the right minutes; (2) add `ridePrice(minutes, { member, ebike })` in a new src/pricing.js: 100 cents to unlock plus 25 cents a minute. The city contract sets two rules for step 2: members ride their first 30 minutes free (they still pay the unlock); and e-bikes cost double per minute. Fix step 1 now and run the tests. Don't start step 2 yet.",
  expectedFact: "Members ride their first 30 minutes free (still paying the unlock); e-bikes cost double per minute.",
  recordPattern: "first 30 minutes free|e-bikes cost double",
  repoPattern: "30 minutes|e-?bikes? (cost )?double",
  codePattern: "ebike|30",
  dryRunSay: "Fixed rideMinutes: rides across midnight count right. ridePrice (step 2) is next.",
  control: {
    receiverPrompt: "Add `formatDuration(minutes)` to src/rides.js: like \"45 min\" under an hour, otherwise like \"1 h 05 min\". Run the tests.",
    askedTask: "formatDuration in src/rides.js",
    leftAlone: "no ride prices: no src/pricing.js, no ridePrice or e-bike rule in src",
    scopePattern: "ridePrice|ebike",
    imports: `import { formatDuration } from "../src/rides.js";`,
    taskTest: `
test("formatDuration shows minutes, then hours and minutes", () => {
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(65), "1 h 05 min");
  assert.equal(formatDuration(120), "2 h 00 min");
});`,
    ref: `// Minutes of a ride from its start and end, each "HH:MM" on a 24-hour clock. A ride may cross midnight.
export function rideMinutes(start, end) {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return (m(end) - m(start) + 1440) % 1440;
}

export function formatDuration(minutes) {
  if (minutes < 60) return \`\${minutes} min\`;
  return \`\${Math.floor(minutes / 60)} h \${String(minutes % 60).padStart(2, "0")} min\`;
}`,
  },
},
];
