import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';

// Full highlight.js is ~900 kB; register only a curated set (their built-in aliases — js, ts, py,
// html, yml, sh — come along automatically). Keeps the bundle lean for a desktop app.
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import cssLang from 'highlight.js/lib/languages/css';
import markdownLang from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';

const langs = { javascript, typescript, python, bash, json, yaml, xml, css: cssLang, markdown: markdownLang, rust, go, sql, diff, c, cpp, java, dockerfile, ini };
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def);

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang }).value; } catch (e) {}
    }
    return '';
  },
});

// Markdown -> sanitized HTML. DOMPurify is the load-bearing XSS guard for assistant output.
export function renderMarkdown(text) {
  return DOMPurify.sanitize(md.render(text || ''), { ADD_ATTR: ['target'] });
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const EXT_LANG = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', bash: 'bash', json: 'json', jsonl: 'json', yml: 'yaml', yaml: 'yaml', html: 'xml', xml: 'xml', svg: 'xml', css: 'css', md: 'markdown', markdown: 'markdown', rs: 'rust', go: 'go', sql: 'sql', diff: 'diff', patch: 'diff', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', java: 'java', dockerfile: 'dockerfile', ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', env: 'ini' };

// Syntax-highlight a code string by file extension (returns safe, escaped HTML).
export function highlightCode(text, ext) {
  const lang = EXT_LANG[(ext || '').toLowerCase()];
  if (lang && hljs.getLanguage(lang)) { try { return hljs.highlight(text, { language: lang }).value; } catch (e) {} }
  return escHtml(text);
}
