// 生成无头测试页并运行（开发自检用）
const fs = require('fs');
const { execFileSync } = require('child_process');

let h = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const test = `
<script>
window.__errs=[];
window.onerror=function(m,s,l,c,e){window.__errs.push(String(m));};
function makeSphereOBJ(seg,rings){
  const L=[]; const V=[];
  for(let r=0;r<=rings;r++){const phi=Math.PI*r/rings;
    for(let s=0;s<=seg;s++){const th=2*Math.PI*s/seg;
      V.push([Math.sin(phi)*Math.cos(th),Math.cos(phi),Math.sin(phi)*Math.sin(th)]);}}
  V.forEach(p=>L.push('v '+p[0].toFixed(6)+' '+p[1].toFixed(6)+' '+p[2].toFixed(6)));
  for(let r=0;r<rings;r++)for(let s=0;s<seg;s++){
    const a=r*(seg+1)+s+1,b=a+seg+1;
    L.push('f '+a+' '+b+' '+(a+1));
    L.push('f '+b+' '+(b+1)+' '+(a+1));}
  return L.join('\\n');
}
setTimeout(function(){
  try{
    const obj=makeSphereOBJ(90,60);
    const file=new File([obj],'test-sphere.obj',{type:'text/plain'});
    const dt=new DataTransfer(); dt.items.add(file);
    const fi=document.getElementById('file');
    fi.files=dt.files;
    fi.dispatchEvent(new Event('change'));
  }catch(e){ window.__errs.push('load:'+e.message); }
},300);
setTimeout(function(){ try{document.getElementById('run').click();}catch(e){window.__errs.push('run:'+e.message);} },2500);
setTimeout(function(){
  var r={errs:window.__errs,
    src:document.getElementById('saF').textContent,
    dst:document.getElementById('sbF').textContent,
    red:document.getElementById('sbR').textContent,
    toast:document.getElementById('toast').textContent,
    expDisabled:document.getElementById('expGLB').disabled,
    gl2:!!document.createElement('canvas').getContext('webgl2')};
  document.title='RESULT:'+JSON.stringify(r);
  var d=document.createElement('div'); d.id='testout'; d.textContent=JSON.stringify(r);
  document.body.appendChild(d);
},6000);
</script>
`;
h = h.replace('</body>', test + '</body>');
fs.writeFileSync('_test.html', h);

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = [
  '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--hide-scrollbars', '--window-size=1500,950', '--virtual-time-budget=10000',
  '--screenshot=' + process.cwd().replace(/\\/g, '/') + '/_shot.png',
  '--dump-dom',
  'file:///' + process.cwd().replace(/\\/g, '/') + '/_test.html'
];
let out = '';
try {
  out = execFileSync(edge, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
} catch (e) { out = e.stdout || ''; }
const m = out.match(/<div id="testout">([^<]*)/);
console.log(m ? m[1] : '(未拿到测试结果，可能页面脚本报错)');
