import { useCallback, useEffect, useState } from "react";
import type { ProductWithStock } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { bpToPercent, minorToInput, parseMoney, parseQty, percentToBp } from "./format";
import { Modal } from "./Modal";

export function Products() {
  const { money, toast, can } = useApp();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ProductWithStock[]>([]);
  const [editing, setEditing] = useState<ProductWithStock | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<ProductWithStock | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api.listProducts();
      const q = query.trim().toLowerCase();
      setItems(
        all.filter(
          (p) =>
            (showInactive || p.active) &&
            (!q ||
              p.name.toLowerCase().includes(q) ||
              (p.sku ?? "").toLowerCase().includes(q) ||
              (p.barcode ?? "").toLowerCase().includes(q)),
        ),
      );
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [query, showInactive, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Products</h1>
        <div className="row">
          <input
            className="search"
            placeholder="Search name, SKU or barcode"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search products"
          />
          <label className="check">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            Add product
          </button>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Barcode</th>
            <th className="num">Price</th>
            <th className="num">Tax</th>
            <th className="num">Stock</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const low = p.trackStock && p.stock <= p.reorderLevel;
            return (
              <tr key={p.id} className={p.active ? "" : "inactive"}>
                <td>
                  {p.name}
                  {!p.active && <span className="badge">inactive</span>}
                </td>
                <td className="mono">{p.barcode ?? "—"}</td>
                <td className="num">{money(p.priceMinor)}</td>
                <td className="num">{bpToPercent(p.taxRateBp)}%</td>
                <td className={`num${low ? " low" : ""}`}>
                  {p.trackStock ? p.stock : "—"}
                  {low && <span className="badge badge-warn">low</span>}
                </td>
                <td className="actions">
                  {p.trackStock && can("stock.adjust") && (
                    <button className="btn" onClick={() => setAdjusting(p)}>
                      Adjust stock
                    </button>
                  )}
                  <button className="btn" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 && <p className="empty">No products to show.</p>}

      {editing && (
        <ProductForm
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {adjusting && (
        <AdjustForm
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ProductForm({
  product,
  onClose,
  onSaved,
}: {
  product: ProductWithStock | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(product?.name ?? "");
  const [barcode, setBarcode] = useState(product?.barcode ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [price, setPrice] = useState(product ? minorToInput(product.priceMinor) : "");
  const [cost, setCost] = useState(product ? minorToInput(product.costMinor) : "");
  const [tax, setTax] = useState(product ? bpToPercent(product.taxRateBp) : "0");
  const [track, setTrack] = useState(product?.trackStock ?? true);
  const [reorder, setReorder] = useState(String(product?.reorderLevel ?? 0));
  const [opening, setOpening] = useState("0");
  const [active, setActive] = useState(product?.active ?? true);
  const [error, setError] = useState("");

  const save = async () => {
    const priceMinor = parseMoney(price);
    const costMinor = cost.trim() === "" ? 0 : parseMoney(cost);
    const taxRateBp = percentToBp(tax);
    const reorderLevel = parseQty(reorder);
    const openingStock = parseQty(opening);
    if (!name.trim()) return setError("Name is required");
    if (priceMinor === null) return setError("Enter a valid price, e.g. 12.50");
    if (costMinor === null) return setError("Enter a valid cost, e.g. 8.00");
    if (taxRateBp === null) return setError("Enter a valid tax percentage, e.g. 18");
    if (reorderLevel === null || reorderLevel < 0) return setError("Reorder level must be 0 or more");
    if (!product && (openingStock === null || openingStock < 0)) {
      return setError("Opening stock must be 0 or more");
    }
    try {
      const fields = {
        name,
        barcode: barcode.trim() || null,
        sku: sku.trim() || null,
        priceMinor,
        costMinor,
        taxRateBp,
        trackStock: track,
        reorderLevel,
      };
      if (product) {
        await api.updateProduct(product.id, { ...fields, active });
        toast("Product updated");
      } else {
        await api.createProduct(fields, track ? (openingStock ?? 0) : 0);
        toast("Product added");
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={product ? "Edit product" : "Add product"} onClose={onClose} wide>
      <div className="form-grid">
        <label className="field span2">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Barcode
          <input value={barcode} onChange={(e) => setBarcode(e.target.value)} />
        </label>
        <label className="field">
          SKU
          <input value={sku} onChange={(e) => setSku(e.target.value)} />
        </label>
        <label className="field">
          Price
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field">
          Cost
          <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <label className="field">
          Tax %
          <input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
        </label>
        <label className="field">
          Reorder level
          <input inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} />
        </label>
        {!product && track && (
          <label className="field">
            Opening stock
            <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </label>
        )}
        <label className="check span2">
          <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
          Track stock for this product
        </label>
        {product && (
          <label className="check span2">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active (can be sold)
          </label>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function AdjustForm({
  product,
  onClose,
  onSaved,
}: {
  product: ProductWithStock;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("purchase");
  const [error, setError] = useState("");

  const save = async () => {
    const qty = parseQty(delta);
    if (qty === null || qty === 0) return setError("Enter a quantity, e.g. 12 to add or -3 to remove");
    if (product.stock + qty < 0) return setError("That would take stock below zero");
    try {
      await api.adjustStock(product.id, qty, reason);
      toast("Stock updated");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`Adjust stock · ${product.name}`} onClose={onClose}>
      <p className="muted">Currently {product.stock} in stock.</p>
      <label className="field">
        Change (use a minus to remove)
        <input
          autoFocus
          inputMode="decimal"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
      </label>
      <label className="field">
        Reason
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="purchase">Purchase / delivery</option>
          <option value="stock count">Stock count correction</option>
          <option value="damage">Damaged</option>
          <option value="expired">Expired</option>
          <option value="theft">Lost / stolen</option>
          <option value="return">Customer return</option>
        </select>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
