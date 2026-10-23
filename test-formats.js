const MC = require('./mesh-core.js');

// ascii PLY 四面体
const plyAscii = `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 4
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
0 0 1
3 0 1 2
3 0 1 3
3 0 2 3
3 1 2 3
`;
const a = MC.parsePLY(new TextEncoder().encode(plyAscii).buffer);
console.log('PLY ascii: 点', a.positions.length/3, '面', a.indices.length/3);

// binary little endian PLY
const nv = 4, nf = 4;
const buf = new ArrayBuffer(512);
const dv = new DataView(buf);
const head = 'ply\nformat binary_little_endian 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n';
for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
let o = head.length;
const V = [[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
for (const p of V) { dv.setFloat32(o,p[0],true); dv.setFloat32(o+4,p[1],true); dv.setFloat32(o+8,p[2],true); o += 12; }
const F = [[0,1,2],[0,1,3],[0,2,3],[1,2,3]];
for (const f of F) { dv.setUint8(o,f.length); o+=1; for(const i of f){dv.setInt32(o,i,true); o+=4;} }
const b = MC.parsePLY(buf.slice(0,o));
console.log('PLY binary: 点', b.positions.length/3, '面', b.indices.length/3);

// OFF
const off = `OFF
4 4 6
0 0 0
1 0 0
0 1 0
0 0 1
3 0 1 2
3 0 1 3
3 0 2 3
3 1 2 3
`;
const c = MC.parseOFF(off);
console.log('OFF: 点', c.positions.length/3, '面', c.indices.length/3);

// 误差阈值：球体上测试 maxDist 是否导致提前停止
function sphere(seg, rings) {
  const pos = [], idx = [];
  for (let r = 0; r <= rings; r++) { const phi = Math.PI*r/rings;
    for (let s = 0; s <= seg; s++) { const th = 2*Math.PI*s/seg;
      pos.push(Math.sin(phi)*Math.cos(th), Math.cos(phi), Math.sin(phi)*Math.sin(th)); } }
  for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
    const a0 = r*(seg+1)+s, b0 = a0+seg+1;
    idx.push(a0,b0,a0+1, b0,b0+1,a0+1); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
const s = sphere(80, 50);
const w = MC.weld(s.positions, s.indices);
const src = w.indices.length/3;
for (const th of [0, 0.001, 0.01, 0.05]) {
  const opts = { boundaryWeight: 8 };
  if (th > 0) opts.maxDist = th * 2; // 直径 2
  const r = MC.simplify(w, Math.round(src*0.02), opts);
  console.log(`误差上限 ${th}: 请求 ${Math.round(src*0.02)} 面 → 实得 ${r.stats.dstFaces} 面`);
}
