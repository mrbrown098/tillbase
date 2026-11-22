import type { Database } from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
}

/**
 * Ordered, append-only list of schema migrations. Never edit an old entry:
 * add a new one. IDs are UUID text so data can later be merged across
 * devices and branches without collisions.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE counters (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      CREATE TABLE categories (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE products (
        id            TEXT PRIMARY KEY,
        sku           TEXT,
        barcode       TEXT,
        name          TEXT NOT NULL,
        category_id   TEXT REFERENCES categories(id),
        price_minor   INTEGER NOT NULL CHECK (price_minor >= 0),
        cost_minor    INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
        tax_rate_bp   INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0),
        track_stock   INTEGER NOT NULL DEFAULT 1,
        reorder_level REAL NOT NULL DEFAULT 0,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
      CREATE UNIQUE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL;
      CREATE INDEX idx_products_name ON products(name);

      CREATE TABLE stock_movements (
        id         TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        qty_delta  REAL NOT NULL,
        reason     TEXT NOT NULL,
        ref_type   TEXT,
        ref_id     TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_stock_product ON stock_movements(product_id);

      CREATE TABLE sales (
        id             TEXT PRIMARY KEY,
        receipt_no     TEXT NOT NULL UNIQUE,
        status         TEXT NOT NULL CHECK (status IN ('completed', 'void')),
        subtotal_minor INTEGER NOT NULL,
        discount_minor INTEGER NOT NULL,
        tax_minor      INTEGER NOT NULL,
        total_minor    INTEGER NOT NULL,
        paid_minor     INTEGER NOT NULL,
        change_minor   INTEGER NOT NULL,
        cashier        TEXT,
        void_reason    TEXT,
        created_at     TEXT NOT NULL,
        voided_at      TEXT
      );
      CREATE INDEX idx_sales_created ON sales(created_at);

      CREATE TABLE sale_items (
        id               TEXT PRIMARY KEY,
        sale_id          TEXT NOT NULL REFERENCES sales(id),
        product_id       TEXT NOT NULL REFERENCES products(id),
        name             TEXT NOT NULL,
        qty              REAL NOT NULL CHECK (qty > 0),
        unit_price_minor INTEGER NOT NULL,
        discount_minor   INTEGER NOT NULL,
        tax_rate_bp      INTEGER NOT NULL,
        tax_minor        INTEGER NOT NULL,
        total_minor      INTEGER NOT NULL
      );
      CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

      CREATE TABLE payments (
        id           TEXT PRIMARY KEY,
        sale_id      TEXT NOT NULL REFERENCES sales(id),
        method       TEXT NOT NULL CHECK (method IN ('cash', 'card', 'other')),
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0)
      );
      CREATE INDEX idx_payments_sale ON payments(sale_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
        pin_salt   TEXT NOT NULL,
        pin_hash   TEXT NOT NULL,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_users_name ON users(lower(name));

      CREATE TABLE shifts (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id),
        opened_at           TEXT NOT NULL,
        closed_at           TEXT,
        opening_cash_minor  INTEGER NOT NULL CHECK (opening_cash_minor >= 0),
        counted_cash_minor  INTEGER,
        expected_cash_minor INTEGER,
        variance_minor      INTEGER,
        note                TEXT,
        status              TEXT NOT NULL CHECK (status IN ('open', 'closed'))
      );
      -- At most one open shift (one till). Multi-terminal support will scope this per terminal.
      CREATE UNIQUE INDEX idx_one_open_shift ON shifts(status) WHERE status = 'open';

      CREATE TABLE cash_movements (
        id           TEXT PRIMARY KEY,
        shift_id     TEXT NOT NULL REFERENCES shifts(id),
        user_id      TEXT NOT NULL REFERENCES users(id),
        amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
        reason       TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_cash_movements_shift ON cash_movements(shift_id);

      ALTER TABLE sales ADD COLUMN shift_id TEXT REFERENCES shifts(id);
      ALTER TABLE sales ADD COLUMN user_id TEXT REFERENCES users(id);
      CREATE INDEX idx_sales_shift ON sales(shift_id);
    `,
  },
  {
    version: 3,
    sql: `
      -- Costing: every item has a weighted-average cost per unit; ingredients are
      -- stock items that are not sold directly but consumed by recipes.
      ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'product'
        CHECK (kind IN ('product', 'ingredient'));
      ALTER TABLE products ADD COLUMN unit TEXT NOT NULL DEFAULT 'pcs';
      ALTER TABLE products ADD COLUMN avg_cost REAL NOT NULL DEFAULT 0;
      UPDATE products SET avg_cost = cost_minor;

      ALTER TABLE stock_movements ADD COLUMN value_minor INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sale_items ADD COLUMN cogs_minor INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE recipe_items (
        id            TEXT PRIMARY KEY,
        product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        ingredient_id TEXT NOT NULL REFERENCES products(id),
        qty           REAL NOT NULL CHECK (qty > 0),
        UNIQUE (product_id, ingredient_id)
      );
      CREATE INDEX idx_recipe_product ON recipe_items(product_id);

      -- Purchases and what we owe suppliers
      CREATE TABLE purchases (
        id          TEXT PRIMARY KEY,
        supplier    TEXT,
        reference   TEXT,
        note        TEXT,
        total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
        paid_minor  INTEGER NOT NULL DEFAULT 0,
        user_id     TEXT REFERENCES users(id),
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_purchases_created ON purchases(created_at);
      CREATE TABLE purchase_items (
        id          TEXT PRIMARY KEY,
        purchase_id TEXT NOT NULL REFERENCES purchases(id),
        product_id  TEXT NOT NULL REFERENCES products(id),
        qty         REAL NOT NULL CHECK (qty > 0),
        cost_minor  INTEGER NOT NULL CHECK (cost_minor >= 0)
      );
      CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
      CREATE TABLE purchase_payments (
        id           TEXT PRIMARY KEY,
        purchase_id  TEXT NOT NULL REFERENCES purchases(id),
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        method       TEXT NOT NULL CHECK (method IN ('cash', 'card', 'other')),
        created_at   TEXT NOT NULL
      );

      -- Running costs
      CREATE TABLE expense_categories (
        id     TEXT PRIMARY KEY,
        name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO expense_categories (id, name) VALUES
        (lower(hex(randomblob(16))), 'Rent'),
        (lower(hex(randomblob(16))), 'Electricity'),
        (lower(hex(randomblob(16))), 'Gas'),
        (lower(hex(randomblob(16))), 'Water'),
        (lower(hex(randomblob(16))), 'Internet and phone'),
        (lower(hex(randomblob(16))), 'Packaging'),
        (lower(hex(randomblob(16))), 'Marketing'),
        (lower(hex(randomblob(16))), 'Repairs and maintenance'),
        (lower(hex(randomblob(16))), 'Transport and delivery'),
        (lower(hex(randomblob(16))), 'Cleaning'),
        (lower(hex(randomblob(16))), 'Licenses and taxes'),
        (lower(hex(randomblob(16))), 'Other');
      CREATE TABLE expenses (
        id           TEXT PRIMARY KEY,
        category_id  TEXT NOT NULL REFERENCES expense_categories(id),
        description  TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        spent_on     TEXT NOT NULL,
        method       TEXT NOT NULL CHECK (method IN ('cash', 'card', 'other')),
        user_id      TEXT REFERENCES users(id),
        created_at   TEXT NOT NULL,
        voided_at    TEXT,
        void_reason  TEXT
      );
      CREATE INDEX idx_expenses_date ON expenses(spent_on);

      -- Labour
      CREATE TABLE employees (
        id                     TEXT PRIMARY KEY,
        name                   TEXT NOT NULL,
        phone                  TEXT,
        title                  TEXT,
        pay_type               TEXT NOT NULL CHECK (pay_type IN ('monthly', 'daily', 'hourly')),
        pay_rate_minor         INTEGER NOT NULL CHECK (pay_rate_minor >= 0),
        overtime_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (overtime_after_minutes >= 0),
        overtime_multiplier_bp INTEGER NOT NULL DEFAULT 15000 CHECK (overtime_multiplier_bp >= 10000),
        active                 INTEGER NOT NULL DEFAULT 1,
        created_at             TEXT NOT NULL
      );
      CREATE TABLE attendance (
        id          TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        clock_in    TEXT NOT NULL,
        clock_out   TEXT,
        note        TEXT
      );
      CREATE INDEX idx_attendance_emp ON attendance(employee_id, clock_in);
      CREATE UNIQUE INDEX idx_attendance_open ON attendance(employee_id) WHERE clock_out IS NULL;
      CREATE TABLE advances (
        id              TEXT PRIMARY KEY,
        employee_id     TEXT NOT NULL REFERENCES employees(id),
        amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
        recovered_minor INTEGER NOT NULL DEFAULT 0,
        given_on        TEXT NOT NULL,
        note            TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE payroll_runs (
        id           TEXT PRIMARY KEY,
        period_start TEXT NOT NULL,
        period_end   TEXT NOT NULL,
        user_id      TEXT REFERENCES users(id),
        created_at   TEXT NOT NULL
      );
      CREATE TABLE payslips (
        id               TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL REFERENCES payroll_runs(id),
        employee_id      TEXT NOT NULL REFERENCES employees(id),
        period_start     TEXT NOT NULL,
        period_end       TEXT NOT NULL,
        minutes          INTEGER NOT NULL,
        days             INTEGER NOT NULL,
        base_minor       INTEGER NOT NULL,
        overtime_minor   INTEGER NOT NULL,
        bonus_minor      INTEGER NOT NULL,
        deductions_minor INTEGER NOT NULL,
        advances_minor   INTEGER NOT NULL,
        net_minor        INTEGER NOT NULL,
        paid_minor       INTEGER NOT NULL DEFAULT 0,
        paid_at          TEXT,
        method           TEXT
      );
      CREATE INDEX idx_payslips_emp ON payslips(employee_id, period_end);
    `,
  },
  {
    version: 4,
    sql: `
      -- Fast-food orders: a token per day, an order type, held (open) orders,
      -- add-ons (modifiers) and a kitchen status.
      CREATE TABLE orders (
        id               TEXT PRIMARY KEY,
        token_date       TEXT NOT NULL,
        token            INTEGER NOT NULL,
        type             TEXT NOT NULL CHECK (type IN ('dine_in','takeaway','delivery')),
        table_label      TEXT,
        customer_name    TEXT,
        customer_phone   TEXT,
        delivery_address TEXT,
        note             TEXT,
        status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled')),
        kitchen_status   TEXT CHECK (kitchen_status IN ('new','preparing','ready','served')),
        user_id          TEXT REFERENCES users(id),
        sale_id          TEXT REFERENCES sales(id),
        cancel_reason    TEXT,
        created_at       TEXT NOT NULL,
        sent_at          TEXT,
        UNIQUE (token_date, token)
      );
      CREATE INDEX idx_orders_status ON orders(status, created_at);

      CREATE TABLE order_items (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL REFERENCES orders(id),
        product_id    TEXT NOT NULL REFERENCES products(id),
        qty           REAL NOT NULL CHECK (qty > 0),
        note          TEXT,
        modifiers     TEXT NOT NULL DEFAULT '[]',
        sent_at       TEXT
      );
      CREATE INDEX idx_order_items_order ON order_items(order_id);

      CREATE TABLE modifiers (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
        price_minor     INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
        ingredient_id   TEXT REFERENCES products(id),
        ingredient_qty  REAL NOT NULL DEFAULT 0 CHECK (ingredient_qty >= 0),
        active          INTEGER NOT NULL DEFAULT 1
      );
    `,
  },
  {
    version: 5,
    sql: `
      -- Delivery fees, and bills split by items.
      -- is_system marks a product the app creates for itself (the delivery fee line on a sale).
      -- It is never listed, searched, exported, imported or counted as stock.
      ALTER TABLE products ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
      -- What a delivery order charges on top of its food, in minor units.
      ALTER TABLE orders ADD COLUMN delivery_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0);
      -- The order a bill was split from, if it was made by splitting.
      ALTER TABLE orders ADD COLUMN split_from TEXT REFERENCES orders(id);
    `,
  },
  {
    version: 6,
    sql: `
      -- Customers, loyalty points and a prepaid wallet.
      -- points and wallet_minor are never edited by hand: the triggers below keep them equal to the
      -- sum of the customer's ledger rows, and the ledger can only be added to.
      CREATE TABLE customers (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        phone        TEXT,
        address      TEXT,
        notes        TEXT,
        points       INTEGER NOT NULL DEFAULT 0,
        wallet_minor INTEGER NOT NULL DEFAULT 0 CHECK (wallet_minor >= 0),
        created_at   TEXT NOT NULL
      );
      -- A phone number belongs to one customer. Customers without a phone are allowed.
      CREATE UNIQUE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
      CREATE INDEX idx_customers_name ON customers(name COLLATE NOCASE);

      CREATE TABLE customer_ledger (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        account     TEXT NOT NULL CHECK (account IN ('points', 'wallet')),
        delta       INTEGER NOT NULL CHECK (delta <> 0),
        reason      TEXT NOT NULL CHECK (reason IN
                      ('earn', 'redeem', 'spend', 'topup', 'adjust', 'void_earn', 'void_redeem', 'void_spend')),
        sale_id     TEXT REFERENCES sales(id),
        user_id     TEXT,
        note        TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_customer ON customer_ledger(customer_id, created_at);
      CREATE INDEX idx_ledger_sale ON customer_ledger(sale_id);

      CREATE TRIGGER customer_ledger_no_update BEFORE UPDATE ON customer_ledger
      BEGIN SELECT RAISE(ABORT, 'The customer ledger cannot be changed. Add a correcting entry instead.'); END;
      CREATE TRIGGER customer_ledger_no_delete BEFORE DELETE ON customer_ledger
      BEGIN SELECT RAISE(ABORT, 'The customer ledger cannot be changed. Add a correcting entry instead.'); END;
      CREATE TRIGGER customer_ledger_balance AFTER INSERT ON customer_ledger
      BEGIN
        UPDATE customers
           SET points       = points       + CASE WHEN NEW.account = 'points' THEN NEW.delta ELSE 0 END,
               wallet_minor = wallet_minor + CASE WHEN NEW.account = 'wallet' THEN NEW.delta ELSE 0 END
         WHERE id = NEW.customer_id;
      END;

      ALTER TABLE orders ADD COLUMN customer_id TEXT REFERENCES customers(id);
      ALTER TABLE sales ADD COLUMN customer_id TEXT REFERENCES customers(id);
      -- Points the sale earned and used, kept on the sale so the receipt never has to guess.
      ALTER TABLE sales ADD COLUMN points_earned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN points_redeemed INTEGER NOT NULL DEFAULT 0;
      -- 'other' payments can carry a name, e.g. 'wallet' for money taken from a customer's wallet.
      ALTER TABLE payments ADD COLUMN label TEXT;
      CREATE INDEX idx_sales_customer ON sales(customer_id);
    `,
  },
  {
    version: 7,
    sql: `
      -- Supplier purchase orders: what was ordered, and what has arrived so far.
      -- Receiving goods does NOT touch stock here: each receipt is recorded through PurchaseService, which
      -- writes the purchase, the stock movements and the new average cost. purchase_order_receipts links a
      -- receipt to that purchase.
      CREATE TABLE purchase_orders (
        id            TEXT PRIMARY KEY,
        number        INTEGER NOT NULL UNIQUE,
        supplier      TEXT NOT NULL,
        reference     TEXT,
        note          TEXT,
        status        TEXT NOT NULL CHECK (status IN ('open', 'received', 'cancelled')),
        user_id       TEXT,
        created_at    TEXT NOT NULL,
        cancelled_at  TEXT,
        cancel_reason TEXT
      );
      CREATE INDEX idx_po_status ON purchase_orders(status, created_at);
      CREATE INDEX idx_po_supplier ON purchase_orders(supplier COLLATE NOCASE);

      CREATE TABLE purchase_order_lines (
        id             TEXT PRIMARY KEY,
        order_id       TEXT NOT NULL REFERENCES purchase_orders(id),
        product_id     TEXT NOT NULL REFERENCES products(id),
        qty_ordered    REAL NOT NULL CHECK (qty_ordered > 0),
        unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
        qty_received   REAL NOT NULL DEFAULT 0 CHECK (qty_received >= 0)
      );
      CREATE INDEX idx_po_lines_order ON purchase_order_lines(order_id);

      CREATE TABLE purchase_order_receipts (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES purchase_orders(id),
        purchase_id TEXT NOT NULL REFERENCES purchases(id),
        user_id     TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_po_receipts_order ON purchase_order_receipts(order_id);

      CREATE TABLE purchase_order_receipt_lines (
        id          TEXT PRIMARY KEY,
        receipt_id  TEXT NOT NULL REFERENCES purchase_order_receipts(id),
        line_id     TEXT NOT NULL REFERENCES purchase_order_lines(id),
        qty         REAL NOT NULL CHECK (qty > 0),
        cost_minor  INTEGER NOT NULL CHECK (cost_minor >= 0)
      );
      CREATE INDEX idx_po_receipt_lines_receipt ON purchase_order_receipt_lines(receipt_id);
    `,
  },
];

/** Apply any migrations that have not run yet. Safe to call on every start. */
export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
