// The local site the live e2e specs run against (scripts/e2e.mjs). It stands in for the public demo pages of
// examples/: same kinds of controls, but served from 127.0.0.1, so a run fails only when plainwright or Jev does,
// never because a remote site is slow, changed or down. Plain HTML and inline scripts, no dependencies.
import { createServer } from 'node:http';

export const USER = { name: 'tomsmith', pass: 'SuperSecretPassword!' };
export const AUTH = { user: 'admin', pass: 'admin' };

const page = (title, body, script = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><main>${body}</main>${script && `<script>${script}</script>`}</body></html>`;

const LOGIN = (flash = '') => page('Login', `<h1>Login Page</h1>${flash}
<form method="post" action="/authenticate">
  <label>Username <input name="username"></label>
  <label>Password <input name="password" type="password"></label>
  <button type="submit">Login</button>
</form>`);

const SWAP_ON_DROP = `let dragged;
for (const box of document.querySelectorAll('[draggable]')) {
  box.addEventListener('dragstart', () => dragged = box);
  box.addEventListener('dragover', (e) => e.preventDefault());
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    [dragged.textContent, box.textContent] = [box.textContent, dragged.textContent];
  });
}`;

const PAGES = {
  '/candidate-editor': () => page('Article editor', `<h1>Article editor</h1>
<label>Title <input></label><div contenteditable role="textbox" aria-label="Article body" style="border:1px solid;padding:20px"></div>
<div contenteditable="plaintext-only" role="textbox" aria-label="Notes" style="border:1px solid;padding:20px"></div>
<button>Save preview</button><section aria-label="Article preview"><p id="article-preview"></p><p id="notes-preview"></p></section>`,
    `document.querySelector('button').onclick = () => {
  document.querySelector('#article-preview').textContent = 'Article body: ' + document.querySelector('[aria-label="Article body"]').textContent;
  document.querySelector('#notes-preview').textContent = 'Notes: ' + document.querySelector('[aria-label="Notes"]').textContent;
};`),
  '/candidate-dialog': () => page('Store dialog', `<h1>Store</h1><main inert>
${Array.from({ length: 180 }, (_, i) => `<button>Browse product ${i}</button>`).join('')}
<button onclick="document.querySelector('#result').textContent='Background selected'">Continue</button>
<div id="inactive-shadow"></div></main>
<div role="dialog" aria-modal="true"><h2>Confirm choice</h2>
<button onclick="document.querySelector('#result').textContent='Dialog selected'">Continue</button></div>
<p id="result" role="status"></p>`,
    `document.querySelector('#inactive-shadow').attachShadow({mode:'open'}).innerHTML='<button>Continue</button>';`),
  // A long article, so the tree passes the snapshot cap, then a consent modal at the end of the body: a native
  // modal dialog in a shadow root whose button labels are slotted. The list items are the Google Flights shape.
  '/consent': () => page('Travel news', `<h1>Travel news</h1>
<button onclick="document.querySelector('#result').textContent='Background accepted'">Accept All</button>
<ul role="listbox" aria-label="City">${['Paris', 'Rome', 'Madrid'].map((city) =>
    `<li role="option" onclick="document.querySelector('#result').textContent += ', ${city}'">${city}</li>`).join('')}</ul>
<p id="result" role="status"></p>
${Array.from({ length: 1200 }, (_, i) => `<p>Story ${i}: the regional rail timetable for the coming season changes on several lines.</p>`).join('')}
<x-consent><h2 slot="title">We use cookies</h2><x-button data-choice="Necessary only">Necessary Only</x-button>
<x-button data-choice="All accepted">Accept All</x-button></x-consent>`,
    `customElements.define('x-button', class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({mode:'open'}).innerHTML = '<button><slot></slot></button>';
    this.shadowRoot.querySelector('button').onclick = () => {
      document.querySelector('#result').textContent = this.dataset.choice;
      this.closest('x-consent').shadowRoot.querySelector('dialog').close();
    };
  }
});
customElements.define('x-consent', class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({mode:'open'}).innerHTML = '<dialog aria-label="Cookie consent"><slot name="title"></slot><slot></slot></dialog>';
    this.shadowRoot.querySelector('dialog').showModal();
  }
});`),
  // A script dialog, the Shoelace shape: a fixed layer in a shadow root with an overlay over the whole page and a
  // role=dialog panel, a slotted button named like a background one, and a fade-out when it closes.
  '/overlay': () => page('Newsletter', `<h1>Newsletter</h1>
<button onclick="document.querySelector('#result').textContent='Background subscribe'">Subscribe</button>
<button onclick="document.querySelector('#result').textContent += ', archive opened'">Open the archive</button>
<p id="result" role="status"></p>
<x-promo><p>Get the weekly digest.</p><button>Subscribe</button></x-promo>`,
    `const promo = document.querySelector('x-promo');
promo.attachShadow({mode:'open'}).innerHTML =
  '<div class="base" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center">' +
  '<div style="position:fixed;inset:0;background:#0008"></div>' +
  '<div role="dialog" aria-modal="true" aria-label="Weekly digest" style="position:relative;background:white;padding:24px"><slot></slot></div></div>';
promo.querySelector('button').onclick = () => {
  document.querySelector('#result').textContent = 'Dialog subscribe';
  const base = promo.shadowRoot.querySelector('.base');
  base.animate([{ opacity: 1 }, { opacity: 0 }], 400).finished.then(() => promo.remove());
};`),
  // An aria-modal cookie bar at the bottom that leaves the page usable: nothing behind it is blocked.
  '/cookie-bar': () => page('Shop', `<h1>Shop</h1>
<button onclick="document.querySelector('#result').textContent='Added to cart'">Add to cart</button>
<p id="result" role="status"></p>
<div role="dialog" aria-modal="true" aria-label="Cookies" style="position:fixed;left:0;right:0;bottom:0;background:#eee;padding:12px">
<button>Accept cookies</button></div>`),
  '/login': () => LOGIN(),
  '/login?error': () => LOGIN('<p role="alert">Your password is invalid!</p>'),
  '/secure': () => page('Secure Area', `<h1>Secure Area</h1><p role="status">You logged into a secure area!</p>
<a href="/login">Logout</a>`),

  '/forms': () => page('Forms', `<h1>Forms</h1>
<label>Size <select><option>Please select</option><option>Small</option><option>Large</option></select></label>
<form aria-label="Toppings">
  <label><input type="checkbox"> Cheese</label>
  <label><input type="checkbox" checked> Olives</label>
</form>
<figure><img alt="Avatar of user one" width="80" height="80" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <figcaption hidden><h2>name: user1</h2></figcaption></figure>
<label>Search <input id="q"></label><p id="results"></p>`,
  `document.querySelector('figure').addEventListener('mouseenter', () => document.querySelector('figcaption').hidden = false);
document.querySelector('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.querySelector('#results').textContent = 'Results for ' + e.target.value;
});`),

  '/dialogs': () => page('Dialogs', `<h1>Dialogs</h1>
<button onclick="alert('Hello'); out('You clicked the alert')">Show alert</button>
<button onclick="out(confirm('Sure?') ? 'You chose Ok' : 'You chose Cancel')">Show confirm</button>
<p id="result" role="status"></p><a href="/new-window" target="_blank">Open new window</a>`,
  `function out(text) { document.querySelector('#result').textContent = text; }`),
  '/new-window': () => page('New Window', '<h1>New Window</h1>'),

  // The ad sync frame removes its body, like static.admaster.cc's cookieSync.html: a look must not wait for one.
  '/frames': () => page('Frames', `<h1>Frames</h1>
<iframe title="Comment editor" srcdoc="${`<label>Comment <textarea></textarea></label>`.replaceAll('"', '&quot;')}"></iframe>
<iframe title="Ad sync" srcdoc="<script>addEventListener('load', () => document.body.remove())</script>"></iframe>
<shadow-counter></shadow-counter>`,
  `customElements.define('shadow-counter', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Add one</button><p>Count: <span>0</span></p>';
    root.querySelector('button').onclick = () => root.querySelector('span').textContent++;
  }
});`),

  '/files': () => page('Files', `<h1>Files</h1>
<form method="post" action="/upload" enctype="multipart/form-data">
  <label>File to send <input type="file" name="file"></label><button type="submit">Upload</button>
</form>
<h2>Downloads</h2><ul><li><a href="/files/notes.txt">notes.txt</a></li></ul>`),

  '/drag': () => page('Drag', `<h1>Drag and Drop</h1>
<div style="display:flex;gap:20px">
  <div draggable="true" role="region" aria-label="Column A" style="width:100px;height:100px;border:1px solid">A</div>
  <div draggable="true" role="region" aria-label="Column B" style="width:100px;height:100px;border:1px solid">B</div>
</div>`,
  SWAP_ON_DROP),

  // Boxes with no role: the tree shows only their letters, `B A`. The ad frame holds a long tracking link.
  '/boxes': () => page('Drag and Drop page for automation testing practice', `<h1>Drag and Drop</h1>
<p>Drag box A onto box B, then check the letter in each box.</p>
<div style="display:flex;gap:20px">
  <div id="box-a" draggable="true" style="width:100px;height:100px;border:1px solid"><header>A</header></div>
  <div id="box-b" draggable="true" style="width:100px;height:100px;border:1px solid"><header>B</header></div>
</div>
<iframe title="Advertisement" srcdoc="${`<a href="https://ads.example/aclk?sa=l&ai=${'Xy7'.repeat(500)}">Garden tools on sale</a>`.replaceAll('"', '&quot;')}"></iframe>`,
  SWAP_ON_DROP),

  '/waits': () => page('Waits', `<h1>Waits</h1>
<button onclick="setTimeout(() => document.querySelector('#done').innerHTML = '<h2>Report ready</h2>', 1500)">Build report</button>
<div id="done"></div>
<section aria-label="Feed" id="feed"><article>Post 1</article></section>
<div style="height:3000px"></div>`,
  `let posts = 1;
addEventListener('scroll', () => {
  if (posts < 6 && innerHeight + scrollY >= document.body.scrollHeight - 50) {
    const post = document.createElement('article');
    post.textContent = 'Post ' + ++posts;
    document.querySelector('#feed').append(post);
  }
});`),

  '/where': () => page('Where', `<h1>Where am I</h1><button>Locate me</button><p id="pos"></p>`,
  `document.querySelector('button').onclick = () => navigator.geolocation.getCurrentPosition((p) =>
  document.querySelector('#pos').textContent = 'Latitude ' + p.coords.latitude + ', longitude ' + p.coords.longitude);`),
};

async function body(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

async function respond(req, res) {
  const send = (status, html, headers = {}) => res.writeHead(status, { 'content-type': 'text/html', ...headers }).end(html);
  if (req.method === 'POST' && req.url === '/authenticate') {
    const form = new URLSearchParams(await body(req));
    const ok = form.get('username') === USER.name && form.get('password') === USER.pass;
    return send(303, '', { location: ok ? '/secure' : '/login?error' });
  }
  if (req.method === 'POST' && req.url === '/upload') {
    const name = /filename="([^"]*)"/.exec(await body(req))?.[1] || 'nothing';
    return send(200, page('Uploaded', `<h1>File Uploaded!</h1><p>${name}</p>`));
  }
  if (req.url === '/files/notes.txt') {
    return res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' }).end('notes\n');
  }
  if (req.url === '/basic-auth') {
    const expected = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    if (req.headers.authorization !== expected) return send(401, 'Not authorized', { 'www-authenticate': 'Basic realm="e2e"' });
    return send(200, page('Basic Auth', '<h1>Basic Auth</h1><p>Congratulations! You must have the proper credentials.</p>'));
  }
  const html = PAGES[req.url];
  return html ? send(200, html()) : send(404, page('Not found', '<h1>Not found</h1>'));
}

/** Starts the site on a free local port; resolves to its base URL and a close function. */
export async function startSite() {
  const server = createServer((req, res) => respond(req, res).catch((error) => send500(res, error)));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const close = () => new Promise((done) => {
    server.close(done);
    server.closeAllConnections();  // keep-alive sockets of the browser would hold close() open
  });
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

function send500(res, error) {
  res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
}
