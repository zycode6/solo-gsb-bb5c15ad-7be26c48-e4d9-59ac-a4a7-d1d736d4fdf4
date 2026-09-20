'use strict';

const path = require('path');
const express = require('express');
const { analyze } = require('./lib/analyzer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/analyze
 * body: { rules: [{ method: string, path: string }],
 *         samples?: ["METHOD /path" | { method, path }],
 *         baselineRules?: [{ method: string, path: string }] }
 * 规则在数组中的顺序即优先级（索引 0 最先匹配）。
 * samples 可选：逐行“方法 路径”的真实请求样例，用于请求行为回归预演
 * （首条命中计算 + 修复方案前后对比）。
 * baselineRules 可选：基线路由表（与 rules 同构），用于版本差异审计——
 * 按首条命中语义比较基线与当前规则的整个请求空间，响应附带 diff 字段；
 * 缺省时响应不含 diff（向后兼容）。
 */
app.post('/api/analyze', (req, res) => {
  const body = req.body || {};
  const rules = body.rules;
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: '请求体必须为 { rules: [...] }' });
  }
  if (rules.length > 500) {
    return res.status(400).json({ error: '规则数量不能超过 500 条' });
  }
  const samples = body.samples;
  if (samples !== undefined) {
    if (!Array.isArray(samples)) {
      return res
        .status(400)
        .json({ error: 'samples 必须为数组（每行一个“方法 路径”样例）' });
    }
    if (samples.length > 1000) {
      return res.status(400).json({ error: '请求样例数量不能超过 1000 条' });
    }
  }
  const baselineRules = body.baselineRules;
  if (baselineRules !== undefined) {
    if (!Array.isArray(baselineRules)) {
      return res
        .status(400)
        .json({ error: 'baselineRules 必须为数组（与 rules 同构的基线路由表）' });
    }
    if (baselineRules.length > 500) {
      return res.status(400).json({ error: '基线规则数量不能超过 500 条' });
    }
  }
  res.json(analyze(rules, { samples, baselineRules }));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`路由冲突实验室已启动: http://localhost:${PORT}`);
});
