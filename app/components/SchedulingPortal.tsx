"use client";

import { useEffect, useState } from "react";
import StoreShiftSwapPanel from "./StoreShiftSwapPanel";
import { localDate } from "../lib/scheduling";
import styles from "./SchedulingPortal.module.css";

type ScopedStore = { id: string; name: string; status?: string };

/** Scheduling-only shell: HTKD never loads manager finance or employee APIs. */
export default function SchedulingPortal() {
  const [stores, setStores] = useState<ScopedStore[]>([]);
  const [storeId, setStoreId] = useState("");
  const [date, setDate] = useState(localDate());
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/auth/me", { signal: controller.signal });
        if (response.status === 401) return window.location.replace("/");
        if (!response.ok) throw new Error("Không thể xác minh phiên đăng nhập.");
        const { user } = await response.json();
        if (user.role !== "HTKD") return window.location.replace(user.role === "MANAGER" ? "/manager" : "/employee");
        const scoped = await fetch("/api/shift-swaps?stores=1", { signal: controller.signal });
        if (!scoped.ok) throw new Error("Không thể tải phạm vi cửa hàng được cấp.");
        const data = await scoped.json();
        if (controller.signal.aborted) return;
        setName(user.name);
        setStores(data.stores);
        setStoreId((current) => data.stores.some((store: ScopedStore) => store.id === current) ? current : data.stores[0]?.id ?? "");
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Không thể kết nối hệ thống.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [reload]);
  const store = stores.find((item) => item.id === storeId);
  async function logout() {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (response.ok) window.location.replace("/");
    else setError("Chưa đăng xuất được. Vui lòng thử lại.");
  }
  return <main className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.brand}>DORE · HTKD</p><h1>Lịch phân ca</h1><p>{name}</p></div>
      <button type="button" onClick={() => void logout()}>Đăng xuất</button>
    </header>
    {error && <div role="alert" className={styles.error}>{error} <button type="button" onClick={() => setReload((value) => value + 1)}>Thử lại</button></div>}
    {loading ? <p role="status">Đang tải cửa hàng được cấp quyền...</p> : <>
      <div className={styles.filters}>
        <label>Cửa hàng<select value={storeId} onChange={(event) => setStoreId(event.target.value)} disabled={!stores.length}>
          {!stores.length && <option value="">Chưa được cấp cửa hàng</option>}
          {stores.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>Ngày phân ca<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      </div>
      {!stores.length && <p>Bạn chưa được cấp phạm vi cửa hàng. Vui lòng liên hệ quản trị hệ thống.</p>}
      {store && date && <StoreShiftSwapPanel key={`${store.id}:${date}`} store={store} date={date} onCompleted={() => undefined} />}
    </>}
  </main>;
}
