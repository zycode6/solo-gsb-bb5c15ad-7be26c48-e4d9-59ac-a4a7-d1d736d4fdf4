'use strict';

/* 路由冲突实验室 —— 原生前端
 * 规则编辑后（含拖动排序）防抖调用 POST /api/analyze 实时重算。
 */

const STORAGE_KEY = 'route-conflict-lab.rules.v1';
const SAMPLES_STORAGE_KEY = 'route-conflict-lab.samples.v1';
const BASELINE_STORAGE_KEY = 'route-conflict-lab.baseline.v1';

const DEFAULT_RULES = [
  { method: 'GET', path: '/api/*' },
  { method: 'GET', path: '/api/users/*' },
  { method: 'GET', path: '/api/users/:id' },
  { method: 'GET', path: '/assets/*' },
  { method: 'GET', path: '/assets/css/*' },
  { method: 'GET', path: '/a/*/c' },
  { method: 'GET', path: '/*/b/c' },
  { method: 'POST', path: '/api/users' },
];

/* 默认请求样例：覆盖命中、无匹配与 ALL/通配符语义，便于首次打开即看到预演效果 */
const DEFAULT_SAMPLES = [
  'GET /api/users/123',
  'GET /assets/css/site.css',
  'POST /api/users',
  'GET /nowhere/deep',
].join('\n');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'];

const listEl = document.getElementById('rules-list');
const conflictsEl = document.getElementById('conflicts');
const summaryEl = document.getElementById('summary');
const toastEl = document.getElementById('toast');
const fixEl = document.getElementById('fix-plan');
const fixBtnEl = document.getElementById('btn-fix');
const samplesInput = document.getElementById('samples-input');
const samplesSummaryEl = document.getElementById('samples-summary');
const samplesResultEl = document.getElementById('samples-result');
const diffSummaryEl = document.getElementById('diff-summary');
const diffResultEl = document.getElementById('diff-result');
const baselineInfoEl = document.getElementById('baseline-info');
const baselineClearBtn = document.getElementById('btn-baseline-clear');

let rules = loadRules();
let baseline = loadBaseline(); // 基线路由表（仅保存在浏览器），null 表示未设置
let baselineDetailsOpen = false;
let dragIndex = null;
let lastAnalysis = null;
let debounceTimer = null;
let fixOpen = false;

function loadRules() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((r) => r && typeof r.path === 'string')) {
        return parsed.map((r) => ({
          method: typeof r.method === 'string' ? r.method : 'GET',
          path: r.path,
        }));
      }
    }
  } catch (_e) {
    /* 存储损坏时回退到默认示例 */
  }
  return DEFAULT_RULES.map((r) => ({ ...r }));
}

function saveRules() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

/* ---------------- 基线路由表（版本差异审计，仅保存在浏览器） ---------------- */

function loadBaseline() {
  try {
    const raw = localStorage.getItem(BASELINE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((r) => r && typeof r.path === 'string')) {
        return parsed.map((r) => ({
          method: typeof r.method === 'string' ? r.method : 'GET',
          path: r.path,
        }));
      }
    }
  } catch (_e) {
    /* 存储损坏时视为未设置基线 */
  }
  return null;
}

function saveBaseline() {
  try {
    localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(baseline));
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

/** 解析导入的 JSON：兼容裸数组与 { rules: [...] } 两种格式（当前规则与基线共用） */
function parseRulesJson(data) {
  const incoming = Array.isArray(data) ? data : data && data.rules;
  if (!Array.isArray(incoming)) {
    throw new Error('JSON 中未找到 rules 数组');
  }
  const cleaned = incoming
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      method: typeof r.method === 'string' ? r.method : 'GET',
      path: String(r.path ?? ''),
    }));
  if (cleaned.length === 0) throw new Error('规则列表为空');
  return cleaned;
}

/* ---------------- 请求样例（回归预演输入） ---------------- */

function loadSamplesText() {
  try {
    const v = localStorage.getItem(SAMPLES_STORAGE_KEY);
    // 首次使用（从未保存过）时给出默认样例；用户清空后保持为空
    return typeof v === 'string' ? v : DEFAULT_SAMPLES;
  } catch (_e) {
    return DEFAULT_SAMPLES;
  }
}

function saveSamplesText() {
  try {
    localStorage.setItem(SAMPLES_STORAGE_KEY, samplesInput.value);
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

/** 当前输入框中的样例行（含空白行，由后端跳过并保留行号） */
function currentSampleLines() {
  return String(samplesInput.value || '').split('\n');
}

function showToast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

/* ---------------- 规则列表渲染 ---------------- */

function renderRules() {
  listEl.innerHTML = '';
  rules.forEach((rule, i) => {
    const li = document.createElement('li');
    li.className = 'rule-row';
    li.dataset.index = String(i);
    li.draggable = true;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⣿';
    grip.title = '拖动以调整优先级';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;

    const method = document.createElement('select');
    method.className = 'rule-method';
    method.setAttribute('aria-label', `规则 ${i + 1} 的请求方法`);
    for (const m of METHODS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if ((rule.method || 'GET').toUpperCase() === m) opt.selected = true;
      method.appendChild(opt);
    }
    method.addEventListener('change', () => {
      rules[i].method = method.value;
      saveRules();
      scheduleAnalyze();
    });

    const pathWrap = document.createElement('span');
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'path-input';
    pathInput.value = rule.path;
    pathInput.placeholder = '/users/:id';
    pathInput.setAttribute('aria-label', `规则 ${i + 1} 的路径模式`);
    pathInput.spellcheck = false;
    pathInput.addEventListener('input', () => {
      rules[i].path = pathInput.value;
      saveRules();
      scheduleAnalyze();
    });
    pathWrap.appendChild(pathInput);

    const status = document.createElement('span');
    status.className = 'status-cell';

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.type = 'button';
    del.textContent = '✕';
    del.title = '删除该规则';
    del.addEventListener('click', () => {
      rules.splice(i, 1);
      saveRules();
      closeFix();
      renderRules();
      scheduleAnalyze(true);
    });

    li.append(grip, idx, method, pathWrap, status, del);
    attachDragHandlers(li);
    listEl.appendChild(li);
  });
  paintAnalysis();
}

/* ---------------- 拖拽排序（HTML5 DnD） ---------------- */

function attachDragHandlers(li) {
  li.addEventListener('dragstart', (e) => {
    dragIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', String(dragIndex));
    } catch (_e) {
      /* 某些浏览器要求 setData，失败可忽略 */
    }
  });

  li.addEventListener('dragend', () => {
    dragIndex = null;
    document.querySelectorAll('.rule-row').forEach((el) => {
      el.classList.remove('dragging', 'drop-above', 'drop-below');
    });
  });

  li.addEventListener('dragover', (e) => {
    if (dragIndex === null || dragIndex === Number(li.dataset.index)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    li.classList.toggle('drop-above', above);
    li.classList.toggle('drop-below', !above);
  });

  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-above', 'drop-below');
  });

  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetIndex = Number(li.dataset.index);
    if (dragIndex === null || dragIndex === targetIndex) return;
    const rect = li.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;

    const [moved] = rules.splice(dragIndex, 1);
    let insertAt = targetIndex;
    if (dragIndex < targetIndex) insertAt = targetIndex - 1;
    if (!above) insertAt += 1;
    rules.splice(insertAt, 0, moved);

    saveRules();
    closeFix();
    renderRules();
    scheduleAnalyze(true);
  });
}

/* ---------------- 分析 ---------------- */

function scheduleAnalyze(immediate = false) {
  clearTimeout(debounceTimer);
  if (immediate) {
    analyze();
    return;
  }
  debounceTimer = setTimeout(analyze, 150);
}

async function analyze() {
  try {
    const payload = { rules, samples: currentSampleLines() };
    if (baseline) payload.baselineRules = baseline; // 设置基线后每次分析自动附带差异审计
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lastAnalysis = await resp.json();
    paintAnalysis();
  } catch (err) {
    closeFix();
    summaryEl.innerHTML = '';
    conflictsEl.innerHTML =
      `<div class="empty-state">分析失败：${escapeHTML(err.message)}</div>`;
    samplesSummaryEl.innerHTML = '';
    samplesResultEl.innerHTML = '';
    diffSummaryEl.innerHTML = '';
    diffResultEl.innerHTML = '';
    baselineInfoEl.innerHTML = '';
  }
}

function pillEl(cls, text, n) {
  const el = document.createElement('span');
  el.className = `pill ${cls}`;
  const num = document.createElement('span');
  num.className = 'n';
  num.textContent = n;
  el.append(num, ` ${text}`);
  return el;
}

function paintAnalysis() {
  if (!lastAnalysis) return;
  const { rules: results, conflicts, summary } = lastAnalysis;

  // 行高亮 + 状态徽标
  listEl.querySelectorAll('.rule-row').forEach((row) => {
    const i = Number(row.dataset.index);
    const r = results[i];
    if (!r) return;
    row.classList.toggle('row-invalid', !r.valid);
    row.classList.toggle('row-shadow', r.shadows.length > 0);
    row.classList.toggle(
      'row-partial',
      r.overlaps.length > 0 && r.shadows.length === 0
    );

    const status = row.querySelector('.status-cell');
    status.innerHTML = '';
    if (!r.valid) {
      const badge = badgeEl('invalid', '语法错误');
      status.appendChild(badge);
      const err = document.createElement('span');
      err.className = 'row-error';
      err.textContent = r.errors.join('；');
      status.appendChild(err);
    } else if (r.shadows.length > 0) {
      status.appendChild(badgeEl('shadow', `遮蔽 ${r.shadows.length} 条`));
      if (r.overlaps.length > 0) {
        status.appendChild(badgeEl('partial', `重叠 ${r.overlaps.length} 条`));
      }
    } else if (r.overlaps.length > 0) {
      status.appendChild(badgeEl('partial', `重叠 ${r.overlaps.length} 条`));
    } else {
      status.appendChild(badgeEl('ok', '无冲突'));
    }
  });

  // 摘要
  summaryEl.innerHTML = '';
  summaryEl.appendChild(pillEl('pill-shadow', '完全遮蔽', summary.shadow));
  summaryEl.appendChild(pillEl('pill-partial', '部分重叠', summary.partial));
  if (summary.total === 0) {
    summaryEl.appendChild(pillEl('pill-ok', '无冲突', ''));
  }

  // “生成修复方案”仅在存在遮蔽时可用；规则内容变化则收起可能过期的预览
  // （签名只覆盖规则集：仅编辑样例时预览保持打开并用新对比结果重绘）
  const fp = lastAnalysis.fixPlan;
  if (fixOpen && fp && lastAnalysis.signature !== currentSignature()) {
    closeFix();
  }
  if (fp && fp.needed) {
    fixBtnEl.hidden = false;
  } else {
    fixBtnEl.hidden = true;
    closeFix();
  }
  if (fixOpen && fp) renderFixPlan(fp);

  // 请求行为回归预演：按当前优先级逐条展示首条命中
  renderSamples(lastAnalysis.samples);

  // 版本差异审计：基线 × 当前规则的全空间对比（未设基线时显示空状态）
  renderDiff(lastAnalysis.diff);

  // 冲突卡片
  conflictsEl.innerHTML = '';
  if (conflicts.length === 0) {
    conflictsEl.innerHTML =
      '<div class="empty-state"><span class="big">✅</span>未发现冲突。<br/>不同方法的规则互不影响；尝试调整顺序或加入 <code>/*</code> 通配符。</div>';
    return;
  }
  for (const c of conflicts) {
    conflictsEl.appendChild(renderConflictCard(c));
  }
}

function badgeEl(kind, text) {
  const b = document.createElement('span');
  b.className = `badge badge-${kind}`;
  b.textContent = text;
  return b;
}

function renderConflictCard(c) {
  const card = document.createElement('div');
  card.className = `conflict-card c-${c.type}`;

  const top = document.createElement('div');
  top.className = 'conflict-top';
  const type = document.createElement('span');
  type.className = 'conflict-type';
  type.textContent = c.type === 'shadow' ? '⛔ 完全遮蔽' : '⚠️ 部分重叠';
  const desc = document.createElement('span');
  desc.className = 'conflict-desc';
  desc.textContent =
    c.type === 'shadow'
      ? `#${c.higher.index + 1} 命中后，#${c.lower.index + 1} 永远不会被执行`
      : `#${c.higher.index + 1} 与 #${c.lower.index + 1} 在部分路径上同时命中`;
  top.append(type, desc);

  const pair = document.createElement('div');
  pair.className = 'route-pair';
  pair.appendChild(routeLine('高优先级', c.higher));
  pair.appendChild(routeLine('低优先级', c.lower));

  const ex = document.createElement('div');
  ex.className = 'example-box';
  const exLabel = document.createElement('span');
  exLabel.className = 'ex-label';
  exLabel.textContent = '最短同时命中';
  const exValue = document.createElement('span');
  exValue.className = 'ex-value';
  exValue.textContent = c.example;
  exValue.title = '点击复制';
  exValue.addEventListener('click', () => {
    navigator.clipboard
      ?.writeText(c.example)
      .then(() => showToast(`已复制：${c.example}`, 'ok'))
      .catch(() => showToast('复制失败，请手动选择', 'error'));
  });
  ex.append(exLabel, exValue);

  card.append(top, pair, ex);
  return card;
}

function routeLine(tag, endpoint) {
  const wrap = document.createElement('span');
  wrap.className = 'rp';
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = tag;
  const method = document.createElement('span');
  method.className = 'm';
  method.textContent = endpoint.method;
  const p = document.createElement('span');
  p.textContent = endpoint.path;
  p.title = `规则 #${endpoint.index + 1}`;
  wrap.append(t, method, p);
  return wrap;
}

/* ---------------- 请求行为回归预演（首条命中） ---------------- */

function renderSamples(data) {
  samplesSummaryEl.innerHTML = '';
  samplesResultEl.innerHTML = '';
  if (!data || data.total === 0) {
    samplesResultEl.innerHTML =
      '<div class="samples-empty">输入样例后，将按当前优先级逐条计算首条命中规则；空白行会被忽略。</div>';
    return;
  }

  const invalid = data.total - data.validCount;
  const parts = [
    `共 ${data.total} 条`,
    `命中 ${data.validCount - data.unmatched}`,
    `无匹配 ${data.unmatched}`,
  ];
  if (invalid > 0) parts.push(`无效 ${invalid}`);
  samplesSummaryEl.textContent = parts.join(' · ');

  for (const s of data.results) {
    samplesResultEl.appendChild(renderSampleRow(s));
  }
}

function renderSampleRow(s) {
  const state = !s.valid ? 'invalid' : s.hit ? 'hit' : 'unmatched';
  const row = document.createElement('div');
  row.className = `sample-row s-${state}`;

  const line = document.createElement('span');
  line.className = 'sample-line';
  line.textContent = `L${s.line}`;
  line.title = `输入第 ${s.line} 行`;

  const input = document.createElement('span');
  input.className = 'sample-input';
  input.textContent = s.input;

  const verdict = document.createElement('span');
  verdict.className = 'sample-verdict';
  if (!s.valid) {
    verdict.appendChild(badgeEl('invalid', '无效样例'));
    const err = document.createElement('span');
    err.className = 'sample-err';
    err.textContent = s.errors.join('；');
    verdict.appendChild(err);
  } else if (s.hit) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sample-hit';
    chip.textContent = `#${s.hit.index + 1} ${s.hit.method} ${s.hit.path}`;
    chip.title = '点击定位到该规则';
    chip.addEventListener('click', () => locateRule(s.hit.index));
    verdict.appendChild(chip);
  } else {
    verdict.appendChild(badgeEl('partial', '无匹配规则'));
  }

  row.append(line, input, verdict);
  return row;
}

/** 滚动定位并短暂高亮指定规则行（预演结果与修复预览共用） */
function locateRule(index) {
  const row = listEl.children[index];
  if (!row) return;
  if (typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  row.classList.add('row-locate');
  setTimeout(() => row.classList.remove('row-locate'), 1600);
}

/* ---------------- 版本差异审计（基线 × 当前，首条命中语义） ---------------- */

function renderDiff(diff) {
  diffSummaryEl.innerHTML = '';
  diffResultEl.innerHTML = '';
  baselineInfoEl.innerHTML = '';
  baselineClearBtn.hidden = !baseline;

  if (!baseline) {
    diffResultEl.innerHTML =
      '<div class="empty-state"><span class="big">📊</span>尚未设置基线路由表。<br/>' +
      '点击「导入基线 JSON」选择一份基线，或点击「将当前设为基线」快照当前规则；' +
      '此后对规则的任何修改都会与基线按<strong>首条命中语义</strong>自动比较整个请求空间。' +
      '<br/>基线仅保存在浏览器 localStorage，不会上传到服务器。</div>';
    return;
  }

  renderBaselineInfo(diff);

  if (!diff) {
    diffResultEl.innerHTML = '<div class="empty-state">差异计算中…</div>';
    return;
  }

  diffSummaryEl.appendChild(pillEl('pill-added', '新增覆盖', diff.summary.added));
  diffSummaryEl.appendChild(pillEl('pill-lost', '丢失覆盖', diff.summary.lost));
  diffSummaryEl.appendChild(pillEl('pill-migrated', '命中迁移', diff.summary.migrated));
  if (diff.summary.total === 0) {
    diffSummaryEl.appendChild(pillEl('pill-ok', '两版本行为一致', ''));
  }

  if (diff.truncated) {
    const warn = document.createElement('div');
    warn.className = 'diff-truncated';
    warn.textContent =
      '⚠️ 请求空间的乘积自动机状态数触及上限，以下结果可能不完整（仅覆盖部分请求空间）。';
    diffResultEl.appendChild(warn);
  }

  if (diff.summary.total === 0) {
    const ok = document.createElement('div');
    ok.className = 'empty-state';
    ok.innerHTML =
      '<span class="big">✅</span>两版本的首条命中行为在全部方法 × 全部路径空间上完全一致。';
    diffResultEl.appendChild(ok);
    return;
  }

  if (diff.added.length > 0) {
    diffResultEl.appendChild(
      renderDiffSection(
        '🟢 新增覆盖',
        '当前规则可命中、基线版本无匹配的请求空间（按当前规则归组）',
        diff.added,
        'added'
      )
    );
  }
  if (diff.lost.length > 0) {
    diffResultEl.appendChild(
      renderDiffSection(
        '🔴 丢失覆盖',
        '基线版本可命中、当前规则已无匹配的请求空间（按基线规则归组）',
        diff.lost,
        'lost'
      )
    );
  }
  if (diff.migrated.length > 0) {
    diffResultEl.appendChild(
      renderDiffSection(
        '🟠 命中迁移',
        '两版本都能命中、但首条命中规则发生变化的请求空间（按基线规则归组）',
        diff.migrated,
        'migrated'
      )
    );
  }
}

/** 基线规则概览：条数/有效性 + 可折叠的只读规则清单 */
function renderBaselineInfo(diff) {
  const list =
    diff && Array.isArray(diff.baselineRules)
      ? diff.baselineRules
      : baseline.map((r, i) => ({ index: i, method: r.method, path: r.path, valid: true, errors: [] }));
  const invalidCount = list.filter((r) => !r.valid).length;

  const head = document.createElement('div');
  head.className = 'baseline-head';
  const meta = document.createElement('span');
  meta.className = 'baseline-meta';
  meta.textContent =
    `基线：${list.length} 条规则` +
    (invalidCount > 0 ? `（${invalidCount} 条无效，已跳过）` : '（全部有效）') +
    ' · 仅保存在浏览器';
  head.appendChild(meta);
  baselineInfoEl.appendChild(head);

  const details = document.createElement('details');
  details.className = 'baseline-details';
  details.open = baselineDetailsOpen;
  details.addEventListener('toggle', () => {
    baselineDetailsOpen = details.open;
  });
  const summary = document.createElement('summary');
  summary.textContent = '查看基线规则';
  details.appendChild(summary);
  const box = document.createElement('div');
  box.className = 'baseline-rules';
  for (const r of list) {
    const chip = document.createElement('span');
    chip.className = 'baseline-chip' + (r.valid ? '' : ' chip-invalid');
    chip.textContent = `#${r.index + 1} ${r.method || '?'} ${r.path || '(空)'}`;
    chip.title = r.valid
      ? `基线规则 #${r.index + 1}`
      : `无效：${(r.errors || []).join('；')}`;
    box.appendChild(chip);
  }
  details.appendChild(box);
  baselineInfoEl.appendChild(details);
}

function renderDiffSection(title, desc, entries, kind) {
  const sec = document.createElement('div');
  sec.className = `diff-section diff-${kind}`;

  const head = document.createElement('div');
  head.className = 'diff-section-head';
  const t = document.createElement('span');
  t.className = 'diff-section-title';
  t.textContent = `${title}（${entries.length}）`;
  const d = document.createElement('span');
  d.className = 'diff-section-desc';
  d.textContent = desc;
  head.append(t, d);
  sec.appendChild(head);

  if (kind === 'migrated') {
    // 按基线规则归组：组内逐条列出迁移到的当前规则
    let groupBox = null;
    let curBase = -1;
    for (const e of entries) {
      if (e.baseline.index !== curBase) {
        curBase = e.baseline.index;
        groupBox = document.createElement('div');
        groupBox.className = 'diff-group';
        const gh = document.createElement('div');
        gh.className = 'diff-group-head';
        gh.textContent = `基线 #${e.baseline.index + 1} ${e.baseline.method} ${e.baseline.path}`;
        groupBox.appendChild(gh);
        sec.appendChild(groupBox);
      }
      groupBox.appendChild(renderDiffRow('→ 当前 ', e.current, e.witness, true));
    }
  } else if (kind === 'added') {
    for (const e of entries) {
      sec.appendChild(renderDiffRow('', e.current, e.witness, true));
    }
  } else {
    for (const e of entries) {
      sec.appendChild(renderDiffRow('基线 ', e.baseline, e.witness, false));
    }
  }
  return sec;
}

function renderDiffRow(prefix, rule, witness, locate) {
  const row = document.createElement('div');
  row.className = 'diff-row';

  const ref = document.createElement(locate ? 'button' : 'span');
  ref.className = 'diff-rule' + (locate ? ' diff-rule-link' : '');
  ref.textContent = `${prefix}#${rule.index + 1} ${rule.method} ${rule.path}`;
  if (locate) {
    ref.type = 'button';
    ref.title = '点击定位到该规则';
    ref.addEventListener('click', () => locateRule(rule.index));
  }

  const wl = document.createElement('span');
  wl.className = 'witness-label';
  wl.textContent = '最短见证';

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'witness-chip';
  chip.textContent = `${witness.method} ${witness.path}`;
  chip.title = '点击回填到请求行为回归预演';
  chip.addEventListener('click', () => backfillSample(witness.method, witness.path));

  row.append(ref, wl, chip);
  return row;
}

/** 见证请求回填：追加到预演输入框（去重）并立即重算首条命中 */
function backfillSample(method, path) {
  const line = `${method} ${path}`;
  const lines = String(samplesInput.value || '').split('\n');
  if (!lines.some((l) => l.trim() === line)) {
    if (samplesInput.value.length > 0 && !samplesInput.value.endsWith('\n')) {
      samplesInput.value += '\n';
    }
    samplesInput.value += line;
    saveSamplesText();
    scheduleAnalyze(true);
  }
  if (typeof samplesInput.scrollIntoView === 'function') {
    samplesInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  showToast(`已回填到请求预演：${line}`, 'ok');
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------------- 修复方案（确定性重排） ---------------- */

function closeFix() {
  fixOpen = false;
  fixEl.hidden = true;
  fixEl.innerHTML = '';
}

/** 当前规则集的内容签名，与 /api/analyze 返回的 signature 对齐 */
function currentSignature() {
  return JSON.stringify(
    rules.map((r) => [
      typeof r.method === 'string' ? r.method.trim().toUpperCase() : '',
      typeof r.path === 'string' ? r.path : '',
    ])
  );
}

fixBtnEl.addEventListener('click', () => {
  fixOpen = !fixOpen;
  if (fixOpen && lastAnalysis && lastAnalysis.fixPlan) {
    renderFixPlan(lastAnalysis.fixPlan);
  } else {
    closeFix();
  }
});

function renderFixPlan(fp) {
  fixEl.hidden = false;
  fixEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'fix-head';
  const title = document.createElement('span');
  title.className = 'fix-title';
  title.textContent = '🛠 修复方案（按语言等价关系分组 + 约束图拓扑排序）';
  head.appendChild(title);

  // 汇总：调整前后遮蔽数量 + 仍不可避免的遮蔽数量
  const stats = document.createElement('div');
  stats.className = 'fix-stats';
  stats.appendChild(fixStat('stat-before', '调整前遮蔽', fp.shadowBefore));
  stats.appendChild(fixStat('stat-after', '调整后遮蔽', fp.shadowAfter));
  stats.appendChild(
    fixStat('stat-unavoid', '仍不可避免的遮蔽', fp.unavoidableShadow)
  );
  stats.appendChild(fixStat('stat-move', '需移动规则', fp.moves.length));

  const verdict = document.createElement('div');
  verdict.className = `fix-verdict ${fp.shadowAfter === 0 ? 'fv-ok' : 'fv-warn'}`;
  if (fp.shadowBefore === 0) {
    verdict.textContent = '当前没有需要修复的遮蔽。';
  } else if (fp.shadowAfter === 0) {
    verdict.textContent =
      `✅ 该顺序可消除全部 ${fp.shadowBefore} 条遮蔽（被消除的遮蔽会转为部分重叠，仍在下方冲突卡片中标注）。`;
  } else if (fp.fixedCount > 0) {
    verdict.textContent =
      `⚠️ 重排可消除 ${fp.fixedCount} 条遮蔽，但仍有 ${fp.unavoidableShadow} 条遮蔽不可避免` +
      `（互相覆盖的等价规则无法通过排序消除）；调整后遮蔽 ${fp.shadowBefore} → ${fp.shadowAfter}。`;
  } else {
    verdict.textContent =
      `⛔ ${fp.unavoidableShadow} 条遮蔽均来自互相覆盖的等价规则，无法通过排序消除——只能合并、删除或改写路径。`;
  }

  // 建议顺序：展示每条规则调整前 #from → 调整后 #to
  const orderBox = document.createElement('div');
  orderBox.className = 'fix-order';
  const orderLabel = document.createElement('div');
  orderLabel.className = 'fix-section-label';
  orderLabel.textContent = '建议顺序（新位置 → 规则，括号内为调整前位置）';
  orderBox.appendChild(orderLabel);

  fp.order.forEach((origIdx, pos) => {
    const r = rules[origIdx];
    if (!r) return;
    const row = document.createElement('div');
    row.className = 'fix-order-row';
    const newNo = document.createElement('span');
    newNo.className = 'fix-new-no';
    newNo.textContent = pos + 1;
    const arrow = document.createElement('span');
    arrow.className = `fix-move ${origIdx === pos ? 'no-move' : ''}`;
    arrow.textContent = origIdx === pos ? '＝' : `#${origIdx + 1} →`;
    arrow.title =
      origIdx === pos ? '位置不变' : `调整前位于第 ${origIdx + 1} 位`;
    const m = document.createElement('span');
    m.className = 'fix-m';
    m.textContent = r.method;
    const p = document.createElement('span');
    p.className = 'fix-p';
    p.textContent = r.path;
    row.append(newNo, arrow, m, p);
    orderBox.appendChild(row);
  });

  // 不可消除的等价组：明确标注，不伪装成已修复
  const groupsBox = document.createElement('div');
  if (fp.equivalenceGroups.some((g) => g.unavoidableShadow > 0)) {
    groupsBox.className = 'fix-groups';
    const glabel = document.createElement('div');
    glabel.className = 'fix-section-label label-danger';
    glabel.textContent = '不可通过排序消除的等价规则（互相覆盖）';
    groupsBox.appendChild(glabel);
    for (const g of fp.equivalenceGroups) {
      if (g.unavoidableShadow === 0) continue;
      const card = document.createElement('div');
      card.className = 'equiv-card';
      const members = document.createElement('div');
      members.className = 'equiv-members';
      g.members.forEach((m2) => {
        const chip = document.createElement('span');
        chip.className = 'equiv-chip';
        chip.textContent = `${m2.method} ${m2.path}`;
        members.appendChild(chip);
      });
      const note = document.createElement('div');
      note.className = 'equiv-note';
      note.textContent =
        `这 ${g.size} 条规则的路径语言互相覆盖、方法兼容，任何顺序下都有 ${g.unavoidableShadow} 对遮蔽。`;
      card.append(members, note);
      groupsBox.appendChild(card);
    }
  }

  // 调整后仍存在的遮蔽（预览）
  const remainBox = document.createElement('div');
  const remainShadows = (fp.residualConflicts || []).filter(
    (c) => c.type === 'shadow'
  );
  if (remainShadows.length > 0) {
    remainBox.className = 'fix-remain';
    const rlabel = document.createElement('div');
    rlabel.className = 'fix-section-label label-danger';
    rlabel.textContent = `应用后仍将存在的 ${remainShadows.length} 条遮蔽`;
    remainBox.appendChild(rlabel);
    for (const c of remainShadows) {
      const line = document.createElement('div');
      line.className = 'remain-line';
      line.textContent =
        `#${c.newPositionA} ${c.higher.method} ${c.higher.path} ⛔ 遮蔽 ` +
        `#${c.newPositionB} ${c.lower.method} ${c.lower.path}（示例 ${c.example}）`;
      remainBox.appendChild(line);
    }
  }

  // 请求行为回归预演：同一批样例 × 建议顺序，逐条对比命中变化
  const replayBox = document.createElement('div');
  if (fp.sampleReplay && fp.sampleReplay.results.length > 0) {
    const rp = fp.sampleReplay;
    replayBox.className = 'fix-samples';
    const label = document.createElement('div');
    label.className = 'fix-section-label';
    label.textContent = '请求行为回归预演（同一批样例 × 建议顺序）';
    replayBox.appendChild(label);

    const sum = document.createElement('div');
    sum.className = 'fix-samples-summary';
    sum.textContent =
      `共 ${rp.total} 条有效样例 · 命中改变 ${rp.changed} · ` +
      `原本无匹配 ${rp.unmatchedBefore} · 调整后无匹配 ${rp.unmatchedAfter}`;
    replayBox.appendChild(sum);

    for (const r of rp.results) {
      replayBox.appendChild(renderReplayRow(r));
    }
  }

  // 操作按钮：预览后一次应用 / 取消
  const actions = document.createElement('div');
  actions.className = 'fix-actions';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-primary';
  applyBtn.textContent = fp.moves.length > 0
    ? `一次应用（移动 ${fp.moves.length} 条）`
    : '顺序无需调整';
  applyBtn.disabled = fp.moves.length === 0;
  applyBtn.addEventListener('click', () => applyFix(fp));
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '收起预览';
  cancelBtn.addEventListener('click', () => closeFix());
  actions.append(applyBtn, cancelBtn);

  fixEl.append(head, stats, verdict, orderBox, replayBox, groupsBox, remainBox, actions);
}

/** 修复预览中的单条样例对比行：当前命中 → 建议顺序命中 */
function renderReplayRow(r) {
  const row = document.createElement('div');
  row.className =
    'fs-row' +
    (r.changed ? ' fs-changed' : '') +
    (r.unmatchedBefore || r.unmatchedAfter ? ' fs-unmatched' : '');

  const badge = document.createElement('span');
  if (r.changed) {
    badge.className = 'fs-badge fb-changed';
    badge.textContent = '命中改变';
  } else if (r.unmatchedBefore && r.unmatchedAfter) {
    badge.className = 'fs-badge fb-unmatched';
    badge.textContent = '始终无匹配';
  } else if (r.unmatchedBefore) {
    badge.className = 'fs-badge fb-unmatched';
    badge.textContent = '原本无匹配';
  } else if (r.unmatchedAfter) {
    badge.className = 'fs-badge fb-unmatched';
    badge.textContent = '调整后无匹配';
  } else {
    badge.className = 'fs-badge fb-same';
    badge.textContent = '不变';
  }

  const input = document.createElement('span');
  input.className = 'fs-input';
  input.textContent = r.input;

  const before = document.createElement('span');
  before.className = 'fs-hit';
  if (r.before) {
    before.textContent = `#${r.before.index + 1} ${r.before.method} ${r.before.path}`;
    before.classList.add('fs-hit-link');
    before.title = '点击定位到该规则';
    before.addEventListener('click', () => locateRule(r.before.index));
  } else {
    before.textContent = '（无匹配）';
  }

  const arrow = document.createElement('span');
  arrow.className = 'fs-arrow';
  arrow.textContent = '→';

  const after = document.createElement('span');
  after.className = 'fs-hit';
  if (r.after) {
    after.textContent = `#${r.afterPosition} ${r.after.method} ${r.after.path}`;
    after.classList.add('fs-hit-link');
    after.title = `调整后位于第 ${r.afterPosition} 位（点击定位当前规则）`;
    after.addEventListener('click', () => locateRule(r.after.index));
  } else {
    after.textContent = '（无匹配）';
  }

  row.append(badge, input, before, arrow, after);
  return row;
}

function fixStat(cls, label, n) {
  const el = document.createElement('span');
  el.className = `fix-stat ${cls}`;
  const num = document.createElement('span');
  num.className = 'fix-stat-n';
  num.textContent = n;
  const lab = document.createElement('span');
  lab.className = 'fix-stat-label';
  lab.textContent = label;
  el.append(num, lab);
  return el;
}

function applyFix(fp) {
  // 防御：规则内容若已变化（编辑/增删/导入），order 索引不再可信，要求重新生成
  if (
    !lastAnalysis ||
    !fp ||
    !Array.isArray(fp.order) ||
    lastAnalysis.total !== rules.length ||
    lastAnalysis.signature !== currentSignature()
  ) {
    showToast('规则已变化，请重新生成修复方案', 'error');
    closeFix();
    scheduleAnalyze(true);
    return;
  }
  const next = fp.order.map((origIdx) => rules[origIdx]).filter(Boolean);
  if (next.length !== rules.length) {
    showToast('规则已变化，请重新生成修复方案', 'error');
    closeFix();
    scheduleAnalyze(true);
    return;
  }
  rules = next;
  saveRules();
  closeFix();
  renderRules();
  scheduleAnalyze(true);
  showToast(
    fp.shadowAfter === 0
      ? '已应用修复方案：遮蔽全部消除'
      : `已应用修复方案：仍有 ${fp.shadowAfter} 条不可避免的遮蔽`,
    fp.shadowAfter === 0 ? 'ok' : 'error'
  );
}

/* ---------------- 导入 / 导出 / 新增 / 重置 ---------------- */

document.getElementById('btn-add').addEventListener('click', () => {
  rules.push({ method: 'GET', path: '/new/route/:id' });
  saveRules();
  closeFix();
  renderRules();
  scheduleAnalyze(true);
  const inputs = listEl.querySelectorAll('.path-input');
  const last = inputs[inputs.length - 1];
  last.focus();
  last.select();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  rules = DEFAULT_RULES.map((r) => ({ ...r }));
  saveRules();
  closeFix();
  renderRules();
  scheduleAnalyze(true);
  showToast('已恢复默认示例', 'ok');
});

document.getElementById('btn-export').addEventListener('click', () => {
  const payload = {
    format: 'route-conflict-lab/v1',
    exportedAt: new Date().toISOString(),
    rules,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'route-rules.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${rules.length} 条规则`, 'ok');
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('file-import').click();
});

document.getElementById('file-import').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const cleaned = parseRulesJson(JSON.parse(String(reader.result)));
      rules = cleaned;
      saveRules();
      closeFix();
      renderRules();
      scheduleAnalyze(true);
      showToast(`已导入 ${cleaned.length} 条规则`, 'ok');
    } catch (err) {
      showToast(`导入失败：${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

/* ---------------- 基线导入 / 快照 / 清除 ---------------- */

document.getElementById('btn-baseline-import').addEventListener('click', () => {
  document.getElementById('file-baseline').click();
});

document.getElementById('file-baseline').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const cleaned = parseRulesJson(JSON.parse(String(reader.result)));
      baseline = cleaned;
      saveBaseline();
      scheduleAnalyze(true); // 自动重算差异
      showToast(`已导入 ${cleaned.length} 条基线规则`, 'ok');
    } catch (err) {
      showToast(`基线导入失败：${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-baseline-snapshot').addEventListener('click', () => {
  baseline = rules.map((r) => ({ method: r.method, path: r.path }));
  saveBaseline();
  scheduleAnalyze(true);
  showToast(`已将当前 ${baseline.length} 条规则设为基线`, 'ok');
});

baselineClearBtn.addEventListener('click', () => {
  baseline = null;
  try {
    localStorage.removeItem(BASELINE_STORAGE_KEY);
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
  renderDiff(null);
  showToast('已清除基线', 'ok');
});

/* ---------------- 启动 ---------------- */
samplesInput.value = loadSamplesText();
samplesInput.addEventListener('input', () => {
  saveSamplesText();
  scheduleAnalyze();
});
renderRules();
renderDiff(lastAnalysis ? lastAnalysis.diff : null);
scheduleAnalyze(true);
