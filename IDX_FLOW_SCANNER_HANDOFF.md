# IDX Flow Scanner v2.0 — Project Handoff

**Tanggal:** 4 Juni 2026  
**Status:** Production-ready MVP  
**Versi:** 2.0 — Auto Web Sync

---

## Daftar Isi

1. [Ringkasan Proyek](#1-ringkasan-proyek)
2. [File Deliverables](#2-file-deliverables)
3. [Arsitektur Sistem](#3-arsitektur-sistem)
4. [Setup & Deployment](#4-setup--deployment)
5. [Backend API Contract](#5-backend-api-contract)
6. [Signal Engine](#6-signal-engine)
7. [Data Mode & Confidence System](#7-data-mode--confidence-system)
8. [Frontend — Struktur Kode](#8-frontend--struktur-kode)
9. [State Management](#9-state-management)
10. [Halaman & Navigasi](#10-halaman--navigasi)
11. [Real-Time Sync Flow](#11-real-time-sync-flow)
12. [CSV Emergency Import](#12-csv-emergency-import)
13. [Supabase Migration Path](#13-supabase-migration-path)
14. [Known Limitations](#14-known-limitations)
15. [Changelog dari Versi Sebelumnya](#15-changelog-dari-versi-sebelumnya)
16. [Checklist Produksi](#16-checklist-produksi)

---

## 1. Ringkasan Proyek

IDX Flow Scanner adalah mobile-first PWA untuk memindai saham Indonesia (IDX/BEI) dengan sinyal trading otomatis berbasis analisis flow data broker dan asing.

### Fitur Utama

| Fitur | Status |
|---|---|
| Dashboard IHSG + market breadth | ✅ |
| Scanner dengan filter & sort | ✅ |
| Trading signals (BUY/SELL/HOLD) | ✅ |
| Entry zone, Target, Stop Loss | ✅ |
| Risk/Reward calculator | ✅ |
| Signal strength + confidence | ✅ |
| BUY zone threshold indicator | ✅ |
| Auto web sync via backend | ✅ |
| Freshness status (LIVE/STALE/LOCAL) | ✅ |
| Data mode badges (FULL FLOW/PRICE ONLY) | ✅ |
| Watchlist | ✅ |
| Score breakdown per komponen | ✅ |
| Risk flag detection (6 jenis) | ✅ |
| CSV emergency import (flow data) | ✅ |
| localStorage cache | ✅ |
| Mobile-first glassmorphism UI | ✅ |
| Dark neon aesthetic | ✅ |

### Tech Stack

| Komponen | Teknologi |
|---|---|
| Frontend | Vanilla HTML5 + CSS + JavaScript (ES6) |
| Backend | Node.js (Vercel API route / Express) |
| Data source | Yahoo Finance v8 + v7 (public, no auth) |
| Cache | In-memory (backend) + localStorage (frontend) |
| Font | DM Sans + DM Mono (Google Fonts) |
| Deploy target | Vercel (recommended) |

### Tidak Ada

- React / Vue / Angular
- npm dependencies di frontend
- API key di frontend
- LLM API (Claude, OpenAI, Gemini)
- Paid data provider
- Build step untuk frontend

---

## 2. File Deliverables

```
idx-flow-scanner.html     89KB   1,261 baris   Frontend lengkap (single file)
api-idx-quotes.js         15KB     398 baris   Backend API route
IDX_FLOW_SCANNER_HANDOFF.md       File ini
```

### Struktur Deploy (Vercel)

```
project-root/
├── public/
│   └── index.html              ← copy dari idx-flow-scanner.html
├── api/
│   └── idx-quotes.js           ← copy dari api-idx-quotes.js
├── vercel.json                 ← (opsional, lihat bagian deployment)
└── package.json                ← (minimal, lihat bawah)
```

### `package.json` minimal

```json
{
  "name": "idx-flow-scanner",
  "version": "2.0.0",
  "engines": { "node": ">=18" }
}
```

### `vercel.json` (opsional)

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api/:path*" },
    { "source": "/(.*)", "destination": "/public/index.html" }
  ]
}
```

---

## 3. Arsitektur Sistem

```
┌─────────────────────────────────────────┐
│           Browser / Mobile              │
│                                         │
│   idx-flow-scanner.html                 │
│   ┌─────────────────────────────────┐   │
│   │  STATE (in-memory)              │   │
│   │  localStorage (cache)           │   │
│   │  65 JS functions                │   │
│   │  Signal Engine (pure JS)        │   │
│   └────────────┬────────────────────┘   │
│                │ fetch('/api/idx-quotes')│
└────────────────┼────────────────────────┘
                 │ HTTP GET
                 ▼
┌─────────────────────────────────────────┐
│           Backend (Vercel/Node)         │
│                                         │
│   api/idx-quotes.js                     │
│   ┌─────────────────────────────────┐   │
│   │  In-memory CACHE                │   │
│   │  TTL: 60s (market) /            │   │
│   │       15min (off-hours)         │   │
│   └────────────┬────────────────────┘   │
│                │                        │
│   ┌────────────▼────────────────────┐   │
│   │  fetchWebQuotes()               │   │
│   │  ├── fetchYahooFinance()        │   │
│   │  │   Provider 1: YF v8 chart   │   │
│   │  │   URL: query1.finance.yahoo  │   │
│   │  │         .com/v8/finance/     │   │
│   │  │         chart/{SYM}.JK      │   │
│   │  └── fetchYahooFinanceV7()      │   │
│   │      Provider 2: YF v7 quote   │   │
│   │      (fallback jika v8 gagal)  │   │
│   └─────────────────────────────────┘   │
│                                         │
│   Jika SEMUA provider gagal:            │
│   → return CACHE (freshness: STALE)     │
│   → atau return SAMPLE (freshness:      │
│          LOCAL_SAMPLE) jika no cache    │
└─────────────────────────────────────────┘
```

### Data Flow Detail

```
1. App load → renderDashboard() dengan base data
2. setTimeout 1.5s → fetchLive()
3. fetchLive() → GET /api/idx-quotes
4. Backend cek cache → HIT? return cache
5. Backend MISS → fetchWebQuotes()
6. Provider 1 (YF v8) → sukses? normalize → return
7. Provider 1 gagal → Provider 2 (YF v7) → sukses? normalize → return
8. Semua gagal → return cache STALE atau LOCAL_SAMPLE
9. Frontend applyPayload() → merge ke STATE.liveQuotes
10. getEnriched() → enrich() per saham → signal engine
11. renderCurrent() → update semua komponen UI
12. startSyncTimer() → ulangi setiap N detik
```

---

## 4. Setup & Deployment

### Deploy Vercel (Recommended)

```bash
# 1. Install Vercel CLI
npm i -g vercel

# 2. Buat struktur project
mkdir idx-flow-scanner && cd idx-flow-scanner
mkdir public api

# 3. Copy file
cp /path/to/idx-flow-scanner.html public/index.html
cp /path/to/api-idx-quotes.js     api/idx-quotes.js

# 4. Buat package.json
echo '{"name":"idx-flow-scanner","version":"2.0.0","engines":{"node":">=18"}}' > package.json

# 5. Deploy
vercel deploy

# 6. Production deploy
vercel --prod
```

### Deploy Express/Node Lokal

```javascript
// server.js
const express = require('express');
const handler = require('./api/idx-quotes');
const path    = require('path');

const app = express();
app.use(express.static('public'));
app.get('/api/idx-quotes', handler);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(3000, () => console.log('IDX Flow Scanner running on :3000'));
```

```bash
npm install express
node server.js
# Buka http://localhost:3000
```

### Test Backend Endpoint

```bash
# Cek endpoint
curl http://localhost:3000/api/idx-quotes | jq .

# Force refresh (bypass cache)
curl "http://localhost:3000/api/idx-quotes?force=true" | jq .

# Cek freshness
curl http://localhost:3000/api/idx-quotes | jq '.freshness, .provider, .asOf'
```

### Environment

Tidak diperlukan environment variable untuk MVP. Backend menggunakan public Yahoo Finance endpoints tanpa API key.

---

## 5. Backend API Contract

### Endpoint

```
GET /api/idx-quotes
GET /api/idx-quotes?force=true   (bypass cache)
```

### Response Schema

```json
{
  "status":    "ok",
  "source":    "web",
  "provider":  "yahoo-finance-v8",
  "asOf":      "2026-06-04T09:30:00.000Z",
  "freshness": "LIVE",
  "IHSG": {
    "price":       7089.24,
    "chg":         87.12,
    "pctChg":      1.24,
    "high":        7112.00,
    "low":         7042.50,
    "marketState": "REGULAR",
    "asOf":        "2026-06-04T09:30:00.000Z",
    "source":      "yahoo-finance-v8"
  },
  "quotes": {
    "BBCA": {
      "price":       9850,
      "prevClose":   9600,
      "high":        9900,
      "low":         9780,
      "volume":      45200000,
      "pctChg":      2.60,
      "brokerBuy":   null,
      "brokerSell":  null,
      "foreignBuy":  null,
      "foreignSell": null,
      "netBuy":      null,
      "freqBuy":     null,
      "freqSell":    null,
      "dataMode":    "PRICE_ONLY",
      "asOf":        "2026-06-04T09:30:00.000Z",
      "source":      "yahoo-finance-v8"
    }
  },
  "errors":   [],
  "warnings": []
}
```

### Freshness Values

| Value | Artinya |
|---|---|
| `LIVE` | Data baru di-fetch dari provider, usia < 90 detik |
| `STALE` | Cache lama, live fetch gagal |
| `LOCAL_SAMPLE` | Tidak ada cache, menggunakan data bundled |

### Cache TTL

| Kondisi | TTL |
|---|---|
| Market hours (Mon-Fri 09:00-15:00 WIB) | 60 detik |
| Di luar jam bursa | 15 menit |
| Cache dipaksa bypass (`?force=true`) | Tidak ada TTL |

### Catatan Field Null

Yahoo Finance **tidak menyediakan** data berikut:
- `brokerBuy` / `brokerSell`
- `foreignBuy` / `foreignSell`
- `netBuy`
- `freqBuy` / `freqSell`

Field ini selalu `null` dari web sync. Hanya tersedia setelah operator upload CSV broker summary via halaman Import Darurat.

---

## 6. Signal Engine

### Scoring Formula

```
score = (
  calcNetBuy(s)    * 0.30 +   // Net buy/sell pressure
  calcForeign(s)   * 0.20 +   // Foreign flow direction
  calcBrkDist(s)   * 0.15 +   // Price vs broker average
  calcVolSpike(s)  * 0.15 +   // Volume spike vs 5d avg
  calcFreq(s)      * 0.10     // Frequency buy vs sell
  - riskPenalty    * 0.10     // Risk flags deduction
) * confidenceMult             // Data mode multiplier
```

### Confidence Multiplier

| Data Mode | Multiplier | Alasan |
|---|---|---|
| `FULL_FLOW` | 1.00 (100%) | Semua data tersedia |
| `PARTIAL_FLOW` | 0.82 (82%) | Sebagian data flow ada |
| `PRICE_ONLY` | 0.65 (65%) | Hanya OHLCV, tidak ada flow |
| `LOCAL_SAMPLE` | 0.65 (65%) | Data statis, bukan live |

### Signal Classification

| Range Score | Label | Warna |
|---|---|---|
| 85–100 | AKUMULASI KUAT | Hijau (#00FF9C) |
| 70–84 | AKUMULASI | Cyan (#00D4FF) |
| 55–69 | WATCHLIST | Kuning (#FFD600) |
| 40–54 | HOLD | Abu (#ffffff88) |
| 20–39 | DISTRIBUSI | Orange (#FF8C42) |
| 0–19 | HINDARI | Pink (#FF3D7F) |

### Trading Action (BUY/SELL/HOLD)

```javascript
// BUY — hanya jika FULL_FLOW dan semua kondisi terpenuhi
if (dataMode === 'FULL_FLOW'
    && score >= 70
    && riskFlags.length <= 1
    && foreignPct >= 50
    && freqPct >= 55) → BUY

// SELL
else if (score <= 35
         || riskFlags.length >= 3
         || (foreignPct < 30 && netBuy < 0)) → SELL

// HOLD (default)
else → HOLD
```

> **Penting:** Sinyal BUY **tidak akan pernah** diberikan pada data `PRICE_ONLY`. Ini disengaja untuk menghindari sinyal palsu dari data yang tidak lengkap.

### Risk Flags (6 Jenis)

| Flag | Kondisi | Warna |
|---|---|---|
| Risiko ARA | Harga naik > 20% dari prev close | Pink |
| Foreign Sell | Foreign sell ratio > 65% | Kuning |
| Jauh Broker Avg | Jarak harga vs broker avg > 10% | Kuning |
| Volume Spike Ekstrem | Volume > 4.5x rata-rata 5 hari | Pink |
| Frequency Lemah | Freq buy ratio < 35% | Abu |
| Distribusi Terselubung | Net sell + foreign sell > 55% | Pink |

### Level Calculator

```javascript
// Entry zone
entryLow  = round(min(price, brokerAvg) * 0.995)
entryHigh = round(max(price, brokerAvg) * 1.005)

// Targets (upside max 8% berdasarkan score)
upside  = (score/100) * 0.08
target1 = round(price * (1 + upside * 0.5))
target2 = round(price * (1 + upside))

// Stop loss
slPct    = riskFlags.length >= 2 ? 3% : 5%
stopLoss = round(min(price*(1-slPct), brokerSell*0.98))

// Risk/Reward
rr = (target2 - price) / (price - stopLoss)
```

---

## 7. Data Mode & Confidence System

### Data Mode Logic

```javascript
function dataMode(s) {
  var flowFields = ['brokerBuy','brokerSell','foreignBuy',
                    'foreignSell','netBuy','freqBuy','freqSell'];
  var hasFields  = flowFields.filter(k => Number.isFinite(Number(s[k])));

  if (s.dataMode === 'LOCAL_SAMPLE') return 'LOCAL_SAMPLE';
  if (hasFields.length === flowFields.length) return 'FULL_FLOW';
  if (hasFields.length > 0)                  return 'PARTIAL_FLOW';
  return 'PRICE_ONLY';
}
```

### UI Badges

| Badge | Warna | Artinya |
|---|---|---|
| `FULL FLOW` | Hijau | Price + semua 7 flow fields |
| `PARTIAL FLOW` | Cyan | Price + 1-6 flow fields |
| `PRICE ONLY` | Kuning | Hanya OHLCV dari Yahoo |
| `SAMPLE DATA` | Orange | Data bundled, backend offline |

### Cara Upgrade PRICE ONLY → FULL FLOW

1. Ekspor data broker summary dari platform trading (Mirae, BNI Sekuritas, RHB, dll)
2. Format CSV dengan kolom: `Symbol,BrokerBuy,BrokerSell,ForeignBuy,ForeignSell,NetBuy,FreqBuy,FreqSell,VolumeAvg5d`
3. Upload via halaman **Import Darurat** di app
4. Data disimpan di `STATE.uploadedFlow`, otomatis merge dengan harga live dari backend

---

## 8. Frontend — Struktur Kode

### File: `idx-flow-scanner.html` (89KB, 1.261 baris)

```
Lines 1–50      HTML head, CSS variables, layout styles
Lines 51–120    Component CSS (cards, badges, nav, animations)
Lines 121–180   HTML body structure (topbar, pages, navbar)
Lines 181–260   Safe math helpers (num, safeDiv, validPrice, clamp)
Lines 261–310   Color tokens + format helpers (fmtB, fmtK, fmtPrice)
Lines 311–380   Base flow data (FLOW_BASE) + stock metadata (STOCK_META)
Lines 381–420   Initial sparkline generation
Lines 421–450   App STATE object
Lines 451–490   localStorage cache functions
Lines 491–560   Payload validation + applyPayload()
Lines 561–650   fetchLive() + sync engine (setSyncUI, startSyncTimer)
Lines 651–780   Signal engine (calcNetBuy → calcScore → calcTrading)
Lines 781–870   SVG helpers + HTML component builders
Lines 871–960   renderDashboard() + renderScanner()
Lines 961–1060  renderSignals() + renderDetail()
Lines 1061–1160 renderWatchlist() + renderSettings()
Lines 1161–1230 renderUpload() + handleUpload()
Lines 1231–1261 Navigation (showPage, openDetail) + Init
```

### 65 JavaScript Functions

**Safe Math**
```
num()  maybeNum()  safeDiv()  validPrice()  clamp()  hasFlowData()  dataMode()
```

**Format Helpers**
```
fmtB()  fmtK()  fmtPrice()  fmtTime()  pctColor()  pctStr()
```

**Cache**
```
saveToLocalCache()  loadFromLocalCache()  clearLocalCache()
```

**Sync**
```
validatePayload()  applyPayload()  getFreshnessAge()
addLog()  fetchLive()  forceSync()  startSyncTimer()  setSyncUI()
```

**Signal Engine**
```
calcNetBuy()  calcForeign()  calcBrkDist()  calcFreq()
calcVolSpike()  calcRiskFlags()  calcScore()  classifySig()
calcTrading()  enrich()  getEnriched()
```

**UI Builders**
```
sparkSVG()  ringHTML()  scoreBarHTML()  badgeHTML()
actionBadgeHTML()  pctHTML()  dataModeBadge()  freshnessColor()
stockCardHTML()  miniCardHTML()
```

**Page Renderers**
```
renderDashboard()  setDashTab()
renderScanner()    setScanFilter()  setScanSort()  setScanView()  setScanSearch()
renderSignals()    setSigTab()
renderDetail()     setDetailTab()
renderWatchlist()  toggleWatchlist()
renderSettings()   setIntervalSec()  clearCache()
renderUpload()     handleUpload()
```

**Navigation**
```
openDetail()  showPage()  renderCurrent()
```

---

## 9. State Management

Semua state disimpan di objek `STATE` global (in-memory):

```javascript
var STATE = {
  // Navigation
  page:          'dashboard',
  selectedSym:   null,

  // Watchlist
  watchlist:     ['BBCA','TLKM','BYAN','GOTO','ADRO'],

  // Live data dari backend
  liveQuotes:    {},        // { BBCA: {price, prevClose, ...}, ... }
  liveIHSG:      null,      // { price, chg, pctChg, high, low, marketState }

  // Sync metadata
  freshness:     'LOCAL_SAMPLE',
  provider:      '—',
  dataSource:    '—',
  lastSync:      null,      // timestamp ms
  lastAsOf:      null,      // ISO string dari backend
  syncErrors:    [],
  syncWarnings:  [],

  // Sync UI state
  syncState:     'idle',    // idle|fetching|live|stale|local|error
  fetching:      false,
  syncTimer:     null,
  syncInterval:  60,        // detik
  syncLog:       [],        // [{ts, msg}] max 30 entries

  // Flow data dari CSV upload
  uploadedFlow:  {},        // { BBCA: {brokerBuy, ...}, ... }

  // Scanner page state
  scanFilter:    'all',
  scanSort:      'score',
  scanView:      'card',
  scanSearch:    '',

  // Other page state
  dashTab:       'buy',
  sigTab:        'buy',
  detailTab:     'signal',
};
```

### localStorage Keys

| Key | Value | Tujuan |
|---|---|---|
| `idx_flow_cache_v2` | `{payload, savedAt}` | Cache backend response |

---

## 10. Halaman & Navigasi

### 7 Halaman

| ID | Halaman | Nav | Fungsi Render |
|---|---|---|---|
| `dashboard` | Home / IHSG | ⊞ Home | `renderDashboard()` |
| `scanner` | Stock Scanner | ⊡ Scanner | `renderScanner()` |
| `signals` | Trading Signals | ◎ Signals | `renderSignals()` |
| `detail` | Detail Saham | (dari scanner) | `renderDetail()` |
| `watchlist` | Watchlist | ★ Watch | `renderWatchlist()` |
| `settings` | Settings + Log | ◈ Settings | `renderSettings()` |
| `upload` | Import Darurat | (dari topbar ⬆) | `renderUpload()` |

### Navigasi

```javascript
showPage('scanner')      // navigate ke halaman
openDetail('BBCA')       // buka detail saham tertentu
```

Detail page mapping navbar: `detail` → highlight `scanner`.  
Upload page mapping navbar: `upload` → highlight `settings`.

---

## 11. Real-Time Sync Flow

```
App Load
    ↓
renderDashboard()          ← tampil dengan base/cached data
    ↓
setTimeout(fetchLive, 1500ms)
    ↓
fetchLive()
    ├─ setSyncUI('fetching')
    ├─ fetch('/api/idx-quotes', timeout 20s)
    │
    ├─ SUCCESS
    │   ├─ validatePayload()
    │   ├─ applyPayload()    ← merge ke STATE.liveQuotes
    │   ├─ saveToLocalCache()
    │   ├─ setSyncUI('live'|'stale'|'local')
    │   └─ renderCurrent()
    │
    └─ FAILURE
        ├─ loadFromLocalCache()
        │   ├─ HIT  → applyPayload(cached), setSyncUI('stale')
        │   └─ MISS → setSyncUI('local'), render dengan base data
        └─ renderCurrent()

startSyncTimer()
    └─ setInterval(fetchLive, syncInterval * 1000)
       Default: 60s (bisa diubah di Settings: 30s/1m/2m/5m)
```

### Sync Status Labels (UI)

| Status | Warna Dot | Label | Kondisi |
|---|---|---|---|
| `idle` | Abu | STANDBY | Belum sync |
| `fetching` | Kuning (blink) | FETCHING | Sedang fetch |
| `live` | Hijau (glow) | LIVE | Sukses, data fresh |
| `stale` | Orange | STALE | Gagal, pakai cache lama |
| `local` | Purple | LOCAL | Tidak ada cache, pakai sample |
| `error` | Merah | ERROR | Error kritis |

---

## 12. CSV Emergency Import

Untuk mengaktifkan `FULL_FLOW` pada data saham, operator perlu upload CSV broker summary.

### Format CSV

```csv
Symbol,BrokerBuy,BrokerSell,ForeignBuy,ForeignSell,NetBuy,FreqBuy,FreqSell,VolumeAvg5d
BBCA,9500,9200,85000000000,62000000000,23000000000,4200,3100,38000000
BBRI,4700,4900,45000000000,78000000000,-12000000000,5800,6400,95000000
TLKM,3850,3720,92000000000,41000000000,31000000000,3900,2800,72000000
```

### Sumber Data Broker Summary

Data ini biasanya bisa diambil dari:
- Platform trading yang punya fitur ekspor broker summary (Mirae Asset, BNI Sekuritas, RHB, Stockbit Pro, dll)
- Data IDX resmi (untuk foreign flow)
- Provider data IDX berbayar (Investasi.id, Stockbit Data API, dll)

### Catatan

- CSV hanya berisi **flow data** — data harga (price, prevClose, high, low, volume) **selalu** diambil dari backend web sync, tidak dari CSV
- Data CSV tersimpan di `STATE.uploadedFlow` (in-memory), reset saat halaman di-refresh
- Untuk persistensi, simpan ke localStorage atau Supabase (lihat bagian migration path)

---

## 13. Supabase Migration Path

### Schema SQL (siap pakai)

```sql
-- Tabel untuk flow data (broker summary dari operator)
CREATE TABLE idx_flow_data (
  symbol       TEXT PRIMARY KEY,
  broker_buy   BIGINT,
  broker_sell  BIGINT,
  foreign_buy  BIGINT,
  foreign_sell BIGINT,
  net_buy      BIGINT,
  freq_buy     INTEGER,
  freq_sell    INTEGER,
  volume_avg5d BIGINT,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel cache harga (opsional, ganti in-memory cache backend)
CREATE TABLE idx_price_cache (
  symbol      TEXT PRIMARY KEY,
  price       NUMERIC,
  prev_close  NUMERIC,
  high        NUMERIC,
  low         NUMERIC,
  volume      BIGINT,
  pct_chg     NUMERIC,
  as_of       TIMESTAMPTZ,
  source      TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### Variabel Environment

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Langkah Migrasi

1. Ganti `STATE.uploadedFlow` dengan fetch dari Supabase `idx_flow_data`
2. Ganti `CACHE` in-memory di backend dengan Supabase `idx_price_cache`
3. Frontend tetap hanya bicara ke `/api/idx-quotes` — tidak perlu diubah

---

## 14. Known Limitations

### Data

| Keterbatasan | Penjelasan |
|---|---|
| **Broker summary tidak ada dari Yahoo** | `brokerBuy`, `brokerSell`, `foreignBuy`, `foreignSell`, `netBuy`, `freqBuy`, `freqSell` selalu `null` dari web sync. Harus upload manual via CSV. |
| **Yahoo Finance delay ~15 menit** | Data bukan real-time sesungguhnya. Yahoo Finance memberikan data delayed sekitar 15 menit selama jam bursa. |
| **Yahoo bisa rate limit** | Jika terlalu sering hit, Yahoo Finance bisa return 429 atau 403. Backend menangani ini dengan cache dan fallback. |
| **VolumeAvg5d tidak dari Yahoo** | `volumeAvg5d` diambil dari `FLOW_BASE` yang hardcoded. Untuk akurasi, perlu upload via CSV. |
| **Sinyal BUY tidak muncul tanpa FULL_FLOW** | Ini by design — lebih baik tidak ada sinyal daripada sinyal palsu. |

### Teknis

| Keterbatasan | Penjelasan |
|---|---|
| **uploadedFlow hilang saat refresh** | Flow data dari CSV upload tersimpan in-memory, reset saat halaman reload. Solusi: tambah localStorage persistence atau Supabase. |
| **IHSG sparkline statis** | Sparkline IHSG tidak diperbarui dari live data, hanya price terkini yang diperbarui. |
| **Tidak ada WebSocket** | Sync berbasis polling (setInterval). Tidak ada push notification saat harga berubah. |
| **Single HTML file** | Seluruh app dalam 1 file. Untuk app yang lebih besar, pertimbangkan modularisasi. |

---

## 15. Changelog dari Versi Sebelumnya

### v2.0 (Juni 2026)

**DIHAPUS (Breaking):**
- ❌ `fetch('https://api.anthropic.com/v1/messages')` — dihapus total
- ❌ Claude API + web_search tool sebagai data source
- ❌ Header `anthropic-dangerous-direct-browser-access`
- ❌ `PROMPT` template untuk LLM
- ❌ Semua referensi "Claude", "Anthropic", "web_search" di UI
- ❌ Sync log yang menyebut "Claude API"

**DITAMBAHKAN:**
- ✅ Backend `api/idx-quotes.js` — real web fetch ke Yahoo Finance
- ✅ Provider 1: Yahoo Finance v8 chart API
- ✅ Provider 2: Yahoo Finance v7 quote API (fallback)
- ✅ In-memory cache dengan TTL berbasis jam bursa
- ✅ `freshness` field: LIVE / STALE / LOCAL_SAMPLE
- ✅ `dataMode` per saham: FULL_FLOW / PARTIAL_FLOW / PRICE_ONLY / LOCAL_SAMPLE
- ✅ Confidence multiplier berdasarkan data mode
- ✅ BUY signal hanya muncul pada FULL_FLOW — tidak ada sinyal palsu
- ✅ Data quality section di Settings
- ✅ Force sync + clear cache buttons di Settings
- ✅ Semua score components gracefully degrade jika data null
- ✅ Safe math: `num()`, `safeDiv()`, `maybeNum()`, `validPrice()` — tidak ada NaN/Infinity
- ✅ Upload halaman dilabel "Import Darurat" dengan warning
- ✅ Halaman Signals baru (◎) — dedicated BUY/HOLD/SELL list dengan entry/target/SL
- ✅ `asOf` timestamp di setiap quote

**DIPERTAHANKAN:**
- ✅ Seluruh UI style dan layout
- ✅ Semua halaman: dashboard, scanner, detail, watchlist, settings
- ✅ Signal engine logic (diperketat)
- ✅ Risk flag system
- ✅ Sparkline charts
- ✅ Mobile-first glassmorphism aesthetic
- ✅ Dark neon color scheme

---

## 16. Checklist Produksi

Sebelum go-live, verifikasi:

### Backend

- [ ] `api/idx-quotes.js` di-deploy dan accessible di `/api/idx-quotes`
- [ ] `GET /api/idx-quotes` return JSON valid
- [ ] `freshness: "LIVE"` muncul saat jam bursa (09:00–15:00 WIB)
- [ ] Cache bekerja — request kedua lebih cepat dari pertama
- [ ] `?force=true` bypass cache
- [ ] Jika Yahoo gagal, return `freshness: "STALE"` dengan data cache
- [ ] Jika tidak ada cache, return `freshness: "LOCAL_SAMPLE"` dengan warning

### Frontend

- [ ] Tidak ada string "anthropic", "claude", "openai", "gemini"
- [ ] `fetch()` hanya ke `/api/idx-quotes`
- [ ] App load tanpa error di console
- [ ] Sync status pill berubah: STANDBY → FETCHING → LIVE
- [ ] IHSG card menampilkan harga terbaru
- [ ] `dataMode` badge muncul di setiap kartu saham
- [ ] Sinyal BUY tidak muncul pada saham dengan PRICE ONLY
- [ ] N/A muncul untuk field yang null (bukan 0 atau NaN)
- [ ] Score tidak pernah NaN
- [ ] Force sync button berfungsi
- [ ] Clear cache berfungsi
- [ ] CSV import mengubah dataMode ke FULL_FLOW
- [ ] Watchlist tersimpan selama session
- [ ] Navigasi semua halaman berfungsi
- [ ] Detail saham menampilkan 4 tab: Signal, Data, Score, Risk
- [ ] Mobile layout normal di layar 375px

### Data Honesty

- [ ] UI tidak pernah menampilkan "LIVE" untuk data sample
- [ ] Confidence menurun untuk PRICE_ONLY
- [ ] Tidak ada angka broker/foreign yang difabrikasi
- [ ] Semua field null tampil sebagai "N/A"

---

## Kontak & Referensi

**Proyek:** IDX Flow Scanner  
**Stack:** HTML5 + Vanilla JS + Node.js  
**Deploy:** Vercel  
**Data:** Yahoo Finance (public, no auth, ~15min delay)

**Referensi Data IDX:**
- Yahoo Finance: `https://finance.yahoo.com/quote/BBCA.JK`
- IDX Resmi: `https://www.idx.co.id`
- Broker summary: Dari platform broker masing-masing

---

*Handoff document generated: 4 Juni 2026*
