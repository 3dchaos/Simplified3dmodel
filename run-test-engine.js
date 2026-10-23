// 浏览器端验证：引擎是否加载、是否走 meshopt、UV 是否保留
const fs = require('fs');
const { execFileSync } = require('child_process');

const htmlFile = process.argv[2] || 'index.html';
const shot = process.argv[3] || '_shot_engine.png';
let h = fs.readFileSync(htmlFile, 'utf8');

const test = `
<script>
window.__errs=[];
window.onerror=function(m,s,l,c,e){window.__errs.push(String(m));};
function uvSphereOBJ(seg,rings){
  const L=[]; const V=[]; const T=[];
  for(let r=0;r<=rings;r++){const phi=Math.PI*r/rings;
    for(let s=0;s<=seg;s++){const th=2*Math.PI*s/seg;
      V.push([Math.sin(phi)*Math.cos(th),Math.cos(phi),Math.sin(phi)*Math.sin(th)]);
      T.push([s/seg, r/rings]);}}
  V.forEach(p=>L.push('v '+p[0].toFixed(6)+' '+p[1].toFixed(6)+' '+p[2].toFixed(6)));
  T.forEach(p=>L.push('vt '+p[0].toFixed(6)+' '+p[1].toFixed(6)));
  for(let r=0;r<rings;r++)for(let s=0;s<seg;s++){
    const a=r*(seg+1)+s+1,b=a+seg+1;
    L.push('f '+a+'/'+a+' '+b+'/'+b+' '+(a+1)+'/'+(a+1));
    L.push('f '+b+'/'+b+' '+(b+1)+'/'+(b+1)+' '+(a+1)+'/'+(a+1));}
  return L.join('\\n');
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async function(){
  var out={errs:window.__errs};
  try{
    const obj=uvSphereOBJ(96,48);
    const file=new File([obj],'sphere.obj',{type:'text/plain'});
    const dt=new DataTransfer(); dt.items.add(file);
    const fi=document.getElementById('file');
    fi.files=dt.files; fi.dispatchEvent(new Event('change'));
    for(let i=0;i<300;i++){ if(document.getElementById('fmeta').textContent!=='—') break; await sleep(50); }
    out.engine = window.__app.state.engine;
    out.srcFaces = window.__app.state.original.indices.length/3;
    out.srcVerts = window.__app.state.original.positions.length/3;
    out.hasUV = !!window.__app.state.original.uvs;
    out.fileMeta = document.getElementById('fmeta').textContent;

    // 10%
    const r=document.getElementById('ratio'); r.value=10; r.dispatchEvent(new Event('input'));
    document.getElementById('run').click();
    for(let i=0;i<400;i++){ if(!document.getElementById('expGLB').disabled) break; await sleep(50); }
    await sleep(300);
    out.toast = document.getElementById('toast').textContent;
    out.dstFaces = window.__app.state.current ? window.__app.state.current.indices.length/3 : 0;
    out.dstVerts = window.__app.state.current ? window.__app.state.current.positions.length/3 : 0;
    out.dstHasUV = !!(window.__app.state.current && window.__app.state.current.uvs);
    out.errs = window.__errs;
  }catch(e){ out.fatal = e.message; }
  document.title='RESULT:'+JSON.stringify(out);
  var d=document.createElement('div'); d.id='testout'; d.textContent=JSON.stringify(out);
  document.body.appendChild(d);
})();
</script>
`;
h = h.replace('</body>', test + '</body>');
fs.writeFileSync('_test_engine.html', h);

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = [
  '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--hide-scrollbars', '--window-size=1500,950', '--virtual-time-budget=20000',
  '--screenshot=' + process.cwd().replace(/\\/g, '/') + '/' + shot,
  '--dump-dom',
  'file:///' + process.cwd().replace(/\\/g, '/') + '/_test_engine.html'
];
let out = '';
try {
  out = execFileSync(edge, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
} catch (e) { out = e.stdout || ''; }
const m = out.match(/<div id="testout">([^<]*)/);
console.log(m ? m[1] : '(未拿到结果)');
