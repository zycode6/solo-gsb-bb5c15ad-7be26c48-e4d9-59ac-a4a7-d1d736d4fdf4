'use strict';

/*
 * 前端冒烟测试：用最小 DOM/fetch stub 在 Node 中加载 public/app.js，
 * 模拟 打开页面 -> 实时分析 -> 生成修复方案 -> 一次应用 -> 再次实时分析，
 * 校验：按钮显隐、预览中的前后位置/不可避免遮蔽数、应用后的规则顺序与本地保存。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { analyze } = require('../lib/analyzer');

// ---------- 最小 DOM stub ----------
function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    hidden: false,
    disabled: false,
    _text: '',
    _html: '',
    className: '',
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) {
        if (force === undefined) force = !this._set.has(c);
        force ? this._set.add(c) : this._set.delete(c);
      },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    attrs: {},
    listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.children.push(c)); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) {
      const all = [];
      const walk = (n) => n.children.forEach((c) => { all.push(c); walk(c); });
      walk(this);
      if (sel === '.status-cell') return all.find((c) => c.className === 'status-cell');
      return all.find((c) => c.className === sel.slice(1));
    },
    querySelectorAll() {
      const all = [];
      const walk = (n) => n.children.forEach((c) => { all.push(c); walk(c); });
      walk(this);
      return all;
    },
    focus() {}, select() {}, click() { this.dispatch('click'); },
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent).join('');
      return this._text || this._html;
    },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
  };
  return el;
}

const ids = [
  'rules-list', 'conflicts', 'summary', 'toast', 'fix-plan', 'btn-fix',
  'btn-add', 'btn-reset', 'btn-export', 'btn-import', 'file-import',
  'samples-input', 'samples-summary', 'samples-result',
  'diff-summary', 'diff-result', 'baseline-info',
  'btn-baseline-import', 'btn-baseline-snapshot', 'btn-baseline-clear', 'file-baseline',
];
const els = {};
for (const id of ids) els[id] = makeEl('div');

const storage = {};
const sandbox = {
  console,
  setTimeout, clearTimeout,
  document: {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: () => [],
  },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  navigator: {},
  fetch: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () =>
        analyze(body.rules, {
          samples: body.samples,
          baselineRules: body.baselineRules,
        }),
    };
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: function () {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(code, sandbox);

// app.js 启动时会 scheduleAnalyze(true) -> 异步 fetch
(async () => {
  await new Promise((r) => setTimeout(r, 30));

  // 0) 请求回归预演：默认样例随首次分析即时计算首条命中
  const samplesText0 = els['samples-result'].textContent;
  assert.ok(
    samplesText0.includes('#1 GET /api/*'),
    '默认顺序下 GET /api/users/123 应首条命中 #1 /api/*'
  );
  assert.ok(
    samplesText0.includes('#8 POST /api/users'),
    'POST /api/users 应命中第 8 条规则'
  );
  assert.ok(samplesText0.includes('无匹配规则'), '无匹配样例应被标注');

  // 0b) 编辑样例 -> 防抖重算 + 本地保存；非法样例逐条标注
  els['samples-input'].value = 'GET /api/users/123\nBADMETHOD /x\nGET /x/:bad';
  els['samples-input'].dispatch('input');
  await new Promise((r) => setTimeout(r, 250)); // 防抖 150ms
  const samplesText = els['samples-result'].textContent;
  assert.ok(samplesText.includes('#1 GET /api/*'), '样例编辑后应自动重算命中');
  assert.ok(samplesText.includes('无效样例'), '非法方法/非具体路径应标为无效样例');
  assert.strictEqual(
    storage['route-conflict-lab.samples.v1'],
    'GET /api/users/123\nBADMETHOD /x\nGET /x/:bad',
    '样例文本应持久化到 localStorage'
  );

  // 1) 默认示例存在 4 条遮蔽 -> 修复按钮可见
  assert.strictEqual(els['btn-fix'].hidden, false, '存在遮蔽时应显示“生成修复方案”按钮');

  // 2) 打开修复方案预览
  els['btn-fix'].dispatch('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(els['fix-plan'].hidden, false, '预览面板应显示');
  const previewText = els['fix-plan'].textContent;
  assert.ok(previewText.includes('调整前遮蔽'), '应展示调整前位置指标');
  assert.ok(previewText.includes('调整后遮蔽'), '应展示调整后位置指标');
  assert.ok(previewText.includes('仍不可避免的遮蔽'), '应展示不可避免遮蔽数量');
  assert.ok(previewText.includes('4'), '默认示例应显示 4 条调整前遮蔽');
  // 默认示例全部可修复
  assert.ok(previewText.includes('一次应用（移动 4 条）'), '应显示一次应用按钮及移动数');
  assert.ok(!/仍将存在的/.test(previewText), '全可修复时不应有残留遮蔽区块');
  // 请求行为回归预演对比：同一批样例 × 建议顺序
  assert.ok(previewText.includes('请求行为回归预演'), '预览应包含样例对比区块');
  assert.ok(previewText.includes('命中改变'), '应标出命中规则改变的样例');
  assert.ok(previewText.includes('#1 GET /api/users/:id'), '应展示建议顺序下的新命中规则');

  // 3) 一次应用
  const applyBtn = els['fix-plan']
    .querySelectorAll()
    .find((c) => c.tagName === 'button' && String(c.textContent).includes('一次应用'));
  assert.ok(applyBtn, '应找到“一次应用”按钮');
  applyBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));

  // 应用后规则顺序：:id -> /users/* -> /api/* ...
  const saved = JSON.parse(storage['route-conflict-lab.rules.v1']);
  assert.strictEqual(saved[0].path, '/api/users/:id');
  assert.strictEqual(saved[1].path, '/api/users/*');
  assert.strictEqual(saved[2].path, '/api/*');
  assert.strictEqual(saved[3].path, '/assets/css/*');
  assert.strictEqual(saved[4].path, '/assets/*');
  assert.strictEqual(els['fix-plan'].hidden, true, '应用后应收起预览');
  assert.strictEqual(els['btn-fix'].hidden, true, '无遮蔽时修复按钮应隐藏');

  // 3b) 应用修复后样例自动重算：/api/users/:id 提升为第 1 位并被首条命中
  const samplesAfter = els['samples-result'].textContent;
  assert.ok(
    samplesAfter.includes('#1 GET /api/users/:id'),
    '应用修复后应命中提升后的 :id 规则'
  );

  // 4) 不可消除场景：导入含等价重复规则的规则集，预览必须如实标注残留遮蔽
  sandbox.FileReader = class {
    readAsText() {
      this.result = JSON.stringify({
        format: 'route-conflict-lab/v1',
        rules: [
          { method: 'GET', path: '/*' },
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/b' },
        ],
      });
      this.onload();
    }
  };
  els['file-import'].dispatch('change', { target: { files: [{}], value: '' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(els['btn-fix'].hidden, false, '含遮蔽时应显示修复按钮');
  // 导入后样例按新规则集自动重算
  const samplesImported = els['samples-result'].textContent;
  assert.ok(
    samplesImported.includes('#1 GET /*'),
    '导入新规则集后样例应自动重算（/* 首条命中）'
  );
  els['btn-fix'].dispatch('click');
  await new Promise((r) => setTimeout(r, 10));
  const text2 = els['fix-plan'].textContent;
  // 原始：/* 遮蔽 3 条（/a、/a、/b）+ 两条 /a 互相遮蔽 = 4；可修复 3，残留 1
  assert.ok(text2.includes('不可通过排序消除的等价规则'), '应出现不可消除等价组区块');
  assert.ok(/应用后仍将存在的 1 条遮蔽/.test(text2), '应如实列出 1 条残留遮蔽');
  assert.ok(text2.includes('移动 4 条'), '等价组前移 + /* 后移，共 4 条位置变化');
  // 建议顺序：等价的 /a、/a 在前，随后 /b，最宽泛的 /* 最后
  const fpExpect = analyze([
    { method: 'GET', path: '/*' },
    { method: 'GET', path: '/a' },
    { method: 'GET', path: '/a' },
    { method: 'GET', path: '/b' },
  ]).fixPlan;
  assert.deepStrictEqual(
    fpExpect.order.map((i) => ['/*', '/a', '/a', '/b'][i]),
    ['/a', '/a', '/b', '/*']
  );
  // 应用一次：顺序变为 /a /a /b /*（/* 移到最后），遮蔽 4 -> 1
  const applyBtn2 = els['fix-plan']
    .querySelectorAll()
    .find((c) => c.tagName === 'button' && String(c.textContent).includes('一次应用'));
  applyBtn2.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  const saved2 = JSON.parse(storage['route-conflict-lab.rules.v1']);
  assert.strictEqual(saved2[3].path, '/*', '最宽泛的 /* 应移至末尾');
  assert.strictEqual(els['btn-fix'].hidden, false, '仍有 1 条不可避免遮蔽，按钮应保持可见');

  // 5) 版本差异审计：初始无基线 -> 空状态，清除按钮隐藏
  assert.ok(
    els['diff-result'].textContent.includes('尚未设置基线'),
    '未设置基线时应显示空状态'
  );
  assert.strictEqual(els['btn-baseline-clear'].hidden, true, '无基线时清除按钮应隐藏');

  // 5a) 导入基线（FileReader stub）：GET /a/*、GET /b
  sandbox.FileReader = class {
    readAsText() {
      this.result = JSON.stringify({
        format: 'route-conflict-lab/v1',
        rules: [
          { method: 'GET', path: '/a/*' },
          { method: 'GET', path: '/b' },
        ],
      });
      this.onload();
    }
  };
  els['file-baseline'].dispatch('change', { target: { files: [{}], value: '' } });
  await new Promise((r) => setTimeout(r, 30));

  // 基线落 localStorage（仅保存在浏览器），清除按钮出现
  const savedBaseline = JSON.parse(storage['route-conflict-lab.baseline.v1']);
  assert.strictEqual(savedBaseline.length, 2);
  assert.strictEqual(savedBaseline[0].path, '/a/*');
  assert.strictEqual(els['btn-baseline-clear'].hidden, false, '有基线时清除按钮应显示');
  assert.ok(
    els['baseline-info'].textContent.includes('基线：2 条规则'),
    '应展示基线规则条数'
  );

  // 当前规则 [/a, /a, /b, /*] vs 基线 [/a/*, /b]：
  //   迁移：/a ->（基线 /a/* → 当前 /a）；/a/x ->（基线 /a/* → 当前 /*）
  //   新增：基线未覆盖空间（如 /、/c）-> 当前 /*，最短见证 GET /
  //   丢失：无（基线覆盖的空间当前都能命中）
  const diffText = els['diff-result'].textContent;
  assert.ok(diffText.includes('命中迁移'), '应出现命中迁移分组');
  assert.ok(diffText.includes('新增覆盖'), '应出现新增覆盖分组');
  assert.ok(!diffText.includes('丢失覆盖'), '本例不应出现丢失覆盖分组');
  const chips = els['diff-result']
    .querySelectorAll()
    .filter((c) => c.className === 'witness-chip')
    .map((c) => c.textContent);
  assert.ok(chips.includes('GET /'), '新增覆盖的最短见证应为 GET /');
  assert.ok(chips.includes('GET /a'), '迁移见证应包含 GET /a');
  assert.ok(chips.includes('GET /a/a'), '迁移见证应包含 GET /a/a');

  // 5b) 点击见证请求 -> 回填请求预演输入框并自动重算
  const chip = els['diff-result']
    .querySelectorAll()
    .find((c) => c.className === 'witness-chip' && c.textContent === 'GET /a/a');
  assert.ok(chip, '应找到 GET /a/a 见证芯片');
  chip.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    els['samples-input'].value.split('\n').includes('GET /a/a'),
    '见证请求应回填到预演输入框'
  );
  assert.ok(
    els['samples-result'].textContent.includes('GET /a/a'),
    '回填后预演结果应自动重算'
  );
  assert.ok(
    storage['route-conflict-lab.samples.v1'].split('\n').includes('GET /a/a'),
    '回填的样例应持久化到 localStorage'
  );

  // 5c) 将当前设为基线 -> 两版本完全一致
  els['btn-baseline-snapshot'].dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    els['diff-result'].textContent.includes('完全一致'),
    '快照当前规则后两版本应完全一致'
  );

  // 5d) 清除基线 -> 回到空状态，本地基线被移除
  els['btn-baseline-clear'].dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    els['diff-result'].textContent.includes('尚未设置基线'),
    '清除基线后应回到空状态'
  );
  assert.ok(
    !('route-conflict-lab.baseline.v1' in storage),
    '清除后应移除 localStorage 中的基线'
  );

  console.log('前端冒烟测试全部通过 ✓');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
