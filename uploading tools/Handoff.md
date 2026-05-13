# Handoff: G2G Content Upload Automation (`upload.js`)

## What It Does

`upload.js` is a Node.js automation script that reads product content from a Google Sheets spreadsheet and programmatically fills it into the G2G crew admin panel (`crew-vue.g2g.com`) using a headless Firefox browser.

For every product row where column E says `Generated`, the script visits three admin pages in sequence — Marketing, SEO, and FAQ — and writes the correct content for both English and Indonesian, then saves each page.

It replaces manual copy-paste work for content teams uploading product descriptions, metadata, and FAQs at scale.

---

## How It Works — End to End

```
Google Sheets (EN sheet + ID sheet)
         ↓  fetch via API or CSV export
   Parse rows where column E = "Generated"
         ↓
   Group by Relation ID
         ↓  for each product:
   Firefox (headless, using your saved login profile)
         ↓
   ┌─── 1. /marketing  → fill Description (English + Indonesian)
   ├─── 2. /seo        → fill Meta Title + Meta Description (English + Indonesian)
   └─── 3. /faq        → delete old FAQs, upload new Q&A pairs (English + Indonesian)
         ↓
   Console report (success / skipped / ID mismatches)
```

---

## Prerequisites

### Node.js Packages

```bash
npm install puppeteer-core csv-parse
```

> `googleapis` is only needed if you use a Service Account instead of an API Key (optional advanced setup — see Configuration below).

### Firefox

The script uses Firefox (not Chromium). Firefox must be installed and its executable path set in config. It also requires a Firefox **profile that already has an active G2G admin session** — the script loads your saved profile so it inherits your login cookies automatically.

### Files Required in the Same Directory

| File | Purpose |
|------|---------|
| `upload.js` | The main script |
| `config.js` | Base config (exports defaults) |
| `config.local.js` | Your local overrides — Firefox path, profile, API key |
| `cookies.json` | *(Optional)* Manually exported G2G session cookies as a fallback |

---

## Configuration (`config.local.js`)

Create a file called `config.local.js` in the same directory as `upload.js`. It is merged with `config.js` at runtime.

```js
module.exports = {
  // Required: path to your Firefox binary
  firefoxPath: '/Applications/Firefox.app/Contents/MacOS/firefox',
  // Windows example: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'

  // Required: path to your Firefox user profile directory
  // To find it: open Firefox → type about:profiles in the address bar → copy the Root Directory path
  firefoxProfile: '/Users/yourname/Library/Application Support/Firefox/Profiles/abc123.default',

  // Recommended: Google Sheets API key (enables reading the sheet reliably)
  // Without this, the script falls back to CSV export, which requires the sheet to be publicly readable
  googleApiKey: 'AIza...',
};
```

---

## Google Sheets Data Source

**Spreadsheet:** https://docs.google.com/spreadsheets/d/1KSDPg0mrJ15ZTikOYeEoaA6NnM74G0d2rND2LDG8kEM

Two sheets are read independently, then merged by Relation ID:

| Sheet | GID | Language |
|-------|-----|----------|
| EN | `0` | English |
| ID | `1621635253` | Indonesian |

### How the Sheet Is Read (auto-selected)

1. **Google Sheets API v4** — used when `config.googleApiKey` is set. Reliable, works on private sheets.
2. **CSV export URL** — fallback if no API key is configured. The spreadsheet must be set to *"Anyone with the link can view"* for this to work.

---

## Sheet Structure

Both the EN and ID sheets share the same column layout. The script skips row 0 (the URL path row) and row 1 (the header row). Data starts at **row 2**.

### Trigger Column

| Column | Field | Trigger Value |
|--------|-------|---------------|
| **E** | **Create now?** | **`Generated`** → row will be processed |

Any other value (`To do`, blank, anything else) means the row is skipped entirely. This is the sole flag that controls whether a product gets uploaded.

### Full Column Map

| Column | Index | Field | Destination |
|--------|-------|-------|-------------|
| A | 0 | Brand Name | Logging only |
| B | 1 | Category | Not used |
| **C** | **2** | **Relation ID** | Used to build all 3 target URLs |
| D | 3 | Request Date | Not used |
| **E** | **4** | **Create now?** | **Must be `Generated` to process** |
| F | 5 | Main Keyword | Not used |
| G | 6 | Secondary Keyword | Not used |
| **H** | **7** | **Meta Title** | → SEO page, Meta Title field |
| **I** | **8** | **Meta Descriptions** | → SEO page, Meta Description field |
| J | 9 | Meta Keyword | Not used |
| **K** | **10** | Marketing Title | ↘ |
| **L** | **11** | Marketing Intro | &nbsp; |
| **M** | **12** | Marketing Description (1) | &nbsp; Combined into one block, |
| **N** | **13** | Marketing Description (2) | &nbsp; non-empty cells joined |
| **O** | **14** | Marketing Description (3) | &nbsp; with newlines |
| **P** | **15** | Marketing Description (4) | &nbsp; → Marketing page |
| **Q** | **16** | Marketing Description (5) | &nbsp; Description textarea |
| **R** | **17** | Marketing Description (6) | &nbsp; |
| **S** | **18** | Marketing Description (7) | &nbsp; |
| **T** | **19** | Marketing Description (8) | ↗ |
| **U** | **20** | FAQ 1 — Question | ↘ |
| **V** | **21** | FAQ 1 — Answer | &nbsp; |
| **W** | **22** | FAQ 2 — Question | &nbsp; Each Q+A pair |
| **X** | **23** | FAQ 2 — Answer | &nbsp; becomes one FAQ entry |
| **Y** | **24** | FAQ 3 — Question | &nbsp; on the FAQ page |
| **Z** | **25** | FAQ 3 — Answer | &nbsp; |
| **AA** | **26** | FAQ 4 — Question | &nbsp; |
| **AB** | **27** | FAQ 4 — Answer | &nbsp; |
| **AC** | **28** | FAQ 5 — Question | &nbsp; |
| **AD** | **29** | FAQ 5 — Answer | ↗ |
| AE | 30 | FAQ 6 — Question | *(optional, used if present)* |
| AF | 31 | FAQ 6 — Answer | *(optional)* |
| AG | 32 | FAQ 7 — Question | *(optional)* |
| AH | 33 | FAQ 7 — Answer | *(optional)* |

> Empty cells in K–T are silently skipped (not included in the marketing block).
> FAQ pairs where either Q or A is empty are skipped entirely.

---

## The Three Target URLs

All URLs are generated dynamically from the **Relation ID** in column C:

```
/marketing  →  https://crew-vue.g2g.com/offers/products/config/{relationId}/marketing
/seo        →  https://crew-vue.g2g.com/offers/products/config/{relationId}/seo
/faq        →  https://crew-vue.g2g.com/offers/products/config/{relationId}/faq
```

Before writing anything to a page, the script reads the Relation ID displayed on that page and confirms it matches the expected value. If they don't match, the product is flagged in the report and skipped.

---

## What Gets Written — Per Page

### 1. `/marketing`

Opens the marketing config page, expands the "Description" accordion, and fills:

- **English** description textarea ← columns K–T from the **EN sheet** (joined with newlines)
- **Indonesian** description textarea ← columns K–T from the **ID sheet**

Clicks **Save**.

### 2. `/seo`

Opens the SEO config page, expands the Meta Title and Meta Description sections, and fills:

- **Meta Title / English** ← column H from EN sheet
- **Meta Description / English** ← column I from EN sheet
- **Meta Title / Indonesian** ← column H from ID sheet
- **Meta Description / Indonesian** ← column I from ID sheet

Clicks **Save**.

### 3. `/faq`

Opens the FAQ config page and for each language:

1. Expands the language's FAQ accordion section
2. **Deletes all existing FAQ entries** (loops through delete buttons and confirms each deletion)
3. Adds new entries one by one from the sheet (columns U–AD, up to FAQ 7 if columns AE–AH are present)

- **English FAQs** ← columns U–AD (or U–AH) from EN sheet
- **Indonesian FAQs** ← columns U–AD (or U–AH) from ID sheet

Clicks **Save**.

---

## How to Run

```bash
node upload.js
```

The script will:

1. Fetch both EN and ID sheets from Google Sheets
2. Parse all rows where column E = `Generated`
3. Group them by Relation ID (so EN + ID data for the same product are processed together)
4. Launch headless Firefox with your saved profile
5. Load cookies from `cookies.json` if it exists
6. Process each product through all 3 pages in order
7. Print a summary report at the end

### Stopping Mid-Run

Press `Ctrl+C` at any time. The script catches the signal, finishes the current page action cleanly, and exits without corrupting data.

---

## Console Output Example

```
🦊 Firefox: /Applications/Firefox.app/Contents/MacOS/firefox
👤 Profile: /Users/.../Firefox/Profiles/abc123.default

📥 正在读取 Google Sheets...
   EN: https://docs.google.com/spreadsheets/d/.../edit?gid=0
   ID: https://docs.google.com/spreadsheets/d/.../edit?gid=1621635253
   EN 读取成功，共 12 行
   ID 读取成功，共 12 行

   EN 待上传: 8 条
   ID 待上传: 8 条
   合并后产品: 8 个

────────────────────────────────────────────────────────────
处理: [Kiln]  ID: 57851424-8658-4d74-b5d6-62ea28af1975

  [1/3 Marketing] https://crew-vue.g2g.com/...
    EN Marketing 内容长度: 4821
    成功填写: English
    ID Marketing 内容长度: 4633
    成功填写: Indonesian
    → 点击 Save

  [2/3 SEO] https://crew-vue.g2g.com/...
    EN Meta Title (H列): Buy Kiln Accounts | G2G.com Gaming Marketplace
    成功填写: Meta Title - English
    EN Meta Desc  (I列): Secure kiln accounts and pottery equipment on G2G.com...
    成功填写: Meta Description - English
    → 点击 Save

  [3/3 FAQ] https://crew-vue.g2g.com/...
    上传 English FAQ 6 条
    无旧 FAQ 需要删除
    FAQ 1: 成功填写第 1 条
    ...
    → 点击 Save
  ✅ 完成

============================================================
运行报告
============================================================

✅ 成功处理 (8 条):
   - Kiln：English / Indonesian
   - WARLODE：English / Indonesian
   ...

⏭️  跳过 (0 条):
   无

❌ ID不匹配/异常 (0 条):
   无
============================================================
```

---

## Known Behaviours & Edge Cases

| Situation | What Happens |
|-----------|-------------|
| Row E column is blank, `To do`, or anything other than `Generated` | Row is skipped entirely |
| EN sheet has a row but ID sheet does not (or vice versa) | Only the available language is filled; the other is silently skipped |
| K–T columns are all empty | Marketing textarea for that language is not touched; a warning is logged |
| FAQ columns U–AD are all empty | FAQ section for that language is not touched; a warning is logged |
| Relation ID on page doesn't match sheet value | Entire product is skipped and flagged in the ID mismatch report |
| Page crashes or becomes unresponsive | Script detects the dead page, recreates it, and continues |
| `Ctrl+C` pressed | Script finishes the current page action and exits cleanly |
| `cookies.json` is present | Cookies are injected into the browser session on startup |

---

## File Reference

```
project/
├── upload.js          ← main script (this file)
├── config.js          ← default config (do not edit)
├── config.local.js    ← YOUR local config: Firefox path, profile, API key
├── cookies.json       ← optional: G2G session cookies
└── package.json
```

---

## Quick Troubleshooting

**"EN sheet 读取失败"**
The spreadsheet is private and no `googleApiKey` is set. Either add an API key to `config.local.js` or change the sheet sharing to "Anyone with the link can view."

**"未找到 Firefox"**
`firefoxPath` in `config.local.js` is missing or wrong. Verify the path points to the Firefox binary on your machine.

**"未找到 Firefox Profile"**
`firefoxProfile` in `config.local.js` is missing or wrong. Open Firefox, go to `about:profiles`, and copy the **Root Directory** path of your active profile.

**"Marketing ID 不匹配"**
The Relation ID in column C does not match what the G2G admin page shows. Double-check the Relation ID value in the sheet for that product.

**"未找到 Marketing Description 容器"**
The admin page UI structure may have changed. The script looks for `.q-expansion-item` elements containing "Description" — if the G2G frontend is updated, the selectors may need to be revised.

**Content appears blank after upload**
The Vue.js reactive framework requires native input events to register the value. The script uses `Object.getOwnPropertyDescriptor` to set textarea values and dispatches both `input` and `change` events. If G2G updates its frontend framework version, this method should still work but can be tested by checking if the Save button becomes enabled after filling.
