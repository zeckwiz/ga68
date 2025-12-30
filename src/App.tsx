
import React, { useEffect, useMemo, useState } from "react";

/**
 * Ga‑68 Planner — Single-file React app
 * (Upcoming shows LIVE+FUTURE, Future Save/Delete fixes, Promote to Live, Auto-Assign simulation, Short IDs)
 */

// ---------- Constants ----------
const HALF_LIFE_GA_MIN = 67.71;
const HALF_LIFE_GE_DAYS = 270.95;
const LN2 = Math.log(2);
const LAMBDA_GA = LN2 / HALF_LIFE_GA_MIN;
const LAMBDA_GE = LN2 / (HALF_LIFE_GE_DAYS * 24 * 60);

const SPEED_KMH = 60;
const minutesFromDistance = (km: number) => Math.max(0, Math.round((km / SPEED_KMH) * 60));

const DB_NAME = "Ga68Planner";
const DB_VERSION = 2;
const STORE_GENERATORS = "generators";
const STORE_HOSPITALS = "hospitals";
const STORE_ORDERS = "orders";
const STORE_FUTURE_ORDERS = "future_orders";

// ---------- IndexedDB ----------
function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Use `any` on event to avoid TS DOM lib mismatch in some setups
    req.onupgradeneeded = (event: any) => {
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

    req.onblocked = () => {
      alert("Database upgrade blocked by another tab/window. Close other tabs using Ga‑68 Planner and retry.");
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

// ---------- Types ----------
type Generator = {
  id: string;
  activity_mCi: number;
  efficiency_pct: number;
  calibration_dt: string; // "YYYY-MM-DDTHH:MM" local
  last_eluted_dt: string; // "YYYY-MM-DDTHH:MM" local
  total_eluted_today_mCi?: number;
  _wearDate?: string;
};

type Hospital = {
  id: string;
  name: string;
  travel_minutes: number;
};

type Order = {
  id: string;
  hospitalId: string;
  product: "PSMA" | "Dotatate" | "Research";
  requested_mCi_at_cal: number;
  calibration_dt: string; // "YYYY-MM-DDTHH:MM" local
  prep_minutes: number;
  travel_minutes: number;
  assignedGeneratorIds?: string[];
  assigned_elute_dt?: string;
  assigned_delta_minutes?: number[];
  notes?: string;
};

// ---------- Helpers ----------
function minutesBetween(a: Date, b: Date) {
  return (b.getTime() - a.getTime()) / 60000;
}

function parseLocalDateYYYYMMDD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

// ✅ FIXED parser: supports 'T' or space → YYYY-MM-DDTHH:MM and YYYY-MM-DD HH:MM
function parseLocalDateTimeYYYYMMDDTHHMM(s: string): Date {
  if (!s || typeof s !== "string") return new Date(NaN);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]);
    return new Date(y, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0, 0);
  }
  // Fallback: handles ISO with seconds/timezone but beware UTC parsing
  return new Date(s);
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
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
  const rnd = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `${prefix}-${stamp}-${rnd}`;
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
  const orig = parseLocalDateTimeYYYYMMDDTHHMM(origISO);
  const [y, m, d] = newDateYYYYMMDD.split("-").map(Number);
  const newDt = new Date(orig);
  newDt.setFullYear(y, (m ?? 1) - 1, d ?? 1);
  return formatLocal(newDt);
}

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

// Safe extract local date string
function localDateStringFromISO(isoLocal: string): string {
  return dateOnly(parseLocalDateTimeYYYYMMDDTHHMM(isoLocal));
}

// Short ID (display only)
function shortId(id: string, len: number = 6): string {
  const clean = (id ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (!clean) return id ?? "";
  return clean.length <= len ? clean : clean.slice(-len);
}

// ---------- Range helpers (restore) ----------
function addDays(yyyyMMDD: string, days: number): string {
  const d = parseLocalDateYYYYMMDD(yyyyMMDD);
  d.setDate(d.getDate() + days);
  return dateOnly(d);
}
function startOfWeekMonday(yyyyMMDD: string): string {
  const d = parseLocalDateYYYYMMDD(yyyyMMDD);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const offset = (dow + 6) % 7; // Monday=0
  return addDays(yyyyMMDD, -offset);
}
function inDateRange(dYYYYMMDD: string, startYYYYMMDD: string, endYYYYMMDD: string): boolean {
  return dYYYYMMDD >= startYYYYMMDD && dYYYYMMDD <= endYYYYMMDD;
}

// ---------- Save As helper (restore) ----------
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

// ---------- Wear normalization (restore) ----------
function normalizeDailyWear(gens: Generator[], dayYYYYMMDD: string): Generator[] {
  return gens.map((g) => {
    const anyG = g as Generator;
    if (anyG._wearDate !== dayYYYYMMDD) {
      return { ...g, total_eluted_today_mCi: 0, _wearDate: dayYYYYMMDD };
    }
    return g;
  });
}

// ---------- Confirmation text ----------
function buildOrderProcessedConfirmation(order: Order, hospitals: Hospital[]): string {
  const clientName = hospitals.find(h => h.id === order.hospitalId)?.name ?? order.hospitalId;
  const dt = parseLocalDateTimeYYYYMMDDTHHMM(order.calibration_dt);
  const timeStr = isNaN(dt.getTime()) ? "—" : formatTimeLocal(dt);
  const doseStr = Number(order.requested_mCi_at_cal ?? 0).toFixed(2);
  return `${doseStr} mCi dose with cal time of ${timeStr} for "${clientName}" has been processed.`;
}

// ---------- Expiry helpers ----------
function generatorExpiryDate(gen: Generator): Date {
  const cal = parseLocalDateTimeYYYYMMDDTHHMM(gen.calibration_dt);
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

// ---------- Physics ----------
function parentAtTime_mCi(gen: Generator, eluteDt: Date): number {
  const cal = parseLocalDateTimeYYYYMMDDTHHMM(gen.calibration_dt);
  const minutes = minutesBetween(cal, eluteDt);
  const A0 = gen.activity_mCi;
  return A0 * Math.exp(-LAMBDA_GE * minutes);
}
function availableAtElute_mCi(
  gen: Generator,
  eluteDt: Date,
  minLockMinutes: number
): { available: number; eligible: boolean; reason?: string; deltaSinceLastMin: number } {
  const last = parseLocalDateTimeYYYYMMDDTHHMM(gen.last_eluted_dt);
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
  const calDt = parseLocalDateTimeYYYYMMDDTHHMM(order.calibration_dt);
  const deltaMinutes = (order.prep_minutes ?? 15) + (order.travel_minutes ?? 0);
  const eluteDt = new Date(calDt.getTime() - deltaMinutes * 60000);
  const required = (order.requested_mCi_at_cal ?? 0) * Math.exp(LAMBDA_GA * deltaMinutes);
  return { required, eluteDt };
}

// ---------- Assignment policy ----------
function assignOrdersEfficient(
  orders: Order[],
  generators: Generator[],
  options: { minLockMinutes: number }
): { orders: Order[]; messages: string[] } {
  const msgs: string[] = [];
  const gens = generators.map((g) => ({ ...g }));
  const byId: Record<string, Generator> = Object.fromEntries(gens.map((g) => [g.id, g]));

  const sorted = [...orders].sort(
    (a, b) => parseLocalDateTimeYYYYMMDDTHHMM(a.calibration_dt).getTime() - parseLocalDateTimeYYYYMMDDTHHMM(b.calibration_dt).getTime()
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

// ---------- Simulation assignment ----------
function assignOrdersEfficientSim(
  orders: Order[],
  generators: Generator[],
  options: { minLockMinutes: number; respectLock: boolean; treatFirstUseMax: boolean; firstUseIgnoresLock?: boolean }
): { orders: Order[]; messages: string[] } {
  const msgs: string[] = [];
  const gens = generators.map((g) => ({ ...g }));
  const usedFirst: Set<string> = new Set();
  const ignoreLockOnFirst = options.firstUseIgnoresLock ?? true;

  const sorted = [...orders].sort(
    (a, b) => parseLocalDateTimeYYYYMMDDTHHMM(a.calibration_dt).getTime() - parseLocalDateTimeYYYYMMDDTHHMM(b.calibration_dt).getTime()
  );

  const resultOrders: Order[] = [];

  for (const ord of sorted) {
    const { required, eluteDt } = requiredAtElute_mCi(ord);

    const candidates = gens.map((g) => {
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
      let eligible = baseline.eligible || !options.respectLock;
      let deltaSinceLastMin = baseline.deltaSinceLastMin;

      if (options.treatFirstUseMax && !usedFirst.has(g.id)) {
        const parent = parentAtTime_mCi(g, eluteDt);
        const efficiency = (g.efficiency_pct ?? 60) / 100;
        available = parent * efficiency; // MAX at first use
        eligible = !isGeneratorExpired(g, eluteDt) && (ignoreLockOnFirst ? true : (options.respectLock ? baseline.eligible : true));
      }

      return {
        gen: g,
        available,
        eligible,
        reason: undefined,
        deltaSinceLastMin,
        efficiency: g.efficiency_pct ?? 60,
        parentAtElute: parentAtTime_mCi(g, eluteDt),
        wear: g.total_eluted_today_mCi ?? 0,
      };
    });

    const eligible = candidates.filter((c) => c.eligible);

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
      msgs.push(`Sim ${ord.id}: assigned ${assigned.join(", ")} at ${oCopy.assigned_elute_dt}`);
      usedFirst.add(assigned[0]);
      if (assigned.length === 2) usedFirst.add(assigned[1]);
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

// ---------- UI primitives ----------
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
  const dt = parseLocalDateTimeYYYYMMDDTHHMM(iso);
  return isNaN(dt.getTime())
    ? <div className="text-xs text-red-600">Invalid datetime</div>
    : <div className="text-xs text-slate-500">Preview: {formatDateTimeFriendly(dt)}</div>;
}
function Toast({ message, kind }: { message: string; kind: "info" | "success" | "error" }) {
  const color =
    kind === "success" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    kind === "error" ? "bg-red-50 text-red-700 border-red-200" :
    "bg-slate-50 text-slate-700 border-slate-200";
  return <div className={`p-2 rounded border ${color}`}>{message}</div>;
}

// ---------- App ----------
function App() {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [page, setPage] = useState<"orders" | "upcoming" | "future" | "generators" | "hospitals">("orders");

  const [generators, setGenerators] = useState<Generator[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [futureOrders, setFutureOrders] = useState<Order[]>([]);

  const [minLockMinutes, setMinLockMinutes] = useState<number>(20);
  const [selectedDate, setSelectedDate] = useState<string>(todayLocalDate());

  const [busy, setBusy] = useState<boolean>(false);
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "success" | "error" } | null>(null);

  const [ordersFilterHospitalId, setOrdersFilterHospitalId] = useState<string>("");
  const [ordersFilterProduct, setOrdersFilterProduct] = useState<"" | "PSMA" | "Dotatate" | "Research">("");

  // Upcoming
  const [upcomingAnchorDate, setUpcomingAnchorDate] = useState<string>(todayLocalDate());
  const upcomingWeekStart = useMemo(() => startOfWeekMonday(upcomingAnchorDate), [upcomingAnchorDate]);
  const upcomingDays = useMemo(() => Array.from({ length: 5 }, (_, i) => addDays(upcomingWeekStart, i)), [upcomingWeekStart]);
  const [upcomingActiveIdx, setUpcomingActiveIdx] = useState<number>(0);

  // Future Vault edit states
  const [editingFutureId, setEditingFutureId] = useState<string | null>(null);
  const [futureEditFormById, setFutureEditFormById] = useState<Record<string, Partial<Order>>>({});

  // Future auto-assign controls & messages
  const [futureSimSelectedDate, setFutureSimSelectedDate] = useState<string>(todayLocalDate());
  const [simFutureMsgs, setSimFutureMsgs] = useState<string[]>([]);

  // Promotion date picker (for "Promote to…")
  const [promoteTargetDate, setPromoteTargetDate] = useState<string>(todayLocalDate());

  // Load DB
  useEffect(() => {
    let closed = false;

    (async () => {
      if ("storage" in navigator && "persist" in (navigator as any).storage) {
        try { await (navigator as any).storage.persist(); } catch {}
      }
    })();

    openDB().then(async (database) => {
      setDb(database);
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

    return () => { closed = true; };
  }, []);

  // ---------- Generators Tab ----------
  const [genForm, setGenForm] = useState<Partial<Generator>>({
    id: "",
    activity_mCi: 50,
    efficiency_pct: 60,
    calibration_dt: nowLocalISO(),
    last_eluted_dt: nowLocalISO(),
  });

  function validateGeneratorPayload(p: Generator): string | null {
    if (!p.id?.trim()) return "Generator ID is required.";
    if (!Number.isFinite(p.activity_mCi) || p.activity_mCi <= 0) return "Activity must be > 0.";
    const eff = Number(p.efficiency_pct ?? 60);
    if (!Number.isFinite(eff) || eff < 0 || eff > 100) return "Efficiency must be between 0 and 100.";
    return null;
  }

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
    const err = validateGeneratorPayload(payload);
    if (err) { alert(err); return; }

    setBusy(true);
    try {
      await idbPut(db, STORE_GENERATORS, payload);
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setGenForm({ ...genForm, id: "" });
      setToast({ msg: `Generator ${shortId(id)} saved.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to save generator ${shortId(id)}.`, kind: "error" });
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
      setToast({ msg: `Generator ${shortId(id)} deleted.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to delete generator ${shortId(id)}.`, kind: "error" });
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
      setToast({ msg: `Hospital "${payload.name}" (${shortId(payload.id)}) saved.`, kind: "success" });
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
      setToast({ msg: `Hospital "${h?.name ?? id}" (${shortId(id)}) deleted.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to delete hospital.`, kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Orders Tab (Entry) ----------
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
      formatLocal(parseLocalDateTimeYYYYMMDDTHHMM(o.calibration_dt)) === formatLocal(parseLocalDateTimeYYYYMMDDTHHMM(candidate.calibration_dt))
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

  function validateOrderPayload(p: Order): string | null {
    if (!p.hospitalId) return "Select hospital.";
    if (!["PSMA", "Dotatate", "Research"].includes(p.product)) return "Invalid product.";
    if (!Number.isFinite(p.requested_mCi_at_cal) || p.requested_mCi_at_cal <= 0) return "Requested mCi must be > 0.";
    if (!Number.isFinite(p.prep_minutes) || p.prep_minutes < 0) return "Prep minutes must be ≥ 0.";
    if (!Number.isFinite(p.travel_minutes) || p.travel_minutes < 0) return "Travel minutes must be ≥ 0.";
    return null;
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
    const err = validateOrderPayload(payload);
    if (err) { alert(err); return; }

    const dup = isPotentialDuplicateOrder(payload, orders);
    if (dup.idExists || dup.sameByFields) {
      const proceed = confirm(`Potential duplicate order${dup.idExists ? " (same ID)" : ""}${dup.sameByFields ? " (same hospital/product/time)" : ""}. Continue?`);
      if (!proceed) return;
    }

    const calDateStr = localDateStringFromISO(payload.calibration_dt);
    const todayStr = todayLocalDate();

    if (calDateStr === todayStr) {
      if (!canFulfillOrder(payload, orders, generators)) {
        alert("This order cannot be fulfilled today given current generators and lock window.");
        return;
      }
      setBusy(true);
      try {
        await idbPut(db, STORE_ORDERS, payload);
        const ordsNow = await idbGetAll<Order>(db, STORE_ORDERS);
        setOrders(ordsNow);

        const reassigned = runRescan(ordsNow, generators);
        const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
        await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);

        setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
        setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
        clearOrderForm();

        setToast({ msg: buildOrderProcessedConfirmation(payload, hospitals), kind: "success" });
      } catch (e) {
        console.error(e);
        setToast({ msg: `Failed to save order.`, kind: "error" });
      } finally {
        setBusy(false);
        setTimeout(() => setToast(null), 3500);
      }
    } else {
      const feasible = canFulfillOrder(payload, orders, generators);
      if (!feasible) {
        const proceed = confirm(`Warning: Generators are not feasible for ${calDateStr} given current lock window.\nSave to Future Orders anyway?`);
        if (!proceed) return;
      }
      setBusy(true);
      try {
        await idbPut(db, STORE_FUTURE_ORDERS, payload);
        setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
        clearOrderForm();
        setToast({ msg: `Saved to Future Orders vault for ${calDateStr}.`, kind: "success" });
      } catch (e) {
        console.error(e);
        setToast({ msg: `Failed to save to Future Orders.`, kind: "error" });
      } finally {
        setBusy(false);
        setTimeout(() => setToast(null), 3500);
      }
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
      setToast({ msg: `Order ${shortId(id)} deleted and assignments updated.`, kind: "success" });
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

  // ---------- Bundle Import/Export ----------
  async function exportBundle() {
    const payload = { generators, hospitals, orders, future_orders: futureOrders, meta: { exportedAt: new Date().toISOString(), minLockMinutes, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
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

  async function importBundle(ev: React.ChangeEvent<HTMLInputElement>) {
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

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_GENERATORS, STORE_HOSPITALS, STORE_ORDERS, STORE_FUTURE_ORDERS], "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as any);
        tx.onabort = () => reject(tx.error as any);
        const stG = tx.objectStore(STORE_GENERATORS);
        const stH = tx.objectStore(STORE_HOSPITALS);
        const stO = tx.objectStore(STORE_ORDERS);
        const stF = tx.objectStore(STORE_FUTURE_ORDERS);
        gens.forEach(v => stG.put(v as any));
        hos.forEach(v => stH.put(v as any));
        ords.forEach(v => stO.put(v as any));
        fut.forEach(v => stF.put(v as any));
      });

      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
      setHospitals(await idbGetAll<Hospital>(db, STORE_HOSPITALS));
      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
      setToast({ msg: "Bundle imported.", kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Import failed.", kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Derived (LIVE + FUTURE) ----------
  const ordersWithCalcAll = useMemo(() => {
    return orders.map((o) => {
      const { required, eluteDt } = requiredAtElute_mCi(o);
      return { ...o, _requiredAtElute: required, _eluteDtObj: eluteDt } as any;
    });
  }, [orders]);

  const futureOrdersWithCalcAll = useMemo(() => {
    return futureOrders.map((o) => {
      const { required, eluteDt } = requiredAtElute_mCi(o);
      return { ...o, _requiredAtElute: required, _eluteDtObj: eluteDt } as any;
    });
  }, [futureOrders]);

  const ordersWithCalc = useMemo(() => {
    return ordersWithCalcAll
      .filter((o: any) => localDateStringFromISO(o.calibration_dt) === selectedDate)
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

  // Upcoming (LIVE + FUTURE)
  const upcomingDayOrders = useMemo(() => {
    const byDay: Record<string, any[]> = {};
    upcomingDays.forEach(d => { byDay[d] = []; });

    ordersWithCalcAll.forEach((o: any) => {
      const d = localDateStringFromISO(o.calibration_dt);
      if (byDay[d]) byDay[d].push(o);
    });
    futureOrdersWithCalcAll.forEach((o: any) => {
      const d = localDateStringFromISO(o.calibration_dt);
      if (byDay[d]) byDay[d].push(o);
    });

    Object.keys(byDay).forEach(day => {
      byDay[day].sort((a, b) =>
        parseLocalDateTimeYYYYMMDDTHHMM(a.calibration_dt).getTime() -
        parseLocalDateTimeYYYYMMDDTHHMM(b.calibration_dt).getTime()
      );
    });

    return byDay;
  }, [ordersWithCalcAll, futureOrdersWithCalcAll, upcomingDays]);

  // ---------- Future: update & delete ----------
  function validateFutureOrderPayload(p: Order): string | null {
    if (!p.hospitalId) return "Select hospital.";
    if (!["PSMA", "Dotatate", "Research"].includes(p.product)) return "Invalid product.";
    if (!p.calibration_dt) return "Calibration date/time is required.";
    if (!Number.isFinite(p.requested_mCi_at_cal) || p.requested_mCi_at_cal <= 0) return "Requested mCi must be > 0.";
    if (!Number.isFinite(p.prep_minutes) || p.prep_minutes < 0) return "Prep minutes must be ≥ 0.";
    if (!Number.isFinite(p.travel_minutes) || p.travel_minutes < 0) return "Travel minutes must be ≥ 0.";
    return null;
  }

  async function updateFutureOrder(updated: Order) {
    if (!db) return;
    const id = (updated.id ?? "").trim();
    const final: Order = { ...updated };

    if (!id) {
      final.id = genId("F"); // auto ID for missing imports
    }

    // Defaults
    final.calibration_dt = final.calibration_dt ?? nowLocalISO();
    final.prep_minutes = Number(final.prep_minutes ?? 15);
    final.travel_minutes = Number(final.travel_minutes ?? 0);
    final.requested_mCi_at_cal = Number(final.requested_mCi_at_cal ?? 0);

    const err = validateFutureOrderPayload(final);
    if (err) { setToast({ msg: `Cannot save: ${err}`, kind: "error" }); setTimeout(() => setToast(null), 3500); return; }

    try {
      await idbPut(db, STORE_FUTURE_ORDERS, final);
      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
      setToast({ msg: `Future order ${shortId(final.id)} saved.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to update future order.`, kind: "error" });
    } finally {
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function deleteFutureOrder(id: string) {
    if (!db) return;
    const cleanId = (id ?? "").trim();
    if (!cleanId) { setToast({ msg: "Cannot delete: missing ID.", kind: "error" }); setTimeout(() => setToast(null), 3500); return; }
    const proceed = confirm(`Delete future order ${cleanId}?`);
    if (!proceed) return;
    try {
      await idbDelete(db, STORE_FUTURE_ORDERS, cleanId);
      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
      setToast({ msg: `Future order ${shortId(cleanId)} deleted.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: `Failed to delete future order.`, kind: "error" });
    } finally {
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Future → Live promotion ----------
  function toLivePayload(src: Order, overrideDate?: string): Order {
    const cal = overrideDate ? setDatePreserveTime(src.calibration_dt, overrideDate) : src.calibration_dt;
    return {
      id: genOrderIdDateBased(src.hospitalId, src.product), // new live order ID
      hospitalId: src.hospitalId,
      product: src.product,
      requested_mCi_at_cal: Number(src.requested_mCi_at_cal ?? 0),
      calibration_dt: cal,
      prep_minutes: Number(src.prep_minutes ?? 15),
      travel_minutes: Number(src.travel_minutes ?? 0),
    };
  }

  async function promoteFutureKeepDate(fOrder: Order) {
    if (!db) return;
    const payload = toLivePayload(fOrder);
    const err = validateOrderPayload(payload);
    if (err) { setToast({ msg: `Cannot promote: ${err}`, kind: "error" }); setTimeout(() => setToast(null), 3500); return; }

    const calDateStr = localDateStringFromISO(payload.calibration_dt);
    const feasible = canFulfillOrder(payload, orders, generators);
    if (!feasible) {
      const proceed = confirm(`Warning: Generators may not be feasible for ${calDateStr}. Promote anyway?`);
      if (!proceed) return;
    }

    setBusy(true);
    try {
      await idbPut(db, STORE_ORDERS, payload);
      await idbDelete(db, STORE_FUTURE_ORDERS, fOrder.id); // remove from future
      const ordsNow = await idbGetAll<Order>(db, STORE_ORDERS);
      setOrders(ordsNow);
      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));

      // Rescan
      const reassigned = runRescan(ordsNow, generators);
      const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
      await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);

      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));

      setToast({ msg: buildOrderProcessedConfirmation(payload, hospitals), kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Failed to promote order.", kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function promoteFutureToToday(fOrder: Order) {
    await promoteFutureToDay(fOrder, todayLocalDate());
  }

  async function promoteFutureToDay(fOrder: Order, dayYYYYMMDD: string) {
    if (!db) return;
    const payload = toLivePayload(fOrder, dayYYYYMMDD);
    const err = validateOrderPayload(payload);
    if (err) { setToast({ msg: `Cannot promote: ${err}`, kind: "error" }); setTimeout(() => setToast(null), 3500); return; }

    const feasible = canFulfillOrder(payload, orders, generators);
    if (!feasible) {
      const proceed = confirm(`Warning: Generators may not be feasible for ${dayYYYYMMDD}. Promote anyway?`);
      if (!proceed) return;
    }

    setBusy(true);
    try {
      await idbPut(db, STORE_ORDERS, payload);
      await idbDelete(db, STORE_FUTURE_ORDERS, fOrder.id);
      const ordsNow = await idbGetAll<Order>(db, STORE_ORDERS);
      setOrders(ordsNow);
      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));

      const reassigned = runRescan(ordsNow, generators);
      const updatedGens = generators.map((g) => reassigned.updatedById[g.id] ?? g);
      await idbWriteRescanAtomically(db, reassigned.orders, updatedGens);

      setOrders(await idbGetAll<Order>(db, STORE_ORDERS));
      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));

      setToast({ msg: buildOrderProcessedConfirmation(payload, hospitals), kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Failed to promote order.", kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Future auto-assign (restore) ----------
  async function simulateAutoAssignFuture(dayYYYYMMDD?: string) {
    if (!db) return;
    setBusy(true);
    try {
      const target = dayYYYYMMDD
        ? futureOrders.filter(o => localDateStringFromISO(o.calibration_dt) === dayYYYYMMDD)
        : futureOrders;

      if (target.length === 0) {
        setToast({ msg: dayYYYYMMDD ? `No future orders on ${dayYYYYMMDD}.` : "No future orders to simulate.", kind: "info" });
        setSimFutureMsgs([]);
        return;
      }

      const sim = assignOrdersEfficientSim(
        target.map(o => ({ ...o })),           // copy future orders for sim
        generators.map(g => ({ ...g })),       // copy generators for sim-only
        { minLockMinutes, respectLock: true, treatFirstUseMax: true, firstUseIgnoresLock: true }
      );

      // Write back simulated assignments to future_orders store
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_FUTURE_ORDERS], "readwrite");
        const st = tx.objectStore(STORE_FUTURE_ORDERS);
        sim.orders.forEach(o => st.put(o as any));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as any);
      });

      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
      setSimFutureMsgs(sim.messages);
      setToast({ msg: `Auto assignment ${dayYYYYMMDD ? `for ${dayYYYYMMDD}` : "for all future orders"} completed.`, kind: "info" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Future auto-assign failed.", kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  async function clearFutureAssignments(dayYYYYMMDD?: string) {
    if (!db) return;
    setBusy(true);
    try {
      const target = dayYYYYMMDD
        ? futureOrders.filter(o => localDateStringFromISO(o.calibration_dt) === dayYYYYMMDD)
        : futureOrders;

      if (target.length === 0) {
        setToast({ msg: dayYYYYMMDD ? `No future orders on ${dayYYYYMMDD} to clear.` : "No future orders to clear.", kind: "info" });
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_FUTURE_ORDERS], "readwrite");
        const st = tx.objectStore(STORE_FUTURE_ORDERS);
        target.forEach(o => {
          const cleared: Order = {
            ...o,
            assignedGeneratorIds: [],
            assigned_delta_minutes: [],
            assigned_elute_dt: undefined,
            notes: undefined,
          };
          st.put(cleared as any);
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as any);
      });

      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
      setSimFutureMsgs([]);
      setToast({ msg: `Cleared assignments ${dayYYYYMMDD ? `for ${dayYYYYMMDD}` : "for all future orders"}.`, kind: "success" });
    } catch (e) {
      console.error(e);
      setToast({ msg: "Failed to clear future assignments.", kind: "error" });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  // ---------- Export helpers (live orders only) ----------
  function ordersToCSV(rows: {
    id: string; hospitalName: string; product: string; calibration: string;
    elute: Date; assignedStr: string; deltaStr: string;
    requestedAtCal: number; requiredAtElute: number; availableAtElute: number;
  }[]) {
    const header = [
      "Order ID","Hospital","Product","Calibration (local)","Elute (local)",
      "Assigned Generators","Δt since last elution","Requested @ cal (mCi)",
      "Required @ elute (mCi)","Available @ elute (mCi)"
    ];
    const body = rows.map(r => [
      shortId(r.id),
      r.hospitalName,
      r.product,
      formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(r.calibration)),
      formatDateTimeFriendly(r.elute),
      r.assignedStr || "",
      r.deltaStr || "",
      Number(r.requestedAtCal ?? 0).toFixed(2),
      Number(r.requiredAtElute ?? 0).toFixed(2),
      Number(r.availableAtElute ?? 0).toFixed(2)
    ]);
    return [header, ...body].map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  }

  async function exportOrdersRangeJSON(startYYYYMMDD: string, endYYYYMMDD: string) {
    const filtered = ordersWithCalcAll.filter((o: any) => {
      const d = localDateStringFromISO(o.calibration_dt);
      return inDateRange(d, startYYYYMMDD, endYYYYMMDD);
    });
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    await saveBlobWithPicker(`orders_${startYYYYMMDD}_to_${endYYYYMMDD}`, blob, {
      description: "Orders (range)",
      mime: "application/json",
      ext: ".json"
    });
    setToast({ msg: `Exported ${filtered.length} order(s) to JSON.`, kind: "success" });
    setTimeout(() => setToast(null), 3500);
  }

  async function exportOrdersRangeCSV(startYYYYMMDD: string, endYYYYMMDD: string) {
    const genById: Record<string, Generator> = Object.fromEntries(generators.map(g => [g.id, g]));
    const filteredTableRows = ordersWithCalcAll
      .filter((o: any) => inDateRange(localDateStringFromISO(o.calibration_dt), startYYYYMMDD, endYYYYMMDD))
      .map((o: any) => {
        const hospitalName = hospitals.find(h => h.id === o.hospitalId)?.name ?? o.hospitalId;
        const assigned = o.assignedGeneratorIds ?? [];
        const eluteDtObj: Date = o._eluteDtObj;
        const availableTotal = assigned.reduce((sum: number, gid: string) => {
          const g = genById[gid];
          if (!g) return sum;
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

    const csv = ordersToCSV(filteredTableRows);
    const blob = new Blob([csv], { type: "text/csv" });
    await saveBlobWithPicker(`orders_${startYYYYMMDD}_to_${endYYYYMMDD}`, blob, {
      description: "Orders (range CSV)",
      mime: "text/csv",
      ext: ".csv"
    });
    setToast({ msg: `Exported ${filteredTableRows.length} order(s) to CSV.`, kind: "success" });
    setTimeout(() => setToast(null), 3500);
  }

  function exportOrdersRangePDF(startYYYYMMDD: string, endYYYYMMDD: string) {
    const filtered = ordersWithCalcAll.filter((o: any) => {
      const d = localDateStringFromISO(o.calibration_dt);
      return inDateRange(d, startYYYYMMDD, endYYYYMMDD);
    });

    const genById: Record<string, Generator> = Object.fromEntries(generators.map(g => [g.id, g]));
    const htmlRows = filtered.map((o: any) => {
      const hospitalName = hospitals.find(h => h.id === o.hospitalId)?.name ?? o.hospitalId;
      const assigned = o.assignedGeneratorIds ?? [];
      const eluteStr = formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(o.assigned_elute_dt ?? o.calibration_dt));
      const availableTotal = assigned.reduce((sum: number, gid: string) => {
        const g = genById[gid];
        if (!g) return sum;
        const eluteDtObj = parseLocalDateTimeYYYYMMDDTHHMM(o.assigned_elute_dt ?? o.calibration_dt);
        const avail = availableAtElute_mCi(g, eluteDtObj, minLockMinutes).available;
        return sum + avail;
      }, 0);
      const deltaStr = (o.assigned_delta_minutes ?? []).map((m: number, idx: number) => `${assigned[idx]}: ${Math.round(m)} min`).join("; ");
      return `
        <tr>
          <td>${shortId(o.id)}</td>
          <td>${hospitalName}</td>
          <td>${o.product}</td>
          <td>${formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(o.calibration_dt))}</td>
          <td>${eluteStr}</td>
          <td>${assigned.join(", ") || "—"}</td>
          <td>${deltaStr || "—"}</td>
          <td>${(o.requested_mCi_at_cal ?? 0).toFixed?.(2) ?? o.requested_mCi_at_cal ?? "—"}</td>
          <td>${(o._requiredAtElute ?? 0).toFixed?.(2) ?? o._requiredAtElute ?? "—"}</td>
          <td>${availableTotal ? availableTotal.toFixed(2) : "—"}</td>
        </tr>`;
    }).join("");

    const w = window.open("", "_blank");
    if (!w) { alert("Popup blocked. Allow popups to export PDF."); return; }
    w.document.write(`
      <html>
        <head>
          <title>Orders ${startYYYYMMDD} → ${endYYYYMMDD}</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 16px; }
            h1 { font-size: 18px; margin-bottom: 8px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #999; padding: 6px; font-size: 12px; }
            thead { background: #eee; }
            @media print {
              body { padding: 0; }
              a.print-hide, button.print-hide { display: none; }
            }
          </style>
        </head>
        <body>
          <h1>Orders ${startYYYYMMDD} → ${endYYYYMMDD}</h1>
          <table>
            <thead>
              <tr>
                <th>Order ID</th><th>Hospital</th><th>Product</th>
                <th>Calibration</th><th>Elute</th><th>Assigned</th>
                <th>Δt since last</th><th>Req @ cal (mCi)</th>
                <th>Req @ elute (mCi)</th><th>Avail @ elute (mCi)</th>
              </tr>
            </thead>
            <tbody>
              ${htmlRows || `<tr><td colspan="10">No orders in range.</td></tr>`}
            </tbody>
          </table>
          <div style="margin-top:12px;">
            <button class="print-hide" onclick="window.print()">Print / Save as PDF</button>
          </div>
        </body>
      </html>
    `);
    w.document.close();
    w.focus();
  }

  // ---------- Render ----------
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="max-w-6xl mx-auto p-4">
        {/* Nav */}
        <div className="flex gap-3 mb-4 items-center">
          <button className={`px-3 py-1 rounded-2xl ${page === "orders" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("orders")}>Orders (Today)</button>
          <button className={`px-3 py-1 rounded-2xl ${page === "upcoming" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("upcoming")}>Upcoming (Mon–Fri)</button>
          <button className={`px-3 py-1 rounded-2xl ${page === "future" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("future")}>Future Orders Vault</button>
          <button className={`px-3 py-1 rounded-2xl ${page === "generators" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("generators")}>Generators</button>
          <button className={`px-3 py-1 rounded-2xl ${page === "hospitals" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setPage("hospitals")}>Hospitals</button>

          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-sm text-slate-700">Min lock (min)</span>
              <input title="Minimum minutes between reusing the same generator" type="number" value={minLockMinutes} onChange={(e) => setMinLockMinutes(Number(e.target.value))} className="border rounded p-1 w-24" />
            </label>
            <button disabled={busy} className={`px-3 py-1 rounded ${busy ? "bg-emerald-300 text-white" : "bg-emerald-600 text-white"}`} onClick={rescanAll}>{busy ? "Rescanning…" : "Rescan & Reassign"}</button>
            <button className="px-3 py-1 rounded bg-slate-700 text-white" onClick={exportBundle}>Export Bundle (Save As)</button>
            <label className="px-3 py-1 rounded bg-slate-200 text-black cursor-pointer">
              Import Bundle
              <input title="Import a full JSON bundle" type="file" accept="application/json" className="hidden" onChange={importBundle} />
            </label>
          </div>
        </div>

        {toast && <Toast message={toast.msg} kind={toast.kind} />}

        {/* Orders (today) */}
        {page === "orders" && (
          <div className="grid grid-cols-1 gap-4">
            <Section title="Enter Orders (today only)">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Field label="Order ID (optional; auto if blank)">
                  <input title="Optional custom Order ID; will autogenerate (date-based) if blank" className="border p-2 rounded" placeholder="Auto (optional)" value={orderForm.id ?? ""} onChange={(e) => setOrderForm({ ...orderForm, id: e.target.value })} />
                </Field>
                <Field label="Hospital">
                  <select title="Select hospital for this order" className="border p-2 rounded" value={orderForm.hospitalId ?? ""} onChange={(e) => onHospitalSelect(e.target.value)}>
                    <option value="">Select hospital</option>
                    {hospitals.map((h) => (
                      <option key={h.id} value={h.id}>{h.name} — {h.travel_minutes} min</option>
                    ))}
                  </select>
                </Field>
                <Field label="Product">
                  <select title="Select product type" className="border p-2 rounded" value={orderForm.product ?? "PSMA"} onChange={(e) => setOrderForm({ ...orderForm, product: e.target.value as any })}>
                    <option value="PSMA">PSMA</option>
                    <option value="Dotatate">Dotatate</option>
                    <option value="Research">Research</option>
                  </select>
                </Field>
                <Field label="Requested mCi @ calibration">
                  <input title="Requested activity at hospital's calibration time" type="number" className="border p-2 rounded" placeholder="e.g., 5" value={orderForm.requested_mCi_at_cal ?? ""} onChange={(e) => setOrderForm({ ...orderForm, requested_mCi_at_cal: Number(e.target.value) })} />
                </Field>
                <Field label="Calibration date/time">
                  <input title="Hospital calibration date & time (local)" type="datetime-local" className="border p-2 rounded" value={orderForm.calibration_dt ?? nowLocalISO()} onChange={(e) => setOrderForm({ ...orderForm, calibration_dt: e.target.value })} />
                  <PreviewDateTime iso={orderForm.calibration_dt} />
                </Field>
                <Field label="Prep minutes">
                  <input title="Preparation time in minutes" type="number" className="border p-2 rounded" placeholder="e.g., 15" value={orderForm.prep_minutes ?? ""} onChange={(e) => setOrderForm({ ...orderForm, prep_minutes: Number(e.target.value) })} />
                </Field>
                <Field label="Travel minutes (auto from hospital)">
                  <input title="Travel time in minutes (auto-filled from hospital)" type="number" className="border p-2 rounded" placeholder="e.g., 30" value={orderForm.travel_minutes ?? ""} onChange={(e) => setOrderForm({ ...orderForm, travel_minutes: Number(e.target.value) })} />
                </Field>
                <div className="flex items-end gap-2">
                  <button disabled={busy} className={`w-full md:w-auto px-3 py-2 rounded ${busy ? "bg-blue-300 text-white" : "bg-blue-600 text-white"}`} onClick={saveOrder}>{editingOrderId ? (busy ? "Saving…" : "Save Changes") : (busy ? "Adding…" : "Add Order")}</button>
                  <button className="w-full md:w-auto px-3 py-2 rounded bg-slate-200 text-slate-800" onClick={clearOrderForm}>Clear</button>
                </div>
              </div>
            </Section>

            <Section title="Orders (Filtered by day selector below)">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2">
                  <span className="text-sm text-slate-700">Day</span>
                  <input title="Select day to view orders" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="border rounded p-1" />
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-sm">Hospital</span>
                  <select className="border p-1 rounded" value={ordersFilterHospitalId} onChange={(e) => setOrdersFilterHospitalId(e.target.value)}>
                    <option value="">All</option>
                    {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-sm">Product</span>
                  <select className="border p-1 rounded" value={ordersFilterProduct} onChange={(e) => setOrdersFilterProduct(e.target.value as any)}>
                    <option value="">All</option>
                    <option value="PSMA">PSMA</option>
                    <option value="Dotatate">Dotatate</option>
                    <option value="Research">Research</option>
                  </select>
                </label>
                <button className="px-2 py-1 rounded bg-slate-200" onClick={() => { setOrdersFilterHospitalId(""); setOrdersFilterProduct(""); }}>Clear Filters</button>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full border rounded-lg overflow-hidden">
                  <thead className="bg-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left">Hospital</th>
                      <th className="px-3 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-left">Calibration</th>
                      <th className="px-3 py-2 text-left">Elution (time)</th>
                      <th className="px-3 py-2 text-left">Assigned generators</th>
                      <th className="px-3 py-2 text-left">Time since last elution</th>
                      <th className="px-3 py-2 text-left">Requested (mCi)</th>
                      <th className="px-3 py-2 text-left">Available / Required @ elute (mCi)</th>
                      <th className="px-3 py-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white">
                    {ordersTable.length === 0 && (
                      <tr>
                        <td className="px-3 py-3 text-slate-500" colSpan={9}>No orders for {selectedDate} {ordersFilterHospitalId ? `— ${hospitals.find(h => h.id === ordersFilterHospitalId)?.name}` : ""} {ordersFilterProduct ? `— ${ordersFilterProduct}` : ""}.</td>
                      </tr>
                    )}
                    {ordersTable.map((row) => (
                      <tr key={row.id} className="border-t">
                        <td className="px-3 py-2">
                          <span title={`Hospital ID: ${row.hospitalName}`}>{row.hospitalName}</span>
                        </td>
                        <td className="px-3 py-2">{row.product}</td>
                        <td className="px-3 py-2">{formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(row.calibration))}</td>
                        <td className="px-3 py-2 font-semibold">{formatTimeLocal(row.elute)}</td>
                        <td className="px-3 py-2 font-semibold">{row.assignedStr || "—"}</td>
                        <td className="px-3 py-2">{row.deltaStr || "—"}</td>
                        <td className="px-3 py-2">{row.requestedAtCal > 0 ? Number(row.requestedAtCal).toFixed(2) : "—"}</td>
                        <td className="px-3 py-2">{row.availableAtElute > 0 ? Number(row.availableAtElute).toFixed(2) : "—"} {row.requiredAtElute > 0 ? `| req ${Number(row.requiredAtElute).toFixed(2)}` : ""}</td>
                        <td className="px-3 py-2">
                          <div className="flex gap-2">
                            <button className="px-2 py-1 rounded bg-amber-600 text-white" onClick={() => { const o = orders.find((oo) => oo.id === row.id); if (o) onEditOrder(o); }}>Edit</button>
                            <button className="px-2 py-1 rounded bg-red-600 text-white" onClick={() => deleteOrder(row.id)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        )}

        {/* Upcoming Mon–Fri (LIVE + FUTURE) */}
        {page === "upcoming" && (
          <div className="grid grid-cols-1 gap-4">
            <Section title="Upcoming Week (Mon–Fri)">
              <div className="flex flex-wrap gap-3 mb-3 items-center">
                <label className="flex items-center gap-2">
                  <span className="text-sm">Week of</span>
                  <input type="date" className="border rounded p-1"
                    value={upcomingAnchorDate}
                    onChange={(e) => {
                      setUpcomingAnchorDate(e.target.value);
                      setUpcomingActiveIdx(0);
                    }} />
                </label>

                <div className="flex gap-2">
                  {upcomingDays.map((d, idx) => {
                    const count = (upcomingDayOrders[d] ?? []).length;
                    return (
                      <button key={d}
                        className={`px-3 py-1 rounded-2xl ${idx === upcomingActiveIdx ? "bg-blue-600 text-white" : "bg-slate-200"}`}
                        onClick={() => setUpcomingActiveIdx(idx)}
                        title={`${count} order(s)`}>
                        {["Mon","Tue","Wed","Thu","Fri"][idx]} {d} {count > 0 ? `(${count})` : ""}
                      </button>
                    );
                  })}
                </div>

                {/* Export (live only) */}
                <button className="px-3 py-1 rounded bg-slate-700 text-white"
                  onClick={() => exportOrdersRangeJSON(upcomingDays[upcomingActiveIdx], upcomingDays[upcomingActiveIdx])}>
                  Export Day JSON
                </button>
                <button className="px-3 py-1 rounded bg-slate-700 text-white"
                  onClick={() => exportOrdersRangeCSV(upcomingDays[upcomingActiveIdx], upcomingDays[upcomingActiveIdx])}>
                  Export Day CSV
                </button>
                <button className="px-3 py-1 rounded bg-indigo-700 text-white"
                  onClick={() => exportOrdersRangePDF(upcomingDays[upcomingActiveIdx], upcomingDays[upcomingActiveIdx])}>
                  Export Day PDF
                </button>

                <button className="px-3 py-1 rounded bg-slate-700 text-white"
                  onClick={() => exportOrdersRangeJSON(upcomingWeekStart, addDays(upcomingWeekStart, 4))}>
                  Export Week JSON
                </button>
                <button className="px-3 py-1 rounded bg-slate-700 text-white"
                  onClick={() => exportOrdersRangeCSV(upcomingWeekStart, addDays(upcomingWeekStart, 4))}>
                  Export Week CSV
                </button>
                <button className="px-3 py-1 rounded bg-indigo-700 text-white"
                  onClick={() => exportOrdersRangePDF(upcomingWeekStart, addDays(upcomingWeekStart, 4))}>
                  Export Week PDF
                </button>
              </div>

              {/* Table for active day (LIVE + FUTURE) */}
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full border rounded-lg overflow-hidden">
                  <thead className="bg-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left">Order (short ID)</th>
                      <th className="px-3 py-2 text-left">Hospital</th>
                      <th className="px-3 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-left">Calibration</th>
                      <th className="px-3 py-2 text-left">Elute</th>
                      <th className="px-3 py-2 text-left">Assigned</th>
                      <th className="px-3 py-2 text-left">Δt since last</th>
                      <th className="px-3 py-2 text-left">Requested (mCi)</th>
                      <th className="px-3 py-2 text-left">Avail / Req @ elute (mCi)</th>
                      <th className="px-3 py-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white">
                    {((upcomingDayOrders[upcomingDays[upcomingActiveIdx]] ?? []).length === 0) && (
                      <tr><td className="px-3 py-3 text-slate-500" colSpan={10}>No orders on {upcomingDays[upcomingActiveIdx]}.</td></tr>
                    )}
                    {(upcomingDayOrders[upcomingDays[upcomingActiveIdx]] ?? []).map((o: any) => {
                      const hospitalName = hospitals.find(h => h.id === o.hospitalId)?.name ?? o.hospitalId;
                      const assigned = o.assignedGeneratorIds ?? [];
                      const elute = o._eluteDtObj as Date;
                      const genById: Record<string, Generator> = Object.fromEntries(generators.map((g) => [g.id, g]));
                      const availableTotal = assigned.reduce((sum: number, gid: string) => {
                        const g = genById[gid];
                        if (!g) return sum;
                        const avail = availableAtElute_mCi(g, elute, minLockMinutes).available;
                        return sum + avail;
                      }, 0);
                      const deltaStr = (o.assigned_delta_minutes ?? []).map((m: number, idx: number) => `${assigned[idx]}: ${Math.round(m)} min`).join("; ");
                      const isLive = !!orders.find(x => x.id === o.id);
                      return (
                        <tr key={`${o.id}-${o.calibration_dt}`} className="border-t">
                          <td className="px-3 py-2">
                            <span title={`Order ID: ${o.id}`}>{shortId(o.id)}</span>
                            <span className="ml-2 text-xs text-slate-500">{isLive ? "LIVE" : "FUTURE"}</span>
                          </td>
                          <td className="px-3 py-2">{hospitalName}</td>
                          <td className="px-3 py-2">{o.product}</td>
                          <td className="px-3 py-2">{formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(o.calibration_dt))}</td>
                          <td className="px-3 py-2 font-semibold">{formatDateTimeFriendly(elute)}</td>
                          <td className="px-3 py-2 font-semibold">{assigned.join(", ") || "—"}</td>
                          <td className="px-3 py-2">{deltaStr || "—"}</td>
                          <td className="px-3 py-2">{o.requested_mCi_at_cal > 0 ? Number(o.requested_mCi_at_cal).toFixed(2) : "—"}</td>
                          <td className="px-3 py-2">{availableTotal > 0 ? availableTotal.toFixed(2) : "—"} {o._requiredAtElute > 0 ? `| req ${Number(o._requiredAtElute).toFixed(2)}` : ""}</td>
                          <td className="px-3 py-2">
                            <div className="flex gap-2">
                              {isLive ? (
                                <button className="px-2 py-1 rounded bg-amber-600 text-white" onClick={() => { const oo = orders.find(ox => ox.id === o.id); if (oo) onEditOrder(oo); }}>Edit</button>
                              ) : (
                                <span className="text-xs text-slate-500">Edit in Future Vault</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        )}

        {/* Future Orders Vault */}
        {page === "future" && (
          <div className="grid grid-cols-1 gap-4">
            <Section title="Future Orders Vault (Edit / Delete / Promote / Import)">
              <div className="flex flex-wrap gap-3 mb-3 items-center">
                {/* Import */}
                <label className="px-3 py-1 rounded bg-slate-200 text-black cursor-pointer">
                  Import Orders → Future Vault
                  <input title="Import orders JSON (array or {orders: [...]}) into Future Orders vault" type="file" accept="application/json" className="hidden" onChange={async (ev) => {
                    if (!db) return;
                    const file = ev.target.files?.[0];
                    if (!file) return;
                    setBusy(true);
                    try {
                      const text = await file.text();
                      const data = JSON.parse(text);
                      const ords: Order[] = Array.isArray(data) ? data : (data.orders ?? []);
                      if (!Array.isArray(ords) || ords.length === 0) { alert("No orders found in file."); setBusy(false); return; }
                      await idbBulkPut(db, STORE_FUTURE_ORDERS, ords);
                      setFutureOrders(await idbGetAll<Order>(db, STORE_FUTURE_ORDERS));
                      setToast({ msg: `Imported ${ords.length} future order(s).`, kind: "success" });
                    } catch (e) {
                      console.error(e);
                      setToast({ msg: "Import failed.", kind: "error" });
                    } finally {
                      setBusy(false);
                      setTimeout(() => setToast(null), 3500);
                    }
                  }} />
                </label>

                {/* Auto-assign toolbar */}
                <label className="flex items-center gap-2">
                  <span className="text-sm">Day</span>
                  <input type="date" className="border rounded p-1"
                    value={futureSimSelectedDate}
                    onChange={(e) => setFutureSimSelectedDate(e.target.value)} />
                </label>
                <button disabled={busy}
                  className={`px-3 py-1 rounded ${busy ? "bg-blue-300 text-white" : "bg-blue-600 text-white"}`}
                  onClick={() => simulateAutoAssignFuture(futureSimSelectedDate)}>
                  {busy ? "Assigning…" : "Auto Assign (Selected Day)"}
                </button>
                <button disabled={busy}
                  className={`px-3 py-1 rounded ${busy ? "bg-indigo-300 text-white" : "bg-indigo-600 text-white"}`}
                  onClick={() => simulateAutoAssignFuture(undefined)}>
                  {busy ? "Assigning…" : "Auto Assign (All Future)"}
                </button>
                <button disabled={busy}
                  className={`px-3 py-1 rounded ${busy ? "bg-amber-300 text-white" : "bg-amber-600 text-white"}`}
                  onClick={() => clearFutureAssignments(futureSimSelectedDate)}>
                  {busy ? "Clearing…" : "Clear Assignments (Selected Day)"}
                </button>

                {/* Promote to … date picker */}
                <label className="flex items-center gap-2 ml-auto">
                  <span className="text-sm">Promote target</span>
                  <input type="date" className="border rounded p-1"
                    value={promoteTargetDate}
                    onChange={(e) => setPromoteTargetDate(e.target.value)} />
                </label>
              </div>

              {/* Simulation messages */}
              {simFutureMsgs.length > 0 && (
                <div className="text-xs text-slate-600 mb-2">
                  {simFutureMsgs.join(" | ")}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {futureOrders.length === 0 && <div className="text-slate-500">No future orders in the vault.</div>}
                {futureOrders.map((fo: any) => (
                  <div key={fo.id} className="border rounded p-2 bg-slate-50">
                    <div className="flex justify-between items-center">
                      <div className="font-semibold">
                        <span title={`Order ID: ${fo.id}`}>{shortId(fo.id)}</span> — {fo.product}
                      </div>
                      <div className="flex gap-2 items-center">
                        {editingFutureId === fo.id ? (
                          <>
                            <button className="px-2 py-1 rounded bg-amber-600 text-white"
                              onClick={() => {
                                const form = futureEditFormById[fo.id] || {};
                                const updated: Order = {
                                  ...(fo as Order),
                                  id: fo.id,
                                  hospitalId: form.hospitalId ?? fo.hospitalId,
                                  product: (form.product as any) ?? fo.product,
                                  requested_mCi_at_cal: Number(form.requested_mCi_at_cal ?? fo.requested_mCi_at_cal ?? 0),
                                  calibration_dt: form.calibration_dt ?? fo.calibration_dt ?? nowLocalISO(),
                                  prep_minutes: Number(form.prep_minutes ?? fo.prep_minutes ?? 15),
                                  travel_minutes: Number(form.travel_minutes ?? fo.travel_minutes ?? 0),
                                };
                                updateFutureOrder(updated);
                                setEditingFutureId(null);
                              }}>
                              Save
                            </button>
                            <button className="px-2 py-1 rounded bg-slate-300 text-slate-900"
                              onClick={() => { setEditingFutureId(null); setFutureEditFormById(m => ({ ...m, [fo.id]: {} })); }}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button className="px-2 py-1 rounded bg-amber-600 text-white"
                            onClick={() => {
                              setEditingFutureId(fo.id);
                              setFutureEditFormById(m => ({ ...m, [fo.id]: { ...fo } }));
                            }}>
                            Edit
                          </button>
                        )}
                        <button className="px-2 py-1 rounded bg-red-600 text-white" onClick={() => deleteFutureOrder(fo.id)}>Delete</button>
                      </div>
                    </div>

                    {/* Promote actions */}
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button className="px-2 py-1 rounded bg-emerald-600 text-white" onClick={() => promoteFutureKeepDate(fo as Order)}>Promote (keep date)</button>
                      <button className="px-2 py-1 rounded bg-emerald-700 text-white" onClick={() => promoteFutureToToday(fo as Order)}>Promote to Today</button>
                      <button className="px-2 py-1 rounded bg-emerald-800 text-white" onClick={() => promoteFutureToDay(fo as Order, promoteTargetDate)}>Promote to… {promoteTargetDate}</button>
                    </div>

                    {/* Edit form */}
                    {editingFutureId === fo.id && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2">
                        <Field label="Hospital">
                          <select className="border p-2 rounded"
                            value={futureEditFormById[fo.id]?.hospitalId ?? fo.hospitalId}
                            onChange={(e) => setFutureEditFormById(m => ({ ...m, [fo.id]: { ...m[fo.id], hospitalId: e.target.value } }))}>
                            <option value="">Select hospital</option>
                            {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                          </select>
                        </Field>
                        <Field label="Product">
                          <select className="border p-2 rounded"
                            value={futureEditFormById[fo.id]?.product ?? fo.product}
                            onChange={(e) => setFutureEditFormById(m => ({ ...m, [fo.id]: { ...m[fo.id], product: e.target.value as any } }))}>
                            <option value="PSMA">PSMA</option>
                            <option value="Dotatate">Dotatate</option>
                            <option value="Research">Research</option>
                          </select>
                        </Field>
                        <Field label="Requested mCi @ calibration">
                          <input type="number" className="border p-2 rounded"
                            value={futureEditFormById[fo.id]?.requested_mCi_at_cal ?? fo.requested_mCi_at_cal ?? ""}
                            onChange={(e) => setFutureEditFormById(m => ({ ...m, [fo.id]: { ...m[fo.id], requested_mCi_at_cal: Number(e.target.value) } }))}/>
                        </Field>
                        <Field label="Calibration date/time">
                          <input type="datetime-local" className="border p-2 rounded"
                            value={futureEditFormById[fo.id]?.calibration_dt ?? fo.calibration_dt}
                            onChange={(e) => setFutureEditFormById(m => ({ ...m, [fo.id]: { ...m[fo.id], calibration_dt: e.target.value } }))}/>
                          <PreviewDateTime iso={futureEditFormById[fo.id]?.calibration_dt ?? fo.calibration_dt} />
                        </Field>
                        <Field label="Prep minutes">
                          <input type="number" className="border p-2 rounded"
                            value={futureEditFormById[fo.id]?.prep_minutes ?? fo.prep_minutes ?? ""}
                            onChange={(e) => setFutureEditFormById(m => ({ ...m, [fo.id]: { ...m[fo.id], prep_minutes: Number(e.target.value) } }))}/>
                        </Field>
                        <Field label="Travel minutes">
                          <input type="number" className="border p-2 rounded"
                            value={futureEditFormById[fo.id]?.travel_minutes ?? fo.travel_minutes ?? ""}
                            onChange={(e) => setFutureEditFormById(m => ({ ...m, [fo.id]: { ...m[fo.id], travel_minutes: Number(e.target.value) } }))}/>
                        </Field>
                      </div>
                    )}

                    {/* Summary */}
                    <div className="text-sm">Hospital: {hospitals.find((h) => h.id === fo.hospitalId)?.name ?? fo.hospitalId}</div>
                    <div className="text-sm">Calibration: {formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(fo.calibration_dt))} | Prep: {fo.prep_minutes} | Travel: {fo.travel_minutes}</div>
                    <div className="text-sm">Requested @ cal: {fo.requested_mCi_at_cal ?? "—"} mCi</div>

                    {/* Simulated assignment preview */}
                    <div className="text-sm mt-1">
                      Sim assignment: {Array.isArray(fo.assignedGeneratorIds) && fo.assignedGeneratorIds.length > 0
                        ? `${fo.assignedGeneratorIds.join(", ")} @ ${formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(fo.assigned_elute_dt ?? fo.calibration_dt))}`
                        : "—"}
                    </div>
                    <div className="text-xs text-slate-600">{fo.notes ?? ""}</div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}

        {/* Generators */}
        {page === "generators" && (
          <div className="grid grid-cols-1 gap-4">
            <Section title="Generators">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Field label="Generator ID">
                  <input className="border p-2 rounded" placeholder="Enter Generator ID" value={genForm.id ?? ""} onChange={(e) => setGenForm({ ...genForm, id: e.target.value })} />
                </Field>
                <Field label="Activity (mCi)">
                  <input type="number" className="border p-2 rounded" placeholder="e.g., 50" value={genForm.activity_mCi ?? ""} onChange={(e) => setGenForm({ ...genForm, activity_mCi: Number(e.target.value) })} />
                </Field>
                <Field label="Efficiency (%)">
                  <input type="number" className="border p-2 rounded" placeholder="e.g., 60" value={genForm.efficiency_pct ?? ""} onChange={(e) => setGenForm({ ...genForm, efficiency_pct: Number(e.target.value) })} />
                </Field>
                <Field label="Calibration date/time">
                  <input type="datetime-local" className="border p-2 rounded" value={genForm.calibration_dt ?? nowLocalISO()} onChange={(e) => setGenForm({ ...genForm, calibration_dt: e.target.value })} />
                  <PreviewDateTime iso={genForm.calibration_dt} />
                </Field>
                <Field label="Last eluted date/time">
                  <input type="datetime-local" className="border p-2 rounded" value={genForm.last_eluted_dt ?? nowLocalISO()} onChange={(e) => setGenForm({ ...genForm, last_eluted_dt: e.target.value })} />
                  <PreviewDateTime iso={genForm.last_eluted_dt} />
                </Field>
                <div className="flex items-end">
                  <button disabled={busy} className={`w-full md:w-auto px-3 py-2 rounded ${busy ? "bg-blue-300 text-white" : "bg-blue-600 text-white"}`} onClick={addOrUpdateGenerator}>{busy ? "Saving…" : "Add/Update Generator"}</button>
                </div>
              </div>

              <div className="mt-3">
                {gensWithAvailNow.length === 0 && <div className="text-slate-500">No generators yet.</div>}
                {gensWithAvailNow.map((g: any) => (
                  <div key={g.id} className="border rounded p-2 mb-2 bg-slate-50">
                    <div className="flex justify-between">
                      <div className="font-semibold">
                        <span title={`Generator ID: ${g.id}`}>{shortId(g.id)}</span>
                      </div>
                      <div className="flex gap-2">
                        <button className="px-2 py-1 rounded bg-amber-600 text-white" onClick={() => setGenForm({ ...g })}>Edit</button>
                        <button className="px-2 py-1 rounded bg-red-600 text-white" onClick={() => deleteGenerator(g.id)}>Delete</button>
                      </div>
                    </div>
                    <div className="text-sm">Activity: {g.activity_mCi ?? "—"} mCi; Eff: {g.efficiency_pct ?? "—"}%</div>
                    <div className="text-sm">Cal: {formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(g.calibration_dt))}; Last eluted: {formatDateTimeFriendly(parseLocalDateTimeYYYYMMDDTHHMM(g.last_eluted_dt))}</div>
                    <div className="text-sm">Status: {g._expired ? <span className="text-red-700">Expired</span> : <span className="text-emerald-700">Valid</span>} | Expires in: {g._daysToExpiry} day(s)</div>
                    <div className="text-sm">Available now since last elution: <span className="font-medium">{g._availNow > 0 ? g._availNow.toFixed(2) : "—"} mCi</span> | Δt: {Math.round(g._deltaSinceLast)} min | Eligible now: {g._eligibleNow ? "Yes" : "No"}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex gap-2">
                <button className="px-3 py-1 rounded bg-slate-700 text-white" onClick={exportGenerators}>Export Generators (Save As)</button>
                <label className="px-3 py-1 rounded bg-slate-200 text-black cursor-pointer">
                  Import Generators
                  <input title="Import generators JSON (array or {generators: [...]})" type="file" accept="application/json" className="hidden" onChange={async (ev) => {
                    if (!db) return;
                    const file = ev.target.files?.[0];
                    if (!file) return;
                    setBusy(true);
                    try {
                      const text = await file.text();
                      const data = JSON.parse(text);
                      const gens: Generator[] = Array.isArray(data) ? data : (data.generators ?? []);
                      if (!Array.isArray(gens) || gens.length === 0) { alert("No generators found in file."); setBusy(false); return; }
                      await idbBulkPut(db, STORE_GENERATORS, gens);
                      setGenerators(await idbGetAll<Generator>(db, STORE_GENERATORS));
                      setToast({ msg: `Imported ${gens.length} generator(s).`, kind: "success" });
                    } catch (e) {
                      console.error(e);
                      setToast({ msg: "Import failed.", kind: "error" });
                    } finally {
                      setBusy(false);
                      setTimeout(() => setToast(null), 3500);
                    }
                  }} />
                </label>
              </div>
            </Section>
          </div>
        )}

        {/* Hospitals */}
        {page === "hospitals" && (
          <div className="grid grid-cols-1 gap-4">
            <Section title="Hospitals">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <Field label="Hospital ID (optional; auto if blank)">
                  <input className="border p-2 rounded" placeholder="Auto (optional)" value={hospitalForm.id ?? ""} onChange={(e) => setHospitalForm({ ...hospitalForm, id: e.target.value })} />
                </Field>
                <Field label="Hospital Name">
                  <input className="border p-2 rounded" placeholder="e.g., Lakeshore General" value={hospitalForm.name ?? ""} onChange={(e) => setHospitalForm({ ...hospitalForm, name: e.target.value })} />
                </Field>
                <Field label="Travel minutes">
                  <input type="number" className="border p-2 rounded" placeholder="e.g., 35" value={hospitalForm.travel_minutes ?? ""} onChange={(e) => setHospitalForm({ ...hospitalForm, travel_minutes: Number(e.target.value) })} />
                </Field>
                <div className="flex items-end">
                  <button disabled={busy} className={`col-span-2 px-3 py-2 rounded ${busy ? "bg-blue-300 text-white" : "bg-blue-600 text-white"}`} onClick={addOrUpdateHospital}>{busy ? "Saving…" : "Add/Update Hospital"}</button>
                </div>
              </div>
              <div className="mt-3">
                {hospitals.length === 0 && <div className="text-slate-500">No hospitals yet.</div>}
                {hospitals.map((h) => (
                  <div key={h.id} className="border rounded p-2 mb-2 bg-slate-50">
                    <div className="flex justify-between">
                      <div className="font-semibold">{h.name}</div>
                      <div className="flex gap-2">
                        <button className="px-2 py-1 rounded bg-amber-600 text-white" onClick={() => setHospitalForm({ ...h })}>Edit</button>
                        <button className="px-2 py-1 rounded bg-red-600 text-white" onClick={() => deleteHospital(h.id)}>Delete</button>
                      </div>
                    </div>
                    <div className="text-sm">
                      ID: <span title={`Hospital ID: ${h.id}`}>{shortId(h.id)}</span> | Travel: {h.travel_minutes ?? "—"} min
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <button className="px-3 py-1 rounded bg-slate-700 text-white" onClick={exportHospitals}>Export Hospitals (Save As)</button>
                <label className="px-3 py-1 rounded bg-slate-200 text-black cursor-pointer">
                  Import Hospitals
                  <input title="Import hospitals JSON (array or {hospitals: [...]})" type="file" accept="application/json" className="hidden" onChange={async (ev) => {
                    if (!db) return;
                    const file = ev.target.files?.[0];
                    if (!file) return;
                    setBusy(true);
                    try {
                      const text = await file.text();
                      const data = JSON.parse(text);
                      const hos: Hospital[] = Array.isArray(data)
                        ? data
                        : (data.hospitals ?? []).map((h: any) => ({
                            id: h.id,
                            name: h.name,
                            travel_minutes: h.travel_minutes ?? (h.distance_km != null ? minutesFromDistance(h.distance_km) : 0),
                          }));
                      if (!Array.isArray(hos) || hos.length === 0) { alert("No hospitals found in file."); setBusy(false); return; }
                      await idbBulkPut(db, STORE_HOSPITALS, hos);
                      setHospitals(await idbGetAll<Hospital>(db, STORE_HOSPITALS));
                      setToast({ msg: `Imported ${hos.length} hospital(s).`, kind: "success" });
                    } catch (e) {
                      console.error(e);
                      setToast({ msg: "Import failed.", kind: "error" });
                    } finally {
                      setBusy(false);
                      setTimeout(() => setToast(null), 3500);
                    }
                  }} />
                </label>
              </div>
            </Section>
          </div>
        )}

        <div className="mt-6 text-center text-slate-500 text-sm">
          Ga‑68 Planner · IndexedDB local storage · Upcoming shows LIVE + FUTURE · Future Save/Delete fixed · Promote to Live · Auto-assign (simulation) · Export JSON/CSV/PDF
        </div>
      </div>
    </div>
  );
}

export default App;
