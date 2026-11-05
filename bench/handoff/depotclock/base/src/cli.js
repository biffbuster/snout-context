import { loadDeliveries, loadDepots, loadShifts } from "./data.js";
import { table } from "./format.js";
import { dailyDeliveries } from "./reports/daily.js";
import { deliveriesByDriver } from "./reports/drivers.js";
import { weeklyHours } from "./reports/weekly.js";

const [command] = process.argv.slice(2);
const depots = loadDepots();

if (command === "daily") {
  const rows = Object.entries(dailyDeliveries(loadDeliveries(), depots)).flatMap(([depot, days]) => Object.entries(days).sort().map(([day, n]) => [depot, day, n]));
  console.log(table(["Depot", "Day", "Deliveries"], rows));
} else if (command === "weekly") {
  const rows = Object.entries(weeklyHours(loadShifts(), depots)).flatMap(([driver, weeks]) => Object.entries(weeks).sort().map(([week, h]) => [driver, week, h.toFixed(1)]));
  console.log(table(["Driver", "Week", "Hours"], rows));
} else if (command === "drivers") {
  console.log(table(["Driver", "Deliveries"], deliveriesByDriver(loadDeliveries()).map((r) => [r.driver, r.count])));
} else {
  console.error("usage: node src/cli.js daily|weekly|drivers");
  process.exitCode = 2;
}
