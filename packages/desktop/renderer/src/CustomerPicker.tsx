import { useEffect, useRef, useState } from "react";
import type { Customer } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { Modal } from "./Modal";

/**
 * Find a customer by phone number or name, or add a new one without leaving the till.
 * Typing a phone number that nobody has offers "Add" with the number already filled in.
 */
export function CustomerPicker({ onPick, onClose }: { onPick: (c: Customer) => void; onClose: () => void }) {
  const { toast } = useApp();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Customer[]>([]);
  const [searched, setSearched] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .searchCustomers(query)
        .then((r) => {
          if (cancelled) return;
          setFound(r);
          setSearched(true);
        })
        .catch((e: Error) => toast(e.message, "error"));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, toast]);

  const startAdding = () => {
    const q = query.trim();
    const looksLikePhone = /^[\d\s+()\-.]+$/.test(q) && q.replace(/\D/g, "").length >= 5;
    setPhone(looksLikePhone ? q : "");
    setName(looksLikePhone ? "" : q);
    setError("");
    setAdding(true);
    setTimeout(() => nameRef.current?.focus(), 0);
  };

  const add = async () => {
    if (busy) return;
    if (!name.trim()) return setError("Please enter the customer's name");
    setBusy(true);
    try {
      onPick(await api.createCustomer({ name, phone, address }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (adding) {
    return (
      <Modal title="New customer" onClose={onClose}>
        <label className="field">
          Name
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Phone
          <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="field">
          Address (optional)
          <input value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => setAdding(false)}>
            Back to search
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void add()}>
            Add and use
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Choose a customer" onClose={onClose}>
      <input
        className="scan"
        autoFocus
        placeholder="Phone number or name"
        aria-label="Search customers by phone number or name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && found.length === 1 && found[0]) onPick(found[0]);
        }}
      />
      <ul className="customer-results" aria-label="Matching customers">
        {found.map((c) => (
          <li key={c.id}>
            <button className="customer-result" onClick={() => onPick(c)}>
              <span className="customer-name">{c.name}</span>
              <span className="muted small">{c.phone ?? "No phone"}</span>
              <span className="customer-points">{c.points} pts</span>
            </button>
          </li>
        ))}
      </ul>
      {searched && found.length === 0 && <p className="empty">{query.trim() ? `Nobody found for “${query.trim()}”.` : "No customers yet."}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={startAdding}>
          {query.trim() ? "Add as a new customer" : "New customer"}
        </button>
      </div>
    </Modal>
  );
}
