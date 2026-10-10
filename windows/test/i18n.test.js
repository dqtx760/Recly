'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseLocalizableStrings, extractI18n } = require('../scripts/extract-i18n');
const i18n = require('../src/renderer/i18n');
const { t, getLocale, setLocale, formatString } = i18n;

let passed = 0;
const test = (name, body) => {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('Testing i18n and Localizable.strings parser...');

test('parseLocalizableStrings: 基础解析与注释过滤', () => {
  const sample = `
    /* 顶部块级注释 */
    "时间对齐" = "Timing";
    // 单行注释
    "提前 100 ms" = "Advance 100 ms";
    /*
      多行注释
      "被注释的" = "Ignored";
    */
    "包含\\"引号\\"" = "With \\"Quotes\\"";
    "换行\\n与制表\\t" = "Newline\\nand\\tTab";
  `;
  const result = parseLocalizableStrings(sample);
  assert.equal(result['时间对齐'], 'Timing');
  assert.equal(result['提前 100 ms'], 'Advance 100 ms');
  assert.equal(result['包含"引号"'], 'With "Quotes"');
  assert.equal(result['换行\n与制表\t'], 'Newline\nand\tTab');
  assert.equal(result['被注释的'], undefined);
});

test('extractI18n: 从 Resources/en.lproj/Localizable.strings 提取', () => {
  const stringsPath = path.resolve(__dirname, '../../Resources/en.lproj/Localizable.strings');
  assert.ok(fs.existsSync(stringsPath), 'Localizable.strings 应当存在');

  const enJsonPath = path.resolve(__dirname, '../src/renderer/locales/en.json');
  assert.ok(fs.existsSync(enJsonPath), 'en.json 应当已生成');

  const enData = JSON.parse(fs.readFileSync(enJsonPath, 'utf8'));
  const keyCount = Object.keys(enData).length;
  console.log(`      en.json 包含 ${keyCount} 个翻译词条`);
  assert.ok(keyCount > 1000, `翻译条目应大于 1000 条，实测为 ${keyCount}`);
  assert.equal(enData['时间对齐'], 'Timing');
  assert.equal(enData['光标偏移'], 'Cursor Offset');
  assert.equal(enData['提前 %.0f ms'], 'Advance %.0f ms');
  assert.equal(enData['已用时 %@'], 'Elapsed %@');
});

test('formatString: 占位符替换', () => {
  assert.equal(formatString('纯文本', []), '纯文本');
  assert.equal(formatString('显示%@', ['麦克风']), '显示麦克风');
  assert.equal(formatString('已处理 %d 个，共 %d 个', [3, 10]), '已处理 3 个，共 10 个');
  assert.equal(formatString('延迟 %.0f ms', [250.7]), '延迟 251 ms');
  assert.equal(formatString('数值 %.2f', [3.14159]), '数值 3.14');
  assert.equal(formatString('%1$@ 和 %2$@', ['A', 'B']), 'A 和 B');
});

test('i18n: 英文与中文模式切换及翻译', () => {
  setLocale('zh');
  assert.equal(getLocale(), 'zh');
  assert.equal(t('时间对齐'), '时间对齐');
  assert.equal(t('提前 %.0f ms', 100), '提前 100 ms');
  assert.equal(t('显示%@', '麦克风'), '显示麦克风');

  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(t('时间对齐'), 'Timing');
  assert.equal(t('提前 %.0f ms', 100), 'Advance 100 ms');
  assert.equal(t('显示%@', '麦克风'), 'Show 麦克风');
  assert.equal(t('第 %d 步，共 %d 步', 1, 3), 'Step 1 of 3');

  // 未收录的词条回退原词
  assert.equal(t('自定义未收录词条'), '自定义未收录词条');
  assert.equal(t('自定义 %@', '参数'), '自定义 参数');

  // 非字符串参数原样返回
  assert.equal(t(null), null);
  assert.equal(t(123), 123);

  // 恢复中文
  setLocale('zh');
  assert.equal(getLocale(), 'zh');
});

test('common.js: 导出 t, getLocale, setLocale', () => {
  // common.js 中有 window/location 相关依赖，模拟 location 验证 require
  global.location = { search: '' };
  global.document = { fonts: { add: () => {} }, createElement: () => ({ setAttribute: () => {}, append: () => {} }) };
  global.FontFace = function() { return { load: async () => this }; };

  const common = require('../src/renderer/common');
  assert.equal(typeof common.t, 'function', 'common 应当导出 t 函数');
  assert.equal(typeof common.getLocale, 'function', 'common 应当导出 getLocale 函数');
  assert.equal(typeof common.setLocale, 'function', 'common 应当导出 setLocale 函数');
  assert.equal(typeof common.i18n, 'object', 'common 应当导出 i18n 模块');
});

console.log(`\nAll ${passed} i18n tests passed successfully!`);
