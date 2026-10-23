/* 等价性 + 质量验证
   1) 我的 simplify()（meshopt 引擎）是否与「按原站参数直接调用」逐索引一致
   2) 手写 QEM vs meshopt 在带 UV 的真实形状上的质量差距
*/
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

// 带凹凸的球（模拟真实扫描件的细节）
function bumpySphere(seg, rings) {
  const m = uvSphere(seg, rings);
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const n = 1 + 0.06 * Math.sin(x * 9) * Math.cos(y * 11) * Math.sin(z * 7)
      + 0.03 * Math.sin(x * 23 + y * 17);
    p[i] = x * n; p[i + 1] = y * n; p[i + 2] = z * n;
  }
  return m;
}

// 环面纽结（曲率变化大，QEM 容易翻车）
function torusKnot(tubSeg, radSeg, p = 2, q = 3) {
  const pos = [], uv = [], idx = [];
  const r = 0.28;
  const knot = (t) => {
    const ct = Math.cos(t), st = Math.sin(t);
    const qq = q / p;
    const rad = 2 + Math.cos(qq * t) * 1.0;
    return [rad * ct, rad * st, Math.sin(qq * t) * 1.0];
  };
  for (let i = 0; i <= tubSeg; i++) {
    const t = 2 * Math.PI * i / tubSeg;
    const c = knot(t), c2 = knot(t + 0.001);
    let tx = c2[0] - c[0], ty = c2[1] - c[1], tz = c2[2] - c[2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    // 构造法向标架
    let nx = -ty, ny = tx, nz = 0;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    let bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    for (let j = 0; j <= radSeg; j++) {
      const a = 2 * Math.PI * j / radSeg;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(
        c[0] + r * (ca * nx + sa * bx),
        c[1] + r * (ca * ny + sa * by),
        c[2] + r * (ca * nz + sa * bz)
      );
      uv.push(i / tubSeg, j / radSeg);
    }
  }
  for (let i = 0; i < tubSeg; i++) for (let j = 0; j < radSeg; j++) {
    const a = i * (radSeg + 1) + j, b = a + radSeg + 1;
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

// 顶点到原网格的距离（用顶点采样近似，够用于比较）
function vtxDeviation(srcPos, srcIdx, outPos, diag) {
  const nf = srcIdx.length / 3;
  let sum = 0, mx = 0, cnt = 0;
  const nOut = outPos.length / 3;
  const step = Math.max(1, Math.floor(nOut / 1500));   // 抽样，控制耗时
  for (let v = 0; v < nOut; v += step) {
    const px = outPos[v * 3], py = outPos[v * 3 + 1], pz = outPos[v * 3 + 2];
    let best = Infinity;
    for (let f = 0; f < nf; f++) {
      const i0 = srcIdx[f * 3], i1 = srcIdx[f * 3 + 1], i2 = srcIdx[f * 3 + 2];
      const d = ptTri(px, py, pz,
        srcPos[i0 * 3], srcPos[i0 * 3 + 1], srcPos[i0 * 3 + 2],
        srcPos[i1 * 3], srcPos[i1 * 3 + 1], srcPos[i1 * 3 + 2],
        srcPos[i2 * 3], srcPos[i2 * 3 + 1], srcPos[i2 * 3 + 2]);
      if (d < best) best = d;
    }
    const dd = Math.sqrt(best) / diag;
    sum += dd; if (dd > mx) mx = dd; cnt++;
  }
  return { mean: sum / cnt, max: mx };
}

function ptTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return (px - (ax + abx * v)) ** 2 + (py - (ay + aby * v)) ** 2 + (pz - (az + abz * v)) ** 2;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return (px - (ax + acx * w)) ** 2 + (py - (ay + acy * w)) ** 2 + (pz - (az + acz * w)) ** 2;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return (px - (bx + (cx - bx) * w)) ** 2 + (py - (by + (cy - by) * w)) ** 2 + (pz - (bz + (cz - bz) * w)) ** 2;
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return (px - (ax + abx * v + acx * w)) ** 2 + (py - (ay + aby * v + acy * w)) ** 2 + (pz - (az + abz * v + acz * w)) ** 2;
}

async function main() {
  const { MeshoptSimplifier: S } = await import('./meshopt.mjs');
  await S.ready;
  const ok = await MC.initEngine(S);
  console.log('引擎:', MC.engineName(), '(initEngine=' + ok + ')\n');

  const models = [
    { name: '凹凸球', m: bumpySphere(160, 80) },
    { name: '环面纽结', m: torusKnot(360, 60) },
  ];

  console.log('=== 1) 等价性：我的输出 vs 按原站参数直调 ===');
  let allSame = true;
  for (const { name, m } of models) {
    const w = MC.weld(m.positions, m.indices, m.uvs);
    const nIdx = w.indices.length;
    for (const ratio of [0.5, 0.2, 0.1]) {
      // 原站：floor(ratio * renderCount / 3) * 3
      const targetIdx = Math.floor(ratio * nIdx / 3) * 3;
      const [ref] = S.simplify(w.indices, w.positions, 3, targetIdx, 0.01, []);
      const mine = MC.simplify(w, targetIdx / 3, { maxDist: 0.01 });
      let same = ref.length === mine.indices.length;
      if (same) {
        const remap = new Map();
        let n = 0;
        for (let i = 0; i < mine.indices.length; i++) {
          const o = ref[i];
          if (!remap.has(o)) remap.set(o, n++);
          if (remap.get(o) !== mine.indices[i]) { same = false; break; }
        }
      }
      if (!same) allSame = false;
      console.log(`  ${name} ${(ratio * 100)}%: 参考 ${ref.length / 3} 面 / 我的 ${mine.indices.length / 3} 面 → ${same ? '逐索引一致 ✓' : '不一致 ✗'}`);
    }
  }
  console.log(allSame ? '  >>> 完全一致\n' : '  >>> 存在差异\n');

  console.log('=== 2) 质量：手写 QEM vs meshoptimizer（10%） ===');
  for (const { name, m } of models) {
    const w = MC.weld(m.positions, m.indices, m.uvs);
    const diag = diagOf(w.positions);
    const src = w.indices.length / 3;
    const target = Math.round(src * 0.1);
    const q = MC.simplifyQEM(w, target, { boundaryWeight: 8 });
    const mo = MC.simplify(w, target, { maxDist: 1e9 });
    const dq = vtxDeviation(w.positions, w.indices, q.positions, diag);
    const dm = vtxDeviation(w.positions, w.indices, mo.positions, diag);
    console.log(`  ${name} 源 ${src} 面 → 目标 ${target}`);
    console.log(`    手写QEM      ${q.stats.dstFaces} 面 | 偏差 均 ${(dq.mean * 100).toExponential(2)}% 最大 ${(dq.max * 100).toExponential(2)}%`);
    console.log(`    meshoptimizer ${mo.stats.dstFaces} 面 | 偏差 均 ${(dm.mean * 100).toExponential(2)}% 最大 ${(dm.max * 100).toExponential(2)}%`);
    console.log(`    → 平均偏差降低 ${((1 - dm.mean / dq.mean) * 100).toFixed(1)}%`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
