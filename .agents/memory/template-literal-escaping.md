---
name: Template literal JS escaping in panel server
description: webpanel/zao-server.js and zao-devhub.js embed client-side JS code inside Node.js template literals; backslash escape sequences are processed by Node, mangling the output.
---

## The Rule

In `webpanel/zao-server.js` and `webpanel/zao-devhub.js`, the page body (`const body = \`...\``) is a Node.js template literal. Any backslash escape sequences inside it are processed by Node's template literal parser BEFORE being sent to the browser.

**Why:** The template literal is plain text from Node's perspective — escape sequences are consumed at parse time, so `\'` → `'` and `\n` → actual newline in the rendered output.

**How to apply:** When writing client-side JavaScript code inside these template literals:

1. **Single quotes in onclick/event handlers**: Use `\\'` (double backslash + quote) in the template source to produce `\'` in the rendered client JS.
   - Wrong: `onclick="f(\'id\')"` → renders as `onclick="f('id')"` but also breaks the surrounding JS string delimiter
   - Right: `onclick="f(\\'id\\')"`  → renders as `onclick="f(\'id\')"` in client JS (valid)
   - Best: Use `data-*` attributes + `this.dataset.x` in onclick to avoid the issue entirely

2. **Newlines in string literals**: Use `\\n` in the template source to produce `\n` (the escape sequence) in rendered client JS.
   - Wrong: `span.textContent=text+'\n'` → renders with a literal newline inside a single-quoted string → parse error
   - Right: `span.textContent=text+'\\n'`

3. **CSS values like `'var(--bg3)'` in event handlers**: Use `\\'var(--bg3)\\'` in template source → renders as `\'var(--bg3)\'` in client JS (valid inside a single-quoted string).

## Verification

To catch all remaining issues, scan the template literal bodies for `\x5c\x27` (backslash + quote) NOT preceded by another backslash:
```javascript
// In the file source, single backslash + quote in template literal context = bug
// Fix: double backslash + quote (\\'  in file) produces \' in output
```

All 13 panel pages now parse cleanly after fixing these patterns in 2024-06.
