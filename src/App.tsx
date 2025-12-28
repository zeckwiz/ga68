
import React, { useEffect, useMemo, useState } from "react";

/**
 * Ga‑68 Planner — Vite + Tailwind (Portable + One-click Deploy)
 *
 * Enhancements:
 * - Atomic multi-store transactions for rescan updates (orders + generators).
 * - Atomic bundle import across multiple stores (clear + write in one transaction).
 * - Save As dialogs for export (File System Access API with fallback).
 * - UX: busy indicators, toasts, confirmations, filters, clearer messages.
 * - Simulation: first-use MAX ignores lock by default (configurable).
 * - Daily wear resets per local day via _wearDate.
 * - Safe local date parsing for diffDays warning.
 * - Orders table availability uses the actual lock window.
 * - Harmonized sorting between standard and simulation assignment policies.
 * - IndexedDB onversionchange handler added.
 * - Explicit travel time derivation from distance_km (60 km/h).
 * - Centralized date formatting via pad2; generators show "Expires in X days".
 */

// ---------- Constants ----------
const HALF_LIFE_GA_MIN = 67.71; // minutes
const HALF_LIFE_GE_DAYS = 270.95; // days
const LN2 = Math.log(2);
const LAMBDA_GA = LN2 / HALF_LIFE_GA_MIN; // per minute
const LAMBDA_GE = LN2 / (HALF_LIFE_GE_DAYS * 24 * 60); // per minute

const SPEED_KMH = 60;
const minutesFromDistance = (km: number) => Math.round((km / SPEED_KMH) * 60); // minutes

// IndexedDB setup
const DB_NAME = "Ga68Planner";
const DB_VERSION = 2; // includes future_orders store
const STORE_GENERATORS = "generators";
const STORE_HOSPITALS = "hospitals";
const STORE_ORDERS = "orders";
const STORE_FUTURE_ORDERS = "future_orders"; // vault for planned orders

function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_GENERATORS)) {
        db.createObjectStore(STORE_GENERATORS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_HOSPITALS)) {
        db.createObjectStore(STORE_HOSPITALS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_ORDERS)) {
        db.createObjectStore(STORE_ORDERS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_FUTURE_ORDERS)) {
        db.createObjectStore(STORE_FUTURE_ORDERS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error as any);
  });
}

function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error as any);
  });
}

function idbPut<T>(db: IDBDatabase, store: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    const req = st.put(value as any);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error as any);
  });
}

function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    const req = st.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error as any);
  });
}

function idbBulkPut<T>(db: IDBDatabase, store: string, values: T[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    values.forEach((v) => st.put(v as any));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as any);
  });
}

// Atomic write helper: orders + generators together
async function idbWriteRescanAtomically(
  db: IDBDatabase,
  ordersToWrite: Order[],
  generatorsToWrite: Generator[]
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_ORDERS, STORE_GENERATORS], "readwrite");
    const stOrders = tx.objectStore(STORE_ORDERS);
    const stGens = tx.objectStore(STORE_GENERATORS);

    ordersToWrite.forEach((o) => stOrders.put(o as any));
    generatorsToWrite.forEach((g) => stGens.put(g as any));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as any);
    tx.onabort = () => reject(tx.error as any);
  });
}

// Atomic bundle import across multiple stores (clear + put)
async function idbImportBundleAtomically(
  db: IDBDatabase,
  bundle: {
    generators?: Generator[];
    hospitals?: Hospital[];
    orders?: Order[];
    future_orders?: Order[];
  },
  options?: { clearFirst?: boolean }
): Promise<void> {
  const clearFirst = options?.clearFirst ?? true;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORE_GENERATORS, STORE_HOSPITALS, STORE_ORDERS, STORE_FUTURE_ORDERS],
      "readwrite"
    );

    const stG = tx.objectStore(STORE_GENERATORS);
    const stH = tx.objectStore(STORE_HOSPITALS);
    const stO = tx.objectStore(STORE_ORDERS);
    const stF = tx.objectStore(STORE_FUTURE_ORDERS);

    const doClear = () => {
      if (!clearFirst) return;
      stG.clear();
      stH.clear();
      stO.clear();
      stF.clear();
    };

    try {
      doClear();
      (bundle.generators ?? []).forEach((g) => stG.put(g as any));
      (bundle.hospitals ?? []).forEach((h) => stH.put(h as any));
      (bundle.orders ?? []).forEach((o) => stO.put(o as any));
      (bundle.future_orders ?? []).forEach((f) => stF.put(f as any));
    } catch (e) {
      tx.abort();
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as any);
    tx.onabort = () => reject(tx.error as any);
  });
}

// ---------- Types ----------

type Generator = {
  id: string; // unique id
  activity_mCi: number; // parent Ge-68 activity at calibration
  efficiency_pct: number; // 0-100
  calibration_dt: string; // ISO datetime string
  last_eluted_dt: string; // ISO datetime string
  total_eluted_today_mCi?: number; // runtime wear (resets daily)
  _wearDate?: string; // ephemeral helper for daily reset
};

type Hospital = {
  id: string;
  name: string;
  travel_minutes: number; // user-provided
};

type Order = {
  id: string;
  hospitalId: string;
  product: "PSMA" | "Dotatate" | "Research";
  requested_mCi_at_cal: number; // amount requested at hospital calibration time
  calibration_dt: string; // hospital calibration datetime
  prep_minutes: number; // default 15
  travel_minutes: number; // auto from hospital selection
  assignedGeneratorIds?: string[]; // one or two for PSMA
  assigned_elute_dt?: string; // computed elution datetime
  assigned_delta_minutes?: number[]; // ingrowth time used per assigned generator
  notes?: string; // messages
};

// ---------- Helpers (date/time, formatting) ----------

function minutesBetween(a: Date, b: Date) {
  return (b.getTime() - a.getTime()) / 60000;
}

function parseLocal(dt: string) {
  return new Date(dt);
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function formatLocal(dt: Date) {
  const yyyy = dt.getFullYear();
  const mm = pad2(dt.getMonth() + 1);
  const dd = pad2(dt.getDate());
  const hh = pad2(dt.getHours());
  const mi = pad2(dt.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function dateOnly(dt: Date) {
  const yyyy = dt.getFullYear();
  const mm = pad2(dt.getMonth() + 1);
  const dd = pad2(dt.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

function todayLocalDate() {
  return dateOnly(new Date());
}

function nowLocalISO() {
  return formatLocal(new Date());
}

function genId(prefix: string) {
  const rnd = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `${prefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}-${rnd}`;
}

function genOrderIdDateBased(hospitalId?: string, product?: string) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  const h = hospitalId ? hospitalId : "H";
  const p = product ? product : "P";
  return `O-${yyyy}${mm}${dd}-${hh}${mi}${ss}${ms}-${h}-${p}`;
}

function setDatePreserveTime(origISO: string, newDateYYYYMMDD: string): string {
  const orig = parseLocal(origISO);
  const [y, m, d] = newDateYYYYMMDD.split("-").map(Number);
  const newDt = new Date(orig);
  newDt.setFullYear(y, (m ?? 1) - 1, d ?? 1);
  return formatLocal(newDt);
}

// Safe local date parser for YYYY-MM-DD (avoids UTC pitfall)
function parseLocalDateYYYYMMDD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0); // local midnight
}

// Friendly formats
function formatTimeLocal(dt: Date) {
  return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function formatDateFriendly(dt: Date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function formatDateTimeFriendly(dt: Date) {
  return `${formatDateFriendly(dt)} ${formatTimeLocal(dt)}`;
}

// Generator expiry
function generatorExpiryDate(gen: Generator): Date {
  const cal = parseLocal(gen.calibration_dt);
  const exp = new Date(cal);
  exp.setFullYear(exp.getFullYear() + 1);
  exp.setDate(exp.getDate() - 1);
  exp.setHours(23, 59, 0, 0);
  return exp;
}

function isGeneratorExpired(gen: Generator, eluteDt: Date): boolean {
  return eluteDt.getTime() > generatorExpiryDate(gen).getTime();
}

function daysUntilExpiry(gen: Generator, ref: Date = new Date()): number {
  const ms = generatorExpiryDate(gen).getTime() - ref.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

// ---------- Physics calculations ----------
function parentAtTime_mCi(gen: Generator, eluteDt: Date): number {
  const cal = parseLocal(gen.calibration_dt);
  const minutes = minutesBetween(cal, eluteDt);
  const A0 = gen.activity_mCi;
  return A0 * Math.exp(-LAMBDA_GE * minutes);
}

function availableAtElute_mCi(
  gen: Generator,
  eluteDt: Date,
  minLockMinutes: number
): { available: number; eligible: boolean; reason?: string; deltaSinceLastMin: number } {
  const last = parseLocal(gen.last_eluted_dt);
  const dtMin = Math.max(0, minutesBetween(last, eluteDt));
  const eligibleLock = dtMin >= minLockMinutes;
  const expired = isGeneratorExpired(gen, eluteDt);
  const parent = parentAtTime_mCi(gen, eluteDt);
  const efficiency = (gen.efficiency_pct ?? 60) / 100;
  const available = parent * efficiency * (1 - Math.exp(-LAMBDA_GA * dtMin));
  const eligible = eligibleLock && !expired;
  const reason = expired ? "Expired" : eligibleLock ? undefined : `Lock: needs ${Math.ceil(minLockMinutes - dtMin)} more min`;
  return { available, eligible, reason, deltaSinceLastMin: dtMin };
}

function requiredAtElute_mCi(order: Order): { required: number; eluteDt: Date } {
  const calDt = parseLocal(order.calibration_dt);
  const deltaMinutes = (order.prep_minutes ?? 15) + (order.travel_minutes ?? 0);
  const eluteDt = new Date(calDt.getTime() - deltaMinutes * 60000);
  const required = (order.requested_mCi_at_cal ?? 0) * Math.exp(LAMBDA_GA * deltaMinutes);
  return { required, eluteDt };
}

// ---------- Assignment policy (standard with expiry) ----------
function assignOrdersEfficient(
  orders: Order[],
  generators: Generator[],
  options: { minLockMinutes: number }
): { orders: Order[]; messages: string[] } {
  const msgs: string[] = [];
  const gens = generators.map((g) => ({ ...g }));
  const byId: Record<string, Generator> = Object.fromEntries(gens.map((g) => [g.id, g]));

  const sorted = [...orders].sort(
    (a, b) => parseLocal(a.calibration_dt).getTime() - parseLocal(b.calibration_dt).getTime()
  );

  const resultOrders: Order[] = [];

  for (const ord of sorted) {
    const { required, eluteDt } = requiredAtElute_mCi(ord);
    const candidates = gens.map((g) => {
      const avail = availableAtElute_mCi(g, eluteDt, options.minLockMinutes);
      return {
        gen: g,
        available: avail.available,
        eligible: avail.eligible,
        reason: avail.reason,
        deltaSinceLastMin: avail.deltaSinceLastMin,
        efficiency: g.efficiency_pct ?? 60,
        parentAtElute: parentAtTime_mCi(g, eluteDt),
        wear: g.total_eluted_today_mCi ?? 0,
      };
    });

    const eligible = candidates.filter((c) => c.eligible);

    // Standard comparator: efficiency -> available -> delta -> wear -> id
    eligible.sort((a, b) => {
      if (b.efficiency !== a.efficiency) return b.efficiency - a.efficiency;
      if (b.available !== a.available) return b.available - a.available;
      if (b.deltaSinceLastMin !== a.deltaSinceLastMin) return b.deltaSinceLastMin - a.deltaSinceLastMin;
      if (a.wear !== b.wear) return a.wear - b.wear;
      return a.gen.id.localeCompare(b.gen.id);
    });

    let assigned: string[] = [];
    let assignedDelta: number[] = [];
    let note = "";

    if (ord.product === "PSMA") {
      const single = eligible.find((c) => c.available >= required);
      if (single) {
        assigned = [single.gen.id];
        assignedDelta = [single.deltaSinceLastMin];
        note = `Single generator ${single.gen.id}`;
      } else {
        let bestCombo: { ids: string[]; totalAvailable: number; deltas: number[] } | null = null;
        for (let i = 0; i < eligible.length; i++) {
          for (let j = i + 1; j < eligible.length; j++) {
            const g1 = eligible[i], g2 = eligible[j];
            const total = g1.available + g2.available;
            if (total >= required) {
              const combo = { ids: [g1.gen.id, g2.gen.id], totalAvailable: total, deltas: [g1.deltaSinceLastMin, g2.deltaSinceLastMin] };
              if (!bestCombo || total > bestCombo.totalAvailable) {
                bestCombo = combo;
              }
            }
          }
        }
        if (bestCombo) {
          assigned = bestCombo.ids;
          assignedDelta = bestCombo.deltas;
          note = `Combined generators ${assigned.join(" + ")}`;
        }
      }
    } else {
      const single = eligible.find((c) => c.available >= required);
      if (single) {
        assigned = [single.gen.id];
        assignedDelta = [single.deltaSinceLastMin];
        note = `Single generator ${single.gen.id}`;
      }
    }

    const oCopy: Order = { ...ord };
    oCopy.assigned_elute_dt = formatLocal(eluteDt);

    if (assigned.length > 0) {
      oCopy.assignedGeneratorIds = assigned;
      oCopy.assigned_delta_minutes = assignedDelta;
      oCopy.notes = `${note}; required @ elute ${required.toFixed(2)} mCi`;
      const perGenShare = required / assigned.length;
      for (const gid of assigned) {
        const g = byId[gid];
        g.last_eluted_dt = formatLocal(eluteDt);
        g.total_eluted_today_mCi = (g.total_eluted_today_mCi ?? 0) + perGenShare;
        g._wearDate = todayLocalDate();
      }
      msgs.push(`Order ${ord.id}: assigned ${assigned.join(", ")} at ${oCopy.assigned_elute_dt}`);
    } else {
      oCopy.assignedGeneratorIds = [];
      oCopy.assigned_delta_minutes = [];
      oCopy.notes = `Insufficient availability. Required @ elute ${required.toFixed(2)} mCi.`;
      msgs.push(`Order ${ord.id}: unmet; insufficient availability.`);
    }

    resultOrders.push(oCopy);
  }

  return { orders: resultOrders, messages: msgs };
}

// ---------- Simulation assignment (first-use MAX, expiry enforced) ----------
function assignOrdersEfficientSim(
  orders: Order[],
  generators: Generator[],
  options: { minLockMinutes: number; respectLock: boolean; treatFirstUseMax: boolean; firstUseIgnoresLock?: boolean }
): { orders: Order[]; messages: string[] } {
  const msgs: string[] = [];
  const gens = generators.map((g) => ({ ...g }));
  const byId: Record<string, Generator> = Object.fromEntries(gens.map((g) => [g.id, g]));
  const usedFirst: Set<string> = new Set(); // tracks first-use per generator within this simulation run
  const ignoreLockOnFirst = options.firstUseIgnoresLock ?? true;

  const sorted = [...orders].sort(
    (a, b) => parseLocal(a.calibration_dt).getTime() - parseLocal(b.calibration_dt).getTime()
  );

  const resultOrders: Order[] = [];

  for (const ord of sorted) {
    const { required, eluteDt } = requiredAtElute_mCi(ord);

    const candidates = gens.map((g) => {
      // Enforce expiry always
      if (isGeneratorExpired(g, eluteDt)) {
        return {
          gen: g,
          available: 0,
          eligible: false,
          reason: "Expired",
          deltaSinceLastMin: 0,
          efficiency: g.efficiency_pct ?? 60,
          parentAtElute: parentAtTime_mCi(g, eluteDt),
          wear: g.total_eluted_today_mCi ?? 0,
        };
      }

      const baseline = availableAtElute_mCi(g, eluteDt, options.respectLock ? options.minLockMinutes : 0);
      let available = baseline.available;
      let reason = baseline.reason;
      let eligible = baseline.eligible || !options.respectLock; // if ignoring lock globally, allow
      let deltaSinceLastMin = baseline.deltaSinceLastMin;

      if (options.treatFirstUseMax && !usedFirst.has(g.id)) {
        const parent = parentAtTime_mCi(g, eluteDt);
        const efficiency = (g.efficiency_pct ?? 60) / 100;
        available = parent * efficiency; // MAX at first use

        // First-use can ignore lock (simulation "what-if")
        eligible = !isGeneratorExpired(g, eluteDt) && (ignoreLockOnFirst ? true : (options.respectLock ? baseline.eligible : true));
        reason = isGeneratorExpired(g, eluteDt) ? "Expired" : undefined;
        // keep baseline delta for reporting
      }

      return {
        gen: g,
        available,
        eligible,
        reason,
        deltaSinceLastMin,
        efficiency: g.efficiency_pct ?? 60,
        parentAtElute: parentAtTime_mCi(g, eluteDt),
        wear: g.total_eluted_today_mCi ?? 0,
      };
    });

    const eligible = candidates.filter((c) => c.eligible);

    // Harmonize comparator with standard policy
    eligible.sort((a, b) => {
      if (b.efficiency !== a.efficiency) return b.efficiency - a.efficiency;
      if (b.available !== a.available) return b.available - a.available;
      if (b.deltaSinceLastMin !== a.deltaSinceLastMin) return b.deltaSinceLastMin - a.deltaSinceLastMin;
      if (a.wear !== b.wear) return a.wear - b.wear;
      return a.gen.id.localeCompare(b.gen.id);
    });

    let assigned: string[] = [];
    let assignedDelta: number[] = [];
    let note = "";

    if (ord.product === "PSMA") {
      const single = eligible.find((c) => c.available >= required);
      if (single) {
        assigned = [single.gen.id];
        assignedDelta = [single.deltaSinceLastMin];
        note = `Single generator ${single.gen.id}`;
      } else {
        let bestCombo: { ids: string[]; totalAvailable: number; deltas: number[] } | null = null;
        for (let i = 0; i < eligible.length; i++) {
          for (let j = i + 1; j < eligible.length; j++) {
            const g1 = eligible[i], g2 = eligible[j];
            const total = g1.available + g2.available;
            if (total >= required) {
              const combo = { ids: [g1.gen.id, g2.gen.id], totalAvailable: total, deltas: [g1.deltaSinceLastMin, g2.deltaSinceLastMin] };
              if (!bestCombo || total > bestCombo.totalAvailable) {
                bestCombo = combo;
              }
            }
          }
        }
        if (bestCombo) {
          assigned = bestCombo.ids;
          assignedDelta = bestCombo.deltas;
          note = `Combined generators ${assigned.join(" + ")}`;
        }
      }
    } else {
      const single = eligible.find((c) => c.available >= required);
      if (single) {
        assigned = [single.gen.id];
        assignedDelta = [single.deltaSinceLastMin];
        note = `Single generator ${single.gen.id}`;
      }
    }

    const oCopy: Order = { ...ord };
    oCopy.assigned_elute_dt = formatLocal(eluteDt);

    if (assigned.length > 0) {
      oCopy.assignedGeneratorIds = assigned;
      oCopy.assigned_delta_minutes = assignedDelta;
      oCopy.notes = `${note}; required @ elute ${required.toFixed(2)} mCi (simulation)`;
      const perGenShare = required / assigned.length;
      for (const gid of assigned) {
        const g = byId[gid];
        g.last_eluted_dt = formatLocal(eluteDt); // advance ingrowth for subsequent orders
        g.total_eluted_today_mCi = (g.total_eluted_today_mCi ?? 0) + perGenShare;
        g._wearDate = todayLocalDate();
        usedFirst.add(gid); // mark as first-use completed
      }
      msgs.push(`Sim ${ord.id}: assigned ${assigned.join(", ")} at ${oCopy.assigned_elute_dt}`);
    } else {
      oCopy.assignedGeneratorIds = [];
      oCopy.assigned_delta_minutes = [];
      oCopy.notes = `Unmet (simulation). Required @ elute ${required.toFixed(2)} mCi.`;
      msgs.push(`Sim ${ord.id}: unmet.`);
    }

    resultOrders.push(oCopy);
  }

  return { orders: resultOrders, messages: msgs };
}

// ---------- UI Components ----------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4 my-3 rounded-2xl shadow bg-white">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      {children}
    </div>
  );
}

function PreviewDateTime({ iso }: { iso?: string }) {
  if (!iso) return null;
  const dt = parseLocal(iso);
  return <div className="text-xs text-slate-500">Preview: {formatDateTimeFriendly(dt)}</div>;
}

// Simple toast notifications
function Toast({ message, kind }: { message: string; kind: "info" | "success" | "error" }) {
  const color =
    kind === "success" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    kind === "error" ? "bg-red-50 text-red-700 border-red-200" :
    "bg-slate-50 text-slate-700 border-slate-200";
  return <div className={`p-2 rounded border ${color}`}>{message}</div>;
}

// Save As helper using File System Access API (fallback to prompt+download)
async function saveBlobWithPicker(
  suggestedName: string,
  blob: Blob,
  opts?: { description?: string; mime?: string; ext?: string }
): Promise<void> {
  const description = opts?.description ?? "File";
  const mime = opts?.mime ?? blob.type ?? "application/octet-stream";
  const ext = opts?.ext ?? (suggestedName.includes(".") ? "" : ".json");
  const finalName = suggestedName + ext;

  const anyWindow = window as any;
  if (typeof anyWindow.showSaveFilePicker === "function") {
    const handle = await anyWindow.showSaveFilePicker({
      suggestedName: finalName,
      types: [{ description, accept: { [mime]: [ext || ".json"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } else {
    const name = prompt("Enter file name:", finalName) || finalName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// Normalize/reset daily wear for the given local day
function normalizeDailyWear(gens: Generator[], dayYYYYMMDD: string): Generator[] {
  return gens.map((g) => {
    const anyG = g as Generator;
    if (anyG._wearDate !== dayYYYYMMDD) {
      return { ...g, total_eluted_today_mCi: 0, _wearDate: dayYYYYMMDD };
    }
    return g;
  });
}

function App() {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [page, setPage] = useState<"orders" | "hospitals" | "generators" | "future">("orders");

  const [generators, setGenerators] = useState<Generator[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [futureOrders, setFutureOrders] = useState<Order[]>([]);

  const [minLockMinutes, setMinLockMinutes] = useState<number>(20);
  const [selectedDate, setSelectedDate] = useState<string>(todayLocalDate()); // Orders page day filter
  const [futureSelectedDate, setFutureSelectedDate] = useState<string>(todayLocalDate()); // Future tab day selector
  const [futureGoTo, setFutureGoTo] = useState<boolean>(false); // toggles showing filtered future orders panel
  const [promotionDateById, setPromotionDateById] = useState<Record<string, string>>({}); // per-order selected promotion date

  // UX states
  const [busy, setBusy] = useState<boolean>(false);
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "success" | "error" } | null>(null);

  // Simulation (auto-assign for selected date)
  const [simAutoAssignOrders, setSimAutoAssignOrders] = useState<Order[]>([]);
  const [simAutoAssignMsgs, setSimAutoAssignMsgs] = useState<string[]>([]);

  // Orders tab filters
  const [ordersFilterHospitalId, setOrdersFilterHospitalId] = useState<string>("");
  const [ordersFilterProduct, setOrdersFilterProduct] = useState<"" | "PSMA" | "Dotatate" | "Research">("");

  // Load DB
  useEffect(() => {
    let closed = false;
    openDB().then(async (database) => {
      setDb(database);

      // Handle DB upgrades from other tabs/windows
      database.onversionchange = () => {
        alert("Database updated in another tab. Reloading to stay in sync.");
        database.close();
        if (!closed) location.reload();
      };

      const gens = await idbGetAll<Generator>(database, STORE_GENERATORS);
      const hos = await idbGetAll<Hospital>(database, STORE_HOSPITALS);
      const ords = await idbGetAll<Order>(database, STORE_ORDERS);
      const fut = await idbGetAll<Order>(database, STORE_FUTURE_ORDERS);
      const fixedHos: Hospital[] = (hos as any[]).map((h: any) => ({
        id: h.id,
        name: h.name,
        travel_minutes: h.travel_minutes ?? (h.distance_km != null ? minutesFromDistance(h.distance_km) : 0),
      }));
      setGenerators(gens);
      setHospitals(fixedHos);
      setOrders(ords);
      setFutureOrders(fut);
    });
    return () => {
      closed = true;
    };
  }, []);

  // ---------- Generators Tab ----------
  const [genForm, setGenForm] = useState<Partial<Generator>>({
    id: "",
    activity_mCi: 50,
    efficiency_pct: 60,
    calibration_dt: nowLocalISO(),
    last_eluted_dt: nowLocalISO(),
  });

  async function addOrUpdateGenerator() {
    if (!db) return;
    const id = (genForm.id ?? "").trim();
    if (!id) { alert("Generator ID is required"); return; }
    const payload: Generator = {
      id,
      activity_mCi: Number(genForm.activity_mCi ?? 50),
      efficiency_pct: Number(genForm.efficiency_pct ?? 60),
      calibration_dt: genForm.calibration_dt ?? nowLocalISO(),
      last_eluted_dt: genForm.last_eluted_dt ?? nowLocalISO(),
      total_eluted_today_mCi: 0,
      _wearDate: todayLocalDate(),
    };
    setBusy(true);
    try {
      await idbPut(db, STORE_GENERATORS, payload);
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setGenForm({ ...genForm, id: "" });
      setToast({ msg: `Generator ${id} saved.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to save generator ${id}.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function deleteGenerator(id: string) {
    if (!db) return;
    const proceed = confirm(`Delete generator ${id}?`);
    if (!proceed) return;
    setBusy(true);
    try {
      await idbDelete(db, STORE_GENERATORS, id);
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setToast({ msg: `Generator ${id} deleted.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to delete generator ${id}.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  const gensWithAvailNow = useMemo(() => {
    const now = new Date();
    return generators.map((g) => {
      const { available, eligible, deltaSinceLastMin } = availableAtElute_mCi(g, now, minLockMinutes);
      return {
        ...g,
        _availNow: available,
        _deltaSinceLast: deltaSinceLastMin,
        _eligibleNow: eligible,
        _expired: isGeneratorExpired(g, now),
        _daysToExpiry: daysUntilExpiry(g, now),
      } as any;
    });
  }, [generators, minLockMinutes]);

  // ---------- Hospitals Tab ----------
  const [hospitalForm, setHospitalForm] = useState<Partial<Hospital>>({ id: "", name: "", travel_minutes: undefined as any });

  async function addOrUpdateHospital() {
    if (!db) return;
    let id = (hospitalForm.id ?? "").trim();
    if (!id) id = genId("H");
    if (!hospitalForm.name || (hospitalForm.name ?? "").trim() === "") { alert("Hospital name is required"); return; }
    const payload: Hospital = { id, name: hospitalForm.name!, travel_minutes: Number(hospitalForm.travel_minutes ?? 0) };
    setBusy(true);
    try {
      await idbPut(db, STORE_HOSPITALS, payload);
      setHospitals(await idbGetAll<Hospital>(db, STORE_HOSPITALS));
      setHospitalForm({ id: "", name: "", travel_minutes: undefined as any });
      setToast({ msg: `Hospital "${payload.name}" saved.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to save hospital.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function deleteHospital(id: string) {
    if (!db) return;
    const h = hospitals.find((x) => x.id === id);
    const proceed = confirm(`Delete hospital "${h?.name ?? id}"?`);
    if (!proceed) return;
    setBusy(true);
    try {
      await idbDelete(db, STORE_HOSPITALS, id);
      setHospitals(await idbGetAll<Hospital>(db, STORE_HOSPITALS));
      setToast({ msg: `Hospital "${h?.name ?? id}" deleted.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to delete hospital.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Orders Tab ----------
  const [orderForm, setOrderForm] = useState<Partial<Order>>({
    id: "",
    hospitalId: "",
    product: "PSMA",
    requested_mCi_at_cal: undefined as any,
    calibration_dt: nowLocalISO(),
    prep_minutes: 15,
    travel_minutes: undefined as any,
  });
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);

  function onHospitalSelect(hid: string) {
    const hos = hospitals.find((h) => h.id === hid);
    setOrderForm((f) => ({ ...f, hospitalId: hid, travel_minutes: hos ? hos.travel_minutes : undefined as any }));
  }

  function isPotentialDuplicateOrder(candidate: Order, existingOrders: Order[]): { sameByFields: boolean; idExists: boolean } {
    const sameByFields = existingOrders.some((o) =>
      o.id !== candidate.id &&
      o.hospitalId === candidate.hospitalId &&
      o.product === candidate.product &&
      formatLocal(parseLocal(o.calibration_dt)) === formatLocal(parseLocal(candidate.calibration_dt))
    );
    const idExists = existingOrders.some((o) => o.id === candidate.id);
    return { sameByFields, idExists };
  }

  function canFulfillOrder(candidate: Order, existingOrders: Order[], currentGenerators: Generator[]): boolean {
    const trialOrders = [...existingOrders.filter((o) => o.id !== candidate.id), candidate];
    const baselineGens = normalizeDailyWear(currentGenerators.map((g) => ({ ...g, total_eluted_today_mCi: 0 })), todayLocalDate());
    const { orders: reassigned } = assignOrdersEfficient(trialOrders, baselineGens, { minLockMinutes });
    const found = reassigned.find((o) => o.id === candidate.id);
    return !!found && (found.assignedGeneratorIds?.length ?? 0) > 0;
  }

  function clearOrderForm() {
    setOrderForm({ id: "", hospitalId: "", product: "PSMA", requested_mCi_at_cal: undefined as any, calibration_dt: nowLocalISO(), prep_minutes: 15, travel_minutes: undefined as any });
    setEditingOrderId(null);
  }

  async function saveOrder() {
    if (!db) return;
    let id = ((editingOrderId ?? orderForm.id) ?? "").trim();
    const isEditing = !!editingOrderId;
    if (!isEditing && !id) id = genOrderIdDateBased(orderForm.hospitalId ?? undefined, orderForm.product ?? undefined);
    if (!id) { alert("Order ID is required"); return; }
    if (!orderForm.hospitalId) { alert("Select hospital"); return; }
    const payload: Order = {
      id,
      hospitalId: orderForm.hospitalId!,
      product: (orderForm.product as any) ?? "PSMA",
      requested_mCi_at_cal: Number(orderForm.requested_mCi_at_cal ?? 0),
      calibration_dt: orderForm.calibration_dt ?? nowLocalISO(),
      prep_minutes: Number(orderForm.prep_minutes ?? 15),
      travel_minutes: Number(orderForm.travel_minutes ?? 0),
    };
    const dup = isPotentialDuplicateOrder(payload, orders);
    if (dup.idExists || dup.sameByFields) {
      const proceed = confirm(`Potential duplicate order${dup.idExists ? " (same ID)" : ""}${dup.sameByFields ? " (same hospital/product/time)" : ""}. Continue?`);
      if (!proceed) return;
    }
    if (!canFulfillOrder(payload, orders, generators)) {
      alert("This order cannot be fulfilled given current generators and lock window.");
      return;
    }
    setBusy(true);
    try {
      await idbPut(db, STORE_ORDERS, payload);
      const ords = await idbGetAll<Order>(db, STORE_ORDERS);
      setOrders(ords);
      const reassigned = runRescan(ords, generators);
      const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
      await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);
      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      clearOrderForm();
      setToast({ msg: `Order ${payload.id} saved and assignments updated.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to save order.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function deleteOrder(id: string) {
    if (!db) return;
    const proceed = confirm(`Delete order ${id}?`);
    if (!proceed) return;
    setBusy(true);
    try {
      await idbDelete(db, STORE_ORDERS, id);
      const ords = await idbGetAll<Order>(db, STORE_ORDERS);
      setOrders(ords);
      const reassigned = runRescan(ords, generators);
      const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
      await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);
      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      if (editingOrderId === id) setEditingOrderId(null);
      setToast({ msg: `Order ${id} deleted and assignments updated.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to delete order.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  function onEditOrder(o: Order) {
    setOrderForm({ ...o });
    setEditingOrderId(o.id);
  }

  function runRescan(currentOrders: Order[], currentGenerators: Generator[]) {
    const day = todayLocalDate();
    const baselineGens = normalizeDailyWear(currentGenerators.map((g) => ({ ...g })), day);
    const { orders: reassignedOrders } = assignOrdersEfficient(currentOrders, baselineGens, { minLockMinutes });
    const updatedById: Record<string, Generator> = Object.fromEntries(baselineGens.map((g: any) => [g.id, g]));
    return { orders: reassignedOrders, updatedById };
  }

  async function rescanAll() {
    if (!db) return;
    setBusy(true);
    try {
      const reassigned = runRescan(orders, generators);
      const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
      await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);
      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setToast({ msg: `Rescan complete. Assignments updated.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Rescan failed.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Import/Export (bundle) ----------
  async function exportBundle() {
    const payload = { generators, hospitals, orders, future_orders: futureOrders, meta: { exportedAt: new Date().toISOString(), minLockMinutes } };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    try {
      await saveBlobWithPicker(`ga68_planner_export_${new Date().toISOString().slice(0, 19)}`, blob, {
        description: "Ga-68 Planner Bundle",
        mime: "application/json",
        ext: ".json",
      });
      setToast({ msg: "Bundle exported.", kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Export failed.", kind: "error" });
    } finally {
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function exportGenerators() {
    const payload = generators;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    try {
      await saveBlobWithPicker(`generators_${new Date().toISOString().slice(0, 19)}`, blob, { description: "Generators", mime: "application/json", ext: ".json" });
      setToast({ msg: "Generators exported.", kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Export failed.", kind: "error" });
    } finally {
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function exportHospitals() {
    const payload = hospitals;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    try {
      await saveBlobWithPicker(`hospitals_${new Date().toISOString().slice(0, 19)}`, blob, { description: "Hospitals", mime: "application/json", ext: ".json" });
      setToast({ msg: "Hospitals exported.", kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Export failed.", kind: "error" });
    } finally {
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function importBundleAtomic(ev: React.ChangeEvent<HTMLInputElement>) {
    if (!db) return;
    const file = ev.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const gens: Generator[] = data.generators ?? [];
      const hosRaw: any[] = data.hospitals ?? [];
      const hos: Hospital[] = hosRaw.map((h: any) => ({ id: h.id, name: h.name, travel_minutes: h.travel_minutes ?? (h.distance_km != null ? minutesFromDistance(h.distance_km) : 0) }));
      const ords: Order[] = data.orders ?? [];
      const fut: Order[] = data.future_orders ?? [];

      await idbImportBundleAtomically(db, {
        generators: gens,
        hospitals: hos,
        orders: ords,
        future_orders: fut
      }, { clearFirst: true });

      // refresh state
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setHospitals(await idbGetAll<Hospital>(db, STORE_HOSPITALS));
      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));

      setToast({ msg: "Bundle imported atomically.", kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Atomic import failed.", kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Derived for display ----------
  const ordersWithCalcAll = useMemo(() => {
    return orders.map((o) => {
      const { required, eluteDt } = requiredAtElute_mCi(o);
      return { ...o, _requiredAtElute: required, _eluteDtObj: eluteDt } as any;
    });
  }, [orders]);

  // Filter by selected day + filters for Orders tab
  const ordersWithCalc = useMemo(() => {
    return ordersWithCalcAll
      .filter((o: any) => dateOnly(parseLocal(o.calibration_dt)) === selectedDate)
      .filter((o: any) => (ordersFilterHospitalId ? o.hospitalId === ordersFilterHospitalId : true))
      .filter((o: any) => (ordersFilterProduct ? o.product === ordersFilterProduct : true));
  }, [ordersWithCalcAll, selectedDate, ordersFilterHospitalId, ordersFilterProduct]);

  const ordersTable = useMemo(() => {
    const genById: Record<string, Generator> = Object.fromEntries(generators.map((g) => [g.id, g]));
    return ordersWithCalc.map((o: any) => {
      const hospitalName = hospitals.find((h) => h.id === o.hospitalId)?.name ?? o.hospitalId;
      const assigned = o.assignedGeneratorIds ?? [];
      const eluteDtObj: Date = o._eluteDtObj;
      const availableTotal = assigned.reduce((sum: number, gid: string) => {
        const g = genById[gid];
        if (!g) return sum;
        // Display availability using the current lock window for consistency
        const avail = availableAtElute_mCi(g, eluteDtObj, minLockMinutes).available;
        return sum + avail;
      }, 0);
      const deltaStr = (o.assigned_delta_minutes ?? []).map((m: number, idx: number) => `${assigned[idx]}: ${Math.round(m)} min`).join("; ");
      const assignedStr = assigned.join(", ");
      return {
        id: o.id,
        hospitalName,
        product: o.product,
        calibration: o.calibration_dt,
        elute: o._eluteDtObj,
        assignedStr,
        deltaStr,
        requestedAtCal: o.requested_mCi_at_cal,
        requiredAtElute: o._requiredAtElute,
        availableAtElute: availableTotal,
      };
    });
  }, [ordersWithCalc, hospitals, generators, minLockMinutes]);

  // ---------- Future Orders: add & simulate & promote ----------
  const [futureForm, setFutureForm] = useState<Partial<Order>>({
    id: "",
    hospitalId: "",
    product: "PSMA",
    requested_mCi_at_cal: undefined as any,
    calibration_dt: nowLocalISO(),
    prep_minutes: 15,
    travel_minutes: undefined as any,
  });

  function onFutureHospitalSelect(hid: string) {
    const hos = hospitals.find((h) => h.id === hid);
    setFutureForm((f) => ({ ...f, hospitalId: hid, travel_minutes: hos ? hos.travel_minutes : undefined as any }));
  }

  async function addFutureOrder() {
    if (!db) return;
    let id = (futureForm.id ?? "").trim();
    if (!id) id = genOrderIdDateBased(futureForm.hospitalId ?? undefined, futureForm.product ?? undefined);
    if (!futureForm.hospitalId) { alert("Select hospital"); return; }
    const payload: Order = {
      id,
      hospitalId: futureForm.hospitalId!,
      product: (futureForm.product as any) ?? "PSMA",
      requested_mCi_at_cal: Number(futureForm.requested_mCi_at_cal ?? 0),
      calibration_dt: futureForm.calibration_dt ?? nowLocalISO(),
      prep_minutes: Number(futureForm.prep_minutes ?? 15),
      travel_minutes: Number(futureForm.travel_minutes ?? 0),
    };
    setBusy(true);
    try {
      await idbPut(db, STORE_FUTURE_ORDERS, payload);
      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
      setFutureForm({ id: "", hospitalId: "", product: "PSMA", requested_mCi_at_cal: undefined as any, calibration_dt: nowLocalISO(), prep_minutes: 15, travel_minutes: undefined as any });
      setToast({ msg: `Future order ${id} saved.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Failed to add future order.", kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  const futureWithCalcAll = useMemo(() => {
    return futureOrders.map((o) => {
      const { required, eluteDt } = requiredAtElute_mCi(o);
      return { ...o, _requiredAtElute: required, _eluteDtObj: eluteDt } as any;
    });
  }, [futureOrders]);

  const futureForDate = useMemo(() => {
    return futureWithCalcAll.filter((o: any) => dateOnly(parseLocal(o.calibration_dt)) === futureSelectedDate);
  }, [futureWithCalcAll, futureSelectedDate]);

  const futureFeasibleById = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const fo of futureWithCalcAll as any[]) {
      map[fo.id] = canFulfillOrder(fo, orders, generators);
    }
    return map;
  }, [futureWithCalcAll, orders, generators]);

  async function promoteFutureOrderToToday(fOrder: Order) {
    if (!db) return;
    const existing = orders.some((o) => o.id === fOrder.id);
    const orderToSave: Order = { ...fOrder, id: existing ? genOrderIdDateBased(fOrder.hospitalId, fOrder.product) : fOrder.id };
    if (!canFulfillOrder(orderToSave, orders, generators)) { alert("This future order cannot be fulfilled today." ); return; }
    setBusy(true);
    try {
      await idbPut(db, STORE_ORDERS, orderToSave);
      const ordsNow = await idbGetAll<Order>(db, STORE_ORDERS);
      setOrders(ordsNow);
      const reassigned = runRescan(ordsNow, generators);
      const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
      await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);
      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setToast({ msg: `Future order added to today and assignments updated.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to add future order to today.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function promoteFutureOrderToDay(fOrder: Order, dayYYYYMMDD: string) {
    if (!db) return;
    const targetCalISO = setDatePreserveTime(fOrder.calibration_dt, dayYYYYMMDD);
    const existing = orders.some((o) => o.id === fOrder.id);
    const candidate: Order = { ...fOrder, id: existing ? genOrderIdDateBased(fOrder.hospitalId, fOrder.product) : fOrder.id, calibration_dt: targetCalISO };
    const can = canFulfillOrder(candidate, orders, generators);

    // Safe local diffDays
    const todayLocalMidnight = parseLocalDateYYYYMMDD(todayLocalDate());
    const targetDateLocal = parseLocalDateYYYYMMDD(dayYYYYMMDD);
    const diffDays = Math.floor((targetDateLocal.getTime() - todayLocalMidnight.getTime()) / (1000 * 60 * 60 * 24));

    if (!can && diffDays > 7) {
      const proceed = confirm(`Warning: This order does not meet criteria for ${dayYYYYMMDD} given current generators and lock window. Do you still want to add it?`);
      if (!proceed) return;
    } else if (!can) {
      alert("This future order cannot be fulfilled for the selected day given current generators and lock window.");
      return;
    }

    setBusy(true);
    try {
      await idbPut(db, STORE_ORDERS, candidate);
      const ordsNow = await idbGetAll<Order>(db, STORE_ORDERS);
      setOrders(ordsNow);
      const reassigned = runRescan(ordsNow, generators);
      const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
      await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);
      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setToast({ msg: `Future order promoted to ${dayYYYYMMDD}. Assignments updated.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Promotion failed.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  function simulateAutoAssignForDate(dayYYYYMMDD: string) {
    // Run simulation assignments for all future orders on selected date
    const futureOrdersOnDay = futureForDate.map((o: any) => ({ ...o } as Order));
    const sim = assignOrdersEfficientSim(futureOrdersOnDay, generators.map((g) => ({ ...g })), {
      minLockMinutes,
      respectLock: true,
      treatFirstUseMax: true,
      firstUseIgnoresLock: true, // default behavior per patch
    });
    setSimAutoAssignOrders(sim.orders);
    setSimAutoAssignMsgs(sim.messages);
    setToast({ msg: `Simulation complete for ${dayYYYYMMDD}.`, kind: "info" });
    setTimeout(() => setToast(null), 3500);
  }

  // ---------- Render ----------
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="max-w-6xl mx-auto p-4">
        <div className="flex gap-3 mb-4 items-center">
          <button className={`px-3 py-1 rounded-2xl ${page === "orders" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("orders")}>Orders</button>
          <button className={`px-3 py-1 rounded-2xl ${page === "future" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("future")}>Future Orders</button>
          <button className={`px-3 py-1 rounded-2xl ${page === "generators" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("generators")}>Generators</button>
          <button className={`px-3 py-1 rounded-2xl ${page === "hospitals" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("hospitals")}>Hospitals</button>

          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-sm text-slate-700">Min lock (min)</span>
              <input title="Minimum minutes between reusing the same generator" type="number" value={minLockMinutes} onChange={(e) => setMinLockMinutes(Number(e.target.value))} className="border rounded p-1 w-24" />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-sm text-slate-700">Day</span>
              <input title="Select day to view orders" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="border rounded p-1" />
            </label>
            <button disabled={busy} className={`px-3 py-1 rounded ${busy ? "bg-emerald-300 text-white" : "bg-emerald-600 text-white"}`} onClick={rescanAll}>{busy ? "Rescanning…" : "Rescan & Reassign"}</button>
            <button className="px-3 py-1 rounded bg-slate-700 text-white" onClick={exportBundle}>Export Bundle (Save As)</button>
            <label className="px-3 py-1 rounded bg-slate-200 text-black cursor-pointer">
              Import Bundle (Atomic)
              <input title="Import a full JSON bundle atomically" type="file" accept="application/json" className="hidden" onChange={importBundleAtomic} />
            </label>
          </div>
        </div>

        {toast && <Toast message={toast.msg} kind={toast.kind} />}

        {/* Orders tab */}
        {page === "orders" && (
          <div className="grid grid-cols-1 gap-4">
            <Section title="Orders (Filtered by selected day)">
              {/* ... (rest of Orders UI from previous version) ... */}
              {/* Omitted to keep this message concise. Use your previous improved Orders UI block here. */}
              {/* The rest of the file above contained full Orders table & filters. */}
            </Section>
          </div>
        )}

        {/* Future tab */}
        {page === "future" && (
          <div className="grid grid-cols-1 gap-4">
            {/* ... Use the previously provided Future UI with simulation, promotion, etc. ... */}
          </div>
        )}

        {/* Generators tab */}
        {page === "generators" && (
          <div className="grid grid-cols-1 gap-4">
            {/* ... Use the previously provided Generators UI ... */}
            <Section title="Generators">
              {/* (Same as prior improved Generators UI; omitted for brevity) */}
            </Section>
          </div>
        )}

        {/* Hospitals tab */}
        {page === "hospitals" && (
          <div className="grid grid-cols-1 gap-4">
            {/* ... Use the previously provided Hospitals UI ... */}
            <Section title="Hospitals">
              {/* (Same as prior improved Hospitals UI; omitted for brevity) */}
            </Section>
          </div>
        )}

        <div className="mt-6 text-center text-slate-500 text-sm">
          Ga‑68 Planner · Vite + Tailwind · IndexedDB local storage · One-click deploy
        </div>
      </div>
    </div>
  );
}

export default App;
