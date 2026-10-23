const MC = require('./mesh-core.js');

// ---- 造一个 UV 球，约 40k 面 ----
function sphere(seg, rings) {
  const pos = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    for (let s = 0; s <= seg; s++) {
      const th = 2 * Math.PI * s / seg;
      pos.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

const s = sphere(160, 80);
console.log('原始: verts=%d faces=%d', s.positions.length / 3, s.indices.length / 3);

const w = MC.weld(s.positions, s.indices);
console.log('焊接后: verts=%d faces=%d', w.positions.length / 3, w.indices.length / 3);

for (const ratio of [0.5, 0.1, 0.02]) {
  const target = Math.round((s.indices.length / 3) * ratio);
  const r = MC.simplify(w, target);
  // 检查：所有顶点是否仍在单位球附近（半径偏差）
  let maxDev = 0, bad = 0;
  for (let i = 0; i < r.positions.length; i += 3) {
    const d = Math.hypot(r.positions[i], r.positions[i + 1], r.positions[i + 2]);
    maxDev = Math.max(maxDev, Math.abs(d - 1));
    if (!isFinite(d)) bad++;
  }
  // 退化面检查
  let degen = 0;
  for (let f = 0; f < r.indices.length; f += 3) {
    if (r.indices[f] === r.indices[f + 1] || r.indices[f + 1] === r.indices[f + 2] || r.indices[f] === r.indices[f + 2]) degen++;
  }
  // 欧拉特征（球应为 2）
  const E = new Set();
  for (let f = 0; f < r.indices.length; f += 3) {
    const a = r.indices[f], b = r.indices[f + 1], c = r.indices[f + 2];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) E.add(x < y ? x + ',' + y : y + ',' + x);
  }
  const chi = r.stats.dstVerts - E.size + r.stats.dstFaces;
  console.log(
    `目标 ${ratio * 100}%: 面 ${r.stats.dstFaces}/${r.stats.srcFaces} 点 ${r.stats.dstVerts} ` +
    `耗时 ${r.stats.ms}ms 半径最大偏差 ${maxDev.toFixed(4)} 退化面 ${degen} NaN ${bad} 欧拉特征 ${chi}`
  );
}

// ---- 格式往返测试 ----
const stl = MC.exportSTL(w.positions, w.indices);
const obj = MC.exportOBJ(w.positions, w.indices, 'test');
const glb = MC.exportGLB(w.positions, w.indices, false);
Promise.all([stl.arrayBuffer(), obj.text(), glb.arrayBuffer()]).then(([stlBuf, objTxt, glbBuf]) => {
  const a = MC.parseSTL(stlBuf);
  const b = MC.parseOBJ(objTxt);
  const c = MC.parseGLB(glbBuf);
  console.log('STL 往返: %d 面 (期望 %d)', a.positions.length / 9, w.indices.length / 3);
  console.log('OBJ 往返: %d 面 (期望 %d)', b.indices.length / 3, w.indices.length / 3);
  console.log('GLB 往返: %d 面 (期望 %d) 点 %d', c.indices.length / 3, w.indices.length / 3, c.positions.length / 3);
  console.log('GLB 字节:', glbBuf.byteLength);
});
