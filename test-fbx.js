/* FBX 解析验证：手工构造二进制/ASCII FBX，比对几何与变换 */
const MC = require('./mesh-core.js');
const zlib = require('zlib');

/* ---------------- 最小二进制 FBX 写出器 ---------------- */
function encodeProp(v) {
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'latin1');
    const h = Buffer.alloc(5); h.write('S', 0, 'latin1'); h.writeUInt32LE(b.length, 1);
    return Buffer.concat([h, b]);
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 2147483647) {
      const b = Buffer.alloc(5); b.write('I', 0, 'latin1'); b.writeInt32LE(v, 1); return b;
    }
    const b = Buffer.alloc(9); b.write('D', 0, 'latin1'); b.writeDoubleLE(v, 1); return b;
  }
  if (v && v.__arr) {
    const { type, data, compress } = v;
    let raw;
    if (type === 'd') { raw = Buffer.alloc(data.length * 8); data.forEach((x, i) => raw.writeDoubleLE(x, i * 8)); }
    else { raw = Buffer.alloc(data.length * 4); data.forEach((x, i) => raw.writeInt32LE(x, i * 4)); }
    const payload = compress ? zlib.deflateSync(raw) : raw;
    const h = Buffer.alloc(13);
    h.write(type, 0, 'latin1');
    h.writeUInt32LE(data.length, 1);
    h.writeUInt32LE(compress ? 1 : 0, 5);
    h.writeUInt32LE(payload.length, 9);
    return Buffer.concat([h, payload]);
  }
  throw new Error('无法编码的属性: ' + v);
}

function buildRec(node, absOffset, wide) {
  const HEAD = wide ? 25 : 13;
  const nameBuf = Buffer.from(node.name, 'latin1');
  const propsBuf = Buffer.concat((node.props || []).map(encodeProp));
  const kids = node.children || [];
  const childBufs = [];
  let off = absOffset + HEAD + nameBuf.length + propsBuf.length;
  for (const c of kids) {
    const b = buildRec(c, off, wide);
    childBufs.push(b);
    off += b.length;
  }
  const total = HEAD + nameBuf.length + propsBuf.length +
    childBufs.reduce((s, b) => s + b.length, 0) + (kids.length ? HEAD : 0);
  const head = Buffer.alloc(HEAD);
  if (wide) {
    head.writeBigUInt64LE(BigInt(absOffset + total), 0);
    head.writeBigUInt64LE(BigInt((node.props || []).length), 8);
    head.writeBigUInt64LE(BigInt(propsBuf.length), 16);
    head.writeUInt8(nameBuf.length, 24);
  } else {
    head.writeUInt32LE(absOffset + total, 0);
    head.writeUInt32LE((node.props || []).length, 4);
    head.writeUInt32LE(propsBuf.length, 8);
    head.writeUInt8(nameBuf.length, 12);
  }
  const parts = [head, nameBuf, propsBuf, ...childBufs];
  if (kids.length) parts.push(Buffer.alloc(HEAD));
  return Buffer.concat(parts);
}

function writeFBX(topRecords, version) {
  const magic = Buffer.concat([
    Buffer.from('Kaydara FBX Binary  ', 'latin1'),
    Buffer.from([0x00, 0x1a, 0x00])
  ]);
  const ver = Buffer.alloc(4); ver.writeUInt32LE(version || 7400, 0);
  const wide = (version || 7400) >= 7500;
  const HEAD = wide ? 25 : 13;
  const parts = [magic, ver];
  let off = 27;
  for (const r of topRecords) {
    const b = buildRec(r, off, wide);
    parts.push(b);
    off += b.length;
  }
  parts.push(Buffer.alloc(HEAD));
  return Buffer.concat(parts);
}

/* ---------------- 测试数据：立方体 ---------------- */
const CUBE_V = [
  0,0,0, 1,0,0, 1,1,0, 0,1,0,
  0,0,1, 1,0,1, 1,1,1, 0,1,1
];
const CUBE_P = [
  0,1,2,-4,   4,7,6,-6,   0,3,7,-5,
  1,5,6,-3,   0,4,5,-2,   3,2,6,-8
];

function makeFBX(opts) {
  const compress = !!(opts && opts.compress);
  const translate = (opts && opts.translate) || [0, 0, 0];
  const rotate = (opts && opts.rotate) || [0, 0, 0];
  const version = (opts && opts.version) || 7400;

  const p70 = {
    name: 'Properties70',
    props: [],
    children: [
      { name: 'P', props: ['Lcl Translation', 'Lcl Translation', '', 'A', translate[0], translate[1], translate[2]], children: [] },
      { name: 'P', props: ['Lcl Rotation', 'Lcl Rotation', '', 'A', rotate[0], rotate[1], rotate[2]], children: [] },
      { name: 'P', props: ['Lcl Scaling', 'Lcl Scaling', '', 'A', 1, 1, 1], children: [] }
    ]
  };

  return writeFBX([
    {
      name: 'FBXHeaderExtension', props: [], children: [
        { name: 'FBXHeaderVersion', props: [1003], children: [] },
        { name: 'FBXVersion', props: [version], children: [] }
      ]
    },
    {
      name: 'Objects', props: [], children: [
        {
          name: 'Geometry', props: [1001, 'Geometry::Cube', 'Mesh'], children: [
            { name: 'Vertices', props: [{ __arr: true, type: 'd', data: CUBE_V, compress }], children: [] },
            { name: 'PolygonVertexIndex', props: [{ __arr: true, type: 'i', data: CUBE_P, compress }], children: [] }
          ]
        },
        { name: 'Model', props: [2001, 'Model::Cube', 'Mesh'], children: [p70] }
      ]
    },
    {
      name: 'Connections', props: [], children: [
        { name: 'C', props: ['OO', 1001, 2001], children: [] },
        { name: 'C', props: ['OO', 2001, 0], children: [] }
      ]
    }
  ], version);
}

/* ---------------- ASCII FBX ---------------- */
const ASCII_FBX = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
}
Objects:  {
	Geometry: 1001, "Geometry::Cube", "Mesh" {
		Vertices: *24 {
			a: 0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1
		}
		PolygonVertexIndex: *24 {
			a: 0,1,2,-4,4,7,6,-6,0,3,7,-5,1,5,6,-3,0,4,5,-2,3,2,6,-8
		}
	}
	Model: 2001, "Model::Cube", "Mesh" {
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",10,0,0
			P: "Lcl Rotation", "Lcl Rotation", "", "A",0,90,0
		}
	}
}
Connections:  {
	C: "OO",1001,2001
	C: "OO",2001,0
}
`;

function toAB(buf){ return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }

/* ---------------- 断言工具 ---------------- */
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + extra : '')); }
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }

/* ---------------- 跑测试 ---------------- */
(async () => {
  console.log('\n[1] 二进制 FBX，未压缩，无变换');
  {
    const m = await MC.parseFBX(toAB(makeFBX({ compress: false })));
    ok(m.positions.length / 3 === 8, '顶点数 8', m.positions.length / 3);
    ok(m.indices.length / 3 === 12, '6 个四边面 → 12 三角形', m.indices.length / 3);
    ok(approx(m.positions[3], 1) && approx(m.positions[4], 0), 'v1 坐标 (1,0,0)',
      [m.positions[3], m.positions[4], m.positions[5]].join(','));
  }

  console.log('\n[2] 二进制 FBX，zlib 压缩数组');
  {
    const m = await MC.parseFBX(toAB(makeFBX({ compress: true })));
    ok(m.positions.length / 3 === 8, '顶点数 8', m.positions.length / 3);
    ok(m.indices.length / 3 === 12, '面数 12', m.indices.length / 3);
  }

  console.log('\n[3] 二进制 FBX，Lcl Translation(10,0,0) + Lcl Rotation(0,90,0)');
  {
    const m = await MC.parseFBX(toAB(makeFBX({ translate: [10, 0, 0], rotate: [0, 90, 0] })));
    // v1 (1,0,0) 绕 Y 转 90° → (0,0,-1)，再平移 → (10,0,-1)
    const i = 1 * 3;
    ok(approx(m.positions[i], 10, 1e-5) && approx(m.positions[i + 1], 0, 1e-5) && approx(m.positions[i + 2], -1, 1e-5),
      'v1 变换后 = (10, 0, -1)',
      [m.positions[i], m.positions[i + 1], m.positions[i + 2]].map(x => x.toFixed(3)).join(','));
    // 原点顶点 → (10,0,0)
    ok(approx(m.positions[0], 10, 1e-5) && approx(m.positions[2], 0, 1e-5), 'v0 变换后 = (10, 0, 0)',
      [m.positions[0], m.positions[1], m.positions[2]].map(x => x.toFixed(3)).join(','));
  }

  console.log('\n[4] FBX 7500（64 位偏移）');
  {
    const m = await MC.parseFBX(toAB(makeFBX({ version: 7500, compress: true, translate: [10, 0, 0], rotate: [0, 90, 0] })));
    ok(m.positions.length / 3 === 8, '顶点数 8', m.positions.length / 3);
    ok(m.indices.length / 3 === 12, '面数 12', m.indices.length / 3);
    const i = 1 * 3;
    ok(approx(m.positions[i], 10, 1e-5) && approx(m.positions[i + 2], -1, 1e-5),
      '64 位偏移 + 压缩 + 变换 全部生效', [m.positions[i], m.positions[i + 2]].map(x => x.toFixed(3)).join(','));
  }

  console.log('\n[5] ASCII FBX');
  {
    const buf = Buffer.from(ASCII_FBX, 'utf8');
    const m = await MC.parseFBX(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    ok(m.positions.length / 3 === 8, '顶点数 8', m.positions.length / 3);
    ok(m.indices.length / 3 === 12, '面数 12', m.indices.length / 3);
    const i = 1 * 3;
    ok(approx(m.positions[i], 10, 1e-5) && approx(m.positions[i + 2], -1, 1e-5),
      'ASCII 变换生效 v1=(10,0,-1)',
      [m.positions[i], m.positions[i + 1], m.positions[i + 2]].map(x => x.toFixed(3)).join(','));
  }

  console.log('\n[6] loadBuffer 按扩展名路由 + 后续简化');
  {
    const buf = makeFBX({ compress: true, translate: [5, 5, 5] });
    const mesh = await MC.loadBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'cube.fbx');
    ok(mesh.indices.length / 3 === 12, 'loadBuffer 解析出 12 面', mesh.indices.length / 3);
    ok(mesh.name === 'cube', '模型名取自文件名', mesh.name);
    const r = MC.simplify(mesh, 6);
    ok(r.stats.dstFaces <= 12 && r.stats.dstFaces >= 4, '可继续简化', r.stats.dstFaces);
  }

  console.log('\n[7] 错误处理');
  {
    let err = null;
    try { await MC.parseFBX(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]).buffer); }
    catch (e) { err = e.message; }
    ok(err !== null, '无效文件抛出明确错误', err);
  }

  console.log('\n===== 通过 ' + pass + ' / 失败 ' + fail + ' =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
