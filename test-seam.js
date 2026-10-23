/* 接缝裂开检测：位置相同但 UV 不同的顶点对，简化后是否还贴合 */
const MC = require('./mesh-core.js');

function uvSphere(seg, rings) {
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    for (let s = 0; s <= seg; s++) {
      const th = 2 * Math.PI * s / seg;
      pos.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      uv.push(s / seg, r / rings);
    }
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
    const a = r * (seg + 1) + s, b = a + seg + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx) };
}

function diagOf(p) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k] < mn[k]) mn[k] = p[i + k];
    if (p[i + k] > mx[k]) mx[k] = p[i + k];
  }
  return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
}

// 把位置量化分组，返回组内最大间距 / 对角线
function seamGap(pos, diag) {
  const qs = 1 / (diag * 1e-5);
  const map = new Map();
  for (let i = 0; i < pos.length / 3; i++) {
    const k = Math.round(pos[i * 3] * qs) + ',' + Math.round(pos[i * 3 + 1] * qs) + ',' + Math.round(pos[i * 3 + 2] * qs);
    let a = map.get(k);
    if (!a) { a = []; map.set(k, a); }
    a.push(i);
  }
  let worst = 0, groups = 0, pairs = 0;
  for (const a of map.values()) {
    if (a.length < 2) continue;
    groups++;
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      pairs++;
      const d = Math.hypot(
        pos[a[i] * 3] - pos[a[j] * 3],
        pos[a[i] * 3 + 1] - pos[a[j] * 3 + 1],
        pos[a[i] * 3 + 2] - pos[a[j] * 3 + 2]
      ) / diag;
      if (d > worst) worst = d;
    }
  }
  return { worst, groups, pairs };
}

async function main() {
  const { MeshoptSimplifier: S } = await import('./meshopt.mjs');
  await S.ready;

  const m = uvSphere(96, 48);
  const w = MC.weld(m.positions, m.indices, m.uvs);
  const diag = diagOf(w.positions);
  console.log('焊接后: ' + w.indices.length / 3 + ' 面, ' + w.positions.length / 3 + ' 顶点, UV=' + (w.uvs ? w.uvs.length / 2 : 0));
  const g0 = seamGap(w.positions, diag);
  console.log('  简化前接缝组: ' + g0.groups + ' 组 / ' + g0.pairs + ' 对, 最大间距 ' + (g0.worst * 100).toFixed(4) + '%');

  const srcFaces = w.indices.length / 3;
  for (const ratio of [0.2, 0.1, 0.05]) {
    const target = Math.round(srcFaces * ratio);
    const [idx, err] = S.simplify(w.indices, w.positions, 3, target * 3, 1e9, []);
    const g = seamGap(w.positions, diag);
    console.log(`  简化到 ${(ratio * 100)}% (${idx.length / 3} 面, err=${err.toExponential(2)}): 接缝 ${g.groups} 组, 最大间距 ${(g.worst * 100).toFixed(3)}% ${g.worst > 1e-4 ? '  <<< 有裂缝' : '  贴合'}`);
  }

  // 对照：LockBorder 标志
  console.log('\n-- 加 LockBorder --');
  for (const ratio of [0.1]) {
    const target = Math.round(srcFaces * ratio);
    const [idx, err] = S.simplify(w.indices, w.positions, 3, target * 3, 1e9, ['LockBorder']);
    const g = seamGap(w.positions, diag);
    console.log(`  ${idx.length / 3} 面, 接缝最大间距 ${(g.worst * 100).toFixed(3)}%`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
