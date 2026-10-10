'use strict';
// DogSC 国际化支持 (i18n)
// 默认支持中文 (zh) 与英文 (en)，翻译字典从 Resources/en.lproj/Localizable.strings 提取生成。

let enTranslations = {};
try {
  enTranslations = require('./locales/en.json');
} catch (e) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    enTranslations = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'en.json'), 'utf8'));
  } catch {}
}

/**
 * 检测当前环境初始语言
 * 优先读取本地存储，其次按系统/浏览器语言检测，默认 zh
 * @returns {'zh' | 'en'}
 */
function detectInitialLocale() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const saved = localStorage.getItem('dogsc_locale');
      if (saved) {
        return saved.toLowerCase().startsWith('en') ? 'en' : 'zh';
      }
    }
  } catch {}

  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.language) {
      return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }
  } catch {}

  return 'zh';
}

let currentLocale = detectInitialLocale();

/**
 * 格式化占位符（支持 %@, %s, %d, %l, %.0f, %.2f, %f 等）
 * @param {string} pattern
 * @param {any[]} args
 * @returns {string}
 */
function formatString(pattern, args) {
  if (!args || args.length === 0) return pattern;
  let argIndex = 0;
  return String(pattern).replace(/%(?:(\d+)\$)?([@sdl]|(?:\.(\d+))?f)/g, (match, pos, spec, decimals) => {
    const idx = pos ? parseInt(pos, 10) - 1 : argIndex++;
    if (idx >= args.length) return match;
    const arg = args[idx];
    if (spec === '@' || spec === 's' || spec === 'l') {
      return String(arg);
    }
    if (spec === 'd') {
      return String(Math.round(Number(arg)));
    }
    if (decimals !== undefined) {
      const precision = parseInt(decimals, 10);
      return Number(arg).toFixed(precision);
    }
    if (spec === 'f') {
      return String(Number(arg));
    }
    return String(arg);
  });
}

/**
 * 翻译文本并在需要时格式化占位符
 * @param {string} key 中文原文字符串
 * @param {...any} args 占位符参数
 * @returns {string}
 */
function t(key, ...args) {
  if (typeof key !== 'string') return key;
  let template = key;
  if (currentLocale === 'en' && Object.prototype.hasOwnProperty.call(enTranslations, key)) {
    template = enTranslations[key];
  }
  return args.length > 0 ? formatString(template, args) : template;
}

/**
 * 获取当前语言
 * @returns {'zh' | 'en'}
 */
function getLocale() {
  return currentLocale;
}

/**
 * 设置当前语言并持久化
 * @param {string} locale
 * @returns {'zh' | 'en'}
 */
function setLocale(locale) {
  currentLocale = (locale && String(locale).toLowerCase().startsWith('en')) ? 'en' : 'zh';
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem('dogsc_locale', currentLocale);
    }
  } catch {}

  if (typeof window !== 'undefined' && window && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent('dogsc:locale-change', { detail: { locale: currentLocale } }));
    } catch {}
  }
  return currentLocale;
}

// 挂载到 window，方便所有渲染页面全局调用
if (typeof window !== 'undefined') {
  window.t = t;
  window.getLocale = getLocale;
  window.setLocale = setLocale;
}

module.exports = {
  t,
  getLocale,
  setLocale,
  formatString,
  enTranslations,
};
