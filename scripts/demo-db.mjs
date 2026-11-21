// Builds a demo shop database: a small burger restaurant with three weeks of trading.
// Used by scripts/screenshots.mjs for the README pictures. All names are made up.
//
//   node scripts/demo-db.mjs /path/to/demo.sqlite
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/demo-db.mjs /path/to/demo.sqlite
//
// The second form uses Electron's own build of SQLite (what `npm run app` prepares), the first one
// the Node build (what `npm run rebuild:node` prepares). Use whichever matches the last rebuild.
//
// Everything goes through the real core services (checkout, orders, purchases, payroll), so stock,
// cost of goods, tokens and profit are computed exactly as in a live shop. The only trick is a fake
// clock that is switched on while one event is written, so sales land on past days.
// The owner is "Maryam" with PIN 1234; the cashier is "Usman" with PIN 4321.
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const core = await import(pathToFileURL(resolve(root, "packages/core/dist/index.js")).href);
const {
  openDatabase, ProductService, RecipeService, PurchaseService, ExpenseService, LabourService,
  OrderService, SaleService, ShiftService, UserService, SettingsService, InventoryService, dates,
} = core;

export const OWNER_PIN = "1234";
export const OWNER_NAME = "Maryam";
export const CASHIER_NAME = "Usman";
export const CASHIER_PIN = "4321";
export const HISTORY_DAYS = 21;

const RealDate = Date;
/** Run `fn` while "now" is the given moment. Everything that stamps the current time sees it. */
function withClock(when, fn) {
  const ms = when.getTime();
  globalThis.Date = class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(ms);
      else super(...args);
    }
    static now() {
      return ms;
    }
  };
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Small deterministic random numbers, so the demo looks the same every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rs = (n) => Math.round(n * 100); // whole rupees to paisa

export function seedDemo(file) {
  if (file !== ":memory:" && existsSync(file)) rmSync(file);
  const db = openDatabase(file);
  const rand = rng(20261121);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  const users = new UserService(db);
  const settings = new SettingsService(db);
  const products = new ProductService(db);
  const recipes = new RecipeService(db);
  const purchases = new PurchaseService(db);
  const expenses = new ExpenseService(db);
  const labour = new LabourService(db);
  const orders = new OrderService(db, "T1");
  const sales = new SaleService(db, "T1");
  const shifts = new ShiftService(db);
  const inventory = new InventoryService(db);

  const now = new RealDate();
  const todayStr = dates.localDate(now);
  const dayStart = (offset) => new RealDate(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0);
  const at = (offset, hour, minute = 0) => new RealDate(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0);
  const dateOf = (offset) => dates.localDate(dayStart(offset));
  /** Never in the future: a moment on a day, but at most 'now' for today. */
  const clamp = (d) => (d.getTime() > now.getTime() ? new RealDate(now.getTime() - 60_000) : d);

  settings.update({ storeName: "Bun & Co. Grill (demo)", currency: "PKR", locale: "en-PK", receiptFooter: "Thank you! Come again." });
  const owner = users.create({ name: OWNER_NAME, pin: OWNER_PIN, role: "owner" });
  const cashier = users.create({ name: CASHIER_NAME, pin: CASHIER_PIN, role: "cashier" });
  users.create({ name: "Zain", pin: "2468", role: "manager" });

  // ---- Stock items (ingredients) and what the menu is made of ----
  const ing = (name, unit, reorderLevel) => products.create({ name, unit, kind: "ingredient", priceMinor: 0, reorderLevel });
  const chicken = ing("Chicken fillet", "kg", 15);
  const wings = ing("Chicken wings", "kg", 25);
  const patty = ing("Beef patty", "pcs", 60);
  const bun = ing("Burger bun", "pcs", 100);
  const cheese = ing("Cheese slice", "pcs", 100);
  const potato = ing("Potatoes", "kg", 25);
  const oil = ing("Cooking oil", "l", 10);
  const milk = ing("Milk", "l", 10);

  const dish = (name, price, recipe) => {
    const p = products.create({ name, priceMinor: rs(price), trackStock: false });
    if (recipe) recipes.set(p.id, recipe.map(([i, q]) => ({ ingredientId: i.id, qty: q })));
    return p;
  };
  const beef = dish("Classic Beef Burger", 650, [[patty, 1], [bun, 1], [cheese, 1]]);
  const zinger = dish("Zinger Burger", 590, [[chicken, 0.18], [bun, 1], [oil, 0.02]]);
  const fries = dish("Fries", 220, [[potato, 0.25], [oil, 0.05]]);
  const cheeseFries = dish("Cheese Fries", 350, [[potato, 0.25], [cheese, 2], [oil, 0.05]]);
  const wingsDish = dish("Chicken Wings (6 pcs)", 480, [[wings, 0.3], [oil, 0.04]]);
  const shake = dish("Milk Shake", 320, [[milk, 0.3]]);
  // A bought-in item that is sold as it is, so it is counted in stock directly.
  const cola = products.create({ name: "Cola 345 ml", priceMinor: rs(150), reorderLevel: 40, barcode: "8964000000011" });
  const food = [beef, zinger, fries, cheeseFries, wingsDish, shake];
  const priceOf = new Map([...food, cola].map((p) => [p.id, p.priceMinor]));

  const extraCheese = orders.addModifier({ name: "Extra cheese", priceMinor: rs(60), ingredientId: cheese.id, ingredientQty: 1 });
  const extraPatty = orders.addModifier({ name: "Extra patty", priceMinor: rs(220), ingredientId: patty.id, ingredientQty: 1 });
  const noOnion = orders.addModifier({ name: "No onion", priceMinor: 0 });
  const modPrice = new Map([[extraCheese.id, extraCheese.priceMinor], [extraPatty.id, extraPatty.priceMinor], [noOnion.id, 0]]);

  // ---- Purchases: a big stock-up at the start, a top-up each week, some still owed ----
  const buy = (when, supplier, lines, paidShare = 1) =>
    withClock(when, () => {
      const items = lines.map(([p, qty, unitRs]) => ({ productId: p.id, qty, costMinor: rs(qty * unitRs) }));
      const total = items.reduce((s, i) => s + i.costMinor, 0);
      purchases.record({ supplier, items, paidMinor: Math.round(total * paidShare), userId: owner.id });
    });
  const stockUp = (offset, scale, paidShare) => {
    buy(at(offset, 9, 30), "City Poultry Farm", [[chicken, 40 * scale, 760], [wings, 25 * scale, 640]], paidShare);
    buy(at(offset, 10, 15), "Metro Fresh Supplies", [[patty, 220 * scale, 118], [bun, 600 * scale, 34], [cheese, 500 * scale, 24], [potato, 100 * scale, 115], [oil, 30 * scale, 505], [milk, 40 * scale, 215]], 1);
    buy(at(offset, 10, 40), "Cola Distributor", [[cola, 300 * scale, 92]], 1);
  };
  stockUp(-HISTORY_DAYS + 1, 1.5, 1);
  stockUp(-12, 1, 1);
  stockUp(-5, 1, 0.5); // half of the last delivery is still owed to the suppliers

  // ---- Staff ----
  const ayesha = labour.createEmployee({ name: "Ayesha Khan", title: "Cashier", payType: "monthly", payRateMinor: rs(42000) });
  const bilal = labour.createEmployee({ name: "Bilal Ahmed", title: "Cook", payType: "monthly", payRateMinor: rs(58000) });
  const hamza = labour.createEmployee({ name: "Hamza Ali", title: "Rider", payType: "daily", payRateMinor: rs(1800) });
  for (let d = -HISTORY_DAYS + 1; d <= 0; d++) {
    for (const [emp, inH, outH, offDay] of [[ayesha, 10, 19, 5], [bilal, 11, 22, 3], [hamza, 12, 22, 1]]) {
      if (Math.abs(d + 100) % 7 === offDay) continue;
      const end = clamp(at(d, outH));
      const start = at(d, inH);
      if (start.getTime() >= end.getTime()) continue;
      labour.addShift(emp.id, start.toISOString(), end.toISOString());
    }
  }
  withClock(at(-HISTORY_DAYS + 8, 9), () => labour.giveAdvance(hamza.id, rs(5000), dateOf(-HISTORY_DAYS + 8), "Advance"));

  // ---- Running costs ----
  const cat = (name) => {
    const found = expenses.categories().find((c) => c.name.toLowerCase().includes(name));
    return found ?? expenses.addCategory(name);
  };
  const monthStartOffset = -(now.getDate() - 1);
  const cost = (offset, name, description, amount) =>
    withClock(at(offset, 15), () =>
      expenses.add({ categoryId: cat(name).id, description, amountMinor: rs(amount), spentOn: dateOf(offset), userId: owner.id }),
    );
  if (monthStartOffset >= -HISTORY_DAYS + 1) cost(monthStartOffset, "rent", "Shop rent", 85000);
  cost(-HISTORY_DAYS + 4, "electric", "Electricity bill", 38500);
  cost(-HISTORY_DAYS + 6, "gas", "Gas cylinders", 14200);
  cost(-9, "packag", "Burger boxes and paper bags", 9600);
  cost(-4, "gas", "Gas cylinders", 7100);
  cost(-2, "clean", "Cleaning supplies", 3200);

  // ---- Trading days ----
  const menuForOrders = [beef, zinger, fries, cheeseFries, wingsDish, shake];
  const hourWeights = [11, 12, 13, 13, 13, 14, 15, 16, 17, 18, 19, 19, 20, 20, 20, 21, 21, 22];

  function randomLines() {
    const n = between(1, 3);
    const chosen = new Set();
    while (chosen.size < n) chosen.add(pick(menuForOrders));
    const lines = [...chosen].map((p) => ({ productId: p.id, qty: between(1, 2) }));
    if (rand() < 0.55) lines.push({ productId: cola.id, qty: between(1, 3) });
    return lines;
  }
  /** An add-on is charged on every unit of its line. */
  const totalOf = (lines) =>
    lines.reduce((s, l) => s + l.qty * (priceOf.get(l.productId) + (l.mods ?? []).reduce((m, id) => m + modPrice.get(id), 0)), 0);
  const payment = (total) => {
    const r = rand();
    if (r < 0.5) return [{ method: "cash", amountMinor: Math.ceil(total / rs(50)) * rs(50) }]; // customer rounds up, change is given
    if (r < 0.92) return [{ method: "card", amountMinor: total }];
    const cashPart = Math.floor(total / 2 / 100) * 100;
    return [{ method: "cash", amountMinor: cashPart }, { method: "other", amountMinor: total - cashPart }];
  };

  for (let d = -HISTORY_DAYS + 1; d <= 0; d++) {
    const weekday = dayStart(d).getDay();
    const busy = weekday === 5 || weekday === 6 ? 10 : 0;
    const count = d === 0 ? between(9, 13) : between(15, 22) + busy;
    const open = clamp(at(d, 10, 30));
    const shift = withClock(open, () => shifts.open(d === 0 ? cashier.id : owner.id, rs(10000)));
    const times = Array.from({ length: count }, () => {
      const t = at(d, pick(hourWeights), between(0, 59));
      return d === 0 ? new RealDate(Math.min(t.getTime(), now.getTime() - between(15, 280) * 60_000)) : t;
    })
      .filter((t) => t.getTime() > open.getTime())
      .sort((a, b) => a - b);

    for (const when of times) {
      withClock(when, () => {
        const lines = randomLines();
        const kind = rand();
        const who = d === 0 ? cashier : owner;
        if (kind < 0.4) {
          sales.checkout({ lines, payments: payment(totalOf(lines)), cashier: who.name, shiftId: shift.id, userId: who.id, allowNegativeStock: true });
          return;
        }
        const type = kind < 0.55 ? "takeaway" : kind < 0.85 ? "dine_in" : "delivery";
        const fee = type === "delivery" ? rs(100) : 0;
        const o = orders.create({
          type,
          tableLabel: type === "dine_in" ? String(between(1, 8)) : null,
          customerName: type === "delivery" ? pick(["Hina", "Sana", "Omar", "Farah", "Talha"]) : null,
          customerPhone: type === "delivery" ? "0300 1234567" : null,
          deliveryAddress: type === "delivery" ? `House ${between(1, 60)}, Street ${between(1, 12)}` : null,
          deliveryFeeMinor: fee,
          userId: who.id,
        });
        for (const l of lines) {
          l.mods = l.productId === beef.id && rand() < 0.4 ? [pick([extraCheese.id, extraPatty.id, noOnion.id])] : [];
          orders.addItem(o.id, { productId: l.productId, qty: l.qty, modifierIds: l.mods });
        }
        if (type !== "takeaway" || rand() < 0.5) {
          orders.sendToKitchen(o.id);
          orders.setKitchenStatus(o.id, "preparing");
          orders.setKitchenStatus(o.id, "ready");
          orders.setKitchenStatus(o.id, "served");
        }
        orders.pay(o.id, {
          payments: payment(totalOf(lines) + fee),
          shiftId: shift.id,
          userId: who.id,
          cashier: who.name,
          allowNegativeStock: true,
        });
      });
    }

    if (d < 0) {
      withClock(at(d, 22, 45), () => {
        const expected = shifts.summary(shift.id).expectedCashMinor;
        // A tidy drawer most days, a little short or over now and then.
        const off = rand() < 0.7 ? 0 : pick([-rs(50), -rs(100), rs(20)]);
        shifts.close(shift.id, Math.max(0, expected + off));
      });
    }
  }

  // ---- Waste, wages ----
  withClock(at(-6, 21), () => inventory.adjust(bun.id, -24, "waste"));
  withClock(at(-3, 21), () => inventory.adjust(chicken.id, -2.5, "spoilage"));
  withClock(at(-1, 21), () => inventory.adjust(milk.id, -3, "expired"));
  // The first two weeks are paid; the most recent week is not, and the Money screen says so.
  const payStart = dateOf(-HISTORY_DAYS + 1);
  const payEnd = dateOf(-HISTORY_DAYS + 14);
  withClock(at(-HISTORY_DAYS + 15, 12), () => {
    const slips = labour.finalize({
      periodStart: payStart,
      periodEnd: payEnd,
      userId: owner.id,
      lines: [{ employeeId: hamza.id, recoverAdvanceMinor: rs(5000) }],
    });
    for (const s of slips) labour.pay(s.id, "cash");
  });

  // ---- Right now: today's orders on the board ----
  const task = (minutesAgo, fn) => withClock(new RealDate(now.getTime() - minutesAgo * 60_000), fn);
  const make = (input, items, sentMinutesAgo, status) => {
    let id;
    task(sentMinutesAgo ?? 1, () => {
      const o = orders.create({ ...input, userId: cashier.id });
      id = o.id;
      for (const [p, qty, mods] of items) orders.addItem(o.id, { productId: p.id, qty, modifierIds: mods ?? [] });
      if (sentMinutesAgo !== null) {
        orders.sendToKitchen(o.id);
        if (status && status !== "new") orders.setKitchenStatus(o.id, "preparing");
        if (status === "ready") orders.setKitchenStatus(o.id, "ready");
      }
    });
    return id;
  };
  make({ type: "dine_in", tableLabel: "3" }, [[zinger, 2], [fries, 1], [cola, 2]], 22, "preparing"); // late: shows red
  make({ type: "dine_in", tableLabel: "5" }, [[beef, 1, [extraCheese.id]], [cheeseFries, 1]], 4, "new");
  make({ type: "takeaway", customerName: "Imran" }, [[wingsDish, 1], [cola, 2]], 11, "ready");
  make({ type: "takeaway", customerName: "Noor" }, [[zinger, 1], [shake, 1]], 7, "preparing");
  make({ type: "delivery", customerName: "Hina", customerPhone: "0300 1234567", deliveryAddress: "House 14, Street 7", deliveryFeeMinor: rs(100) }, [[beef, 2], [fries, 2], [shake, 2]], null);
  make({ type: "dine_in", tableLabel: "2" }, [[wingsDish, 1], [fries, 1]], null);

  const summary = {
    owner: OWNER_NAME,
    sales: db.prepare("SELECT COUNT(*) AS n FROM sales WHERE status = 'completed'").get().n,
    today: todayStr,
  };
  db.close();
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/demo-db.mjs /path/to/demo.sqlite");
    process.exit(2);
  }
  const s = seedDemo(resolve(file));
  console.log(`Demo shop written to ${file}: ${s.sales} sales over ${HISTORY_DAYS} days. Sign in as ${s.owner} with PIN ${OWNER_PIN}.`);
}
