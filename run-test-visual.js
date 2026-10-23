// 视觉验证：真实模型 + 指定比例 + 线框，输出截图与统计
// 用法: node run-test-visual.js <模型文件> <比例%> <截图名> [页面文件] [是否线框1/0] [锁定边界1/0]
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

const file = process.argv[2] || '_helmet.glb';
const ratio = parseInt(process.argv[3] || '10', 10);
const shot = process.argv[4] || '_shot_visual.png';
const htmlFile = process.argv[5] || 'index.html';
const wire = (process.argv[6] || '1') === '1';
const lockBorder = (process.argv[7] || '0') === '1';
const errVal = parseInt(process.argv[8] || '10', 10);   // 1..100 → 0.001..0.1

let h = fs.readFileSync(htmlFile, 'utf8');
const test = `
<script>
window.__errs=[];
window.onerror=function(m){window.__errs.push(String(m));};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function txt(id){return document.getElementById(id).textContent;}
(async function(){
  var out={errs:window.__errs};
  try{
    const resp = await fetch('${file}');
    const buf = await resp.arrayBuffer();
    const f = new File([buf], '${file}', {type:'application/octet-stream'});
    const dt = new DataTransfer(); dt.items.add(f);
    const fi = document.getElementById('file');
    fi.files = dt.files; fi.dispatchEvent(new Event('change'));
  }catch(e){ window.__errs.push('fetch:'+e.message); }

  for(let i=0;i<2400;i++){ if(txt('fmeta')!=='—') break; await sleep(50); }
  out.file = txt('fmeta');
  out.engine = window.__app.state.engine;

  const r=document.getElementById('ratio'); r.value=${ratio}; r.dispatchEvent(new Event('input'));
  if(${lockBorder}) { const l=document.getElementById('lockBorder'); l.checked=true; }
  const ev=document.getElementById('errTh'); ev.value=${errVal}; ev.dispatchEvent(new Event('input'));
  if(${wire}) { const w=document.getElementById('wire'); w.checked=true; w.dispatchEvent(new Event('change')); }

  document.getElementById('run').click();
  for(let i=0;i<2400;i++){ if(!document.getElementById('expGLB').disabled) break; await sleep(50); }
  await sleep(400);

  out.toast = txt('toast');
  out.dst = txt('sbF');
  out.red = txt('sbR');
  out.errs = window.__errs;
  out.wireA = window.__dbgA ? window.__dbgA.nWire : null;
  out.wireB = window.__dbgB ? window.__dbgB.nWire : null;
  document.title='RESULT:'+JSON.stringify(out);
  var d=document.createElement('div'); d.id='testout'; d.textContent=JSON.stringify(out);
  document.body.appendChild(d);
})();
</script>
`;
fs.writeFileSync('_test_visual.html', h.replace('</body>', test + '</body>'));

const port = 8732;
const server = spawn('C:/Users/admin/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe',
  ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: process.cwd(), stdio: 'ignore' });

setTimeout(() => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const args = [
    '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900', '--virtual-time-budget=180000',
    '--screenshot=' + process.cwd().replace(/\\/g, '/') + '/' + shot,
    '--dump-dom',
    'http://127.0.0.1:' + port + '/_test_visual.html'
  ];
  let out = '';
  try { out = execFileSync(edge, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); }
  catch (e) { out = e.stdout || ''; }
  const m = out.match(/<div id="testout">([^<]*)/);
  console.log(m ? m[1] : '(未拿到结果)');
  try { server.kill(); } catch (e) {}
  process.exit(0);
}, 1200);
