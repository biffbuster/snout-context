import { readFileSync } from "node:fs";

const read = (name, dir) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const DATA = new URL("../data/", import.meta.url);

/** The depots, by id: { id, name, tz }. */
export const loadDepots = (dir = DATA) => new Map(read("depots.json", dir).map((d) => [d.id, d]));

/** Finished deliveries: { id, depot, driver, finishedAt }. */
export const loadDeliveries = (dir = DATA) => read("deliveries.json", dir);

/** Driver shifts: { driver, depot, start, end }. */
export const loadShifts = (dir = DATA) => read("shifts.json", dir);
