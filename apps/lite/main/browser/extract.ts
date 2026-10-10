/**
 * Scripts run inside a page, and the cleaning of what they return. The page is not trusted: it can say anything, so
 * whatever comes back is checked for its type and size before it is used.
 */

/** Reads the visible text of the page — the main article if there is one — and its title. */
export const READ_PAGE_SCRIPT = `(() => {
  const drop = 'script,style,noscript,template,svg,canvas,iframe,nav,footer,aside,header,form,[aria-hidden="true"],[hidden]';
  const root = document.querySelector('main, article, [role="main"]') || document.body;
  if (!root) return { title: document.title || '', text: '' };
  const clone = root.cloneNode(true);
  clone.querySelectorAll(drop).forEach((el) => el.remove());
  let text = clone.innerText || clone.textContent || '';
  // A page whose main part is nearly empty (a script-built page) is read from the whole body instead.
  if (text.trim().length < 200 && root !== document.body) {
    const all = document.body.cloneNode(true);
    all.querySelectorAll('script,style,noscript,template,svg').forEach((el) => el.remove());
    text = all.innerText || all.textContent || '';
  }
  const headings = [...document.querySelectorAll('h1,h2')].slice(0, 12).map((h) => (h.textContent || '').trim()).filter(Boolean);
  return { title: document.title || '', text, headings };
})()`;

/** Every link with words on it. */
export const LIST_LINKS_SCRIPT = `(() => {
  return [...document.querySelectorAll('a[href]')].slice(0, 2000).map((a) => ({
    text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim(),
    href: a.href,
  }));
})()`;

/** The results of a search page: links to other sites, each with the words around it. */
export const SEARCH_RESULTS_SCRIPT = `(() => {
  const here = location.hostname.replace(/^www\\./, '');
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href^="http"]')) {
    let host;
    try { host = new URL(a.href).hostname.replace(/^www\\./, ''); } catch { continue; }
    if (host === here || host.endsWith('.' + here)) continue;
    const title = (a.innerText || '').trim().split('\\n')[0].trim();
    if (title.length < 8) continue;
    const key = a.href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const box = a.closest('article, li, [data-testid="result"], .result') || a.parentElement;
    const around = ((box && box.innerText) || '').replace(/\\s+/g, ' ').trim();
    out.push({ title, href: a.href, snippet: around.replace(title, '').trim().slice(0, 240) });
    if (out.length >= 12) break;
  }
  return out;
})()`;

const INVISIBLE = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g');
/** Control characters other than tab and line break. */
const isControl = (code: number) =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;

/** Plain, tidy text: no control characters, runs of blank lines and spaces collapsed, cut to `max` characters. */
export function tidyText(raw: unknown, max: number): { text: string; truncated: boolean } {
  const value = typeof raw === 'string' ? raw : '';
  let out = '';
  for (const char of value.replace(INVISIBLE, '')) {
    if (!isControl(char.codePointAt(0) ?? 0)) out += char;
  }
  out = out
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(out);
  if (chars.length <= max) return { text: out, truncated: false };
  return { text: chars.slice(0, max).join('').trimEnd(), truncated: true };
}

export interface PageRead {
  title: string;
  url: string;
  text: string;
  headings: string[];
  truncated: boolean;
}

/** Checks what a page script returned: wrong shapes become an empty page, never an exception or a surprise. */
export function readPageFrom(result: unknown, url: string, max: number): PageRead {
  const record =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const { text, truncated } = tidyText(record['text'], max);
  const headings = Array.isArray(record['headings'])
    ? record['headings']
        .filter((h): h is string => typeof h === 'string')
        .map((h) => tidyText(h, 120).text)
        .filter(Boolean)
        .slice(0, 12)
    : [];
  return {
    title: tidyText(record['title'], 200).text,
    url,
    text,
    headings,
    truncated,
  };
}

export interface LinkItem {
  text: string;
  href: string;
}

/** Web links only, each once, with words; in the order they appear. */
export function linksFrom(result: unknown, limit: number): LinkItem[] {
  if (!Array.isArray(result)) return [];
  const seen = new Set<string>();
  const out: LinkItem[] = [];
  for (const item of result) {
    if (typeof item !== 'object' || item === null) continue;
    const { text, href } = item as { text?: unknown; href?: unknown };
    if (typeof href !== 'string' || typeof text !== 'string') continue;
    if (!/^https?:\/\//i.test(href)) continue;
    const label = tidyText(text, 120).text.replace(/\n+/g, ' ');
    if (!label) continue;
    const key = `${label}|${href.split('#')[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: label, href: href.slice(0, 500) });
    if (out.length >= limit) break;
  }
  return out;
}

export interface SearchResult {
  title: string;
  href: string;
  snippet: string;
}

export function resultsFrom(result: unknown, limit: number): SearchResult[] {
  if (!Array.isArray(result)) return [];
  const out: SearchResult[] = [];
  for (const item of result) {
    if (typeof item !== 'object' || item === null) continue;
    const { title, href, snippet } = item as Record<string, unknown>;
    if (typeof title !== 'string' || typeof href !== 'string' || !/^https?:\/\//i.test(href))
      continue;
    out.push({
      title: tidyText(title, 160).text,
      href: href.slice(0, 500),
      snippet: tidyText(snippet, 240).text.replace(/\n+/g, ' '),
    });
    if (out.length >= limit) break;
  }
  return out;
}
