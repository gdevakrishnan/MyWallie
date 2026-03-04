# Spend. — Personal Expense Tracker

A complete ReactJS expense tracker using Excel as the only data store.

## Quick Start

```bash
npm install
npm run dev
```

## Tech Stack
- ReactJS (Vite)
- SheetJS (xlsx) — Excel read/write
- FileSaver.js — File download
- dayjs — Date filtering
- recharts — Charts

## Features
- Upload or create `expenses.xlsx`
- Add / Edit / Delete transactions
- Dashboard with charts
- Reports with Daily / Weekly / Monthly / Yearly / Custom filters
- Download filtered Excel reports
- Drag & drop file upload
- All data stored in Excel — no database, no localStorage

## How It Works
1. First visit: Upload existing `expenses.xlsx` or click "Start Fresh"
2. Every create/update/delete triggers an automatic Excel file download
3. Re-upload the file next session to continue where you left off

## Project Structure
```
src/
  services/excelService.js  ← Excel read/write logic
  utils/dateUtils.js        ← Date filtering helpers
  App.jsx                   ← Main app (all components)
  main.jsx                  ← Entry point
```
