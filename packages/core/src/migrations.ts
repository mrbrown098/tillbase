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
