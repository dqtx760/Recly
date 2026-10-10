'use strict';
// 将 Resources/en.lproj/Localizable.strings 提取并转换为 windows/src/renderer/locales/en.json
// 运行：node scripts/extract-i18n.js [可选源文件路径] [可选目标文件路径]

const fs = require('node:fs');
const path = require('node:path');

/**
 * 解析 Apple .strings 格式文件
 * @param {string} content 文本内容
 * @returns {Record<string, string>} 键值对字典
 */
function parseLocalizableStrings(content) {
  if (typeof content !== 'string') return {};

  // 移除 UTF-8 BOM
  let text = content.replace(/^\uFEFF/, '');
  // 移除块级注释 /* ... */
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // 移除单行注释 // ...
  text = text.replace(/^\s*\/\/.*$/gm, '');

  const result = {};
  // 匹配 "key" = "value"; 并支持反斜杠转义
  const pairRegex = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)";/g;
  let match;
  while ((match = pairRegex.exec(text)) !== null) {
    const key = unescapeString(match[1]);
    const val = unescapeString(match[2]);
    result[key] = val;
  }
  return result;
}

/**
 * 反转义字符串
 * @param {string} s
 * @returns {string}
 */
function unescapeString(s) {
  return s
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

/**
 * 提取并写入目标 json 文件
 * @param {string} [inputFilePath]
 * @param {string} [outputFilePath]
 * @returns {Record<string, string>}
 */
function extractI18n(inputFilePath, outputFilePath) {
  const root = path.resolve(__dirname, '..');
  const input = inputFilePath || path.resolve(root, '..', 'Resources', 'en.lproj', 'Localizable.strings');
  const output = outputFilePath || path.resolve(root, 'src', 'renderer', 'locales', 'en.json');

  if (!fs.existsSync(input)) {
    throw new Error(`Strings file not found: ${input}`);
  }

  const raw = fs.readFileSync(input, 'utf8');
  const translations = parseLocalizableStrings(raw);
  const count = Object.keys(translations).length;

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(translations, null, 2) + '\n', 'utf8');

  console.log(`[i18n] Extracted ${count} translations to ${output}`);
  return translations;
}

if (require.main === module) {
  const [,, customIn, customOut] = process.argv;
  try {
    extractI18n(customIn, customOut);
  } catch (err) {
    console.error(`[i18n] Extraction failed:`, err);
    process.exit(1);
  }
}

module.exports = {
  parseLocalizableStrings,
  unescapeString,
  extractI18n,
};
