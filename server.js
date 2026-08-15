const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { convertMany, DEFAULT_FRAGMENT, decodeSubscriptionContent } = require('./converter');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// Persistent storage for saved configs (survives restarts only if
// DATA_DIR points at a Railway Volume — see README notes)
// ---------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

const SLUG_RE = /^[a-zA-Z0-9_-]{3,64}$/;

// Simple HTML form for manual/browser use
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Config Fragment Injector</title></head>
<body style="font-family: sans-serif; max-width: 750px; margin: 40px auto;">
  <h2>VLESS/Trojan Fragment Injector</h2>

  <section style="border:1px solid #ccc; border-radius:8px; padding:20px; margin-bottom:30px;">
    <h3>Manual</h3>
    <textarea id="m-input" rows="8" style="width:100%" placeholder="one config per line"></textarea><br><br>
    <button onclick="convertManual()">Convert</button>

    <h4>Output</h4>
    <textarea id="m-output" rows="8" style="width:100%" readonly></textarea><br><br>
    <button onclick="copyText('m-output')">Copy</button>

    <div style="margin-top:20px;">
      <label>Slug (optional):</label><br>
      <input id="m-slug" type="text" placeholder="e.g. my-configs" style="width:100%; box-sizing:border-box;"><br><br>
      <label><input type="radio" name="m-mode" value="rewrite" checked> Rewrite (replace saved content)</label><br>
      <label><input type="radio" name="m-mode" value="append"> Append (add to saved content)</label><br><br>
      <button onclick="saveOutput('m')">Save to URL</button>
    </div>

    <div id="m-saved-url" style="margin-top:15px; display:none;">
      <b>Saved URL:</b>
      <input id="m-saved-url-input" type="text" readonly style="width:65%;">
      <button onclick="copyText('m-saved-url-input')">Copy link</button>
    </div>
  </section>

  <section style="border:1px solid #ccc; border-radius:8px; padding:20px;">
    <h3>Subscription Link</h3>
    <input id="s-url" type="text" placeholder="https://.../subscribe/..." style="width:100%; box-sizing:border-box;"><br><br>
    <button onclick="convertSub()">Fetch &amp; Convert</button>

    <h4>Output</h4>
    <textarea id="s-output" rows="8" style="width:100%" readonly></textarea><br><br>
    <button onclick="copyText('s-output')">Copy</button>

    <div style="margin-top:20px;">
      <label>Slug (optional):</label><br>
      <input id="s-slug" type="text" placeholder="e.g. my-sub" style="width:100%; box-sizing:border-box;"><br><br>
      <label><input type="radio" name="s-mode" value="rewrite" checked> Rewrite (replace saved content)</label><br>
      <label><input type="radio" name="s-mode" value="append"> Append (add to saved content)</label><br><br>
      <button onclick="saveOutput('s')">Save to URL</button>
    </div>

    <div id="s-saved-url" style="margin-top:15px; display:none;">
      <b>Saved URL:</b>
      <input id="s-saved-url-input" type="text" readonly style="width:65%;">
      <button onclick="copyText('s-saved-url-input')">Copy link</button>
    </div>
  </section>

  <script>
    async function convertManual() {
      const input = document.getElementById('m-input').value;
      const res = await fetch('/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: input
      });
      document.getElementById('m-output').value = await res.text();
    }

    async function convertSub() {
      const url = document.getElementById('s-url').value.trim();
      if (!url) { alert('Enter a subscription URL.'); return; }
      const res = await fetch('/convert-sub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to convert subscription link.');
        return;
      }
      document.getElementById('s-output').value = await res.text();
    }

    function copyText(id) {
      const el = document.getElementById(id);
      el.select();
      navigator.clipboard.writeText(el.value);
    }

    async function saveOutput(prefix) {
      const content = document.getElementById(prefix + '-output').value;
      const slug = document.getElementById(prefix + '-slug').value.trim();
      const mode = document.querySelector('input[name="' + prefix + '-mode"]:checked').value;
      if (!content.trim()) { alert('Convert something first.'); return; }

      const res = await fetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, slug: slug || undefined, mode })
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Save failed'); return; }

      document.getElementById(prefix + '-slug').value = data.slug;
      document.getElementById(prefix + '-saved-url-input').value = data.url;
      document.getElementById(prefix + '-saved-url').style.display = 'block';
    }
  </script>
</body>
</html>`);
});

// POST /convert
// Accepts either:
//   - text/plain body: raw links, one per line
//   - application/json body: { "links": ["...", "..."], "fragment": {...} (optional) }
// Returns: text/plain, converted links one per line
app.post('/convert', (req, res) => {
  let links = [];
  let fragment = DEFAULT_FRAGMENT;

  if (req.is('application/json')) {
    const body = req.body || {};
    if (!Array.isArray(body.links)) {
      return res.status(400).json({ error: 'Expected JSON body: { "links": ["..."] }' });
    }
    links = body.links;
    if (body.fragment) fragment = body.fragment;
  } else {
    const raw = typeof req.body === 'string' ? req.body : '';
    links = raw.split('\n');
  }

  if (links.length === 0) {
    return res.status(400).send('No links provided');
  }

  const result = convertMany(links, fragment);

  if (req.is('application/json')) {
    return res.json({ links: result });
  }
  res.type('text/plain').send(result.join('\n'));
});

// POST /save
// Body (JSON): { content: "line1\nline2...", slug?: "my-configs" }
// If slug is omitted, a new random slug is generated.
// If slug is provided and already exists, its content is overwritten
// (rewritten) — the URL /raw/<slug> stays the same.
app.post('/save', (req, res) => {
  const body = req.is('application/json') ? req.body || {} : {};
  const content = typeof body.content === 'string' ? body.content : '';
  const mode = body.mode === 'append' ? 'append' : 'rewrite';
  let slug = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : null;

  if (!content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  if (slug && !SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'slug must be 3-64 chars: letters, numbers, - or _' });
  }
  if (!slug) {
    slug = crypto.randomBytes(4).toString('hex');
  }

  const store = loadStore();
  if (mode === 'append' && store[slug] && store[slug].content) {
    store[slug] = {
      content: store[slug].content.replace(/\n+$/, '') + '\n' + content,
      updatedAt: new Date().toISOString()
    };
  } else {
    store[slug] = { content, updatedAt: new Date().toISOString() };
  }
  saveStore(store);

  const rawUrl = `${req.protocol}://${req.get('host')}/raw/${slug}`;
  res.json({ slug, url: rawUrl, mode });
});

// GET /raw/:slug -> plain text content, subscribable in a VPN client
app.get('/raw/:slug', (req, res) => {
  const store = loadStore();
  const entry = store[req.params.slug];
  if (!entry) return res.status(404).send('Not found');
  res.type('text/plain').send(entry.content);
});

// POST /convert-sub
// Body (JSON): { url: "https://.../sub-link", fragment?: {...} }
// Fetches the subscription URL server-side, decodes it (plain or base64),
// applies the fragment injection to every vless/trojan line, returns plain text.
app.post('/convert-sub', async (req, res) => {
  const body = req.is('application/json') ? req.body || {} : {};
  const subUrl = typeof body.url === 'string' ? body.url.trim() : '';
  const fragment = body.fragment || DEFAULT_FRAGMENT;

  if (!subUrl) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!/^https?:\/\//i.test(subUrl)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }

  try {
    const upstream = await fetch(subUrl, { headers: { 'User-Agent': 'v2ray/config-converter' } });
    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
    }
    const raw = await upstream.text();
    const decoded = decodeSubscriptionContent(raw);
    const lines = decoded.split('\n').map((l) => l.trim()).filter(Boolean);
    const result = convertMany(lines, fragment);
    res.type('text/plain').send(result.join('\n'));
  } catch (err) {
    res.status(502).json({ error: `Failed to fetch subscription link: ${err.message}` });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
