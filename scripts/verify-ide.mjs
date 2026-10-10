import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const automator = require('miniprogram-automator');
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
fs.mkdirSync('artifacts', { recursive: true });
const report = { at: new Date().toISOString(), status: 'RUNNING', backend: 'real configured backend only; no mocks', checks: [], exceptions: [] };
let mp;
function bounded(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out; inspect the WeFile IDE window (AppID/compile dialogs)`)), ms);
  })]).finally(() => clearTimeout(timer));
}
try {
  if (!process.argv.includes('--connect-only')) {
    const toolDir = process.env.WECHAT_DEVTOOLS_DIR || 'C:/Program Files (x86)/Tencent/微信web开发者工具';
    const output = execFileSync(path.join(toolDir, 'node.exe'), [path.join(toolDir, 'cli.js'), 'auto', '--project', root, '--auto-port', '9420', '--trust-project'], { encoding: 'utf8', timeout: 45000, windowsHide: true });
    fs.writeFileSync('artifacts/ide-cli.log', output);
  }
  // CLI can finish before the automation socket begins listening.
  const deadline = Date.now() + 30000;
  while (!mp) {
    try { mp = await bounded(automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' }), 'IDE handshake'); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  mp.on('exception', e => report.exceptions.push(e));
  await bounded(mp.evaluate(() => { wx.setStorageSync('explicitLogout', true); getApp().globalData.user = null; }), 'prepare login');
  await bounded(mp.reLaunch('/pages/login/index'), 'login page');
  // DevTools 2.01.2510290 Page/Element protocol stalls; query actual rendered
  // native nodes through the supported App-Service protocol instead.
  async function rendered(selector) {
    return bounded(mp.evaluate(selector => new Promise(resolve => {
      const p = getCurrentPages().slice(-1)[0];
      wx.createSelectorQuery().in(p).selectAll(selector).fields({ dataset: true, rect: true }, resolve).exec();
    }), selector), 'native selector');
  }
  let buttons = [];
  for (let i = 0; i < 40; i++) {
    buttons = await rendered('.action-button');
    if (buttons.some(b => b.dataset.action === 'login')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  for (const action of ['login', 'agreement', 'privacy']) {
    const button = buttons.find(b => b.dataset.action === action);
    assert.ok(button && button.right > button.left && button.bottom - button.top >= 44, `Missing or undersized ${action}`);
  }
  assert.ok((await rendered('.global-nav')).length, 'Missing global navigation');
  report.checks.push('Actual native login buttons and global navigation rendered; touch heights at least 44px');
  report.automation = 'Official App-Service evaluate + native wx.createSelectorQuery; Page/Element protocol incompatible with installed IDE';
  await bounded(mp.screenshot({ path: path.join(root, 'artifacts/ide-login.png') }), 'screenshot');
  if (process.argv.includes('--expect-unconfigured')) {
    assert.equal(require(path.join(root, 'miniprogram/config.js')).cloudEnv, '');
    await bounded(mp.evaluate(async () => { await getCurrentPages().slice(-1)[0].action({currentTarget:{dataset:{action:'login'}}}); }), 'login controller');
    const error = await bounded(mp.evaluate(() => getCurrentPages().slice(-1)[0].data.error), 'error data');
    assert.match(error, /尚未配置/);
    report.checks.push('Real login controller rejects missing environment; controller invocation, not simulated touch');
  }
  if (process.argv.includes('--login')) {
    assert.ok(require(path.join(root, 'miniprogram/config.js')).cloudEnv);
    await bounded(mp.evaluate(async () => { await getCurrentPages().slice(-1)[0].action({currentTarget:{dataset:{action:'login'}}}); }), 'real login');
    let current;
    for (let i=0;i<60;i++) {
      current=await bounded(mp.evaluate(() => { const p=getCurrentPages().slice(-1)[0]; return {route:p.route,busy:p.data.busy,error:p.data.error,user:!!getApp().globalData.user}; }), 'login result');
      if(current.route!=='pages/login/index' && !current.busy)break;
      if(current.error)throw Error(current.error);
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(current.user);
    assert.ok(['pages/home/index','pages/profile-edit/index'].includes(current.route),JSON.stringify(current));
    assert.ok(!current.error,current.error);
    report.checks.push('Native login controller uses real cloud identity and navigates to home/profile without errors');
    await bounded(mp.screenshot({path:path.join(root,'artifacts/ide-cloud-home.png')}),'cloud home screenshot');
  }
  if (process.argv.includes('--pages')) {
    const {projectId}=JSON.parse(fs.readFileSync(require(path.join(root,'miniprogram/config.js')).storageMode==='selfhost'?'artifacts/selfhost-smoke-state.json':'artifacts/cloud-smoke-state.json','utf8'));
    for(const id of ['03-A','07','08','09','10','11','15','16','18','02-A','03']) {
      await bounded(mp.evaluate(async(id,projectId)=>{
        await getCurrentPages().slice(-1)[0].go({currentTarget:{dataset:{page:id,project:projectId}}});
      },id,projectId),'navigate '+id);
      let current;
      for(let n=0;n<100;n++){
        current=await bounded(mp.evaluate(()=>{const p=getCurrentPages().slice(-1)[0];return {id:p.data.pageId,busy:p.data.busy,loading:p.data.loading,error:p.data.error};}),'page state '+id);
        if(current.id===id && !current.busy && !current.loading)break;
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      assert.equal(current.id,id,JSON.stringify(current));
      assert.ok(!current.busy&&!current.loading,'Loading did not finish on '+id);
      assert.ok(!current.error,`${id}: ${current.error}`);
      assert.ok((await rendered('.global-nav')).length,`No navigation on ${id}`);
      report.checks.push(`Native page ${id} loaded configured real backend data with no error`);
      if(id==='07')await bounded(mp.screenshot({path:path.join(root,'artifacts/ide-cloud-project.png')}),'project screenshot');
    }
  }
  assert.equal(report.exceptions.length, 0, 'Runtime exception observed');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error.message;
} finally {
  mp?.disconnect();
  fs.writeFileSync('docs/IDE_TEST_RESULT.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  // The official SDK has no handshake cancellation API. Bound the whole CLI lifetime.
  process.exit(report.status === 'PASS' ? 0 : 1);
}
