// 浏览器中验证 UV 保留：载入带 UV 的 OBJ → 简化 → 导出 GLB/OBJ → 再解析
const fs = require('fs');
const { execFileSync } = require('child_process');

const htmlFile = process.argv[2] || 'index.html';
let h = fs.readFileSync(htmlFile, 'utf8');

const test = `
<script>
window.__errs=[];
window.onerror=function(m){window.__errs.push(String(m));};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function txt(id){return document.getElementById(id).textContent;}

function makeUVSphereOBJ(seg, rings){
  const L=[], V=[], T=[];
  for(let r=0;r<=rings;r++){
    const phi=Math.PI*r/rings;
    for(let s=0;s<=seg;s++){
      const th=2*Math.PI*s/seg;
      V.push([Math.sin(phi)*Math.cos(th), Math.cos(phi), Math.sin(phi)*Math.sin(th)]);
      T.push([s/seg, r/rings]);
    }
  }
  V.forEach(p=>L.push('v '+p[0].toFixed(6)+' '+p[1].toFixed(6)+' '+p[2].toFixed(6)));
  T.forEach(t=>L.push('vt '+t[0].toFixed(6)+' '+t[1].toFixed(6)));
  for(let r=0;r<rings;r++)for(let s=0;s<seg;s++){
    const a=r*(seg+1)+s+1, b=a+seg+1;
    L.push('f '+a+'/'+a+' '+b+'/'+b+' '+(a+1)+'/'+(a+1));
    L.push('f '+b+'/'+b+' '+(b+1)+'/'+(b+1)+' '+(a+1)+'/'+(a+1));
  }
  return L.join('\\n');
}

(async function(){
  var out = {};
  try{
    const obj = makeUVSphereOBJ(48, 24);
    const f = new File([obj], 'uvsphere.obj', {type:'text/plain'});
    const dt = new DataTransfer(); dt.items.add(f);
    const fi = document.getElementById('file');
    fi.files = dt.files;
    fi.dispatchEvent(new Event('change'));
  }catch(e){ window.__errs.push('load:'+e.message); }

  for(let i=0;i<600;i++){ if(txt('fmeta')!=='—') break; await sleep(50); }
  out.fmeta = txt('fmeta');
  out.keepUVChecked = document.getElementById('keepUV').checked;
  out.keepUVDisabled = document.getElementById('keepUV').disabled;

  try{ document.getElementById('run').click(); }catch(e){ window.__errs.push('run:'+e.message); }
  for(let i=0;i<600;i++){ if(!document.getElementById('expGLB').disabled) break; await sleep(50); }

  out.runDisabled = document.getElementById('run').disabled;
  out.runBg = getComputedStyle(document.getElementById('run')).backgroundColor;
  out.src = txt('saF'); out.dst = txt('sbF'); out.red = txt('sbR');

  try{
    const st = window.__app.state;
    out.hasUvResult = !!(st.current && st.current.uvs && st.current.uvs.length);
    out.uvCount = st.current && st.current.uvs ? st.current.uvs.length/2 : 0;
    out.vertCount = st.current ? st.current.positions.length/3 : 0;

    // GLB 往返
    const gb = MeshCore.exportGLB(st.current.positions, st.current.indices, false, st.current.uvs);
    const back = MeshCore.parseGLB(await gb.arrayBuffer());
    out.glbHasUv = !!back.uvs;
    out.glbUvCount = back.uvs ? back.uvs.length/2 : 0;
    let md = 0;
    if(back.uvs) for(let i=0;i<back.uvs.length;i++) md = Math.max(md, Math.abs(back.uvs[i]-st.current.uvs[i]));
    out.glbMaxDiff = md;

    // OBJ 往返
    const ot = await MeshCore.exportOBJ(st.current.positions, st.current.indices, 'x', st.current.uvs).text();
    out.objHasVt = /^vt /m.test(ot);
    out.objHasSlashFaces = /^f \\d+\\/\\d+ /m.test(ot);
    const ob = MeshCore.parseOBJ(ot);
    out.objHasUv = !!ob.uvs;
    let md2 = 0;
    if(ob.uvs) for(let i=0;i<ob.uvs.length;i++) md2 = Math.max(md2, Math.abs(ob.uvs[i]-st.current.uvs[i]));
    out.objMaxDiff = md2;
  }catch(e){ window.__errs.push('verify:'+e.message); }

  // 关闭「保留 UV」→ 应按纯位置焊接，接缝合并、UV 丢弃
  try{
    out.vertsWithUV = window.__app.state.original.positions.length/3;
    document.getElementById('keepUV').checked = false;
    document.getElementById('keepUV').dispatchEvent(new Event('change'));
    await sleep(300);
    const o2 = window.__app.state.original;
    out.vertsNoUV = o2.positions.length/3;
    out.uvDropped = !o2.uvs;
    out.resultCleared = window.__app.state.current === null;
  }catch(e){ window.__errs.push('toggle:'+e.message); }

  out.errs = window.__errs;
  var d=document.createElement('div'); d.id='testout'; d.textContent=JSON.stringify(out);
  document.body.appendChild(d);
})();
</script>
`;
fs.writeFileSync('_test_uv.html', h.replace('</body>', '<style>*{transition:none !important}</style>' + test + '</body>'));

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = [
  '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--hide-scrollbars', '--window-size=1440,900', '--virtual-time-budget=40000',
  '--screenshot=' + process.cwd().replace(/\\/g, '/') + '/_shot_uv.png',
  '--dump-dom',
  'file:///' + process.cwd().replace(/\\/g, '/') + '/_test_uv.html'
];
let out = '';
try { out = execFileSync(edge, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); }
catch (e) { out = e.stdout || ''; }
const m = out.match(/<div id="testout">([^<]*)/);
console.log(m ? m[1] : '(未拿到结果)');
