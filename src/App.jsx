import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";
import weekOfYear from "dayjs/plugin/weekOfYear";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from "recharts";
import {
  LayoutDashboard, PlusCircle, List, BarChart2,
  FolderOpen, FilePlus, CheckCircle, XCircle, Info,
  Pencil, Trash2, Upload, Sparkles, FileSpreadsheet,
  TrendingUp, TrendingDown, Wallet, Activity,
  CheckCheck, AlertTriangle, RefreshCw, Download
} from "lucide-react";

dayjs.extend(isBetween);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);
dayjs.extend(weekOfYear);

// ─── IndexedDB handle store ───────────────────────────────────────────────────
// FileSystemFileHandle objects cannot be serialized to JSON/localStorage.
// IndexedDB is the only place they can be persisted across page loads.
// We store the handle under a fixed key so we can restore it on reload.
const IDB_DB = "mywallie_db";
const IDB_STORE = "handles";
const IDB_KEY = "active_file_handle";

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(val) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, IDB_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* silently ignore */ }
}

async function idbGet() {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
  } catch { return null; }
}

async function idbDel() {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* silently ignore */ }
}

// ─── localStorage helpers (for filename display only) ─────────────────────────
const LS_KEY = "mywallie_file_name";
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, v); } catch { } };
const lsGet = () => { try { return localStorage.getItem(LS_KEY); } catch { return null; } };
const lsDel = () => { try { localStorage.removeItem(LS_KEY); } catch { } };

// ─── Excel Service ────────────────────────────────────────────────────────────
const SHEET_NAME = "Transactions";
const HEADERS = ["ID", "Date", "Type", "Category", "Amount", "Notes", "CreatedAt"];

const excelService = {
  createWorkbook(transactions = []) {
    const wb = XLSX.utils.book_new();
    const rows = [
      HEADERS,
      ...transactions.map(t => [t.ID, t.Date, t.Type, t.Category, t.Amount, t.Notes, t.CreatedAt])
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
    return wb;
  },

  toBuffer(wb) {
    return XLSX.write(wb, { bookType: "xlsx", type: "array" });
  },

  parse(arrayBuffer) {
    const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
    const ws = wb.Sheets[SHEET_NAME];
    if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found in file`);
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length <= 1) return [];
    return rows.slice(1).filter(r => r[0]).map(r => ({
      ID: String(r[0] || ""),
      Date: r[1] ? String(r[1]) : dayjs().format("YYYY-MM-DD"),
      Type: r[2] || "Expense",
      Category: r[3] || "",
      Amount: Number(r[4]) || 0,
      Notes: r[5] || "",
      CreatedAt: r[6] || new Date().toISOString(),
    }));
  },

  async writeToHandle(handle, transactions) {
    const buf = this.toBuffer(this.createWorkbook(transactions));
    const writable = await handle.createWritable();
    await writable.write(new Blob([buf], { type: "application/octet-stream" }));
    await writable.close();
  },

  downloadFile(transactions, filename = "expenses.xlsx") {
    const buf = this.toBuffer(this.createWorkbook(transactions));
    saveAs(new Blob([buf], { type: "application/octet-stream" }), filename);
  },

  generateReport(transactions) {
    const wb = XLSX.utils.book_new();
    const income = transactions.filter(t => t.Type === "Income").reduce((s, t) => s + t.Amount, 0);
    const expense = transactions.filter(t => t.Type === "Expense").reduce((s, t) => s + t.Amount, 0);
    const rows = [
      HEADERS,
      ...transactions.map(t => [t.ID, t.Date, t.Type, t.Category, t.Amount, t.Notes, t.CreatedAt]),
      [],
      ["Summary"], ["Total Income", income], ["Total Expense", expense], ["Net Balance", income - expense],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    return wb;
  },
};

// ─── Date Utils ───────────────────────────────────────────────────────────────
const dateUtils = {
  filterByPeriod(transactions, period, from, to) {
    const today = dayjs();
    return transactions.filter(t => {
      const d = dayjs(t.Date);
      if (period === "daily") return d.isSame(today, "day");
      if (period === "weekly") return d.isSame(today, "week");
      if (period === "monthly") return d.isSame(today, "month");
      if (period === "yearly") return d.isSame(today, "year");
      if (period === "custom" && from && to)
        return d.isSameOrAfter(dayjs(from), "day") && d.isSameOrBefore(dayjs(to), "day");
      return true;
    });
  },
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a26; --surface3: #22223a;
    --border: rgba(255,255,255,0.08); --accent: #7c6af7; --text: #f0eeff;
    --muted: rgba(240,238,255,0.45); --income: #4df7c8; --expense: #f74d8a;
    --radius: 16px; --radius-sm: 10px;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Syne', sans-serif; min-height: 100vh; }
  .app { display: flex; min-height: 100vh; }

  /* Sidebar */
  .sidebar { width: 240px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 28px 16px; position: sticky; top: 0; height: 100vh; overflow: hidden; flex-shrink: 0; }
  .logo { font-size: 1.3rem; font-weight: 800; letter-spacing: -0.03em; margin-bottom: 8px; }
  .logo span { color: var(--accent); }
  .logo-sub { font-size: 0.7rem; color: var(--muted); font-family: 'DM Mono', monospace; margin-bottom: 36px; letter-spacing: 0.1em; }
  .nav { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .nav-item { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.18s; color: var(--muted); font-weight: 500; font-size: 0.88rem; border: none; background: none; text-align: left; width: 100%; }
  .nav-item:hover { background: var(--surface2); color: var(--text); }
  .nav-item.active { background: var(--accent); color: #fff; }
  .nav-icon { width: 20px; text-align: center; flex-shrink: 0; display:flex; align-items:center; justify-content:center; }

  /* Bottom nav — mobile only */
  .bottom-nav { display: none; position: fixed; bottom: 0; left: 0; right: 0; z-index: 100; background: var(--surface); border-top: 1px solid var(--border); padding: 6px 0 max(8px, env(safe-area-inset-bottom)); justify-content: space-around; align-items: stretch; }
  .bottom-nav-item { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 8px; border: none; background: none; cursor: pointer; color: var(--muted); font-family: 'Syne', sans-serif; font-size: 0.6rem; font-weight: 600; transition: color 0.15s; flex: 1; min-width: 0; }
  .bottom-nav-item svg { margin-bottom: 1px; }
  .bottom-nav-item.active { color: var(--accent); }

  /* File zone */
  .file-zone { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }
  .file-zone-label { font-size: 0.7rem; color: var(--muted); font-family: 'DM Mono', monospace; letter-spacing: 0.1em; margin-bottom: 10px; }
  .file-btn { width: 100%; padding: 9px 12px; border-radius: var(--radius-sm); background: var(--surface2); border: 1px dashed var(--border); color: var(--muted); font-size: 0.8rem; font-family: 'Syne', sans-serif; cursor: pointer; transition: all 0.18s; display: flex; align-items: center; gap: 8px; }
  .file-btn:hover { border-color: var(--accent); color: var(--accent); }
  .file-status { font-size: 0.72rem; color: var(--income); margin-top: 8px; font-family: 'DM Mono', monospace; line-height: 1.6; }

  /* Main */
  .main { flex: 1; padding: 36px 40px; overflow-x: hidden; min-width: 0; }
  .page-header { margin-bottom: 32px; }
  .page-title { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.04em; }
  .page-sub { color: var(--muted); font-size: 0.85rem; margin-top: 4px; }

  /* Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px; transition: transform 0.18s; }
  .card:hover { transform: translateY(-2px); }
  .card-label { font-size: 0.72rem; color: var(--muted); font-family: 'DM Mono', monospace; letter-spacing: 0.1em; margin-bottom: 10px; }
  .card-value { font-size: 1.6rem; font-weight: 800; letter-spacing: -0.04em; word-break: break-all; }
  .card-value.income { color: var(--income); }
  .card-value.expense { color: var(--expense); }
  .card-value.net.pos { color: var(--income); }
  .card-value.net.neg { color: var(--expense); }
  .card-sub { font-size: 0.75rem; color: var(--muted); margin-top: 6px; }

  /* Table */
  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .table-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); }
  .table-title { font-weight: 700; font-size: 1rem; }
  .desktop-table table { width: 100%; border-collapse: collapse; }
  .desktop-table th { padding: 13px 18px; text-align: left; font-size: 0.72rem; color: var(--muted); font-family: 'DM Mono', monospace; letter-spacing: 0.1em; border-bottom: 1px solid var(--border); background: var(--surface2); }
  .desktop-table td { padding: 13px 18px; font-size: 0.88rem; border-bottom: 1px solid var(--border); }
  .desktop-table tr:last-child td { border-bottom: none; }
  .desktop-table tr:hover td { background: var(--surface2); }

  /* Mobile transaction cards */
  .mobile-cards-list { display: none; }
  .tx-card { padding: 14px 18px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .tx-card:last-child { border-bottom: none; }
  .tx-card-left { flex: 1; min-width: 0; }
  .tx-card-cat { font-weight: 700; font-size: 0.92rem; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tx-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tx-card-date { font-size: 0.7rem; color: var(--muted); font-family: 'DM Mono', monospace; }
  .tx-card-notes { font-size: 0.73rem; color: var(--muted); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
  .tx-card-right { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; flex-shrink: 0; }
  .tx-card-amount { font-family: 'DM Mono', monospace; font-weight: 700; font-size: 0.95rem; }

  .badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 100px; font-size: 0.7rem; font-weight: 600; font-family: 'DM Mono', monospace; }
  .badge.income { background: rgba(77,247,200,0.12); color: var(--income); }
  .badge.expense { background: rgba(247,77,138,0.12); color: var(--expense); }
  .amount.income { color: var(--income); font-weight: 700; font-family: 'DM Mono', monospace; }
  .amount.expense { color: var(--expense); font-weight: 700; font-family: 'DM Mono', monospace; }
  .actions { display: flex; gap: 8px; }
  .btn-icon { background: var(--surface3); border: none; border-radius: 8px; padding: 7px 10px; cursor: pointer; font-size: 0.85rem; transition: all 0.15s; color: var(--muted); }
  .btn-icon:hover { background: var(--accent); color: #fff; }
  .btn-icon.del:hover { background: var(--expense); color: #fff; }

  /* Form */
  .form-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; max-width: 560px; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .form-group { display: flex; flex-direction: column; gap: 7px; }
  .form-group.full { grid-column: 1 / -1; }
  label { font-size: 0.75rem; color: var(--muted); font-family: 'DM Mono', monospace; letter-spacing: 0.08em; }
  input, select, textarea { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); padding: 11px 14px; font-family: 'Syne', sans-serif; font-size: 0.88rem; transition: border-color 0.15s; outline: none; width: 100%; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  select option { background: var(--surface2); }
  textarea { resize: vertical; min-height: 80px; }

  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 22px; border-radius: var(--radius-sm); border: none; cursor: pointer; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.88rem; transition: all 0.18s; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #6a58e5; transform: translateY(-1px); }
  .btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover { background: var(--surface3); }
  .btn-success { background: var(--income); color: #000; }
  .btn-success:hover { filter: brightness(0.9); }

  /* Toast */
  .toast-wrap { position: fixed; bottom: 28px; right: 28px; z-index: 999; display: flex; flex-direction: column; gap: 10px; }
  .toast { padding: 13px 18px; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 600; animation: slideIn 0.25s ease; min-width: 240px; max-width: 320px; display: flex; align-items: center; gap: 10px; }
  .toast.success { background: var(--income); color: #000; }
  .toast.error { background: var(--expense); color: #fff; }
  .toast.info { background: var(--accent); color: #fff; }
  @keyframes slideIn { from { transform: translateX(60px); opacity: 0; } to { transform: none; opacity: 1; } }

  /* Report filters */
  .filter-row { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .filter-bar { display: flex; gap: 12px; margin-bottom: 20px; align-items: center; flex-wrap: wrap; }
  .search-input { flex: 1; min-width: 180px; max-width: 260px; }
  .filter-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  .filter-btn { padding: 8px 14px; border-radius: 100px; border: 1px solid var(--border); background: var(--surface2); color: var(--muted); font-family: 'Syne', sans-serif; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .filter-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }

  .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; }
  .chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px; }
  .chart-title { font-weight: 700; font-size: 0.95rem; margin-bottom: 18px; }

  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
  .empty-icon { margin-bottom: 16px; color: var(--muted); opacity: 0.6; }
  .empty-title { font-size: 1.1rem; font-weight: 700; color: var(--text); margin-bottom: 8px; }
  .loading { display: flex; align-items: center; justify-content: center; height: 200px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: 0.85rem; }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--surface3); border-radius: 3px; }

  /* Welcome screen */
  .welcome-wrap { max-width: 480px; margin: 60px auto 0; text-align: center; }
  .welcome-icon { margin-bottom: 20px; color: var(--accent); }
  .welcome-title { font-size: 1.5rem; font-weight: 800; margin-bottom: 8px; }
  .welcome-sub { color: var(--muted); font-size: 0.88rem; margin-bottom: 32px; line-height: 1.6; }
  .welcome-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .file-input-label { display: inline-flex; align-items: center; gap: 8px; padding: 11px 22px; border-radius: var(--radius-sm); background: var(--accent); color: #fff; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.88rem; cursor: pointer; transition: all 0.18s; border: none; }
  .file-input-label:hover { background: #6a58e5; transform: translateY(-1px); }

  /* Reconnect banner */
  .reconnect-wrap { max-width: 480px; margin: 60px auto 0; }
  .reconnect-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px; text-align: center; }
  .reconnect-icon { margin-bottom: 16px; color: var(--accent); }
  .reconnect-title { font-size: 1.2rem; font-weight: 800; margin-bottom: 8px; }
  .reconnect-sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 8px; line-height: 1.6; }
  .reconnect-filename { font-family: 'DM Mono', monospace; font-size: 0.85rem; color: var(--income); background: rgba(77,247,200,0.08); border: 1px solid rgba(77,247,200,0.2); border-radius: 8px; padding: 8px 14px; margin-bottom: 24px; display: inline-block; }
  .reconnect-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

  /* ── MOBILE ── */
  @media (max-width: 768px) {
    .sidebar { display: none; }
    .bottom-nav { display: flex; }
    .main { padding: 20px 16px 90px; }
    .page-title { font-size: 1.45rem; }
    .cards { grid-template-columns: 1fr 1fr; gap: 12px; }
    .card { padding: 14px 16px; }
    .card-value { font-size: 1.2rem; }
    .desktop-table { display: none; }
    .mobile-cards-list { display: block; }
    .charts-grid { grid-template-columns: 1fr; }
    .form-grid { grid-template-columns: 1fr; }
    .form-card { padding: 20px 16px; max-width: 100%; }
    .filter-btn { padding: 7px 11px; font-size: 0.75rem; }
    .toast-wrap { bottom: 76px; right: 12px; left: 12px; }
    .toast { min-width: unset; }
    .filter-bar { flex-direction: column; align-items: stretch; }
    .search-input { max-width: 100%; }
    .filter-buttons { justify-content: space-between; }
    .filter-buttons .filter-btn { flex: 1; }
    .welcome-wrap, .reconnect-wrap { margin-top: 24px; }
  }
  @media (max-width: 400px) {
    .cards { grid-template-columns: 1fr; }
  }
`;

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ toasts }) {
  return (
    <div className="toast-wrap">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>
          {t.type === "success" ? <CheckCircle size={16} /> : t.type === "error" ? <XCircle size={16} /> : <Info size={16} />}
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [transactions, setTransactions] = useState([]);
  const [fileLoaded, setFileLoaded] = useState(false);
  const [fileName, setFileName] = useState(lsGet() || "");
  const [toasts, setToasts] = useState([]);
  const [editTx, setEditTx] = useState(null);
  // "idle"      → no stored handle, show welcome
  // "restoring" → checking IDB for a saved handle on startup
  // "needs-pick"→ IDB had a handle but needs user permission re-grant
  // "ready"     → handle active, file loaded
  const [status, setStatus] = useState("restoring");

  const fileHandleRef = useRef(null);
  // Hidden <input type="file"> — used as the universal file picker trigger
  // (works on all browsers; on Chrome we also get a writable handle afterward)
  const inputRef = useRef();

  const toast = useCallback((msg, type = "success") => {
    const id = Date.now();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3200);
  }, []);

  // ── On mount: try to restore a previously-saved FileSystemFileHandle from IDB
  useEffect(() => {
    (async () => {
      const handle = await idbGet();
      if (!handle) {
        // No stored handle — check if we at least have a filename (edge case)
        setStatus(lsGet() ? "needs-pick" : "idle");
        return;
      }
      // We have a handle. Ask for read permission silently (no UI prompt yet).
      try {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm === "granted") {
          // Permission still active — load the file automatically
          const file = await handle.getFile();
          const parsed = excelService.parse(await file.arrayBuffer());
          fileHandleRef.current = handle;
          setFileName(file.name);
          lsSet(file.name);
          setTransactions(parsed);
          setFileLoaded(true);
          setStatus("ready");
          toast(`Resumed "${file.name}" — ${parsed.length} records`, "success");
        } else {
          // Handle exists but needs a user gesture to re-grant permission
          setFileName(handle.name || lsGet() || "");
          fileHandleRef.current = handle; // keep it so we can requestPermission later
          setStatus("needs-pick");
        }
      } catch {
        // Handle is stale / file moved — fall back to asking user to pick again
        await idbDel();
        setStatus(lsGet() ? "needs-pick" : "idle");
      }
    })();
  }, []);

  // ── Core: save updated transactions back to the file (in-place or download)
  const persist = useCallback(async (txList) => {
    if (fileHandleRef.current) {
      try {
        await excelService.writeToHandle(fileHandleRef.current, txList);
      } catch (e) {
        // Permission revoked mid-session — fall back to download
        excelService.downloadFile(txList, fileName || "expenses.xlsx");
        toast("Permission lost — file downloaded instead", "info");
      }
    } else {
      excelService.downloadFile(txList, fileName || "expenses.xlsx");
    }
  }, [fileName]);

  // ── Called when <input type="file"> fires (works on all browsers)
  const handleInputChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so same file can be picked again

    try {
      const parsed = excelService.parse(await file.arrayBuffer());

      // On Chrome/Edge we can request a writable handle for the chosen file
      // via showOpenFilePicker — but input:file doesn't give us one directly.
      // So we use showOpenFilePicker when available to get the handle after
      // the user has already confirmed which file they want via the input.
      // For Firefox/Safari we store null and fall back to download-on-save.
      let handle = null;
      if ("showOpenFilePicker" in window) {
        try {
          // User already picked the file via the input — now ask the browser
          // for a writable handle to the same file via the picker API.
          // We can't skip the dialog, but we pre-fill the file name so it's
          // a one-click confirm for the user.
          const [h] = await window.showOpenFilePicker({
            types: [{ description: "Excel Files", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } }],
            multiple: false,
          });
          handle = h;
        } catch {
          // User cancelled the second picker or browser refused — no handle, use download fallback
        }
      }

      fileHandleRef.current = handle;
      if (handle) await idbSet(handle);
      else await idbDel();

      setFileName(file.name);
      lsSet(file.name);
      setTransactions(parsed);
      setFileLoaded(true);
      setStatus("ready");

      toast(`Loaded "${file.name}" — ${parsed.length} records`, "success");
    } catch (err) {
      toast("Failed to read file: " + err.message, "error");
    }
  }, [toast]);

  // ── Triggered when user clicks "Open File" on the reconnect screen
  // We already have a stale handle in fileHandleRef — request permission for it.
  const handleReconnect = useCallback(async () => {
    const handle = fileHandleRef.current;
    if (handle) {
      try {
        const perm = await handle.requestPermission({ mode: "readwrite" });
        if (perm === "granted") {
          const file = await handle.getFile();
          const parsed = excelService.parse(await file.arrayBuffer());
          setFileName(file.name);
          lsSet(file.name);
          setTransactions(parsed);
          setFileLoaded(true);
          setStatus("ready");
          toast(`Resumed "${file.name}"`, "success");
          return;
        }
      } catch { /* fall through to input */ }
    }
    // Permission denied or no handle — open input picker
    inputRef.current.click();
  }, [toast]);

  const handleNewFile = useCallback(async () => {
    fileHandleRef.current = null;
    await idbDel();
    lsDel();
    setFileName("expenses.xlsx");
    setTransactions([]);
    setFileLoaded(true);
    setStatus("ready");
    toast("New file started — first save will ask where to store it", "info");
  }, []);

  // ── CRUD
  const addTransaction = useCallback((tx) => {
    setTransactions(prev => { const u = [...prev, tx]; persist(u); return u; });
    toast("Transaction saved", "success");
  }, [persist]);

  const updateTransaction = useCallback((tx) => {
    if (!tx) {
      setEditTx(null);
      return;
    }
    setTransactions(prev => { const u = prev.map(t => t.ID === tx.ID ? tx : t); persist(u); return u; });
    setEditTx(null);
    toast("Transaction updated", "success");
  }, [persist]);

  const deleteTransaction = useCallback((id) => {
    setTransactions(prev => { const u = prev.filter(t => t.ID !== id); persist(u); return u; });
    toast("Deleted", "success");
  }, [persist]);

  const summary = useMemo(() => {
    const income = transactions.filter(t => t.Type === "Income").reduce((s, t) => s + t.Amount, 0);
    const expense = transactions.filter(t => t.Type === "Expense").reduce((s, t) => s + t.Amount, 0);
    return { income, expense, net: income - expense, count: transactions.length };
  }, [transactions]);

  const navItems = [
    { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
    { id: "add", icon: PlusCircle, label: "Add Transaction" },
    { id: "list", icon: List, label: "Transactions" },
    { id: "reports", icon: BarChart2, label: "Reports" },
  ];

  const goPage = (id) => {
    if (id !== 'add') setEditTx(null);
    setPage(id);
  };

  // ── Render: decide what to show in main area
  let mainContent;
  if (status === "restoring") {
    mainContent = <div className="loading" style={{ height: "60vh" }}>Loading…</div>;
  } else if (!fileLoaded) {
    if (status === "needs-pick") {
      mainContent = (
        <div className="reconnect-wrap">
          <div className="reconnect-card">
            <div className="reconnect-icon"><FolderOpen size={48} strokeWidth={1.5} /></div>
            <div className="reconnect-title">Welcome back!</div>
            <div className="reconnect-sub">Last used file:</div>
            <div className="reconnect-filename">{fileName || "expenses.xlsx"}</div>
            <div className="reconnect-sub" style={{ marginBottom: 24 }}>
              Click <strong>Open File</strong> to resume — the app needs your permission to access it again.
            </div>
            <div className="reconnect-actions">
              <button className="btn btn-primary" onClick={handleReconnect}><FolderOpen size={16} /> Open File</button>
              <button className="btn btn-secondary" onClick={handleNewFile}>Start Fresh</button>
            </div>
          </div>
        </div>
      );
    } else {
      mainContent = (
        <div className="welcome-wrap">
          <div className="welcome-icon"><FileSpreadsheet size={56} strokeWidth={1.2} /></div>
          <div className="welcome-title">Welcome to MyWallie.</div>
          <div className="welcome-sub">
            Select your <strong>expenses.xlsx</strong> to get started.<br />
            The app saves changes directly back to the file — no repeated download dialogs.
          </div>
          <div className="welcome-actions">
            <label className="file-input-label" htmlFor="file-pick">
              <FolderOpen size={18} /> Select File
            </label>
            <button className="btn btn-secondary" onClick={handleNewFile}><FilePlus size={16} /> New File</button>
          </div>
        </div>
      );
    }
  } else {
    if (page === "dashboard") mainContent = <DashboardPage summary={summary} transactions={transactions} />;
    else if (page === "add") mainContent = <AddPage onAdd={addTransaction} onUpdate={updateTransaction} editTx={editTx} />;
    else if (page === "list") mainContent = <ListPage transactions={transactions} onEdit={tx => {
      setEditTx(tx);
      goPage("add");
    }} onDelete={deleteTransaction} />;
    else mainContent = <ReportsPage transactions={transactions} toast={toast} />;
  }

  return (
    <>
      <style>{S}</style>
      {/* Hidden file input — universal picker, works on all browsers */}
      <input
        id="file-pick"
        ref={inputRef}
        type="file"
        accept=".xlsx"
        style={{ display: "none" }}
        onChange={handleInputChange}
      />

      <div className="app">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="logo">My<span>Wallie</span></div>
          <div className="logo-sub">EXPENSE TRACKER</div>
          <nav className="nav">
            {navItems.map(n => (
              <button key={n.id} className={`nav-item ${page === n.id ? "active" : ""}`} onClick={() => goPage(n.id)}>
                <n.icon size={18} />
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
          <div className="file-zone">
            <div className="file-zone-label">DATA FILE</div>
            <label className="file-btn" htmlFor="file-pick" style={{ cursor: "pointer" }}>
              <FolderOpen size={15} /> Open File
            </label>
            <div style={{ marginTop: 8 }}>
              <button className="file-btn" onClick={handleNewFile}>
                <FilePlus size={15} /> New File
              </button>
            </div>
            {fileLoaded && (
              <div className="file-status">
                {fileHandleRef.current ? <CheckCircle size={11} style={{ display: "inline", color: "var(--income)" }} /> : <AlertTriangle size={11} style={{ display: "inline", color: "var(--muted)" }} />} {fileName}
                <br />
                <span style={{ opacity: 0.7 }}>{transactions.length} records</span>
              </div>
            )}
          </div>
        </aside>

        {/* Bottom nav — mobile */}
        <nav className="bottom-nav">
          {navItems.map(n => (
            <button key={n.id} className={`bottom-nav-item ${page === n.id ? "active" : ""}`} onClick={() => goPage(n.id)}>
              <n.icon size={20} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>

        <main className="main">
          {mainContent}
        </main>

        <Toast toasts={toasts} />
      </div>
    </>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function DashboardPage({ summary, transactions }) {
  const fmt = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
  const recent = [...transactions].sort((a, b) => dayjs(b.Date).valueOf() - dayjs(a.Date).valueOf()).slice(0, 5);

  const catData = useMemo(() => {
    const map = {};
    transactions.filter(t => t.Type === "Expense").forEach(t => { map[t.Category] = (map[t.Category] || 0) + t.Amount; });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 6);
  }, [transactions]);

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Dashboard</div>
        <div className="page-sub">Overview of all your finances</div>
      </div>
      <div className="cards">
        <div className="card"><div className="card-label">TOTAL INCOME</div><div className="card-value income">{fmt(summary.income)}</div><div className="card-sub">{transactions.filter(t => t.Type === "Income").length} entries</div></div>
        <div className="card"><div className="card-label">TOTAL EXPENSE</div><div className="card-value expense">{fmt(summary.expense)}</div><div className="card-sub">{transactions.filter(t => t.Type === "Expense").length} entries</div></div>
        <div className="card"><div className="card-label">NET BALANCE</div><div className={`card-value net ${summary.net >= 0 ? "pos" : "neg"}`}>{fmt(summary.net)}</div><div className="card-sub">{summary.net >= 0 ? "Surplus" : "Deficit"}</div></div>
        <div className="card"><div className="card-label">TRANSACTIONS</div><div className="card-value" style={{ color: "var(--accent)" }}>{summary.count}</div><div className="card-sub">Total records</div></div>
      </div>

      {transactions.length > 0 && (
        <div className="charts-grid">
          <div className="chart-card">
            <div className="chart-title">Income vs Expense</div>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={[{ name: "Income", value: summary.income }, { name: "Expense", value: summary.expense }]} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value">
                  <Cell fill="#4df7c8" /><Cell fill="#f74d8a" />
                </Pie>
                <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#7c6af7", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, color: "#f0eeff" }} />
                <Legend formatter={v => <span style={{ color: "#f0eeff", fontSize: "0.8rem" }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-card">
            <div className="chart-title">Top Expense Categories</div>
            {catData.length === 0 ? <div className="loading">No expense data</div> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={catData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="name" tick={{ fill: "rgba(240,238,255,0.45)", fontSize: 11 }} />
                  <YAxis tick={{ fill: "rgba(240,238,255,0.45)", fontSize: 11 }} />
                  <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1a1a26", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, color: "#f0eeff" }} />
                  <Bar dataKey="value" fill="#7c6af7" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 24 }}>
          <div className="table-header"><div className="table-title">Recent Transactions</div></div>
          <div className="desktop-table">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Amount</th><th>Notes</th></tr></thead>
              <tbody>
                {recent.map(t => (
                  <tr key={t.ID}>
                    <td style={{ fontFamily: "DM Mono, monospace", fontSize: "0.82rem" }}>{t.Date}</td>
                    <td><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span></td>
                    <td>{t.Category}</td>
                    <td><span className={`amount ${t.Type.toLowerCase()}`}>{t.Type === "Income" ? "+" : "−"}₹{t.Amount.toLocaleString()}</span></td>
                    <td style={{ color: "var(--muted)", fontSize: "0.82rem" }}>{t.Notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-cards-list">
            {recent.map(t => (
              <div key={t.ID} className="tx-card">
                <div className="tx-card-left">
                  <div className="tx-card-cat">{t.Category}</div>
                  <div className="tx-card-meta"><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span><span className="tx-card-date">{t.Date}</span></div>
                  {t.Notes && <div className="tx-card-notes">{t.Notes}</div>}
                </div>
                <div className="tx-card-right">
                  <span className={`tx-card-amount amount ${t.Type.toLowerCase()}`}>{t.Type === "Income" ? "+" : "−"}₹{t.Amount.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {transactions.length === 0 && (
        <div className="empty"><div className="empty-icon"><Wallet size={48} strokeWidth={1.2} /></div><div className="empty-title">No transactions yet</div><div>Add your first income or expense to get started</div></div>
      )}
    </div>
  );
}

// ─── Add / Edit ───────────────────────────────────────────────────────────────
function AddPage({ onAdd, onUpdate, editTx }) {
  const getEmpty = () => ({ Date: dayjs().format("YYYY-MM-DD"), Type: "Expense", Category: "", Amount: "", Notes: "" });
  const [form, setForm] = useState(editTx || getEmpty());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    setForm(editTx || getEmpty());
    setErrors({});
  }, [editTx]);

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: "" })); };

  const validate = () => {
    const e = {};
    if (!form.Date) e.Date = "Date required";
    if (!form.Category.trim()) e.Category = "Category required";
    if (!form.Amount || isNaN(Number(form.Amount)) || Number(form.Amount) <= 0) e.Amount = "Enter a positive amount";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    console.log(form);
    const tx = { ...form, Amount: Number(form.Amount) };
    if (editTx) {
      onUpdate({ ...tx, ID: editTx.ID, CreatedAt: editTx.CreatedAt });
    } else {
      onAdd({ ...tx, ID: String(Date.now()), CreatedAt: new Date().toISOString() });
      setForm(getEmpty());
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">{editTx ? "Edit Transaction" : "Add Transaction"}</div>
        <div className="page-sub">{editTx ? `Editing ID: ${editTx.ID}` : "Record a new income or expense"}</div>
      </div>
      <div className="form-card">
        <div className="form-grid">
          <div className="form-group">
            <label>Date</label>
            <input type="date" value={form.Date} onChange={e => set("Date", e.target.value)} />
            {errors.Date && <span style={{ color: "var(--expense)", fontSize: "0.75rem" }}>{errors.Date}</span>}
          </div>
          <div className="form-group">
            <label>Type</label>
            <select value={form.Type} onChange={e => set("Type", e.target.value)}>
              <option value="Income">Income</option>
              <option value="Expense">Expense</option>
            </select>
          </div>
          <div className="form-group">
            <label>Category</label>
            <input type="text" placeholder="e.g. Food, Salary, Rent…" value={form.Category} onChange={e => set("Category", e.target.value)} />
            {errors.Category && <span style={{ color: "var(--expense)", fontSize: "0.75rem" }}>{errors.Category}</span>}
          </div>
          <div className="form-group">
            <label>Amount (₹)</label>
            <input type="number" min="0.01" step="0.01" placeholder="0.00" value={form.Amount} onChange={e => set("Amount", e.target.value)} />
            {errors.Amount && <span style={{ color: "var(--expense)", fontSize: "0.75rem" }}>{errors.Amount}</span>}
          </div>
          <div className="form-group full">
            <label>Notes (optional)</label>
            <textarea placeholder="Any additional details…" value={form.Notes} onChange={e => set("Notes", e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 22 }}>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {editTx ? <><CheckCheck size={16} /> Save Changes</> : <><PlusCircle size={16} /> Add Transaction</>}
          </button>
          {editTx && <button className="btn btn-secondary" onClick={() => onUpdate(null)}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

// ─── Transaction List ─────────────────────────────────────────────────────────
function ListPage({ transactions, onEdit, onDelete }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");

  const filtered = useMemo(() =>
    [...transactions]
      .filter(t => typeFilter === "All" || t.Type === typeFilter)
      .filter(t => !search || t.Category.toLowerCase().includes(search.toLowerCase()) || (t.Notes || "").toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => dayjs(b.Date).valueOf() - dayjs(a.Date).valueOf()),
    [transactions, search, typeFilter]
  );

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Transactions</div>
        <div className="page-sub">{transactions.length} total records</div>
      </div>

      <div className="filter-bar">
        <input className="search-input" type="text" placeholder="Search category or notes…" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="filter-buttons">
          {["All", "Income", "Expense"].map(t => (
            <button key={t} className={`filter-btn ${typeFilter === t ? "active" : ""}`} onClick={() => setTypeFilter(t)}>{t}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="empty-icon"><List size={48} strokeWidth={1.2} /></div>
          <div className="empty-title">No transactions found</div>
          <div>Try adjusting filters or add a new transaction</div>
        </div>
      ) : (
        <div className="table-wrap">
          <div className="table-header">
            <div className="table-title">All Transactions</div>
            <span style={{ color: "var(--muted)", fontSize: "0.8rem", fontFamily: "DM Mono, monospace" }}>{filtered.length} shown</span>
          </div>
          <div className="desktop-table">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Amount</th><th>Notes</th><th>Actions</th></tr></thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.ID}>
                    <td style={{ fontFamily: "DM Mono, monospace", fontSize: "0.82rem" }}>{t.Date}</td>
                    <td><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span></td>
                    <td>{t.Category}</td>
                    <td><span className={`amount ${t.Type.toLowerCase()}`}>{t.Type === "Income" ? "+" : "−"}₹{t.Amount.toLocaleString()}</span></td>
                    <td style={{ color: "var(--muted)", fontSize: "0.82rem", maxWidth: 200 }}>{t.Notes || "—"}</td>
                    <td>
                      <div className="actions">
                        <button className="btn-icon" onClick={() => onEdit(t)}><Pencil size={14} /></button>
                        <button className="btn-icon del" onClick={() => { if (confirm("Delete this transaction?")) onDelete(t.ID); }}><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-cards-list">
            {filtered.map(t => (
              <div key={t.ID} className="tx-card">
                <div className="tx-card-left">
                  <div className="tx-card-cat">{t.Category}</div>
                  <div className="tx-card-meta">
                    <span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span>
                    <span className="tx-card-date">{t.Date}</span>
                  </div>
                  {t.Notes && <div className="tx-card-notes">{t.Notes}</div>}
                </div>
                <div className="tx-card-right">
                  <span className={`tx-card-amount amount ${t.Type.toLowerCase()}`}>{t.Type === "Income" ? "+" : "−"}₹{t.Amount.toLocaleString()}</span>
                  <div className="actions">
                    <button className="btn-icon" onClick={() => onEdit(t)}><Pencil size={14} /></button>
                    <button className="btn-icon del" onClick={() => { if (confirm("Delete?")) onDelete(t.ID); }}><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reports ──────────────────────────────────────────────────────────────────
function ReportsPage({ transactions, toast }) {
  const [period, setPeriod] = useState("yearly");
  const [fromDate, setFromDate] = useState(dayjs().startOf("month").format("YYYY-MM-DD"));
  const [toDate, setToDate] = useState(dayjs().format("YYYY-MM-DD"));

  const filtered = useMemo(() => dateUtils.filterByPeriod(transactions, period, fromDate, toDate), [transactions, period, fromDate, toDate]);
  const income = filtered.filter(t => t.Type === "Income").reduce((s, t) => s + t.Amount, 0);
  const expense = filtered.filter(t => t.Type === "Expense").reduce((s, t) => s + t.Amount, 0);
  const net = income - expense;
  const fmt = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

  const catData = useMemo(() => {
    const map = {};
    filtered.filter(t => t.Type === "Expense").forEach(t => { map[t.Category] = (map[t.Category] || 0) + t.Amount; });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [filtered]);

  const handleDownload = () => {
    const start = period === "custom" ? fromDate : dayjs().startOf(period === "daily" ? "day" : period === "weekly" ? "week" : period === "monthly" ? "month" : "year").format("YYYY-MM-DD");
    const end = period === "custom" ? toDate : dayjs().format("YYYY-MM-DD");
    const wb = excelService.generateReport(filtered);
    const buf = excelService.toBuffer(wb);
    saveAs(new Blob([buf]), `report_${start}_${end}.xlsx`);
    toast("Report downloaded!", "success");
  };

  const periods = [
    { id: "daily", label: "Today" }, { id: "weekly", label: "This Week" },
    { id: "monthly", label: "This Month" }, { id: "yearly", label: "This Year" },
    { id: "custom", label: "Custom" },
  ];

  return (
    <div>
      <div className="page-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div><div className="page-title">Reports</div><div className="page-sub">Analyze your spending patterns</div></div>
        <button className="btn btn-success" onClick={handleDownload}><Download size={16} /> Download Excel Report</button>
      </div>

      <div className="filter-row">
        {periods.map(p => (
          <button key={p.id} className={`filter-btn ${period === p.id ? "active" : ""}`} onClick={() => setPeriod(p.id)}>{p.label}</button>
        ))}
        {period === "custom" && (
          <>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={{ maxWidth: 160 }} />
            <span style={{ color: "var(--muted)" }}>→</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={{ maxWidth: 160 }} />
          </>
        )}
      </div>

      <div className="cards">
        <div className="card"><div className="card-label">INCOME</div><div className="card-value income">{fmt(income)}</div><div className="card-sub">{filtered.filter(t => t.Type === "Income").length} entries</div></div>
        <div className="card"><div className="card-label">EXPENSE</div><div className="card-value expense">{fmt(expense)}</div><div className="card-sub">{filtered.filter(t => t.Type === "Expense").length} entries</div></div>
        <div className="card"><div className="card-label">NET BALANCE</div><div className={`card-value net ${net >= 0 ? "pos" : "neg"}`}>{fmt(net)}</div><div className="card-sub">{net >= 0 ? "Surplus" : "Deficit"}</div></div>
        <div className="card"><div className="card-label">TRANSACTIONS</div><div className="card-value" style={{ color: "var(--accent)" }}>{filtered.length}</div><div className="card-sub">In this period</div></div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty"><div className="empty-icon"><BarChart2 size={48} strokeWidth={1.2} /></div><div className="empty-title">No data for this period</div><div>Try a different time range</div></div>
      ) : (
        <>
          <div className="charts-grid">
            <div className="chart-card">
              <div className="chart-title">Income vs Expense</div>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={[{ name: "Income", value: income }, { name: "Expense", value: expense }]} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={5} dataKey="value">
                    <Cell fill="#4df7c8" /><Cell fill="#f74d8a" />
                  </Pie>
                  <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#7c6af7", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, color: "#f0eeff" }} />
                  <Legend formatter={v => <span style={{ color: "#f0eeff", fontSize: "0.8rem" }}>{v}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="chart-card">
              <div className="chart-title">Expense by Category</div>
              {catData.length === 0 ? <div className="loading">No expense data</div> : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={catData} margin={{ top: 0, right: 0, left: 0, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="name" tick={{ fill: "rgba(240,238,255,0.45)", fontSize: 10 }} angle={-30} textAnchor="end" interval={0} />
                    <YAxis tick={{ fill: "rgba(240,238,255,0.45)", fontSize: 11 }} />
                    <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1a1a26", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, color: "#f0eeff" }} />
                    <Bar dataKey="value" fill="#f74d8a" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop: 24 }}>
            <div className="table-header"><div className="table-title">Transactions in Period</div></div>
            <div className="desktop-table">
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Amount</th><th>Notes</th></tr></thead>
                <tbody>
                  {filtered.map(t => (
                    <tr key={t.ID}>
                      <td style={{ fontFamily: "DM Mono, monospace", fontSize: "0.82rem" }}>{t.Date}</td>
                      <td><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span></td>
                      <td>{t.Category}</td>
                      <td><span className={`amount ${t.Type.toLowerCase()}`}>{t.Type === "Income" ? "+" : "−"}₹{t.Amount.toLocaleString()}</span></td>
                      <td style={{ color: "var(--muted)", fontSize: "0.82rem" }}>{t.Notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-cards-list">
              {filtered.map(t => (
                <div key={t.ID} className="tx-card">
                  <div className="tx-card-left">
                    <div className="tx-card-cat">{t.Category}</div>
                    <div className="tx-card-meta"><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span><span className="tx-card-date">{t.Date}</span></div>
                    {t.Notes && <div className="tx-card-notes">{t.Notes}</div>}
                  </div>
                  <div className="tx-card-right">
                    <span className={`tx-card-amount amount ${t.Type.toLowerCase()}`}>{t.Type === "Income" ? "+" : "−"}₹{t.Amount.toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
