// 用真实 FBX 文件在无头浏览器里跑完整流程（经本地 HTTP，验证 DecompressionStream 路径）
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

const file = process.argv[2] || 'test-mixamo.fbx';
const shot = process.argv[3] || '_shot_fbx.png';
const htmlFile = process.argv[4] || 'index.html';
let h = fs.readFileSync(htmlFile, 'utf8');
const test = `
<script>
window.__errs=[];
window.onerror=function(m){window.__errs.push(String(m));};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function txt(id){return document.getElementById(id).textContent;}
(async function(){
  try{
    const resp = await fetch('${file}');
    const buf = await resp.arrayBuffer();
    const f = new File([buf], '${file}', {type:'application/octet-stream'});
    const dt = new DataTransfer(); dt.items.add(f);
    const fi = document.getElementById('file');
    fi.files = dt.files;
    fi.dispatchEvent(new Event('change'));
  }catch(e){ window.__errs.push('fetch:'+e.message); }

  for(let i=0;i<1200;i++){ if(txt('fmeta')!=='—') break; await sleep(50); }
  try{ document.getElementById('run').click(); }catch(e){ window.__errs.push('run:'+e.message); }
  for(let i=0;i<1200;i++){ if(!document.getElementById('expGLB').disabled) break; await sleep(50); }

  var r={errs:window.__errs,
    src:txt('saF'), dst:txt('sbF'), red:txt('sbR'),
    file:txt('fmeta'), toast:txt('toast'),
    expDisabled:document.getElementById('expGLB').disabled};
  document.title='RESULT:'+JSON.stringify(r);
  var d=document.createElement('div'); d.id='testout'; d.textContent=JSON.stringify(r);
  document.body.appendChild(d);
})();
</script>
`;
fs.writeFileSync('_test_fbx.html', h.replace('</body>', test + '</body>'));

const port = 8731;
const server = spawn('C:/Users/admin/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe',
  ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: process.cwd(), stdio: 'ignore' });

setTimeout(() => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const args = [
    '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900', '--virtual-time-budget=120000',
    '--screenshot=' + process.cwd().replace(/\\/g, '/') + '/' + shot,
    '--dump-dom',
    'http://127.0.0.1:' + port + '/_test_fbx.html'
  ];
  let out = '';
  try { out = execFileSync(edge, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); }
  catch (e) { out = e.stdout || ''; }
  const m = out.match(/<div id="testout">([^<]*)/);
  console.log(m ? m[1] : '(未拿到结果)');
  try { server.kill(); } catch (e) {}
  process.exit(0);
}, 1200);
