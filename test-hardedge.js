/* 硬边保留测试：闭合立方体在极限压缩下是否还保持直角 */
const MC = require('./mesh-core.js');

// 半边长 0.5 的闭合立方体，每面 n×n 细分
function box(n) {
  const pos = [], idx = [];
  const faces = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  for (const f of faces) {
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const s = i / n - 0.5, t = j / n - 0.5;
      pos.push(
        0.5 * f.n[0] + f.u[0] * s + f.v[0] * t,
        0.5 * f.n[1] + f.u[1] * s + f.v[1] * t,
        0.5 * f.n[2] + f.u[2] * s + f.v[2] * t
      );
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = base + i * (n + 1) + j, b = a + n + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

(async () => {
  const { MeshoptSimplifier: S } = await import('./meshopt.mjs');
  await S.ready;
  await MC.initEngine(S);

  const m = box(40);
  const w = MC.weld(m.positions, m.indices);
  console.log('闭合立方体：源 ' + m.indices.length / 3 + ' 面 → 焊接后 ' +
    w.indices.length / 3 + ' 面 / ' + w.positions.length / 3 + ' 顶点（棱上重复点已合并）');

  for (const r of [0.2, 0.1, 0.05, 0.01]) {
    const res = MC.simplify(w, Math.round(w.indices.length / 3 * r), { maxDist: 1e9 });
    let mx = 0, sum = 0;
    const p = res.positions, n = p.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      // 到最近那个面的距离（|x|=|y|=|z|=0.5）
      const d = Math.min(
        Math.abs(Math.abs(p[i]) - 0.5),
        Math.abs(Math.abs(p[i + 1]) - 0.5),
        Math.abs(Math.abs(p[i + 2]) - 0.5)
      );
      sum += d; if (d > mx) mx = d;
    }
    console.log(`  ${(r * 100).toFixed(0)}% → ${res.stats.dstFaces} 面 | 顶点偏离立方体表面 均 ${(sum / n).toExponential(2)} 最大 ${mx.toExponential(2)}`);
  }
})();
