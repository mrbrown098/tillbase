import { useCallback, useEffect, useState } from "react";
import type { ProductWithStock } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { bpToPercent, minorToInput, parseMoney, parseQty, percentToBp } from "./format";
import { Modal } from "./Modal";

export const lossReasons = [
  ["waste", "Wasted (cooked or dropped)"],
  ["spoilage", "Spoiled"],
  ["expired", "Expired"],
  ["damage", "Damaged"],
  ["theft", "Lost / stolen"],
  ["stock count", "Stock count correction"],
] as const;

export function Products() {
  const { money, toast, can } = useApp();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ProductWithStock[]>([]);
  const [editing, setEditing] = useState<ProductWithStock | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<ProductWithStock | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [kind, setKind] = useState<"product" | "ingredient">("product");
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [recipeFor, setRecipeFor] = useState<ProductWithStock | null>(null);

  const load = useCallback(async () => {
    try {
      const all = (await api.listItems(kind)).filter((p) => p.kind === kind);
      setCosts(await api.recipeCosts());
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
  }, [query, showInactive, kind, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Menu and stock</h1>
        <div className="seg" role="tablist" aria-label="Kind">
          <button role="tab" aria-selected={kind === "product"} className={kind === "product" ? "on" : ""} onClick={() => setKind("product")}>Menu items</button>
          <button role="tab" aria-selected={kind === "ingredient"} className={kind === "ingredient" ? "on" : ""} onClick={() => setKind("ingredient")}>Ingredients</button>
        </div>
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
            {kind === "product" ? "Add menu item" : "Add ingredient"}
          </button>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            {kind === "product" ? (
              <>
                <th className="num">Price</th>
                <th className="num">Cost</th>
                <th className="num">Margin</th>
              </>
            ) : (
              <th className="num">Avg cost / unit</th>
            )}
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
                {kind === "product" ? (
                  <>
                    <td className="num">{money(p.priceMinor)}</td>
                    <td className="num">{unitCost(p, costs) === null ? "—" : money(unitCost(p, costs)!)}</td>
                    <td className="num">
                      {unitCost(p, costs) === null || p.priceMinor <= 0 ? (
                        <span className="badge badge-warn">no cost</span>
                      ) : (
                        `${Math.round(((p.priceMinor - unitCost(p, costs)!) / p.priceMinor) * 100)}%`
                      )}
                    </td>
                  </>
                ) : (
                  <td className="num">{money(Math.round(p.avgCost))}</td>
                )}
                <td className={`num${low ? " low" : ""}`}>
                  {p.trackStock ? `${p.stock} ${p.kind === "ingredient" ? p.unit : ""}` : "—"}
                  {low && <span className="badge badge-warn">low</span>}
                </td>
                <td className="actions">
                  {kind === "product" && (
                    <button className="btn" onClick={() => setRecipeFor(p)}>
                      Recipe
                    </button>
                  )}
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
      {items.length === 0 && (
        <p className="empty">
          {kind === "product" ? "No menu items yet." : "No ingredients yet. Add what you buy (chicken, buns, oil) so each dish gets a real cost."}
        </p>
      )}
      {recipeFor && (
        <RecipeEditor
          product={recipeFor}
          onClose={() => setRecipeFor(null)}
          onSaved={() => {
            setRecipeFor(null);
            void load();
          }}
        />
      )}

      {editing && (
        <ProductForm
          kind={kind}
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

/** What one sold unit costs: its recipe if it has one, otherwise its own cost. */
function unitCost(p: ProductWithStock, recipeCosts: Record<string, number>): number | null {
  if (recipeCosts[p.id] !== undefined) return recipeCosts[p.id]!;
  return p.costMinor > 0 ? p.costMinor : null;
}

function ProductForm({
  kind,
  product,
  onClose,
  onSaved,
}: {
  kind: "product" | "ingredient";
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
  const [unit, setUnit] = useState(product?.unit ?? "kg");
  const ing = kind === "ingredient";
  const [error, setError] = useState("");

  const save = async () => {
    const priceMinor = ing ? 0 : parseMoney(price);
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
        trackStock: ing ? true : track,
        reorderLevel,
        ...(ing ? { unit: unit.trim() || "pcs" } : {}),
      };
      if (product) {
        await api.updateProduct(product.id, { ...fields, active });
        toast("Product updated");
      } else {
        await api.createProduct({ ...fields, kind }, (track || ing) ? (openingStock ?? 0) : 0);
        toast("Product added");
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`${product ? "Edit" : "Add"} ${ing ? "ingredient" : "menu item"}`} onClose={onClose} wide>
      <div className="form-grid">
        <label className="field span2">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {ing ? (
          <label className="field">
            Unit (kg, l, pcs...)
            <input value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!!product} />
          </label>
        ) : (
          <>
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
              {`Cost${kind === "product" ? " (leave empty if you add a recipe)" : ""}`}
              <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            </label>
            <label className="field">
              Tax %
              <input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
            </label>
          </>
        )}
        <label className="field">
          Reorder level
          <input inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} />
        </label>
        {!product && (track || ing) && (
          <label className="field">
            Opening stock
            <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </label>
        )}
        {!ing && (
          <label className="check span2">
            <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
            Track stock for this item (turn off for dishes made from a recipe)
          </label>
        )}
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
  const [reason, setReason] = useState("waste");
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
      <p className="muted">Currently {product.stock} {product.kind === "ingredient" ? product.unit : ""} in stock.</p>
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
          <option value="purchase">Delivery (no cost recorded, use Purchases for that)</option>
          {lossReasons.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
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

function RecipeEditor({
  product,
  onClose,
  onSaved,
}: {
  product: ProductWithStock;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { money, toast } = useApp();
  const [ingredients, setIngredients] = useState<ProductWithStock[]>([]);
  const [lines, setLines] = useState<{ ingredientId: string; qty: string }[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setIngredients((await api.listItems("ingredient")).filter((i) => i.kind === "ingredient" && i.active));
        const r = await api.getRecipe(product.id);
        setLines(r.lines.map((l) => ({ ingredientId: l.ingredientId, qty: String(l.qty) })));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [product.id]);

  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const lineCost = (l: { ingredientId: string; qty: string }) =>
    Math.round((parseQty(l.qty) ?? 0) * (byId.get(l.ingredientId)?.avgCost ?? 0));
  const total = lines.reduce((s, l) => s + lineCost(l), 0);
  const foodCostPct = product.priceMinor > 0 ? Math.round((total / product.priceMinor) * 1000) / 10 : null;

  const save = async () => {
    const out: { ingredientId: string; qty: number }[] = [];
    for (const l of lines) {
      const q = parseQty(l.qty);
      if (!l.ingredientId || q === null || q <= 0) return setError("Each line needs an ingredient and a quantity above zero");
      out.push({ ingredientId: l.ingredientId, qty: q });
    }
    try {
      await api.setRecipe(product.id, out);
      toast("Recipe saved");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unused = ingredients.filter((i) => !lines.some((l) => l.ingredientId === i.id));

  return (
    <Modal title={`Recipe · ${product.name}`} onClose={onClose} wide>
      <p className="muted">
        What goes into one serving. Selling it uses these up from stock, and its cost comes from what you actually paid.
      </p>
      {ingredients.length === 0 && <p className="form-error">Add some ingredients first (Ingredients tab).</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th className="num">Quantity</th>
            <th className="num">Cost</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.ingredientId}>
              <td>{byId.get(l.ingredientId)?.name ?? "…"}</td>
              <td className="num">
                <input
                  className="qty-input"
                  inputMode="decimal"
                  value={l.qty}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                />{" "}
                {byId.get(l.ingredientId)?.unit}
              </td>
              <td className="num">{money(lineCost(l))}</td>
              <td className="actions">
                <button className="btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove ingredient">
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {unused.length > 0 && (
        <label className="field">
          Add ingredient
          <select
            value=""
            onChange={(e) => e.target.value && setLines([...lines, { ingredientId: e.target.value, qty: "1" }])}
          >
            <option value="">Choose…</option>
            {unused.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.unit})
              </option>
            ))}
          </select>
        </label>
      )}
      <dl className="recap">
        <div>
          <dt>Cost of one serving</dt>
          <dd>{money(total)}</dd>
        </div>
        <div>
          <dt>Selling price</dt>
          <dd>{money(product.priceMinor)}</dd>
        </div>
        <div className="grand">
          <dt>Food cost</dt>
          <dd>
            {foodCostPct === null ? "—" : `${foodCostPct}%`}
            {foodCostPct !== null && ` · profit ${money(product.priceMinor - total)}`}
          </dd>
        </div>
      </dl>
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
          Save recipe
        </button>
      </div>
    </Modal>
  );
}
