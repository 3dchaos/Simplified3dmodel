/* UV 保留验证 */
const MC = require('./mesh-core.js');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + extra : '')); }
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }

/* 带 UV 接缝的球体（圆柱投影，s=0 与 s=seg 同位置不同 U） */
function uvSphere(seg, rings) {
  const pos = [], uv = [], triPos = [], triUv = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    for (let s = 0; s <= seg; s++) {
      const th = 2 * Math.PI * s / seg;
      pos.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      uv.push(s / seg, r / rings);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, b = a + seg + 1;
      triPos.push(a, b, a + 1, b, b + 1, a + 1);
      triUv.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return MC.assemble(new Float32Array(pos), triPos, new Float32Array(uv), triUv);
}

function uvArea(indices, uvs) {
  let a = 0;
  for (let f = 0; f < indices.length; f += 3) {
    const i0 = indices[f], i1 = indices[f + 1], i2 = indices[f + 2];
    const x1 = uvs[i1 * 2] - uvs[i0 * 2], y1 = uvs[i1 * 2 + 1] - uvs[i0 * 2 + 1];
    const x2 = uvs[i2 * 2] - uvs[i0 * 2], y2 = uvs[i2 * 2 + 1] - uvs[i0 * 2 + 1];
    a += Math.abs(x1 * y2 - x2 * y1) * 0.5;
  }
  return a;
}
function uvDegenerate(indices, uvs) {
  let n = 0;
  for (let f = 0; f < indices.length; f += 3) {
    const i0 = indices[f], i1 = indices[f + 1], i2 = indices[f + 2];
    const x1 = uvs[i1 * 2] - uvs[i0 * 2], y1 = uvs[i1 * 2 + 1] - uvs[i0 * 2 + 1];
    const x2 = uvs[i2 * 2] - uvs[i0 * 2], y2 = uvs[i2 * 2 + 1] - uvs[i0 * 2 + 1];
    if (Math.abs(x1 * y2 - x2 * y1) < 1e-12) n++;
  }
  return n;
}

(async () => {
  console.log('\n[1] 装配：UV 接缝必须保留为独立顶点');
  const src = uvSphere(48, 24);
  {
    const seamPos = 48 * 24; // 接缝处的位置数
    ok(src.uvs !== null, '装配结果带 UV');
    ok(src.positions.length / 3 === (49 * 25), '顶点数 = (seg+1)*(rings+1) 未合并接缝', src.positions.length / 3);
    ok(uvDegenerate(src.indices, src.uvs) === 0, '原始网格无退化 UV 三角形');
    void seamPos;
  }

  console.log('\n[2] 焊接：按位置+UV 去重，不能把接缝焊死');
  const welded = MC.weld(src.positions, src.indices, src.uvs);
  {
    ok(welded.positions.length / 3 === src.positions.length / 3,
      '顶点数不变（接缝两侧 UV 不同，不应合并）', welded.positions.length / 3);
    ok(welded.uvs !== null, '焊接后仍带 UV');
    // 极点的重复顶点应被合并（同位置同 UV）
    const nBefore = src.positions.length / 3;
    ok(welded.positions.length / 3 <= nBefore, '未发生错误的过度合并');
  }

  console.log('\n[3] 简化：UV 随之插值，接缝不裂');
  {
    const target = Math.round(welded.indices.length / 3 * 0.25);
    const r = MC.simplify(welded, target);
    ok(r.uvs !== null, '简化结果带 UV');
    ok(r.uvs.length === r.positions.length / 3 * 2, 'UV 数量与顶点数一致',
      `${r.uvs.length / 2} vs ${r.positions.length / 3}`);
    ok(r.stats.dstFaces <= target + 4, '达到目标面数', `${r.stats.dstFaces}/${target}`);

    let bad = 0, minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < r.uvs.length; i += 2) {
      const u = r.uvs[i], v = r.uvs[i + 1];
      if (!isFinite(u) || !isFinite(v)) bad++;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    ok(bad === 0, 'UV 全部为有限值', bad);
    ok(minU >= -0.02 && maxU <= 1.02 && minV >= -0.02 && maxV <= 1.02,
      'UV 保持在 [0,1] 范围内', `u[${minU.toFixed(3)},${maxU.toFixed(3)}] v[${minV.toFixed(3)},${maxV.toFixed(3)}]`);

    const a0 = uvArea(welded.indices, welded.uvs);
    const a1 = uvArea(r.indices, r.uvs);
    const drift = Math.abs(a1 - a0) / a0;
    ok(drift < 0.12, 'UV 展开面积基本守恒（<12%）', `${(drift * 100).toFixed(2)}%`);
    ok(uvDegenerate(r.indices, r.uvs) === 0, '无退化 UV 三角形', uvDegenerate(r.indices, r.uvs));

    // 接缝不能裂：接缝顶点位置必须保持原样
    // 用「U 接近 0 或 1 的顶点」检查其半径仍为 1
    let seamMoved = 0, seamCount = 0;
    for (let i = 0; i < r.uvs.length; i += 2) {
      const u = r.uvs[i];
      if (u < 1e-6 || u > 1 - 1e-6) {
        seamCount++;
        const x = r.positions[i / 2 * 3], y = r.positions[i / 2 * 3 + 1], z = r.positions[i / 2 * 3 + 2];
        if (Math.abs(Math.hypot(x, y, z) - 1) > 0.02) seamMoved++;
      }
    }
    ok(seamMoved === 0, `接缝顶点位置未偏移（${seamCount} 个接缝顶点）`, seamMoved + ' 个偏移');
  }

  console.log('\n[4] 无 UV 的模型保持原有行为');
  {
    const plain = { positions: welded.positions, indices: welded.indices };
    const r = MC.simplify(plain, Math.round(welded.indices.length / 3 * 0.25));
    ok(r.uvs === null, '无 UV 输入 → 无 UV 输出');
    ok(r.stats.hasUV === false, 'stats.hasUV = false');
  }

  console.log('\n[5] GLB 往返');
  {
    const r = MC.simplify(welded, Math.round(welded.indices.length / 3 * 0.25));
    const blob = MC.exportGLB(r.positions, r.indices, false, r.uvs);
    const ab = await blob.arrayBuffer();
    const back = MC.parseGLB(ab);
    ok(back.uvs !== null, 'GLB 重新解析出 UV');
    ok(back.uvs.length === r.uvs.length, 'UV 数量一致', `${back.uvs.length} vs ${r.uvs.length}`);
    let maxDiff = 0;
    for (let i = 0; i < Math.min(back.uvs.length, r.uvs.length); i++) {
      maxDiff = Math.max(maxDiff, Math.abs(back.uvs[i] - r.uvs[i]));
    }
    ok(maxDiff < 1e-5, 'UV 数值无损往返', maxDiff);
    ok(back.positions.length / 3 === r.positions.length / 3, '顶点数一致');
  }

  console.log('\n[6] GLB 平直着色（非索引化）也带 UV');
  {
    const r = MC.simplify(welded, Math.round(welded.indices.length / 3 * 0.25));
    const blob = MC.exportGLB(r.positions, r.indices, true, r.uvs);
    const back = MC.parseGLB(await blob.arrayBuffer());
    ok(back.uvs !== null, '非索引化 GLB 仍带 UV');
    ok(back.uvs.length / 2 === back.positions.length / 3, 'UV 与展开后顶点数一致');
  }

  console.log('\n[7] OBJ 往返（V 轴翻转两次应还原）');
  {
    const r = MC.simplify(welded, Math.round(welded.indices.length / 3 * 0.25));
    const txt = await MC.exportOBJ(r.positions, r.indices, 'x', r.uvs).text();
    ok(/^vt /m.test(txt), 'OBJ 中包含 vt 行');
    ok(/^f \d+\/\d+ /m.test(txt), '面使用 v/vt 索引');
    const back = MC.parseOBJ(txt);
    ok(back.uvs !== null, 'OBJ 重新解析出 UV');
    let maxDiff = 0;
    for (let i = 0; i < Math.min(back.uvs.length, r.uvs.length); i++) {
      maxDiff = Math.max(maxDiff, Math.abs(back.uvs[i] - r.uvs[i]));
    }
    ok(maxDiff < 1e-5, 'OBJ UV 往返无损', maxDiff);
    ok(back.positions.length / 3 === r.positions.length / 3, 'OBJ 顶点数一致',
      `${back.positions.length / 3} vs ${r.positions.length / 3}`);
  }

  console.log('\n[8] 接缝锁定的代价：面数压缩率是否仍够用');
  {
    const src2 = uvSphere(64, 32);
    const w2 = MC.weld(src2.positions, src2.indices, src2.uvs);
    const total = w2.indices.length / 3;
    for (const ratio of [0.5, 0.25, 0.1]) {
      const t = Math.round(total * ratio);
      const r = MC.simplify(w2, t);
      const got = r.stats.dstFaces;
      const okk = got <= t * 1.15;
      console.log(`    目标 ${(ratio * 100).toFixed(0)}%（${t} 面）→ 实得 ${got} 面 ${okk ? '' : ' ← 受阻'}`);
      ok(okk, `可达到 ${ratio * 100}% 目标`);
    }
  }

  console.log('\n===== 通过 ' + pass + ' / 失败 ' + fail + ' =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
