import { createServer } from 'node:http';

export const taskNames = ['contact', 'preferences', 'catalog', 'record', 'wizard', 'validation'];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const field = (name, value = '') => `<label>${name}<input name="${name}" value="${escape(value)}"></label>`;
const select = (name, options) => `<label for="${name}">${name}</label><select id="${name}" name="${name}">${options.map(o => `<option>${o}</option>`).join('')}</select>`;
const form = (body, button = 'Save') => `<form>${body}<button>${button}</button></form>`;

export function fixture(name, variant) {
  const suffix = variant + 31;
  const email = `alex${suffix}@example.test`;
  const target = `Account ${suffix}`;
  const code = `Q${suffix}-72`;
  const data = {
    contact: {
      task: `Create a contact named Alex Morgan with email ${email}. Save the contact and verify it was saved.`,
      body: '<h1>New contact</h1>' + form(field('Full name') + field('Email'), 'Save contact'),
      expected: { 'Full name': 'Alex Morgan', Email: email },
    },
    preferences: {
      task: 'Set notification preferences to weekly digest, disable promotional email, enable security alerts, and choose French as the language. Save and verify the preferences.',
      body: '<h1>Notification preferences</h1>' + form(select('Digest frequency', ['Daily', 'Weekly', 'Never']) + select('Language', ['English', 'French', 'German']) + '<label><input type="checkbox" name="Promotional email" checked>Promotional email</label><label><input type="checkbox" name="Security alerts">Security alerts</label>', 'Save preferences'),
      expected: { 'Digest frequency': 'Weekly', Language: 'French', 'Security alerts': 'on' },
    },
    catalog: {
      task: `Find the in-stock product named Field notebook ${suffix}, open its details, and report its warehouse pickup code.`,
      body: '<h1>Supply catalog</h1><p>Choose a product to see its warehouse pickup code.</p><section aria-label="Products">' + Array.from({ length: 72 }, (_, i) => `<article><h2>${i === 53 ? `Field notebook ${suffix}` : `Office supply ${i + 1}`}</h2><p>${i === 53 ? 'In stock' : i % 3 ? 'In stock' : 'Out of stock'}</p><button type="button" onclick="detail(${i})">View details</button></article>`).join('') + '</section>',
      script: `window.detail=i=>{document.querySelector('main').innerHTML='<h1>Product details</h1><p>Warehouse pickup code: '+(i===53?${JSON.stringify(code)}:'OTHER-'+i)+'</p>';};`,
      answer: code,
    },
    record: {
      task: `Change the contact email for ${target} to ${email}. Leave the other accounts unchanged and verify the update.`,
      body: '<h1>Accounts</h1><table><thead><tr><th>Account</th><th>Email</th><th>Action</th></tr></thead><tbody>' + Array.from({ length: 18 }, (_, i) => `<tr><td>${i === 12 ? target : `Sample account ${i + 1}`}</td><td>old${i}@example.test</td><td><button type="button" onclick="edit(${i})">Edit</button></td></tr>`).join('') + '</tbody></table><div id="editor"></div>',
      script: `window.edit=i=>{document.querySelector('#editor').innerHTML='<section aria-label="Edit account"><h2>Edit '+(i===12?${JSON.stringify(target)}:'Sample account '+(i+1))+'</h2>'+${JSON.stringify(form(field('Contact email'), 'Save account'))}+'</section>';document.querySelector('form').dataset.row=i;};`,
      expected: { 'Contact email': email, row: '12' },
      onlyOneSave: true,
    },
    wizard: {
      task: `Create a project draft called Research ${suffix}, choose the Analytics template, and set visibility to Private. Finish the wizard and verify the draft.`,
      body: '<h1>Project wizard</h1><section id="stage">' + field('Project name') + '<button type="button" onclick="next()">Next</button></section>',
      script: `let draft={};window.next=()=>{draft['Project name']=document.querySelector('input').value;document.querySelector('#stage').innerHTML=${JSON.stringify(form(select('Template', ['Blank', 'Analytics', 'Support']) + select('Visibility', ['Public', 'Private']), 'Create draft'))};};window.extra=()=>draft;`,
      expected: { 'Project name': `Research ${suffix}`, Template: 'Analytics', Visibility: 'Private' },
    },
    validation: {
      task: `Reserve the workspace alias studio for ${email}. If studio is unavailable, use studio-${suffix}. Save and verify the reservation.`,
      body: '<h1>Workspace alias</h1>' + form(field('Alias') + field('Owner email'), 'Reserve alias'),
      validation: true,
      expected: { Alias: `studio-${suffix}`, 'Owner email': email },
    },
  }[name];
  if (!data) throw new Error(`Unknown task ${name}`);
  return data;
}

export function validate(spec, events, answer) {
  if (spec.answer) return String(answer).includes(spec.answer);
  const saves = events.filter(e => e.kind === 'saved');
  if (spec.onlyOneSave && saves.length !== 1) return false;
  return JSON.stringify(Object.entries(saves.at(-1)?.value ?? {}).sort()) === JSON.stringify(Object.entries(spec.expected).sort());
}

export async function startFixtures() {
  const runs = new Map();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
    const run = runs.get(path[0]);
    if (!run) { res.writeHead(404).end(); return; }
    if (req.method === 'POST' && path[1] === 'event') {
      let body = ''; for await (const chunk of req) body += chunk;
      try { run.events.push(JSON.parse(body)); res.writeHead(204).end(); } catch { res.writeHead(400).end(); }
      return;
    }
    if (req.method !== 'GET' || path.length !== 1) { res.writeHead(404).end(); return; }
    const spec = run.spec;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><head><title>Workflow fixture: ${escape(run.name)}</title><style>body{font:16px sans-serif;margin:24px}label{display:block;margin:12px}input,select,button{margin:6px}article{border:1px solid #ccc;padding:8px;margin:8px}td{padding:6px}</style></head><body><nav aria-label="Application"><a href="#home">Home</a><a href="#help">Help</a></nav><main>${spec.body}</main><script>
      ${spec.script ?? ''}
      document.addEventListener('submit',async e=>{e.preventDefault();const f=e.target;const value={...Object.fromEntries(new FormData(f)),...(window.extra?.()??{})};if(f.dataset.row)value.row=f.dataset.row;
      if(${!!spec.validation}&&value.Alias==='studio'){let a=document.querySelector('[role=alert]');if(!a){a=document.createElement('p');a.setAttribute('role','alert');f.prepend(a)}a.textContent='Alias studio is unavailable. Choose a different alias.';await fetch(location.pathname+'/event',{method:'POST',body:JSON.stringify({kind:'rejected',value})});return;}
      await fetch(location.pathname+'/event',{method:'POST',body:JSON.stringify({kind:'saved',value})});document.querySelector('main').innerHTML='<h1>Saved successfully</h1><p role="status">'+Object.entries(value).map(([k,v])=>k+': '+v).join('; ')+'</p>';});
      </script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    add(id, name, variant) { const spec = fixture(name, variant); runs.set(id, { name, spec, events: [] }); return { ...spec, url: `http://127.0.0.1:${server.address().port}/${id}` }; },
    result(id, answer) { const run = runs.get(id); return { success: validate(run.spec, run.events, answer), events: run.events }; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
