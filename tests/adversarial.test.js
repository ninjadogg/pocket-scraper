import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { scrape } from '../runner.js';
import { normalizeRecipe } from '../store.js';
import { chromium } from 'playwright';
import { browserOptions } from '../browser-session.js';
import { captureFields } from '../extension/capture.js';
const token = 'a'.repeat(64);
const auth = { Authorization: 'Bearer ' + token };
const fixture = '<article><h3>A</h3></article><article><h3>B</h3><span class="price">$20</span></article>';
const fields = [{name:'title',selector:'h3',kind:'text'},{name:'price',selector:'.price',kind:'text'}];
const baseRecipe = {name:'Adversarial',url:'https://example.org',fields};

test('record containers preserve missing fields in runner and tab capture; legacy misalignment fails', async () => {
  const recipe = normalizeRecipe({...baseRecipe,rowSelector:'article'});
  const result = await scrape(recipe,{fixtureHtml:fixture});
  assert.deepEqual(result.rows.map(r=>r.fields),[{title:'A',price:''},{title:'B',price:'$20'}]);
  await assert.rejects(scrape(normalizeRecipe(baseRecipe),{fixtureHtml:fixture}), /Field match counts differ/);
  const browser = await chromium.launch({headless:true,...browserOptions()});
  try {
    const page = await browser.newPage(); await page.setContent(fixture);
    const captured = await page.evaluate(captureFields,{fields,rowSelector:'article'});
    assert.deepEqual(captured.rows.map(r=>r.fields),result.rows.map(r=>r.fields));
  } finally {await browser.close();}
});

test('prototype field names extract normally and entirely empty runs fail', async () => {
  const recipe = normalizeRecipe({...baseRecipe,fields:[{name:'__proto__',selector:'h3'}]});
  const result = await scrape(recipe,{fixtureHtml:'<h3>Present</h3>'});
  assert.equal(result.rows[0].fields.__proto__,'Present');
  await assert.rejects(scrape(recipe,{fixtureHtml:'<p>Sign in</p>'}), /No records collected/);
});

test('HTTP errors after workflow clicks are rejected, not collected as data', async () => {
  const site = http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    if(req.url==='/blocked'){res.writeHead(403);res.end('<h1>Forbidden</h1>');}
    else res.end('<a id="next" href="/blocked">Next</a>');
  });
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  try {
    const recipe=normalizeRecipe({...baseRecipe,url:`http://127.0.0.1:${site.address().port}`,fields:[{name:'title',selector:'h1'}],steps:[{type:'click',selector:'#next',waitMs:0},{type:'extract'}]});
    await assert.rejects(scrape(recipe),e=>e.code==='SESSION_ATTENTION'&&/HTTP 403/.test(e.message));
  } finally {await new Promise(resolve=>site.close(resolve));}
});

test('API authenticates clients, preserves split UTF-8, exports safe CSV, survives write failure and recovers stale runs', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pocket-hardening-'));
  const data=join(dir,'store.json');
  writeFileSync(data,JSON.stringify({recipes:[],records:[],runs:[{id:'old',status:'running'}]}));
  const server=spawn(process.execPath,['server.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:'0',POCKET_SCRAPER_DATA:data,POCKET_SCRAPER_TOKEN:token},stdio:['ignore','pipe','pipe']});
  server.stderr.resume();
  try {
    const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),5000);server.once('error',reject);server.stdout.on('data',chunk=>{const m=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});});
    const get=async path=>(await fetch(base+path,{headers:auth})).json();
    const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{...auth,'Content-Type':'application/json',...headers},body:JSON.stringify(body||{})});
    assert.equal((await get('/api/runs'))[0].status,'interrupted');
    assert.equal((await fetch(base+'/api/recipes')).status,401);
    const badHost = await new Promise((resolve,reject)=>{const req=http.get(base+'/api/recipes',{headers:{...auth,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(badHost,403);
    const origin='chrome-extension://'+'b'.repeat(32);
    assert.equal((await post('/api/recipes',baseRecipe,{Origin:origin})).status,403);
    assert.equal((await post('/api/pair',{}, {Origin:origin,Authorization:'Bearer wrong'})).status,401);
    assert.equal((await post('/api/pair',{}, {Origin:origin})).status,200);
    const recipe=await (await post('/api/recipes',baseRecipe,{Origin:origin})).json();
    assert.ok(recipe.id);
    assert.equal((await fetch(base+'/',{headers:{Origin:origin}})).status,401);
    assert.equal((await fetch(base+'/api/recipes',{headers:{Origin:origin}})).status,401);
    const payload=Buffer.from(JSON.stringify({...baseRecipe,name:'Unicode 🧪 test'}));
    const split=payload.indexOf(Buffer.from('🧪'))+2;
    const decoded=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/recipes',{method:'POST',headers:{...auth,'Content-Type':'application/json','Content-Length':payload.length}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve(JSON.parse(text)));});req.on('error',reject);req.write(payload.subarray(0,split));setTimeout(()=>req.end(payload.subarray(split)),30);});
    assert.equal(decoded.name,'Unicode 🧪 test');
    await post('/api/capture/'+recipe.id,{pageUrl:recipe.url,rows:[{pageUrl:recipe.url,fields:{title:'=1+1',price:'20'}}],warnings:[]});
    const csv=await (await fetch(base+'/api/export/'+recipe.id+'.csv',{headers:auth})).text();
    assert.ok(csv.includes('"\t=1+1"'));
    assert.equal((await get('/api/records'))[0].fields.title,'=1+1');
    mkdirSync(data+'.'+server.pid+'.tmp');
    await post('/api/run/'+recipe.id);
    const health=await get('/api/health');
    assert.equal(health.ok,false);assert.deepEqual(health.running,[]);assert.equal(server.exitCode,null);
    rmSync(data+'.'+server.pid+'.tmp',{recursive:true});
    const saved=await post('/api/recipes',{...recipe,name:'Storage recovered'});
    assert.equal(saved.status,200);assert.equal((await get('/api/health')).ok,true);
  } finally {const done=once(server,'close');server.kill();await done;rmSync(dir,{recursive:true,force:true});}
});

test('final-save failure discards unsaved rows, alerts the dashboard, and allows a durable retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-final-save-'));
  const data = join(dir, 'store.json');
  let server, browser, failSave = true;
  const site = http.createServer((req, res) => {
    if (failSave) mkdirSync(`${data}.${server.pid}.tmp`, { recursive: true });
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>Durable record</h1>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  try {
    server = spawn(process.execPath, ['server.js'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0', POCKET_SCRAPER_DATA: data, POCKET_SCRAPER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.resume();
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout')), 10000);
      server.once('error', reject);
      server.stdout.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const api = async (path, input) => {
      const response = await fetch(base + path, { headers: { ...auth, 'Content-Type': 'application/json' }, method: input ? 'POST' : 'GET', ...(input ? { body: JSON.stringify(input) } : {}) });
      assert.ok(response.ok);
      return response.json();
    };
    const waitForRun = async () => {
      for (let i = 0; i < 300; i++) {
        const [run] = await api('/api/runs');
        if (run && run.status !== 'running') return run;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('Run did not finish');
    };
    const recipe = await api('/api/recipes', { name: 'Final save', url: `http://127.0.0.1:${site.address().port}`, fields: [{ name: 'title', selector: 'h1' }] });
    await api('/api/run/' + recipe.id, {});
    const failed = await waitForRun();
    assert.equal(failed.status, 'storage_error');
    assert.match(failed.error, /Results were not saved/);
    assert.equal(failed.newCount, 0);
    assert.deepEqual(await api('/api/records'), []);
    assert.equal(JSON.parse(readFileSync(data, 'utf8')).records.length, 0);
    const health = await api('/api/health');
    assert.equal(health.ok, false);
    assert.deepEqual(health.running, []);

    browser = await chromium.launch({ headless: true, ...browserOptions() });
    const page = await browser.newPage();
    await page.goto(base);
    await page.locator('#storageError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#storageError').textContent(), /Results may not be saved/);

    failSave = false;
    rmSync(`${data}.${server.pid}.tmp`, { recursive: true });
    await api('/api/recipes', recipe);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#recipes table'));
    assert.equal(await page.locator('#storageError').isHidden(), true);
    assert.equal(JSON.parse(readFileSync(data, 'utf8')).runs[0].status, 'storage_error');
    await api('/api/run/' + recipe.id, {});
    const succeeded = await waitForRun();
    assert.equal(succeeded.status, 'success');
    assert.equal(succeeded.newCount, 1, 'unsaved rows must not prevent retry deduplication');
    assert.equal((await api('/api/records')).length, 1);
    assert.equal(JSON.parse(readFileSync(data, 'utf8')).records.length, 1);
  } finally {
    if (browser) await browser.close();
    if (server) { const done = once(server, 'close'); server.kill(); await done; }
    await new Promise(resolve => site.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
