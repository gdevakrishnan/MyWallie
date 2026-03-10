import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";
import weekOfYear from "dayjs/plugin/weekOfYear";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import {
  LayoutDashboard, PlusCircle, List, BarChart2, FolderOpen,
  FilePlus, CheckCircle, XCircle, Info, Pencil, Trash2,
  FileSpreadsheet, Wallet, CheckCheck, Download, Upload,
  Share2, RefreshCw,
} from "lucide-react";
import { Share } from "@capacitor/share";

dayjs.extend(isBetween);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);
dayjs.extend(weekOfYear);

// ─── Platform ─────────────────────────────────────────────────────────────────
const IS_NATIVE = (() => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
})();
const MOBILE_FILE      = "mywallie_data.xlsx";
const MOBILE_READY_KEY = "mywallie_ready";

const safeLS = {
  get: (k)    => { try { return localStorage.getItem(k); }    catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); }        catch {} },
  del: (k)    => { try { localStorage.removeItem(k); }         catch {} },
};

// ─── IndexedDB ────────────────────────────────────────────────────────────────
const WEB_IDB_DB   = "mywallie_db";
const WEB_IDB_DATA = "data";

function openWebIDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(WEB_IDB_DB, 4);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(WEB_IDB_DATA)) db.createObjectStore(WEB_IDB_DATA);
    };
    r.onsuccess = (e) => res(e.target.result);
    r.onerror   = () => rej(r.error);
  });
}

async function idbPut(key, value) {
  try {
    const db = await openWebIDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(WEB_IDB_DATA, "readwrite");
      tx.objectStore(WEB_IDB_DATA).put(typeof value === "string" ? value : JSON.stringify(value), key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch {}
}

async function idbGet(key) {
  try {
    const db = await openWebIDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(WEB_IDB_DATA, "readonly");
      const req = tx.objectStore(WEB_IDB_DATA).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => rej(req.error);
    });
  } catch { return null; }
}

async function idbSave(transactions) { await idbPut("transactions", transactions); }
async function idbLoad() {
  const raw = await idbGet("transactions");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function idbSaveMeta(fileName, synced = false) {
  await idbPut("fileName", fileName);
  await idbPut("synced", synced ? "1" : "0");
}
async function idbLoadMeta() {
  const [name, synced] = await Promise.all([idbGet("fileName"), idbGet("synced")]);
  return { name: name || "", synced: synced === "1" };
}

async function idbClear() {
  try {
    const db = await openWebIDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(WEB_IDB_DATA, "readwrite");
      tx.objectStore(WEB_IDB_DATA).clear();
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch {}
}

// ─── Mobile storage ───────────────────────────────────────────────────────────
const mobileStorage = {
  async load() {
    try {
      const { data } = await Filesystem.readFile({ path: MOBILE_FILE, directory: Directory.Data });
      const binary = atob(data);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return excelService.parse(bytes.buffer);
    } catch { return []; }
  },
  async save(transactions) {
    const base64 = toBase64(excelService.toBuffer(excelService.createWorkbook(transactions)));
    await Filesystem.writeFile({ path: MOBILE_FILE, data: base64, directory: Directory.Data, recursive: true });
  },
  async clear() {
    try { await Filesystem.deleteFile({ path: MOBILE_FILE, directory: Directory.Data }); } catch {}
    safeLS.del(MOBILE_READY_KEY);
  },
  async shareReport(reportTransactions, fileName) {
    const base64 = toBase64(excelService.toBuffer(excelService.generateReport(reportTransactions)));
    await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
    await Share.share({ title: "MyWallie Report", url: uri, dialogTitle: "Share / Save Report" });
  },
};

function toBase64(buf) {
  return btoa(new Uint8Array(buf).reduce((d, b) => d + String.fromCharCode(b), ""));
}

// ─── Excel Service ────────────────────────────────────────────────────────────
const SHEET_NAME = "Transactions";
const HEADERS    = ["ID", "Date", "Type", "Category", "Amount", "Notes", "CreatedAt"];

const excelService = {
  createWorkbook(transactions = []) {
    const wb   = XLSX.utils.book_new();
    const rows = [HEADERS, ...transactions.map(t => [t.ID, t.Date, t.Type, t.Category, t.Amount, t.Notes, t.CreatedAt])];
    const ws   = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch:15 },{ wch:12 },{ wch:10 },{ wch:15 },{ wch:12 },{ wch:30 },{ wch:20 }];
    XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
    return wb;
  },
  toBuffer(wb) { return XLSX.write(wb, { bookType:"xlsx", type:"array" }); },
  parse(buf) {
    const wb = XLSX.read(new Uint8Array(buf), { type:"array" });
    const ws = wb.Sheets[SHEET_NAME];
    if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found`);
    const rows = XLSX.utils.sheet_to_json(ws, { header:1 });
    if (rows.length <= 1) return [];
    return rows.slice(1).filter(r => r[0]).map(r => ({
      ID:        String(r[0]||""),
      Date:      r[1] ? String(r[1]) : dayjs().format("YYYY-MM-DD"),
      Type:      r[2]||"Expense",
      Category:  r[3]||"",
      Amount:    Number(r[4])||0,
      Notes:     r[5]||"",
      CreatedAt: r[6]||new Date().toISOString(),
    }));
  },
  // Full overwrite of the picked file handle
  async writeToHandle(handle, transactions) {
    const buf      = this.toBuffer(this.createWorkbook(transactions));
    const writable = await handle.createWritable();
    await writable.write(new Blob([buf], { type:"application/octet-stream" }));
    await writable.close();
  },
  downloadFile(transactions, filename = "expenses.xlsx") {
    const buf = this.toBuffer(this.createWorkbook(transactions));
    saveAs(new Blob([buf], { type:"application/octet-stream" }), filename);
  },
  generateReport(transactions) {
    const wb      = XLSX.utils.book_new();
    const income  = transactions.filter(t => t.Type==="Income").reduce((s,t) => s+t.Amount, 0);
    const expense = transactions.filter(t => t.Type==="Expense").reduce((s,t) => s+t.Amount, 0);
    const rows    = [
      HEADERS,
      ...transactions.map(t => [t.ID, t.Date, t.Type, t.Category, t.Amount, t.Notes, t.CreatedAt]),
      [], ["Summary"], ["Total Income", income], ["Total Expense", expense], ["Net Balance", income-expense],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch:15 },{ wch:12 },{ wch:10 },{ wch:15 },{ wch:12 },{ wch:30 },{ wch:20 }];
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
      if (period==="daily")   return d.isSame(today, "day");
      if (period==="weekly")  return d.isSame(today, "week");
      if (period==="monthly") return d.isSame(today, "month");
      if (period==="yearly")  return d.isSame(today, "year");
      if (period==="custom" && from && to)
        return d.isSameOrAfter(dayjs(from), "day") && d.isSameOrBefore(dayjs(to), "day");
      return true;
    });
  },
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--surface3:#22223a;
    --border:rgba(255,255,255,0.08);--accent:#7c6af7;--text:#f0eeff;
    --muted:rgba(240,238,255,0.45);--income:#4df7c8;--expense:#f74d8a;
    --radius:16px;--radius-sm:10px;
  }
  body{background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;min-height:100vh}
  .app{display:flex;min-height:100vh}

  .sidebar{width:240px;min-height:100vh;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:28px 16px;position:sticky;top:0;height:100vh;overflow:hidden;flex-shrink:0}
  .logo{font-size:1.3rem;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px}
  .logo span{color:var(--accent)}
  .logo-sub{font-size:0.7rem;color:var(--muted);font-family:'DM Mono',monospace;margin-bottom:36px;letter-spacing:0.1em}
  .nav{display:flex;flex-direction:column;gap:4px;flex:1}
  .nav-item{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:var(--radius-sm);transition:all 0.18s;color:var(--muted);font-weight:500;font-size:0.88rem;border:none;background:none;text-align:left;width:100%}
  .nav-item:hover{background:var(--surface2);color:var(--text)}
  .nav-item.active{background:var(--accent);color:#fff}

  .bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;z-index:100;background:var(--surface);border-top:1px solid var(--border);padding:6px 0 max(8px,env(safe-area-inset-bottom));justify-content:space-around;align-items:stretch}
  .bottom-nav-item{display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 8px;border:none;background:none;color:var(--muted);font-family:'Syne',sans-serif;font-size:0.6rem;font-weight:600;transition:color 0.15s;flex:1;min-width:0}
  .bottom-nav-item.active{color:var(--accent)}

  .file-zone{margin-top:24px;border-top:1px solid var(--border);padding-top:16px}
  .file-zone-label{font-size:0.7rem;color:var(--muted);font-family:'DM Mono',monospace;letter-spacing:0.1em;margin-bottom:10px}
  .file-btn{width:100%;padding:9px 12px;border-radius:var(--radius-sm);background:var(--surface2);border:1px dashed var(--border);color:var(--muted);font-size:0.8rem;font-family:'Syne',sans-serif;transition:all 0.18s;display:flex;align-items:center;gap:8px}
  .file-btn:hover{border-color:var(--accent);color:var(--accent)}
  .file-btn:disabled{opacity:0.5;cursor:not-allowed}
  .file-btn.danger{border-color:rgba(247,77,138,0.3);color:var(--expense)}
  .file-btn.danger:hover{border-color:var(--expense);background:rgba(247,77,138,0.1)}
  .storage-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:100px;font-size:0.7rem;font-family:'DM Mono',monospace;font-weight:600;background:rgba(77,247,200,0.1);color:var(--income);border:1px solid rgba(77,247,200,0.2);margin-top:6px}
  .unsynced-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:100px;font-size:0.7rem;font-family:'DM Mono',monospace;font-weight:600;background:rgba(247,77,138,0.1);color:var(--expense);border:1px solid rgba(247,77,138,0.25);margin-top:6px}

  .main{flex:1;padding:36px 40px;overflow-x:hidden;min-width:0}
  .page-header{margin-bottom:32px}
  .page-title{font-size:1.9rem;font-weight:800;letter-spacing:-0.04em}
  .page-sub{color:var(--muted);font-size:0.85rem;margin-top:4px}

  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px;transition:transform 0.18s}
  .card:hover{transform:translateY(-2px)}
  .card-label{font-size:0.72rem;color:var(--muted);font-family:'DM Mono',monospace;letter-spacing:0.1em;margin-bottom:10px}
  .card-value{font-size:1.6rem;font-weight:800;letter-spacing:-0.04em;word-break:break-all}
  .card-value.income{color:var(--income)}
  .card-value.expense{color:var(--expense)}
  .card-value.net.pos{color:var(--income)}
  .card-value.net.neg{color:var(--expense)}
  .card-sub{font-size:0.75rem;color:var(--muted);margin-top:6px}

  .table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
  .table-header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border);gap:12px;flex-wrap:wrap}
  .table-header-left{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
  .table-header-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
  .table-title{font-weight:700;font-size:1rem}
  .desktop-table table{width:100%;border-collapse:collapse}
  .desktop-table th{padding:13px 18px;text-align:left;font-size:0.72rem;color:var(--muted);font-family:'DM Mono',monospace;letter-spacing:0.1em;border-bottom:1px solid var(--border);background:var(--surface2)}
  .desktop-table td{padding:13px 18px;font-size:0.88rem;border-bottom:1px solid var(--border)}
  .desktop-table tr:last-child td{border-bottom:none}
  .desktop-table tr:hover td{background:var(--surface2)}

  .mobile-cards-list{display:none}
  .tx-card{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .tx-card:last-child{border-bottom:none}
  .tx-card-left{flex:1;min-width:0}
  .tx-card-cat{font-weight:700;font-size:0.92rem;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tx-card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .tx-card-date{font-size:0.7rem;color:var(--muted);font-family:'DM Mono',monospace}
  .tx-card-notes{font-size:0.73rem;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
  .tx-card-right{display:flex;flex-direction:column;align-items:flex-end;gap:10px;flex-shrink:0}
  .tx-card-amount{font-family:'DM Mono',monospace;font-weight:700;font-size:0.95rem}

  .badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:100px;font-size:0.7rem;font-weight:600;font-family:'DM Mono',monospace}
  .badge.income{background:rgba(77,247,200,0.12);color:var(--income)}
  .badge.expense{background:rgba(247,77,138,0.12);color:var(--expense)}
  .amount.income{color:var(--income);font-weight:700;font-family:'DM Mono',monospace}
  .amount.expense{color:var(--expense);font-weight:700;font-family:'DM Mono',monospace}
  .actions{display:flex;gap:8px}
  .btn-icon{background:var(--surface3);border:none;border-radius:8px;padding:7px 10px;font-size:0.85rem;transition:all 0.15s;color:var(--muted)}
  .btn-icon:hover{background:var(--accent);color:#fff}
  .btn-icon.del:hover{background:var(--expense);color:#fff}

  .form-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:28px;max-width:560px}
  .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .form-group{display:flex;flex-direction:column;gap:7px}
  .form-group.full{grid-column:1/-1}
  label{font-size:0.75rem;color:var(--muted);font-family:'DM Mono',monospace;letter-spacing:0.08em}
  input,select,textarea{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:11px 14px;font-family:'Syne',sans-serif;font-size:0.88rem;transition:border-color 0.15s;outline:none;width:100%}
  input:focus,select:focus,textarea:focus{border-color:var(--accent)}
  select option{background:var(--surface2)}
  textarea{resize:vertical;min-height:80px}

  .btn{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:var(--radius-sm);border:none;font-family:'Syne',sans-serif;font-weight:700;font-size:0.88rem;transition:all 0.18s}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-primary:hover{background:#6a58e5;transform:translateY(-1px)}
  .btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
  .btn-secondary:hover{background:var(--surface3)}
  .btn-success{background:var(--income);color:#000}
  .btn-success:hover{filter:brightness(0.9)}

  .btn-sm{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:var(--radius-sm);border:none;font-family:'Syne',sans-serif;font-weight:700;font-size:0.82rem;transition:all 0.18s;white-space:nowrap}
  .btn-sm:disabled{opacity:0.5;cursor:not-allowed;transform:none!important}
  .btn-sync{background:rgba(124,106,247,0.14);color:var(--accent);border:1px solid rgba(124,106,247,0.3)}
  .btn-sync:hover:not(:disabled){background:var(--accent);color:#fff;transform:translateY(-1px)}
  .btn-sync.has-changes{background:rgba(124,106,247,0.22);border-color:var(--accent);animation:pulse-ring 2s infinite}
  .btn-dl{background:rgba(77,247,200,0.1);color:var(--income);border:1px solid rgba(77,247,200,0.25)}
  .btn-dl:hover{background:var(--income);color:#000;transform:translateY(-1px)}
  @keyframes pulse-ring{0%,100%{box-shadow:0 0 0 2px rgba(124,106,247,0.2)}50%{box-shadow:0 0 0 7px rgba(124,106,247,0)}}
  @keyframes spin{to{transform:rotate(360deg)}}

  .unsynced-dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--expense);animation:blink-dot 1.3s ease-in-out infinite;flex-shrink:0}
  @keyframes blink-dot{0%,100%{opacity:1}50%{opacity:0.2}}

  .sync-hint{padding:9px 22px;border-bottom:1px solid var(--border);font-size:0.72rem;color:var(--muted);font-family:'DM Mono',monospace;display:flex;align-items:center;gap:7px;background:rgba(124,106,247,0.04)}

  .toast-wrap{position:fixed;bottom:28px;right:28px;z-index:999;display:flex;flex-direction:column;gap:10px}
  .toast{padding:13px 18px;border-radius:var(--radius-sm);font-size:0.85rem;font-weight:600;animation:slideIn 0.25s ease;min-width:240px;max-width:320px;display:flex;align-items:center;gap:10px}
  .toast.success{background:var(--income);color:#000}
  .toast.error{background:var(--expense);color:#fff}
  .toast.info{background:var(--accent);color:#fff}
  @keyframes slideIn{from{transform:translateX(60px);opacity:0}to{transform:none;opacity:1}}

  .filter-row{display:flex;align-items:center;gap:10px;margin-bottom:24px;flex-wrap:wrap}
  .filter-bar{display:flex;gap:12px;margin-bottom:20px;align-items:center;flex-wrap:wrap}
  .search-input{flex:1;min-width:180px;max-width:260px}
  .filter-buttons{display:flex;gap:8px;flex-wrap:wrap}
  .filter-btn{padding:8px 14px;border-radius:100px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-family:'Syne',sans-serif;font-size:0.8rem;font-weight:600;transition:all 0.15s}
  .filter-btn.active{background:var(--accent);border-color:var(--accent);color:#fff}
  .filter-btn:hover:not(.active){border-color:var(--accent);color:var(--accent)}

  .charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:28px}
  .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px}
  .chart-title{font-weight:700;font-size:0.95rem;margin-bottom:18px}

  .empty{text-align:center;padding:60px 20px;color:var(--muted)}
  .empty-icon{margin-bottom:16px;color:var(--muted);opacity:0.6}
  .empty-title{font-size:1.1rem;font-weight:700;color:var(--text);margin-bottom:8px}
  .loading{display:flex;align-items:center;justify-content:center;height:200px;color:var(--muted);font-family:'DM Mono',monospace;font-size:0.85rem}

  ::-webkit-scrollbar{width:6px;height:6px}
  ::-webkit-scrollbar-track{background:var(--bg)}
  ::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:3px}

  /* Welcome screen */
  .welcome-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:72vh;padding:0 20px;text-align:center}
  .welcome-icon{color:var(--accent);margin-bottom:24px}
  .welcome-title{font-size:2rem;font-weight:800;letter-spacing:-0.04em;margin-bottom:10px}
  .welcome-sub{color:var(--muted);font-size:0.9rem;line-height:1.75;margin-bottom:44px;max-width:400px}
  .welcome-choices{display:grid;grid-template-columns:1fr 1fr;gap:16px;width:100%;max-width:480px}
  .welcome-choice{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--radius);padding:32px 22px;transition:all 0.22s;display:flex;flex-direction:column;align-items:center;gap:14px}
  .welcome-choice:hover{border-color:var(--accent);transform:translateY(-4px);box-shadow:0 12px 40px rgba(124,106,247,0.18)}
  .welcome-choice-icon{color:var(--accent)}
  .welcome-choice-title{font-size:1rem;font-weight:800}
  .welcome-choice-sub{font-size:0.78rem;color:var(--muted);line-height:1.6;text-align:center}

  /* Mobile setup */
  .setup-wrap{max-width:460px;margin:60px auto 0;text-align:center;padding:0 16px}
  .setup-icon{margin-bottom:20px;color:var(--accent)}
  .setup-title{font-size:1.5rem;font-weight:800;margin-bottom:8px}
  .setup-sub{color:var(--muted);font-size:0.88rem;margin-bottom:36px;line-height:1.7}
  .setup-choices{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .setup-choice{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:28px 18px;transition:all 0.2s;text-align:center;display:flex;flex-direction:column;align-items:center}
  .setup-choice:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 8px 32px rgba(124,106,247,0.15)}
  .setup-choice-icon{margin-bottom:14px;color:var(--accent)}
  .setup-choice-title{font-size:0.95rem;font-weight:700;margin-bottom:6px}
  .setup-choice-sub{font-size:0.78rem;color:var(--muted);line-height:1.5}

  @media (max-width:768px){
    .sidebar{display:none}
    .bottom-nav{display:flex}
    .main{padding:20px 16px 90px}
    .page-title{font-size:1.45rem}
    .cards{grid-template-columns:1fr 1fr;gap:12px}
    .card{padding:14px 16px}
    .card-value{font-size:1.2rem}
    .desktop-table{display:none}
    .mobile-cards-list{display:block}
    .charts-grid{grid-template-columns:1fr}
    .form-grid{grid-template-columns:1fr}
    .form-card{padding:20px 16px;max-width:100%}
    .filter-btn{padding:7px 11px;font-size:0.75rem}
    .toast-wrap{bottom:76px;right:12px;left:12px}
    .toast{min-width:unset}
    .filter-bar{flex-direction:column;align-items:stretch}
    .search-input{max-width:100%}
    .filter-buttons{justify-content:space-between}
    .filter-buttons .filter-btn{flex:1}
    .welcome-choices{grid-template-columns:1fr}
    .setup-choices{grid-template-columns:1fr}
    .table-header{flex-direction:column;align-items:flex-start}
    .btn-sm{padding:7px 12px;font-size:0.75rem}
    .welcome-title{font-size:1.5rem}
  }
  @media (max-width:400px){
    .cards{grid-template-columns:1fr}
  }

  /* ── Modal ── */
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)}
  .modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:32px;max-width:420px;width:100%;animation:modalIn 0.2s ease}
  @keyframes modalIn{from{transform:scale(0.92);opacity:0}to{transform:none;opacity:1}}
  .modal-title{font-size:1.1rem;font-weight:800;margin-bottom:10px}
  .modal-body{color:var(--muted);font-size:0.88rem;line-height:1.7;margin-bottom:26px}
  .modal-actions{display:flex;gap:10px;justify-content:flex-end}
  .btn-danger{background:var(--expense);color:#fff;display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:var(--radius-sm);border:none;font-family:'Syne',sans-serif;font-weight:700;font-size:0.88rem;transition:all 0.18s}
  .btn-danger:hover{filter:brightness(0.88)}

`;

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ toasts }) {
  return (
    <div className="toast-wrap">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>
          {t.type==="success" ? <CheckCircle size={16}/> : t.type==="error" ? <XCircle size={16}/> : <Info size={16}/>}
          {t.msg}
        </div>
      ))}
    </div>
  );
}


// ─── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, body, confirmLabel = "Confirm", confirmClass = "btn-danger", onConfirm, onCancel, cancelLabel = "Cancel" }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="modal-overlay" onClick={e=>{ if(e.target===e.currentTarget) onCancel(); }}>
      <div className="modal">
        <div className="modal-title">{title}</div>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>{cancelLabel}</button>
          <button className={confirmClass} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Welcome Screen ───────────────────────────────────────────────────────────
function WelcomeScreen({ onNew, onOpen }) {
  return (
    <div className="welcome-wrap">
      <div className="welcome-icon"><FileSpreadsheet size={60} strokeWidth={1.2}/></div>
      <div className="welcome-title">Welcome to MyWallie</div>
      <div className="welcome-sub">
        Track income and expenses. Start fresh or load an existing file.
      </div>
      <div className="welcome-choices">
        <div className="welcome-choice" onClick={onNew}>
          <div className="welcome-choice-icon"><FilePlus size={44} strokeWidth={1.3}/></div>
          <div className="welcome-choice-title">New File</div>
          <div className="welcome-choice-sub">
            Start with a blank slate. Add transactions, then hit <strong>Sync to File</strong> to write them into an Excel file.
          </div>
        </div>
        <div className="welcome-choice" onClick={onOpen}>
          <div className="welcome-choice-icon"><FolderOpen size={44} strokeWidth={1.3}/></div>
          <div className="welcome-choice-title">Open Existing File</div>
          <div className="welcome-choice-sub">
            Pick a <strong>.xlsx</strong> — all data loads instantly. Hit <strong>Sync to File</strong> anytime to write changes back.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Mobile Setup ─────────────────────────────────────────────────────────────
function MobileSetupScreen({ onNew, onImport }) {
  return (
    <div className="setup-wrap">
      <div className="setup-icon"><FileSpreadsheet size={56} strokeWidth={1.2}/></div>
      <div className="setup-title">Welcome to MyWallie</div>
      <div className="setup-sub">
        Your data lives inside the app and saves automatically.<br/>
        Start fresh or bring in an existing Excel file.
      </div>
      <div className="setup-choices">
        <div className="setup-choice" onClick={onNew}>
          <div className="setup-choice-icon"><FilePlus size={38} strokeWidth={1.4}/></div>
          <div className="setup-choice-title">New File</div>
          <div className="setup-choice-sub">Start fresh. Saves automatically.</div>
        </div>
        <div className="setup-choice" onClick={onImport}>
          <div className="setup-choice-icon"><Upload size={38} strokeWidth={1.4}/></div>
          <div className="setup-choice-title">Import Excel</div>
          <div className="setup-choice-sub">Pick an existing .xlsx from your device.</div>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage]                 = useState("dashboard");
  const [transactions, setTransactions] = useState([]);
  const [status, setStatus]             = useState("restoring");
  // "restoring"    → startup
  // "welcome"      → show New / Open choices
  // "mobile-setup" → Android first launch
  // "ready"        → working

  const [fileName, setFileName]     = useState("");
  const [toasts, setToasts]         = useState([]);
  const [editTx, setEditTx]         = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [syncing, setSyncing]       = useState(false);
  const [modal, setModal]           = useState(null);
  // modal: { title, body, confirmLabel, confirmClass, onConfirm, cancelLabel }

  const importInputRef = useRef();

  const showModal = useCallback((opts) => setModal(opts), []);
  const closeModal = useCallback(() => setModal(null), []);

  const toast = useCallback((msg, type = "success") => {
    const id = Date.now();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3200);
  }, []);

  // ── Startup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      if (IS_NATIVE) {
        const isReady = safeLS.get(MOBILE_READY_KEY);
        if (!isReady) { setStatus("mobile-setup"); return; }
        const parsed = await mobileStorage.load();
        setTransactions(parsed);
        setStatus("ready");
        if (parsed.length > 0) toast(`${parsed.length} records loaded`, "success");
        return;
      }
      // Web: try to restore from IDB on refresh
      const [savedData, meta] = await Promise.all([idbLoad(), idbLoadMeta()]);
      if (savedData !== null) {
        setTransactions(savedData);
        setFileName(meta.name || "");
        setHasChanges(!meta.synced);   // only unsynced if not previously synced
        setStatus("ready");
        if (savedData.length > 0) toast(`Restored ${savedData.length} records`, "info");
      } else {
        setStatus("welcome");
      }
    })();
  }, []);

  // ── beforeunload — warn if unsynced changes ─────────────────────────────
  useEffect(() => {
    if (IS_NATIVE) return;
    const handler = (e) => {
      if (hasChanges) {
        e.preventDefault();
        e.returnValue = "You have unsynced changes. Leave anyway?";
        return e.returnValue;
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasChanges]);

  // ── persist — saves to IDB only ───────────────────────────────────────────
  const persist = useCallback(async (txList) => {
    if (IS_NATIVE) {
      try { await mobileStorage.save(txList); }
      catch (err) { toast("Auto-save failed: " + err.message, "error"); }
      return;
    }
    await idbSave(txList);
    await idbSaveMeta(await idbGet("fileName") || "", false);
    setHasChanges(true);
  }, [toast]);

  // ─────────────────────────────────────────────────────────────────────────
  // handleOpenExisting — picks file, reads data, goes to ready
  // ─────────────────────────────────────────────────────────────────────────
  const handleOpenExisting = useCallback(async () => {
    if (!("showOpenFilePicker" in window)) {
      toast("File picker not supported in this browser", "error");
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description:"Excel Files", accept:{ "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":[".xlsx"] } }],
        multiple: false,
      });
      const file   = await handle.getFile();
      const parsed = excelService.parse(await file.arrayBuffer());
      setFileName(file.name);
      setTransactions(parsed);
      await idbSave(parsed);
      await idbSaveMeta(file.name, true);
      setHasChanges(false);
      setStatus("ready");
      toast(`Loaded "${file.name}" — ${parsed.length} records`, "success");
    } catch (err) {
      if (err.name !== "AbortError") toast("Failed to open file: " + err.message, "error");
    }
  }, [toast]);

  // ─────────────────────────────────────────────────────────────────────────
  // handleNewFile — blank, no file linked
  // ─────────────────────────────────────────────────────────────────────────
  const handleNewFile = useCallback(async () => {
    await idbClear();
    setFileName("");
    setTransactions([]);
    setHasChanges(false);
    setStatus("ready");
    toast("New file ready — add your first transaction!", "success");
  }, [toast]);

  // ── Switch File — back to welcome, clear everything ───────────────────────
  const handleSwitchFile = useCallback(() => {
    const doSwitch = async () => {
      closeModal();
      await idbClear();
      setTransactions([]);
      setFileName("");
      setHasChanges(false);
      setStatus("welcome");
    };
    if (hasChanges) {
      showModal({
        title: "Unsynced Changes",
        body: "You have unsynced changes that will be lost if you switch files. Continue anyway?",
        confirmLabel: "Switch Anyway",
        confirmClass: "btn-danger",
        onConfirm: doSwitch,
      });
    } else {
      doSwitch();
    }
  }, [hasChanges, showModal, closeModal]);

  // ─────────────────────────────────────────────────────────────────────────
  // handleSync — opens Save picker every click, user picks file, we write directly
  // Uses showSaveFilePicker (writable handle, no stale-state issues)
  // ─────────────────────────────────────────────────────────────────────────
  const handleSync = useCallback(async (currentTransactions) => {
    if (!("showSaveFilePicker" in window)) {
      excelService.downloadFile(currentTransactions, fileName || "expenses.xlsx");
      toast("Saved as download (file picker not supported in this browser)", "info");
      return;
    }

    setSyncing(true);
    try {
      // Open Save picker — opens in the folder of the last synced file if available
      const opts = {
        suggestedName: fileName || "expenses.xlsx",
        types: [{ description:"Excel Files", accept:{ "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":[".xlsx"] } }],
      };
      // startIn: "downloads" as fallback, or try to open near last file
      try { opts.startIn = "downloads"; } catch {}

      const handle = await window.showSaveFilePicker(opts);

      const buf      = excelService.toBuffer(excelService.createWorkbook(currentTransactions));
      const writable = await handle.createWritable();
      await writable.write(new Blob([buf], { type:"application/octet-stream" }));
      await writable.close();

      setFileName(handle.name);
      await idbSaveMeta(handle.name, true);
      setHasChanges(false);
      toast(`✓ Saved to "${handle.name}" — ${currentTransactions.length} rows`, "success");
    } catch (err) {
      if (err.name !== "AbortError") toast("Sync failed: " + err.message, "error");
    }
    setSyncing(false);
  }, [fileName, toast]);

  // ── handleDownload ────────────────────────────────────────────────────────
  const handleDownload = useCallback((currentTransactions) => {
    excelService.downloadFile(currentTransactions, fileName || "expenses.xlsx");
    toast("Downloaded!", "success");
  }, [fileName, toast]);

  // ── Android ───────────────────────────────────────────────────────────────
  const handleMobileNew = useCallback(async () => {
    try {
      await mobileStorage.save([]);
      safeLS.set(MOBILE_READY_KEY, "1");
      setTransactions([]);
      setStatus("ready");
      toast("New file ready!", "success");
    } catch (err) { toast("Setup failed: " + err.message, "error"); }
  }, [toast]);

  const triggerImport = useCallback(() => { importInputRef.current?.click(); }, []);

  const handleImportChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const parsed = excelService.parse(await file.arrayBuffer());
      await mobileStorage.save(parsed);
      safeLS.set(MOBILE_READY_KEY, "1");
      setTransactions(parsed);
      setFileName(file.name);
      setStatus("ready");
      toast(`Imported "${file.name}" — ${parsed.length} records`, "success");
    } catch (err) { toast("Import failed: " + err.message, "error"); }
  }, [toast]);

  const handleMobileReset = useCallback(async () => {
    showModal({
      title: "Reset All Data",
      body: "This will permanently delete ALL transactions and cannot be undone. Are you sure?",
      confirmLabel: "Yes, Delete All",
      confirmClass: "btn-danger",
      onConfirm: async () => {
        closeModal();
        await mobileStorage.clear();
        setTransactions([]);
        setFileName("");
        setStatus("mobile-setup");
        toast("All data cleared", "info");
      },
    });
    return;
    await mobileStorage.clear();
    setTransactions([]);
    setFileName("");
    setStatus("mobile-setup");
    toast("All data cleared", "info");
  }, [toast]);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const addTransaction = useCallback((tx) => {
    setTransactions(prev => {
      const next = [...prev, tx];
      persist(next);
      return next;
    });
    toast("Transaction saved", "success");
  }, [persist, toast]);

  const updateTransaction = useCallback((tx) => {
    if (!tx) { setEditTx(null); return; }
    setTransactions(prev => {
      const next = prev.map(t => t.ID === tx.ID ? tx : t);
      persist(next);
      return next;
    });
    setEditTx(null);
    toast("Transaction updated", "success");
  }, [persist, toast]);

  const confirmDelete = useCallback((id) => {
    showModal({
      title: "Delete Transaction",
      body: "Are you sure you want to delete this transaction? This cannot be undone.",
      confirmLabel: "Delete",
      confirmClass: "btn-danger",
      onConfirm: () => {
        closeModal();
        setTransactions(prev => {
          const next = prev.filter(t => t.ID !== id);
          persist(next);
          return next;
        });
        toast("Deleted", "success");
      },
    });
  }, [showModal, closeModal, persist, toast]);

  const summary = useMemo(() => {
    const income  = transactions.filter(t=>t.Type==="Income").reduce((s,t)=>s+t.Amount,0);
    const expense = transactions.filter(t=>t.Type==="Expense").reduce((s,t)=>s+t.Amount,0);
    return { income, expense, net: income-expense, count: transactions.length };
  }, [transactions]);

  const navItems = [
    { id:"dashboard", icon:LayoutDashboard, label:"Dashboard" },
    { id:"add",       icon:PlusCircle,      label:"New Transaction" },
    { id:"list",      icon:List,            label:"Transactions" },
    { id:"reports",   icon:BarChart2,       label:"Reports" },
  ];
  const goPage = (id) => { if (id!=="add") setEditTx(null); setPage(id); };

  // ── Render ────────────────────────────────────────────────────────────────
  let mainContent;

  if (status === "restoring") {
    mainContent = <div className="loading" style={{ height:"60vh" }}>Loading…</div>;
  } else if (IS_NATIVE && status === "mobile-setup") {
    mainContent = <MobileSetupScreen onNew={handleMobileNew} onImport={triggerImport}/>;
  } else if (!IS_NATIVE && status === "welcome") {
    mainContent = <WelcomeScreen onNew={handleNewFile} onOpen={handleOpenExisting}/>;
  } else {
    if      (page==="dashboard") mainContent = <DashboardPage summary={summary} transactions={transactions}/>;
    else if (page==="add")       mainContent = <AddPage onAdd={addTransaction} onUpdate={updateTransaction} editTx={editTx} transactions={transactions}/>;
    else if (page==="list")      mainContent = (
      <ListPage
        transactions={transactions}
        onEdit={tx=>{ setEditTx(tx); goPage("add"); }}
        onDelete={confirmDelete}
        onSync={() => handleSync(transactions)}
        onDownload={() => handleDownload(transactions)}
        hasChanges={hasChanges}
        syncing={syncing}
        isNative={IS_NATIVE}
        fileName={fileName}
      />
    );
    else mainContent = <ReportsPage transactions={transactions} toast={toast}/>;
  }

  return (
    <>
      <style>{S}</style>

      {IS_NATIVE && (
        <input ref={importInputRef} type="file" accept=".xlsx"
          style={{ display:"none" }} onChange={handleImportChange}/>
      )}

      <div className="app">
        <aside className="sidebar">
          <div className="logo">My<span>Wallie</span></div>
          <div className="logo-sub">EXPENSE TRACKER</div>
          <nav className="nav">
            {navItems.map(n => (
              <button key={n.id} className={`nav-item ${page===n.id?"active":""}`} onClick={()=>goPage(n.id)}>
                <n.icon size={18}/><span>{n.label}</span>
              </button>
            ))}
          </nav>

          <div className="file-zone">
            <div className="file-zone-label">DATA FILE</div>
            {IS_NATIVE ? (
              status==="ready" && (
                <>
                  <div style={{ fontSize:"0.72rem", color:"var(--income)", fontFamily:"DM Mono,monospace", lineHeight:1.6, marginTop:8 }}>
                    <CheckCircle size={11} style={{ display:"inline" }}/> Internal Storage<br/>
                    <span style={{ opacity:0.7 }}>{transactions.length} records · auto-saved</span>
                  </div>
                  <div className="storage-badge"><CheckCircle size={11}/> Auto-sync ON</div>
                  <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:8 }}>
                    <button className="file-btn" onClick={triggerImport}><Upload size={15}/> Import Excel</button>
                    <button className="file-btn danger" onClick={handleMobileReset}><Trash2 size={15}/> Reset Data</button>
                  </div>
                </>
              )
            ) : status === "ready" ? (
              <>
                <div style={{ fontSize:"0.72rem", color:"var(--muted)", fontFamily:"DM Mono,monospace", lineHeight:1.6, marginTop:8 }}>
                  {fileName
                    ? <><span style={{ color:"var(--income)" }}>{fileName}</span><br/><span style={{ opacity:0.6, fontSize:"0.68rem" }}>{transactions.length} records in memory</span></>
                    : <><span style={{ opacity:0.7 }}>No file linked</span><br/><span style={{ opacity:0.5, fontSize:"0.68rem" }}>Sync to write to a file</span></>
                  }
                </div>
                {hasChanges && (
                  <div className="unsynced-badge">
                    <span className="unsynced-dot"/> Unsynced changes
                  </div>
                )}
                <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:8 }}>
                  <button className="file-btn" onClick={() => handleSync(transactions)} disabled={syncing}>
                    <RefreshCw size={15} style={{ animation: syncing?"spin 0.8s linear infinite":"none" }}/>
                    {syncing ? "Writing…" : "Sync to File"}
                  </button>
                  <button className="file-btn" onClick={() => handleDownload(transactions)}>
                    <Download size={15}/> Download .xlsx
                  </button>
                  <button className="file-btn" onClick={handleSwitchFile}>
                    <FolderOpen size={15}/> Switch File
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </aside>

        <nav className="bottom-nav">
          {navItems.map(n => (
            <button key={n.id} className={`bottom-nav-item ${page===n.id?"active":""}`} onClick={()=>goPage(n.id)}>
              <n.icon size={20}/><span>{n.label}</span>
            </button>
          ))}
        </nav>

        <main className="main">{mainContent}</main>
        <Toast toasts={toasts}/>
      {modal && (
        <Modal
          title={modal.title}
          body={modal.body}
          confirmLabel={modal.confirmLabel}
          confirmClass={modal.confirmClass}
          cancelLabel={modal.cancelLabel || "Cancel"}
          onConfirm={modal.onConfirm}
          onCancel={closeModal}
        />
      )}
      </div>
    </>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function DashboardPage({ summary, transactions }) {
  const fmt    = n => new Intl.NumberFormat("en-IN",{ style:"currency", currency:"INR", maximumFractionDigits:0 }).format(n);
  const recent = [...transactions].sort((a,b)=>dayjs(b.Date).valueOf()-dayjs(a.Date).valueOf()).slice(0,5);
  const catData = useMemo(() => {
    const map = {};
    transactions.filter(t=>t.Type==="Expense").forEach(t=>{ map[t.Category]=(map[t.Category]||0)+t.Amount; });
    return Object.entries(map).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,6);
  }, [transactions]);

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Dashboard</div>
        <div className="page-sub">Overview of all your finances</div>
      </div>
      <div className="cards">
        <div className="card"><div className="card-label">TOTAL INCOME</div><div className="card-value income">{fmt(summary.income)}</div><div className="card-sub">{transactions.filter(t=>t.Type==="Income").length} entries</div></div>
        <div className="card"><div className="card-label">TOTAL EXPENSE</div><div className="card-value expense">{fmt(summary.expense)}</div><div className="card-sub">{transactions.filter(t=>t.Type==="Expense").length} entries</div></div>
        <div className="card"><div className="card-label">NET BALANCE</div><div className={`card-value net ${summary.net>=0?"pos":"neg"}`}>{fmt(summary.net)}</div><div className="card-sub">{summary.net>=0?"Surplus":"Deficit"}</div></div>
        <div className="card"><div className="card-label">TRANSACTIONS</div><div className="card-value" style={{ color:"var(--accent)" }}>{summary.count}</div><div className="card-sub">Total records</div></div>
      </div>
      {transactions.length > 0 && (
        <div className="charts-grid">
          <div className="chart-card">
            <div className="chart-title">Income vs Expense</div>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={[{name:"Income",value:summary.income},{name:"Expense",value:summary.expense}]} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value">
                  <Cell fill="#4df7c8"/><Cell fill="#f74d8a"/>
                </Pie>
                <Tooltip formatter={v=>fmt(v)} contentStyle={{ background:"#7c6af7", border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, color:"#f0eeff" }}/>
                <Legend formatter={v=><span style={{ color:"#f0eeff", fontSize:"0.8rem" }}>{v}</span>}/>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-card">
            <div className="chart-title">Top Expense Categories</div>
            {catData.length===0 ? <div className="loading">No expense data</div> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={catData} margin={{ top:0,right:0,left:0,bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)"/>
                  <XAxis dataKey="name" tick={{ fill:"rgba(240,238,255,0.45)",fontSize:11 }}/>
                  <YAxis tick={{ fill:"rgba(240,238,255,0.45)",fontSize:11 }}/>
                  <Tooltip formatter={v=>fmt(v)} contentStyle={{ background:"#1a1a26", border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, color:"#f0eeff" }}/>
                  <Bar dataKey="value" fill="#7c6af7" radius={[6,6,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <div className="table-wrap" style={{ marginTop:24 }}>
          <div className="table-header"><div className="table-title">Recent Transactions</div></div>
          <div className="desktop-table">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Amount</th><th>Notes</th></tr></thead>
              <tbody>{recent.map(t=>(
                <tr key={t.ID}>
                  <td style={{ fontFamily:"DM Mono,monospace",fontSize:"0.82rem" }}>{t.Date}</td>
                  <td><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span></td>
                  <td>{t.Category}</td>
                  <td><span className={`amount ${t.Type.toLowerCase()}`}>{t.Type==="Income"?"+":"−"}₹{t.Amount.toLocaleString()}</span></td>
                  <td style={{ color:"var(--muted)",fontSize:"0.82rem" }}>{t.Notes||"—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="mobile-cards-list">
            {recent.map(t=>(
              <div key={t.ID} className="tx-card">
                <div className="tx-card-left">
                  <div className="tx-card-cat">{t.Category}</div>
                  <div className="tx-card-meta"><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span><span className="tx-card-date">{t.Date}</span></div>
                  {t.Notes && <div className="tx-card-notes">{t.Notes}</div>}
                </div>
                <div className="tx-card-right"><span className={`tx-card-amount amount ${t.Type.toLowerCase()}`}>{t.Type==="Income"?"+":"−"}₹{t.Amount.toLocaleString()}</span></div>
              </div>
            ))}
          </div>
        </div>
      )}
      {transactions.length===0 && (
        <div className="empty">
          <div className="empty-icon"><Wallet size={48} strokeWidth={1.2}/></div>
          <div className="empty-title">No transactions yet</div>
          <div>Add your first income or expense to get started</div>
        </div>
      )}
    </div>
  );
}

// ─── Add / Edit ───────────────────────────────────────────────────────────────
function AddPage({ onAdd, onUpdate, editTx, transactions }) {
  const getEmpty = () => ({ Date:dayjs().format("YYYY-MM-DD"), Type:"Expense", Category:"", Amount:"", Notes:"" });
  const [form, setForm]         = useState(editTx||getEmpty());
  const [errors, setErrors]     = useState({});
  const [newCatMode, setNewCatMode] = useState(false);

  // Unique sorted categories from existing transactions
  const existingCats = useMemo(() => {
    const s = new Set((transactions||[]).map(t => t.Category).filter(Boolean));
    return [...s].sort();
  }, [transactions]);

  useEffect(() => {
    setForm(editTx||getEmpty());
    setErrors({});
    setNewCatMode(false);
  }, [editTx]);

  const set = (k,v) => { setForm(f=>({...f,[k]:v})); setErrors(e=>({...e,[k]:""})); };

  const handleCatSelect = (e) => {
    const val = e.target.value;
    if (val === "__new__") {
      setNewCatMode(true);
      set("Category", "");
    } else {
      setNewCatMode(false);
      set("Category", val);
    }
  };

  const validate = () => {
    const e = {};
    if (!form.Date)            e.Date     = "Date required";
    if (!form.Category.trim()) e.Category = "Category required";
    if (!form.Amount||isNaN(Number(form.Amount))||Number(form.Amount)<=0) e.Amount = "Enter a positive amount";
    setErrors(e); return Object.keys(e).length===0;
  };
  const handleSubmit = () => {
    if (!validate()) return;
    const tx = { ...form, Amount:Number(form.Amount) };
    if (editTx) { onUpdate({ ...tx, ID:editTx.ID, CreatedAt:editTx.CreatedAt }); }
    else { onAdd({ ...tx, ID:String(Date.now()), CreatedAt:new Date().toISOString() }); setForm(getEmpty()); setNewCatMode(false); }
  };

  // Determine what value the select should show
  const selectVal = newCatMode ? "__new__" : (existingCats.includes(form.Category) ? form.Category : (form.Category ? "__new__" : ""));

  return (
    <div>
      <div className="page-header">
        <div className="page-title">{editTx?"Edit Transaction":"New Transaction"}</div>
        <div className="page-sub">{editTx?`Editing ID: ${editTx.ID}`:"Record a new income or expense"}</div>
      </div>
      <div className="form-card">
        <div className="form-grid">
          <div className="form-group"><label>Date</label><input type="date" value={form.Date} onChange={e=>set("Date",e.target.value)}/>{errors.Date&&<span style={{ color:"var(--expense)",fontSize:"0.75rem" }}>{errors.Date}</span>}</div>
          <div className="form-group"><label>Type</label><select value={form.Type} onChange={e=>set("Type",e.target.value)}><option value="Income">Income</option><option value="Expense">Expense</option></select></div>
          <div className="form-group full">
            <label>Category</label>
            {existingCats.length > 0 && !newCatMode ? (
              <select value={selectVal} onChange={handleCatSelect}>
                <option value="">-- Select category --</option>
                {existingCats.map(c => <option key={c} value={c}>{c}</option>)}
                <option value="__new__">✚ New category…</option>
              </select>
            ) : (
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <input
                  type="text"
                  placeholder="Type new category name…"
                  value={form.Category}
                  onChange={e=>set("Category",e.target.value)}
                  style={{ flex:1 }}
                  autoFocus
                />
                {existingCats.length > 0 && (
                  <button type="button" className="btn btn-secondary" style={{ padding:"10px 14px", fontSize:"0.8rem" }}
                    onClick={() => { setNewCatMode(false); set("Category",""); }}>
                    Cancel
                  </button>
                )}
              </div>
            )}
            {errors.Category&&<span style={{ color:"var(--expense)",fontSize:"0.75rem" }}>{errors.Category}</span>}
          </div>
          <div className="form-group full"><label>Amount (₹)</label><input type="number" min="0.01" step="0.01" placeholder="0.00" value={form.Amount} onChange={e=>set("Amount",e.target.value)}/>{errors.Amount&&<span style={{ color:"var(--expense)",fontSize:"0.75rem" }}>{errors.Amount}</span>}</div>
          <div className="form-group full"><label>Notes (optional)</label><textarea placeholder="Any additional details…" value={form.Notes} onChange={e=>set("Notes",e.target.value)}/></div>
        </div>
        <div style={{ display:"flex", gap:12, marginTop:22 }}>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {editTx?<><CheckCheck size={16}/> Save Changes</>:<><PlusCircle size={16}/> Add Transaction</>}
          </button>
          {editTx&&<button className="btn btn-secondary" onClick={()=>onUpdate(null)}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

// ─── Transaction List ─────────────────────────────────────────────────────────
function ListPage({ transactions, onEdit, onDelete, onSync, onDownload, hasChanges, syncing, isNative, fileName }) {
  const [search, setSearch]         = useState("");
  const [typeFilter, setTypeFilter] = useState("All");

  const filtered = useMemo(() =>
    [...transactions]
      .filter(t => typeFilter==="All" || t.Type===typeFilter)
      .filter(t => !search || t.Category.toLowerCase().includes(search.toLowerCase()) || (t.Notes||"").toLowerCase().includes(search.toLowerCase()))
      .sort((a,b) => dayjs(b.Date).valueOf() - dayjs(a.Date).valueOf()),
    [transactions, search, typeFilter]);

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Transactions</div>
        <div className="page-sub">{transactions.length} total records</div>
      </div>

      <div className="filter-bar">
        <input className="search-input" type="text" placeholder="Search category or notes…" value={search} onChange={e=>setSearch(e.target.value)}/>
        <div className="filter-buttons">
          {["All","Income","Expense"].map(t=>(
            <button key={t} className={`filter-btn ${typeFilter===t?"active":""}`} onClick={()=>setTypeFilter(t)}>{t}</button>
          ))}
        </div>
      </div>

      {filtered.length===0 ? (
        <div className="empty">
          <div className="empty-icon"><List size={48} strokeWidth={1.2}/></div>
          <div className="empty-title">No transactions found</div>
          <div>Try adjusting filters or add a new transaction</div>
        </div>
      ) : (
        <div className="table-wrap">
          <div className="table-header">
            <div className="table-header-left">
              <div className="table-title">All Transactions</div>
              <span style={{ color:"var(--muted)", fontSize:"0.8rem", fontFamily:"DM Mono,monospace" }}>
                {filtered.length} shown
              </span>
              {!isNative && hasChanges && (
                <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:"0.72rem", color:"var(--expense)", fontFamily:"DM Mono,monospace" }}>
                  <span className="unsynced-dot"/> unsynced
                </span>
              )}
            </div>

            {!isNative && (
              <div className="table-header-actions">
                {/* Sync — always opens picker, user picks file, we overwrite it */}
                <button
                  className={`btn-sm btn-sync${hasChanges ? " has-changes" : ""}`}
                  onClick={onSync}
                  disabled={syncing}
                  title="Open file picker → select a .xlsx → all data is written into it"
                >
                  <RefreshCw size={14} style={{ animation: syncing ? "spin 0.8s linear infinite" : "none" }}/>
                  {syncing ? "Writing…" : hasChanges ? "Sync to File ●" : "Sync to File"}
                </button>

                {/* Download — straight browser download, no picker */}
                <button
                  className="btn-sm btn-dl"
                  onClick={onDownload}
                  title="Download a snapshot .xlsx directly"
                >
                  <Download size={14}/> Download
                </button>
              </div>
            )}
          </div>

          {/* Hint bar */}
          {!isNative && (
            <div className="sync-hint">
              <Info size={12} style={{ flexShrink:0 }}/>
              <span>
                <strong style={{ color:"var(--text)" }}>Sync to File</strong> — opens a file picker, you select which .xlsx to overwrite with current data.&ensp;
                <strong style={{ color:"var(--text)" }}>Download</strong> — saves a snapshot directly to Downloads.
              </span>
            </div>
          )}

          <div className="desktop-table">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Amount</th><th>Notes</th><th>Actions</th></tr></thead>
              <tbody>{filtered.map(t=>(
                <tr key={t.ID}>
                  <td style={{ fontFamily:"DM Mono,monospace",fontSize:"0.82rem" }}>{t.Date}</td>
                  <td><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span></td>
                  <td>{t.Category}</td>
                  <td><span className={`amount ${t.Type.toLowerCase()}`}>{t.Type==="Income"?"+":"−"}₹{t.Amount.toLocaleString()}</span></td>
                  <td style={{ color:"var(--muted)",fontSize:"0.82rem",maxWidth:200 }}>{t.Notes||"—"}</td>
                  <td>
                    <div className="actions">
                      <button className="btn-icon" onClick={()=>onEdit(t)}><Pencil size={14}/></button>
                      <button className="btn-icon del" onClick={()=>{ onDelete(t.ID); }}><Trash2 size={14}/></button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          <div className="mobile-cards-list">
            {filtered.map(t=>(
              <div key={t.ID} className="tx-card">
                <div className="tx-card-left">
                  <div className="tx-card-cat">{t.Category}</div>
                  <div className="tx-card-meta">
                    <span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span>
                    <span className="tx-card-date">{t.Date}</span>
                  </div>
                  {t.Notes&&<div className="tx-card-notes">{t.Notes}</div>}
                </div>
                <div className="tx-card-right">
                  <span className={`tx-card-amount amount ${t.Type.toLowerCase()}`}>
                    {t.Type==="Income"?"+":"−"}₹{t.Amount.toLocaleString()}
                  </span>
                  <div className="actions">
                    <button className="btn-icon" onClick={()=>onEdit(t)}><Pencil size={14}/></button>
                    <button className="btn-icon del" onClick={()=>{ onDelete(t.ID); }}><Trash2 size={14}/></button>
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
  const [period, setPeriod]     = useState("yearly");
  const [fromDate, setFromDate] = useState(dayjs().startOf("month").format("YYYY-MM-DD"));
  const [toDate, setToDate]     = useState(dayjs().format("YYYY-MM-DD"));

  const filtered = useMemo(
    () => dateUtils.filterByPeriod(transactions, period, fromDate, toDate),
    [transactions, period, fromDate, toDate],
  );
  const income  = filtered.filter(t=>t.Type==="Income").reduce((s,t)=>s+t.Amount,0);
  const expense = filtered.filter(t=>t.Type==="Expense").reduce((s,t)=>s+t.Amount,0);
  const net     = income-expense;
  const fmt     = n => new Intl.NumberFormat("en-IN",{ style:"currency", currency:"INR", maximumFractionDigits:0 }).format(n);

  const catData = useMemo(() => {
    const map = {};
    filtered.filter(t=>t.Type==="Expense").forEach(t=>{ map[t.Category]=(map[t.Category]||0)+t.Amount; });
    return Object.entries(map).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,8);
  }, [filtered]);

  const handleDownload = async () => {
    const start = period==="custom" ? fromDate
      : dayjs().startOf(period==="daily"?"day":period==="weekly"?"week":period==="monthly"?"month":"year").format("YYYY-MM-DD");
    const end  = period==="custom" ? toDate : dayjs().format("YYYY-MM-DD");
    const name = `mywallie_report_${start}_${end}.xlsx`;
    if (IS_NATIVE) {
      try { await mobileStorage.shareReport(filtered, name); }
      catch (err) { if (!err?.message?.toLowerCase().includes("cancel")) toast("Share failed: " + err.message, "error"); }
    } else {
      const buf = excelService.toBuffer(excelService.generateReport(filtered));
      saveAs(new Blob([buf]), name);
      toast("Report downloaded!", "success");
    }
  };

  const periods = [
    { id:"daily",label:"Today" },{ id:"weekly",label:"This Week" },
    { id:"monthly",label:"This Month" },{ id:"yearly",label:"This Year" },
    { id:"custom",label:"Custom" },
  ];

  return (
    <div>
      <div className="page-header" style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:16 }}>
        <div><div className="page-title">Reports</div><div className="page-sub">Analyze your spending patterns</div></div>
        <button className="btn btn-success" onClick={handleDownload}>
          {IS_NATIVE ? <><Share2 size={16}/> Share Report</> : <><Download size={16}/> Download Report</>}
        </button>
      </div>
      <div className="filter-row">
        {periods.map(p=><button key={p.id} className={`filter-btn ${period===p.id?"active":""}`} onClick={()=>setPeriod(p.id)}>{p.label}</button>)}
        {period==="custom" && (
          <><input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} style={{ maxWidth:160 }}/><span style={{ color:"var(--muted)" }}>→</span><input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} style={{ maxWidth:160 }}/></>
        )}
      </div>
      <div className="cards">
        <div className="card"><div className="card-label">INCOME</div><div className="card-value income">{fmt(income)}</div><div className="card-sub">{filtered.filter(t=>t.Type==="Income").length} entries</div></div>
        <div className="card"><div className="card-label">EXPENSE</div><div className="card-value expense">{fmt(expense)}</div><div className="card-sub">{filtered.filter(t=>t.Type==="Expense").length} entries</div></div>
        <div className="card"><div className="card-label">NET BALANCE</div><div className={`card-value net ${net>=0?"pos":"neg"}`}>{fmt(net)}</div><div className="card-sub">{net>=0?"Surplus":"Deficit"}</div></div>
        <div className="card"><div className="card-label">TRANSACTIONS</div><div className="card-value" style={{ color:"var(--accent)" }}>{filtered.length}</div><div className="card-sub">In this period</div></div>
      </div>
      {filtered.length===0 ? (
        <div className="empty"><div className="empty-icon"><BarChart2 size={48} strokeWidth={1.2}/></div><div className="empty-title">No data for this period</div><div>Try a different time range</div></div>
      ) : (
        <>
          <div className="charts-grid">
            <div className="chart-card">
              <div className="chart-title">Income vs Expense</div>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={[{name:"Income",value:income},{name:"Expense",value:expense}]} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={5} dataKey="value">
                    <Cell fill="#4df7c8"/><Cell fill="#f74d8a"/>
                  </Pie>
                  <Tooltip formatter={v=>fmt(v)} contentStyle={{ background:"#7c6af7",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,color:"#f0eeff" }}/>
                  <Legend formatter={v=><span style={{ color:"#f0eeff",fontSize:"0.8rem" }}>{v}</span>}/>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="chart-card">
              <div className="chart-title">Expense by Category</div>
              {catData.length===0 ? <div className="loading">No expense data</div> : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={catData} margin={{ top:0,right:0,left:0,bottom:40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)"/>
                    <XAxis dataKey="name" tick={{ fill:"rgba(240,238,255,0.45)",fontSize:10 }} angle={-30} textAnchor="end" interval={0}/>
                    <YAxis tick={{ fill:"rgba(240,238,255,0.45)",fontSize:11 }}/>
                    <Tooltip formatter={v=>fmt(v)} contentStyle={{ background:"#1a1a26",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,color:"#f0eeff" }}/>
                    <Bar dataKey="value" fill="#f74d8a" radius={[6,6,0,0]}/>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop:24 }}>
            <div className="table-header"><div className="table-title">Transactions in Period</div></div>
            <div className="desktop-table">
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Amount</th><th>Notes</th></tr></thead>
                <tbody>{filtered.map(t=>(
                  <tr key={t.ID}>
                    <td style={{ fontFamily:"DM Mono,monospace",fontSize:"0.82rem" }}>{t.Date}</td>
                    <td><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span></td>
                    <td>{t.Category}</td>
                    <td><span className={`amount ${t.Type.toLowerCase()}`}>{t.Type==="Income"?"+":"−"}₹{t.Amount.toLocaleString()}</span></td>
                    <td style={{ color:"var(--muted)",fontSize:"0.82rem" }}>{t.Notes||"—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="mobile-cards-list">
              {filtered.map(t=>(
                <div key={t.ID} className="tx-card">
                  <div className="tx-card-left">
                    <div className="tx-card-cat">{t.Category}</div>
                    <div className="tx-card-meta"><span className={`badge ${t.Type.toLowerCase()}`}>{t.Type}</span><span className="tx-card-date">{t.Date}</span></div>
                    {t.Notes&&<div className="tx-card-notes">{t.Notes}</div>}
                  </div>
                  <div className="tx-card-right"><span className={`tx-card-amount amount ${t.Type.toLowerCase()}`}>{t.Type==="Income"?"+":"−"}₹{t.Amount.toLocaleString()}</span></div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
