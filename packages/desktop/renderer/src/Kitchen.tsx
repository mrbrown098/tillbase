import { useCallback, useEffect, useState } from "react";
import type { KitchenStatus, Order } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";

const typeLabel = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" } as const;
const columns: { status: KitchenStatus; title: string; action: string; next: KitchenStatus }[] = [
  { status: "new", title: "New", action: "Start cooking", next: "preparing" },
  { status: "preparing", title: "Preparing", action: "Ready", next: "ready" },
  { status: "ready", title: "Ready to hand over", action: "Served", next: "served" },
];

export function Kitchen() {
  const { toast } = useApp();
  const [orders, setOrders] = useState<Order[]>([]);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setOrders(await api.kitchenBoard());
      setNow(Date.now());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  const move = async (o: Order, next: KitchenStatus) => {
    try {
      await api.setKitchenStatus(o.id, next);
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Kitchen</h1>
        <span className="muted">Updates every few seconds. {orders.length} order{orders.length === 1 ? "" : "s"} in progress.</span>
      </div>
      <div className="kitchen">
        {columns.map((c) => {
          const list = orders.filter((o) => o.kitchenStatus === c.status);
          return (
            <section key={c.status} className="kcol" aria-label={c.title}>
              <h2>{c.title} <span className="badge">{list.length}</span></h2>
              {list.length === 0 && <p className="empty">Nothing here.</p>}
              {list.map((o) => {
                const mins = o.sentAt ? Math.max(0, Math.floor((now - new Date(o.sentAt).getTime()) / 60000)) : 0;
                return (
                  <article key={o.id} className={`kcard${mins >= 15 && c.status !== "ready" ? " late" : ""}`}>
                    <div className="kcard-head">
                      <strong className="ktoken">#{o.token}</strong>
                      <span>{typeLabel[o.type]}{o.tableLabel ? ` · Table ${o.tableLabel}` : ""}</span>
                      <span className="muted">{mins} min</span>
                    </div>
                    <ul className="kitems">
                      {o.items.map((i) => (
                        <li key={i.id}>
                          <strong>{i.qty} ×</strong> {i.name}
                          {i.modifiers.length > 0 && <div className="kmod">+ {i.modifiers.map((m) => m.name).join(", ")}</div>}
                          {i.note && <div className="kmod">Note: {i.note}</div>}
                        </li>
                      ))}
                    </ul>
                    {o.note && <p className="kmod">Order note: {o.note}</p>}
                    <button className="btn btn-primary btn-lg" onClick={() => void move(o, c.next)}>{c.action}</button>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
