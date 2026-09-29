/**
 * The program that runs INSIDE the web page to describe it. It is a constant string: nothing the model or the page
 * says is ever added to it (its only inputs are three integers, passed as JSON). It labels the visible interactive
 * elements with `data-allaya-ref`, so later actions find them by a validated reference instead of a selector the
 * model wrote, and returns the page's visible text.
 *
 * It is plain JavaScript (not TypeScript) because it runs in the browser; it is exercised against a real
 * Chromium in `tests/integration/browser-playwright.test.ts`.
 */
export const SNAPSHOT_SOURCE = `function (input) {
  var generation = input.generation, maxElements = input.maxElements, maxChars = input.maxChars;
  var doc = document;
  Array.prototype.forEach.call(doc.querySelectorAll('[data-allaya-ref]'), function (old) { old.removeAttribute('data-allaya-ref'); });
  function clean(s, max) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, max || 100); }
  function visible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.05) return false;
    if (style.pointerEvents === 'none') return false;
    return el.closest('[aria-hidden="true"], [inert]') === null;
  }
  function nameOf(el) {
    var aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var text = by.split(/\\s+/).map(function (id) { var t = doc.getElementById(id); return clean(t && t.innerText); }).join(' ').trim();
      if (text) return text;
    }
    var label = el.labels && el.labels[0] ? clean(el.labels[0].innerText) : '';
    if (label) return label;
    var type = String(el.type || '').toLowerCase();
    if (el.tagName.toLowerCase() === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      return clean(el.value) || clean(el.getAttribute('title'));
    }
    var img = el.querySelector && el.querySelector('img[alt]');
    return clean(el.innerText) || clean(el.getAttribute('alt')) || clean(img && img.getAttribute('alt')) ||
      clean(el.getAttribute('title')) || clean(el.placeholder) || clean(el.getAttribute('name'));
  }
  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit && ['link', 'button', 'checkbox', 'radio', 'tab', 'menuitem', 'searchbox', 'textbox', 'combobox'].indexOf(explicit) >= 0) return explicit;
    var tag = el.tagName.toLowerCase();
    var type = String(el.type || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].indexOf(type) >= 0) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return 'other';
  }
  var selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="searchbox"], [role="textbox"], [role="combobox"], [contenteditable=""], [contenteditable="true"]';
  var nodes = Array.prototype.slice.call(doc.querySelectorAll(selector));
  var elements = [];
  var truncated = false;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (!visible(node)) continue;
    if (elements.length >= maxElements) { truncated = true; break; }
    var ref = 'e' + generation + '_' + (elements.length + 1);
    node.setAttribute('data-allaya-ref', ref);
    var tag = node.tagName.toLowerCase();
    var type = String(node.type || '').toLowerCase();
    var isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    elements.push({
      ref: ref,
      role: roleOf(node),
      name: nameOf(node),
      tag: tag,
      inputType: tag === 'input' ? (type || 'text') : undefined,
      autocomplete: node.getAttribute('autocomplete') || undefined,
      href: tag === 'a' ? node.href : undefined,
      disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
      checked: tag === 'input' && (type === 'checkbox' || type === 'radio') ? node.checked : undefined,
      value: isField && type !== 'password' && ['checkbox', 'radio', 'submit', 'button'].indexOf(type) < 0 ? clean(node.value, 200) : undefined,
      inForm: !!node.form || node.closest('form') !== null
    });
  }
  return {
    url: location.href,
    title: doc.title,
    text: String(doc.body ? doc.body.innerText : '').slice(0, maxChars * 2),
    elements: elements,
    elementsTruncated: truncated
  };
}`;
