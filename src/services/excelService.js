/**
 * excelService.js
 * All Excel read/write logic is isolated here per the spec.
 * Uses SheetJS (xlsx) and FileSaver.js.
 */
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";

const SHEET_NAME = "Transactions";
const HEADERS = ["ID", "Date", "Type", "Category", "Amount", "Notes", "CreatedAt"];

export const excelService = {
  createWorkbook(transactions = []) {
    const wb = XLSX.utils.book_new();
    const rows = [
      HEADERS,
      ...transactions.map(t => [t.ID, t.Date, t.Type, t.Category, t.Amount, t.Notes, t.CreatedAt]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
      { wch: 15 }, { wch: 12 }, { wch: 10 },
      { wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 20 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
    return wb;
  },

  workbookToBuffer(wb) {
    return XLSX.write(wb, { bookType: "xlsx", type: "array" });
  },

  parseWorkbook(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const ws = wb.Sheets[SHEET_NAME];
    if (!ws) throw new Error("Sheet 'Transactions' not found");
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length <= 1) return [];
    return rows.slice(1).filter(r => r[0]).map(r => ({
      ID: String(r[0] || ""),
      Date: r[1] ? String(r[1]) : new Date().toISOString().split("T")[0],
      Type: r[2] || "Expense",
      Category: r[3] || "",
      Amount: Number(r[4]) || 0,
      Notes: r[5] || "",
      CreatedAt: r[6] || new Date().toISOString(),
    }));
  },

  saveAndDownload(transactions, filename = "expenses.xlsx") {
    const wb = this.createWorkbook(transactions);
    const buf = this.workbookToBuffer(wb);
    saveAs(new Blob([buf], { type: "application/octet-stream" }), filename);
  },

  generateReportWorkbook(transactions, startDate, endDate) {
    const wb = XLSX.utils.book_new();
    const totalIncome = transactions
      .filter(t => t.Type === "Income")
      .reduce((s, t) => s + t.Amount, 0);
    const totalExpense = transactions
      .filter(t => t.Type === "Expense")
      .reduce((s, t) => s + t.Amount, 0);
    const net = totalIncome - totalExpense;

    const rows = [
      HEADERS,
      ...transactions.map(t => [t.ID, t.Date, t.Type, t.Category, t.Amount, t.Notes, t.CreatedAt]),
      [],
      ["Summary"],
      ["Total Income", totalIncome],
      ["Total Expense", totalExpense],
      ["Net Balance", net],
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
      { wch: 15 }, { wch: 12 }, { wch: 10 },
      { wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 20 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    return wb;
  },
};
