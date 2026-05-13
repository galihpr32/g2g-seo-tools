const puppeteer = require('puppeteer-core');
const fs = require('fs');
const config = require('./config');

// ============================================================
// Google Sheets 数据源配置
// EN sheet  gid=0            → English
// ID sheet  gid=1621635253   → Indonesian
// ============================================================
const SPREADSHEET_ID = '1KSDPg0mrJ15ZTikOYeEoaA6NnM74G0d2rND2LDG8kEM';
const EN_GID         = '0';
const ID_GID         = '1621635253';

// Sheet 列索引（0-based）
// 行结构：
//   第 0 行：Path 行（URL 模板，忽略）
//   第 1 行：表头（列名，忽略）
//   第 2 行起：数据行
//
// A(0)  Brand Name
// B(1)  Category
// C(2)  Relation ID       ← 用于动态生成 3 个 URL
// D(3)  Request Date
// E(4)  Create now?       ← 值为 "Generated" 时处理本行
// F(5)  Main Keyword
// G(6)  Secondary Keyword
// H(7)  Meta Title EN/ID  → /seo  对应语言 Meta Title
// I(8)  Meta Descriptions → /seo  对应语言 Meta Description
// J(9)  Meta Keyword
// K(10) Marketing Title   ↘
// L(11) Marketing Intro    |
// M(12) Marketing Desc (1) |
// N(13) Marketing Desc (2) | → /marketing 对应语言描述框（K~T 列组合）
// O(14) Marketing Desc (3) |
// P(15) Marketing Desc (4) |
// Q(16) Marketing Desc (5) |
// R(17) Marketing Desc (6) |
// S(18) Marketing Desc (7) |
// T(19) Marketing Desc (8) ↗
// U(20) FAQ 1 Q  V(21) FAQ 1 A  ↘
// W(22) FAQ 2 Q  X(23) FAQ 2 A   |
// Y(24) FAQ 3 Q  Z(25) FAQ 3 A   | → /faq 对应语言 FAQ 条目
// AA(26) FAQ 4 Q AB(27) FAQ 4 A  |
// AC(28) FAQ 5 Q AD(29) FAQ 5 A  |
// AE(30) FAQ 6 Q AF(31) FAQ 6 A  |  （如有）
// AG(32) FAQ 7 Q AH(33) FAQ 7 A  ↗  （如有）

const COL_RELATION_ID = 2;
const COL_STATUS      = 4;   // E列 "Create now?"
const COL_META_TITLE  = 7;   // H
const COL_META_DESC   = 8;   // I
const COL_MKT_START   = 10;  // K  Marketing Title（含）
const COL_MKT_END     = 19;  // T  Marketing Desc (8)（含）
const COL_FAQ_START   = 20;  // U  FAQ 1 Q（含）
const COL_FAQ_END     = 33;  // AH FAQ 7 A（含；如列不存在则自动截止）

// 优雅停止
let stopping = false;
process.on('SIGTERM', () => { console.log('\n⏹ 收到停止信号...'); stopping = true; });
process.on('SIGINT',  () => { console.log('\n⏹ 收到中断信号...'); stopping = true; });

// ============================================================
// 从 Google Sheets 读取数据
// 使用 axios（自动处理重定向、SSL、gzip 解压）
// 安装：npm install axios
//
// 优先使用 config.googleApiKey（需在 config.local.js 中配置）
// 否则通过 CSV 导出 URL（需表格设为"知道链接的人可以查看"）
// ============================================================
async function fetchSheetRows(gid) {
  let axios;
  try {
    axios = require('axios');
  } catch {
    throw new Error('缺少依赖，请先运行：npm install axios');
  }

  if (config.googleApiKey) {
    // 方式 1：Sheets API v4 + API Key
    // 先查询 spreadsheet metadata，通过 sheetId 找到 sheet 名称，再用名称构建范围
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?key=${config.googleApiKey}&fields=sheets.properties`;
    const metaRes = await axios.get(metaUrl, { timeout: 30000 });
    const sheets  = metaRes.data.sheets || [];
    const sheet   = sheets.find(s => String(s.properties.sheetId) === String(gid));
    if (!sheet) throw new Error(`找不到 gid=${gid} 对应的 sheet，请确认 GID 是否正确`);
    const sheetName = sheet.properties.title;

    const range   = encodeURIComponent(`${sheetName}!A:AH`);
    const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=${config.googleApiKey}`;
    const dataRes = await axios.get(dataUrl, { timeout: 30000 });
    if (dataRes.data.error) throw new Error(`Sheets API 错误: ${dataRes.data.error.message}`);
    const values = dataRes.data.values || [];
    const maxLen = values.reduce((m, r) => Math.max(m, r.length), 0);
    return values.map(r => { const row = [...r]; while (row.length < maxLen) row.push(''); return row; });

  } else {
    // 方式 2：CSV 导出（表格需设为"知道链接的人可以查看"）
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${gid}`;
    const res = await axios.get(url, {
      timeout: 30000,
      maxRedirects: 10,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const { parse } = require('csv-parse/sync');
    const rows   = parse(res.data, { skip_empty_lines: false, relax_quotes: true, trim: true });
    const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return rows.map(r => { const row = [...r]; while (row.length < maxLen) row.push(''); return row; });
  }
}


// ============================================================
// 解析 sheet 数据行 → 上传任务列表
// ============================================================
function parseSheetRows(allRows, language) {
  // 跳过第 0 行（Path）和第 1 行（表头），从第 2 行起读取数据
  const dataRows = allRows.slice(2);
  const tasks    = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];

    const productName = (row[0]              || '').trim();
    const relationId  = (row[COL_RELATION_ID] || '').trim();
    const status      = (row[COL_STATUS]      || '').trim();

    if (!relationId) continue;

    // 只处理 E列 = "Generated" 的行
    if (status.toLowerCase() !== 'generated') continue;

    // H列：Meta Title
    const metaTitle = (row[COL_META_TITLE] || '').trim();
    // I列：Meta Descriptions
    const metaDesc  = (row[COL_META_DESC]  || '').trim();

    // K(10)~T(19)列：Marketing 内容，非空值换行拼接
    const marketingParts = [];
    for (let c = COL_MKT_START; c <= Math.min(COL_MKT_END, row.length - 1); c++) {
      const val = (row[c] || '').trim();
      if (val) marketingParts.push(val);
    }
    const marketingContent = marketingParts.join('\n');

    // U(20)~AH(33)列（或更多）：FAQ，每两列为一对 Q/A
    const faqs = [];
    const faqEnd = Math.min(COL_FAQ_END, row.length - 2);
    for (let c = COL_FAQ_START; c <= faqEnd; c += 2) {
      const q = (row[c]     || '').trim();
      const a = (row[c + 1] || '').trim();
      if (q && a) faqs.push({ question: q, answer: a });
    }

    tasks.push({
      rowIndex: i,
      productName,
      relationId,
      language,
      metaTitle,
      metaDesc,
      marketingContent,
      faqs,
    });
  }

  return tasks;
}

// ============================================================
// 将 EN 和 ID 任务按 Relation ID 归组
// ============================================================
function mergeTasksByRelationId(enTasks, idTasks) {
  const map = new Map();
  for (const t of enTasks) {
    if (!map.has(t.relationId)) map.set(t.relationId, { productName: t.productName, relationId: t.relationId, en: null, id: null });
    map.get(t.relationId).en = t;
  }
  for (const t of idTasks) {
    if (!map.has(t.relationId)) map.set(t.relationId, { productName: t.productName, relationId: t.relationId, en: null, id: null });
    map.get(t.relationId).id = t;
  }
  return [...map.values()];
}

// ============================================================
// 填写 Marketing 页面某语言的描述框
// ============================================================
async function fillMarketingField(page, languageLabel, content) {
  const result = await page.evaluate((label, text) => {
    const expansionItems = document.querySelectorAll('.q-expansion-item');
    let container = null;
    for (const item of expansionItems) {
      const itemLabel = item.querySelector('.q-item__label');
      if (itemLabel && itemLabel.textContent.includes('Description')) {
        container = item;
        break;
      }
    }
    if (!container) return '未找到 Marketing Description 容器';

    const rows = container.querySelectorAll('.row.items-center');
    for (const row of rows) {
      const labelDiv = row.querySelector('.col-4');
      if (labelDiv && labelDiv.textContent.trim() === label) {
        const textarea = row.querySelector('textarea.q-field__native');
        if (textarea) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(textarea, text);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          return `成功填写: ${label}`;
        }
        return `找到标签但没有 textarea: ${label}`;
      }
    }
    return `未找到标签: ${label}`;
  }, languageLabel, content);
  console.log(`    ${result}`);
}

// ============================================================
// 填写 SEO 页面的 Meta Title / Meta Description
// ============================================================
async function fillSeoField(page, sectionLabel, languageLabel, content) {
  await page.evaluate((section) => {
    const pageMain = document.querySelector('.page-content, .q-page');
    if (!pageMain) return;
    const boldTitles = pageMain.querySelectorAll('p.text-weight-bold, .text-weight-bold');
    for (const title of boldTitles) {
      if (title.textContent.trim().includes(section)) {
        let el = title.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          const toggleBtn = el.querySelector('.q-item--clickable, [aria-expanded]');
          if (toggleBtn && toggleBtn.getAttribute('aria-expanded') !== 'true') {
            toggleBtn.click();
            break;
          }
          el = el.nextElementSibling || el.parentElement;
        }
        break;
      }
    }
  }, sectionLabel);
  await new Promise(r => setTimeout(r, 1000));

  const result = await page.evaluate((section, label, text) => {
    const pageMain = document.querySelector('.page-content, .q-page');
    if (!pageMain) return '未找到页面主区域';

    const boldTitles = pageMain.querySelectorAll('p.text-weight-bold, .text-weight-bold');
    let sectionEl = null;
    for (const title of boldTitles) {
      if (title.textContent.trim().includes(section)) { sectionEl = title; break; }
    }
    if (!sectionEl) return `未找到 ${section} 标题`;

    let parent = sectionEl.parentElement;
    let expansionContent = null;
    for (let i = 0; i < 8; i++) {
      if (!parent) break;
      const items = parent.querySelectorAll('.q-expansion-item--expanded');
      if (items.length > 0) { expansionContent = items[0]; break; }
      let sibling = parent.nextElementSibling;
      while (sibling) {
        if (sibling.querySelector('.q-expansion-item--expanded')) {
          expansionContent = sibling.querySelector('.q-expansion-item--expanded');
          break;
        }
        if (sibling.classList.contains('q-expansion-item--expanded')) {
          expansionContent = sibling;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      if (expansionContent) break;
      parent = parent.parentElement;
    }
    if (!expansionContent) return `未找到 ${section} 展开内容`;

    const rows = expansionContent.querySelectorAll('.row.items-center');
    for (const row of rows) {
      const labelDiv = row.querySelector('.col-4');
      if (labelDiv && labelDiv.textContent.trim() === label) {
        const textarea = row.querySelector('textarea.q-field__native');
        if (textarea) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(textarea, text);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          return `成功填写: ${section} - ${label}`;
        }
        return `找到标签但没有 textarea: ${section} - ${label}`;
      }
    }
    return `未找到标签: ${section} - ${label}`;
  }, sectionLabel, languageLabel, content);
  console.log(`    ${result}`);
}

// ============================================================
// FAQ：删除旧条目
// ============================================================
async function deleteExistingFaqs(page, languageLabel) {
  await page.evaluate((label) => {
    const items = document.querySelectorAll('.q-expansion-item.faq-item');
    for (const item of items) {
      const labelEl = item.querySelector('.q-item__label');
      if (labelEl && labelEl.textContent.trim() === label) {
        const btn = item.querySelector('.q-item--clickable');
        if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
        break;
      }
    }
  }, languageLabel);
  await new Promise(r => setTimeout(r, 1000));

  let deleteCount = 0;
  while (true) {
    const hasDeleteBtn = await page.evaluate((label) => {
      const items = document.querySelectorAll('.q-expansion-item.faq-item');
      for (const item of items) {
        const labelEl = item.querySelector('.q-item__label');
        if (labelEl && labelEl.textContent.trim() === label) {
          const firstFaqItem = item.querySelector('.q-mb-md.q-pa-md.faq-item');
          if (!firstFaqItem) return false;
          const deleteBtn = firstFaqItem.querySelector('.col-1.text-right button, button');
          if (deleteBtn) { deleteBtn.click(); return true; }
          break;
        }
      }
      return false;
    }, languageLabel);

    if (!hasDeleteBtn) break;
    await new Promise(r => setTimeout(r, 800));

    const confirmed = await page.evaluate(() => {
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        const span = btn.querySelector('span.block');
        if (span && span.textContent.trim() === 'Delete') { btn.click(); return true; }
        if (btn.textContent.trim() === 'Delete') { btn.click(); return true; }
      }
      return false;
    });

    if (confirmed) { deleteCount++; await new Promise(r => setTimeout(r, 800)); }
    else break;
  }
  console.log(`    ${deleteCount > 0 ? `已删除 ${deleteCount} 条旧 FAQ` : '无旧 FAQ 需要删除'}`);
}

// ============================================================
// FAQ：上传新条目（来自 U~AD 列）
// ============================================================
async function uploadFaqs(page, languageLabel, faqs) {
  if (!faqs || faqs.length === 0) {
    console.log(`    ⚠️ ${languageLabel} 没有 FAQ 内容`);
    return;
  }

  console.log(`    上传 ${languageLabel} FAQ ${faqs.length} 条`);
  await deleteExistingFaqs(page, languageLabel);

  // 确保语言 section 已展开
  await page.evaluate((label) => {
    const items = document.querySelectorAll('.q-expansion-item.faq-item');
    for (const item of items) {
      const labelEl = item.querySelector('.q-item__label');
      if (labelEl && labelEl.textContent.trim() === label) {
        const btn = item.querySelector('.q-item--clickable');
        if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
        break;
      }
    }
  }, languageLabel);
  await new Promise(r => setTimeout(r, 500));

  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];

    // 点击 Add FAQ
    await page.evaluate((label) => {
      const items = document.querySelectorAll('.q-expansion-item.faq-item');
      for (const item of items) {
        const labelEl = item.querySelector('.q-item__label');
        if (labelEl && labelEl.textContent.trim() === label) {
          const btns = item.querySelectorAll('button');
          for (const btn of btns) {
            const span = btn.querySelector('span.block');
            if (span && span.textContent.includes('Add FAQ')) { btn.click(); break; }
          }
          break;
        }
      }
    }, languageLabel);
    await new Promise(r => setTimeout(r, 800));

    const filled = await page.evaluate((q, a, label) => {
      const items = document.querySelectorAll('.q-expansion-item.faq-item');
      let container = null;
      for (const item of items) {
        const labelEl = item.querySelector('.q-item__label');
        if (labelEl && labelEl.textContent.trim() === label) { container = item; break; }
      }
      if (!container) return `未找到 ${label} 语言容器`;

      const allQuestions = container.querySelectorAll('textarea[placeholder="Enter FAQ question"]');
      const allAnswers   = container.querySelectorAll('textarea[placeholder="Enter FAQ answer"]');
      if (allQuestions.length === 0) return '未找到问题输入框';

      const lastQ = allQuestions[allQuestions.length - 1];
      const lastA = allAnswers[allAnswers.length - 1];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

      setter.call(lastQ, q);
      lastQ.dispatchEvent(new Event('input', { bubbles: true }));
      lastQ.dispatchEvent(new Event('change', { bubbles: true }));

      if (lastA) {
        setter.call(lastA, a);
        lastA.dispatchEvent(new Event('input', { bubbles: true }));
        lastA.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return `成功填写第 ${allQuestions.length} 条`;
    }, faq.question, faq.answer, languageLabel);

    console.log(`    FAQ ${i + 1}: ${filled}`);
    await new Promise(r => setTimeout(r, 300));
  }
}

// ============================================================
// 验证页面 Relation ID
// ============================================================
async function verifyRelationId(page, expectedId) {
  try {
    await page.waitForSelector('.q-item__label--caption', { timeout: 10000 });
    const pageId = await page.$eval('.q-item__label--caption', el => el.textContent.trim());
    return pageId === expectedId ? pageId : null;
  } catch {
    return null;
  }
}

// ============================================================
// 点击 Save 按钮并等待
// ============================================================
async function clickSave(page) {
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button.q-btn');
    for (const btn of buttons) {
      const span = btn.querySelector('span.block');
      if (span && span.textContent.trim() === 'Save') { btn.click(); break; }
    }
  });
  await new Promise(r => setTimeout(r, 2000));
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  if (!config.firefoxPath) {
    console.error('❌ 未找到 Firefox，请在 config.local.js 中设置 firefoxPath');
    process.exit(1);
  }
  if (!config.firefoxProfile) {
    console.error('❌ 未找到 Firefox Profile，请在 config.local.js 中设置 firefoxProfile');
    process.exit(1);
  }

  console.log(`🦊 Firefox: ${config.firefoxPath}`);
  console.log(`👤 Profile: ${config.firefoxProfile}\n`);

  // ── 读取两个 sheet ───────────────────────────────────────
  console.log('📥 正在读取 Google Sheets...');
  console.log(`   EN: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${EN_GID}`);
  console.log(`   ID: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${ID_GID}`);

  let enRows, idRows;
  try {
    enRows = await fetchSheetRows(EN_GID);
    console.log(`   EN 读取成功，共 ${enRows.length} 行`);
  } catch (e) {
    console.error(`❌ EN sheet 读取失败: ${e.message}`);
    process.exit(1);
  }
  try {
    idRows = await fetchSheetRows(ID_GID);
    console.log(`   ID 读取成功，共 ${idRows.length} 行`);
  } catch (e) {
    console.error(`❌ ID sheet 读取失败: ${e.message}`);
    process.exit(1);
  }

  // ── 解析并合并任务 ───────────────────────────────────────
  const enTasks = parseSheetRows(enRows, 'English');
  const idTasks = parseSheetRows(idRows, 'Indonesian');

  console.log(`\n   EN 待上传: ${enTasks.length} 条`);
  console.log(`   ID 待上传: ${idTasks.length} 条`);

  const groups = mergeTasksByRelationId(enTasks, idTasks);
  console.log(`   合并后产品: ${groups.length} 个\n`);

  if (groups.length === 0) {
    console.log('没有需要上传的数据（两个 sheet 中 E列 "Create now?" 均不为 "Generated"）');
    return;
  }

  // ── 启动浏览器 ───────────────────────────────────────────
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: config.firefoxPath,
    headless: true,
    userDataDir: config.firefoxProfile,
  });

  let page = await browser.newPage();

  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const newPage = await target.page();
        if (newPage && newPage !== page) await newPage.close();
      } catch {}
    }
  });

  if (fs.existsSync('./cookies.json')) {
    const cookies = JSON.parse(fs.readFileSync('./cookies.json'));
    await page.setCookie(...cookies);
    console.log('Cookie 已加载\n');
  }

  const uploaded   = [];
  const skipped    = [];
  const idMismatch = [];

  for (const group of groups) {
    if (stopping) { console.log('\n⏹ 已停止'); break; }

    const { productName, relationId, en, id: ind } = group;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`处理: [${productName}]  ID: ${relationId}`);

    // 检查 page 是否失效
    try {
      await page.evaluate(() => true);
    } catch {
      if (stopping) break;
      console.log('  ⚠️ 页面已失效，重新创建...');
      try { page = await browser.newPage(); } catch {}
    }

    const uploadedLangs = [];

    // ════════════════════════════════════════════════════════
    // URL 1: Marketing
    // https://crew-vue.g2g.com/offers/products/config/{relationId}/marketing
    // EN：K~T 列内容 → English 描述框
    // ID：K~T 列内容 → Indonesian 描述框
    // ════════════════════════════════════════════════════════
    if (stopping) break;
    const marketingUrl = `https://crew-vue.g2g.com/offers/products/config/${relationId}/marketing`;
    console.log(`\n  [1/3 Marketing] ${marketingUrl}`);
    try { await page.goto(marketingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
    catch (e) { if (stopping) break; throw e; }
    await new Promise(r => setTimeout(r, 3000));

    const mktId = await verifyRelationId(page, relationId);
    if (!mktId) {
      console.log('  ⚠️ Relation ID 不匹配，跳过本条');
      idMismatch.push({ name: productName, reason: 'Marketing ID不匹配' });
      continue;
    }

    // 展开 Description section
    try {
      await page.waitForSelector('.q-expansion-item', { timeout: 10000 });
      await page.evaluate(() => {
        document.querySelectorAll('.q-expansion-item').forEach(item => {
          const label = item.querySelector('.q-item__label');
          if (label && label.textContent.includes('Description')) {
            const btn = item.querySelector('.q-item--clickable');
            if (btn) btn.click();
          }
        });
      });
      await new Promise(r => setTimeout(r, 1000));
    } catch { console.log('  ⚠️ Description 展开失败'); }

    await page.waitForSelector('textarea.q-field__native', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 500));

    if (en && en.marketingContent) {
      console.log(`    EN Marketing 内容长度: ${en.marketingContent.length}`);
      await fillMarketingField(page, 'English', en.marketingContent);
      uploadedLangs.push('English');
    } else if (en) {
      console.log('    ⚠️ EN Marketing 内容为空（K~T 列均空）');
    }

    if (ind && ind.marketingContent) {
      console.log(`    ID Marketing 内容长度: ${ind.marketingContent.length}`);
      await fillMarketingField(page, 'Indonesian', ind.marketingContent);
      if (!uploadedLangs.includes('Indonesian')) uploadedLangs.push('Indonesian');
    } else if (ind) {
      console.log('    ⚠️ ID Marketing 内容为空（K~T 列均空）');
    }

    console.log('    → 点击 Save');
    await clickSave(page);

    // ════════════════════════════════════════════════════════
    // URL 2: SEO
    // https://crew-vue.g2g.com/offers/products/config/{relationId}/seo
    // EN：H列 Meta Title     → Meta Title / English
    //     I列 Meta Desc      → Meta Description / English
    // ID：H列 Meta Title ID  → Meta Title / Indonesian
    //     I列 Meta Desc ID   → Meta Description / Indonesian
    // ════════════════════════════════════════════════════════
    if (stopping) break;
    const seoUrl = `https://crew-vue.g2g.com/offers/products/config/${relationId}/seo`;
    console.log(`\n  [2/3 SEO] ${seoUrl}`);
    try { await page.goto(seoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
    catch (e) { if (stopping) break; throw e; }
    await new Promise(r => setTimeout(r, 3000));

    const seoPageId = await verifyRelationId(page, relationId);
    if (!seoPageId) {
      console.log('  ⚠️ SEO Relation ID 不匹配，跳过 SEO');
    } else {
      if (en?.metaTitle) {
        console.log(`    EN Meta Title (H列): ${en.metaTitle.substring(0, 60)}`);
        await fillSeoField(page, 'Meta Title', 'English', en.metaTitle);
      }
      if (en?.metaDesc) {
        console.log(`    EN Meta Desc  (I列): ${en.metaDesc.substring(0, 60)}`);
        await fillSeoField(page, 'Meta Description', 'English', en.metaDesc);
      }
      if (ind?.metaTitle) {
        console.log(`    ID Meta Title (H列): ${ind.metaTitle.substring(0, 60)}`);
        await fillSeoField(page, 'Meta Title', 'Indonesian', ind.metaTitle);
      }
      if (ind?.metaDesc) {
        console.log(`    ID Meta Desc  (I列): ${ind.metaDesc.substring(0, 60)}`);
        await fillSeoField(page, 'Meta Description', 'Indonesian', ind.metaDesc);
      }
      console.log('    → 点击 Save');
      await clickSave(page);
    }

    // ════════════════════════════════════════════════════════
    // URL 3: FAQ
    // https://crew-vue.g2g.com/offers/products/config/{relationId}/faq
    // EN：U~AD 列（FAQ 1 Q/A ~ FAQ 5 Q/A，最多 FAQ 7）→ English
    // ID：同结构 → Indonesian
    // ════════════════════════════════════════════════════════
    if (stopping) break;
    const faqUrl = `https://crew-vue.g2g.com/offers/products/config/${relationId}/faq`;
    console.log(`\n  [3/3 FAQ] ${faqUrl}`);
    try { await page.goto(faqUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
    catch (e) { if (stopping) break; throw e; }
    await new Promise(r => setTimeout(r, 4000));

    const faqPageId = await verifyRelationId(page, relationId);
    if (!faqPageId) {
      console.log('  ⚠️ FAQ Relation ID 不匹配，跳过 FAQ');
    } else {
      if (en?.faqs?.length > 0) {
        await uploadFaqs(page, 'English', en.faqs);
        await new Promise(r => setTimeout(r, 500));
      } else if (en) {
        console.log('    ⚠️ EN FAQ 为空（U~AD 列均空）');
      }

      if (ind?.faqs?.length > 0) {
        await uploadFaqs(page, 'Indonesian', ind.faqs);
        await new Promise(r => setTimeout(r, 500));
      } else if (ind) {
        console.log('    ⚠️ ID FAQ 为空（U~AD 列均空）');
      }

      console.log('    → 点击 Save');
      await clickSave(page);
    }

    uploaded.push({ name: productName, langs: uploadedLangs.join(' / ') || '（无内容写入）' });
    console.log(`  ✅ 完成`);
  }

  try { await browser.close(); } catch {}
  if (stopping) console.log('\n⏹ 脚本已停止');
  printReport({ uploaded, skipped, idMismatch });
}

// ============================================================
// 运行报告
// ============================================================
function printReport({ uploaded, skipped, idMismatch }) {
  console.log('\n' + '='.repeat(60));
  console.log('运行报告');
  console.log('='.repeat(60));

  console.log(`\n✅ 成功处理 (${uploaded.length} 条):`);
  uploaded.length === 0
    ? console.log('   无')
    : uploaded.forEach(r => console.log(`   - ${r.name}：${r.langs}`));

  console.log(`\n⏭️  跳过 (${skipped.length} 条):`);
  skipped.length === 0
    ? console.log('   无')
    : skipped.forEach(r => console.log(`   - ${r.name}：${r.reason}`));

  console.log(`\n❌ ID不匹配/异常 (${idMismatch.length} 条):`);
  idMismatch.length === 0
    ? console.log('   无')
    : idMismatch.forEach(r => console.log(`   - ${r.name}：${r.reason}`));

  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
