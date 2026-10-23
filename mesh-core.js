/* ============================================================
   mesh-core.js — 纯 JS 三维网格核心：解析 / 焊接 / QEM 简化 / 导出
   零依赖，浏览器与 Node 通用。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeshCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 几何容器 ---------------- */
  function emptyMesh() {
    return { positions: new Float32Array(0), indices: new Uint32Array(0), name: 'mesh' };
  }

  /* ---------------- STL ---------------- */
  function parseSTL(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (n > 0 && buf.byteLength >= 84 + n * 50 && buf.byteLength <= 84 + n * 50 + 8) {
        const pos = new Float32Array(n * 9);
        let o = 84;
        for (let i = 0; i < n; i++) {
          o += 12;
          for (let k = 0; k < 3; k++) {
            pos[i * 9 + k * 3 + 0] = dv.getFloat32(o, true);
            pos[i * 9 + k * 3 + 1] = dv.getFloat32(o + 4, true);
            pos[i * 9 + k * 3 + 2] = dv.getFloat32(o + 8, true);
            o += 12;
          }
          o += 2;
        }
        return { positions: pos, indices: null, name: 'model' };
      }
    }
    return parseAsciiSTL(new TextDecoder().decode(buf));
  }

  function parseAsciiSTL(txt) {
    const out = [];
    const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      out.push(+m[1], +m[2], +m[3]);
    }
    if (out.length < 9) throw new Error('无法识别的 STL 文件（既非二进制也非 ASCII）');
    return { positions: new Float32Array(out.slice(0, out.length - (out.length % 9))), indices: null, name: 'model' };
  }

  /* ---------------- OBJ ---------------- */
  function parseOBJ(txt) {
    const vs = [];
    const vts = [];
    const triPos = [];
    const triUv = [];
    let uvOk = true;
    const lines = txt.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.length === 0) continue;
      const c0 = line.charCodeAt(0);
      if (c0 === 118 /* v */) {
        const c1 = line.charCodeAt(1);
        if (c1 === 32 || c1 === 9) {
          const p = line.trim().split(/\s+/);
          vs.push(+p[1], +p[2], +p[3]);
        } else if (c1 === 116 /* t */ && (line.charCodeAt(2) === 32 || line.charCodeAt(2) === 9)) {
          const p = line.trim().split(/\s+/);
          // OBJ 的 V 轴原点在左下，内部统一转成 glTF 约定（原点左上）
          vts.push(+p[1], 1 - (+p[2] || 0));
        }
      } else if (c0 === 102 /* f */) {
        if (line.charCodeAt(1) !== 32 && line.charCodeAt(1) !== 9) continue;
        const p = line.trim().split(/\s+/);
        const idx = [];
        const uvi = [];
        for (let i = 1; i < p.length; i++) {
          const parts = p[i].split('/');
          let n = parseInt(parts[0], 10);
          if (isNaN(n)) continue;
          if (n < 0) n = vs.length / 3 + n; else n = n - 1;
          idx.push(n);
          if (parts.length > 1 && parts[1] !== '') {
            let t = parseInt(parts[1], 10);
            if (isNaN(t)) { uvi.push(0); uvOk = false; }
            else { if (t < 0) t = vts.length / 2 + t; else t = t - 1; uvi.push(t); }
          } else { uvi.push(0); uvOk = false; }
        }
        for (let i = 2; i < idx.length; i++) {
          triPos.push(idx[0], idx[i - 1], idx[i]);
          triUv.push(uvi[0], uvi[i - 1], uvi[i]);
        }
      }
    }
    if (vs.length === 0 || triPos.length === 0) throw new Error('OBJ 中未找到顶点或面');
    const useUV = uvOk && vts.length > 0;
    const r = assemble(new Float32Array(vs), triPos, useUV ? new Float32Array(vts) : null, useUV ? triUv : null);
    r.name = 'model';
    return r;
  }

  /* ---------------- GLB / glTF(binary) ---------------- */
  function parseGLB(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是合法的 GLB 文件');
    const total = dv.getUint32(8, true);
    let o = 12, json = null, bin = null;
    while (o < total) {
      const len = dv.getUint32(o, true);
      const type = dv.getUint32(o + 4, true);
      const body = new Uint8Array(buf, o + 8, len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
      else if (type === 0x004e4942) bin = body;
      o += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new Error('GLB 缺少 JSON 段');
    if (!bin) throw new Error('GLB 缺少二进制段（外部 .bin 引用暂不支持，请用 .glb）');

    const allPos = [];
    const allIdx = [];
    const allUv = [];
    let uvSeen = 0;
    let base = 0;

    const readAccessor = (ai) => {
      const acc = json.accessors[ai];
      const bv = json.bufferViews[acc.bufferView];
      const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
      const numComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
      const stride = bv.byteStride || compSize * numComp;
      const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const out = new Float64Array(acc.count * numComp);
      const sub = new DataView(buf, bin.byteOffset + off, acc.count * stride);
      for (let i = 0; i < acc.count; i++) {
        for (let c = 0; c < numComp; c++) {
          const p = i * stride + c * compSize;
          let v;
          switch (acc.componentType) {
            case 5126: v = sub.getFloat32(p, true); break;
            case 5125: v = sub.getUint32(p, true); break;
            case 5123: v = sub.getUint16(p, true); break;
            case 5122: v = sub.getInt16(p, true); break;
            case 5121: v = sub.getUint8(p); break;
            case 5120: v = sub.getInt8(p); break;
            default: v = 0;
          }
          out[i * numComp + c] = v;
        }
      }
      return { data: out, numComp, normalized: !!acc.normalized, componentType: acc.componentType };
    };

    // 矩阵工具
    const mul = (A, B) => {
      const R = new Array(16).fill(0);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
        R[c * 4 + r] = s;
      }
      return R;
    };
    const nodeMatrix = (n) => {
      if (n.matrix) return n.matrix.slice();
      const t = n.translation || [0, 0, 0];
      const r = n.rotation || [0, 0, 0, 1];
      const s = n.scale || [1, 1, 1];
      const [x, y, z, w] = r;
      const m = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        0, 0, 0, 1
      ];
      for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) m[c * 4 + rr] *= s[c];
      m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
      return m;
    };
    const xform = (M, x, y, z) => [
      M[0] * x + M[4] * y + M[8] * z + M[12],
      M[1] * x + M[5] * y + M[9] * z + M[13],
      M[2] * x + M[6] * y + M[10] * z + M[14]
    ];

    const walk = (ni, parentM) => {
      const n = json.nodes[ni];
      const M = parentM ? mul(parentM, nodeMatrix(n)) : nodeMatrix(n);
      if (n.mesh !== undefined) {
        const mesh = json.meshes[n.mesh];
        for (const prim of mesh.primitives) {
          if (prim.mode !== undefined && prim.mode !== 4) continue;
          const posAcc = readAccessor(prim.attributes.POSITION);
          const cnt = posAcc.data.length / 3;

          // 读取 TEXCOORD_0（整数类型需归一化）
          let uvAcc = null;
          if (prim.attributes.TEXCOORD_0 !== undefined) {
            uvAcc = readAccessor(prim.attributes.TEXCOORD_0);
            if (uvAcc.componentType !== 5126) {
              const d = uvAcc.data;
              const div = uvAcc.componentType === 5121 ? 255 : uvAcc.componentType === 5123 ? 65535
                : uvAcc.componentType === 5120 ? 127 : 32767;
              for (let i = 0; i < d.length; i++) d[i] = d[i] / div;
            }
            uvSeen++;
          }

          for (let i = 0; i < cnt; i++) {
            const p = xform(M, posAcc.data[i * 3], posAcc.data[i * 3 + 1], posAcc.data[i * 3 + 2]);
            allPos.push(p[0], p[1], p[2]);
            if (uvAcc) allUv.push(uvAcc.data[i * 2] || 0, uvAcc.data[i * 2 + 1] || 0);
            else allUv.push(0, 0);
          }
          if (prim.indices !== undefined) {
            const ia = readAccessor(prim.indices);
            for (let i = 0; i < ia.data.length; i++) allIdx.push(ia.data[i] + base);
          } else {
            for (let i = 0; i < cnt; i++) allIdx.push(i + base);
          }
          base += cnt;
        }
      }
      if (n.children) for (const c of n.children) walk(c, M);
    };

    const scene = json.scenes[json.scene || 0];
    const roots = scene && scene.nodes ? scene.nodes : json.nodes.map((_, i) => i);
    for (const r of roots) walk(r, null);

    if (allPos.length === 0) throw new Error('GLB 中没有可读取的三角形网格');
    return {
      positions: new Float32Array(allPos),
      indices: new Uint32Array(allIdx),
      uvs: uvSeen ? new Float32Array(allUv) : null,
      name: 'model'
    };
  }

  /* ---------------- PLY ---------------- */
  const PLY_SIZE = {
    char: 1, int8: 1, uchar: 1, uint8: 1,
    short: 2, int16: 2, ushort: 2, uint16: 2,
    int: 4, int32: 4, uint: 4, uint32: 4,
    float: 4, float32: 4, double: 8, float64: 8
  };
  function parsePLY(buf) {
    const u8 = new Uint8Array(buf);
    // 找 end_header
    const headLimit = Math.min(u8.length, 1 << 16);
    let headEnd = -1;
    for (let i = 0; i < headLimit - 10; i++) {
      if (u8[i] === 0x65 && u8[i + 1] === 0x6e && u8[i + 2] === 0x64 &&
          u8[i + 3] === 0x5f && u8[i + 4] === 0x68 && u8[i + 5] === 0x65) { headEnd = i; break; }
    }
    if (headEnd < 0) throw new Error('PLY 头部不完整');
    let bodyStart = headEnd;
    while (bodyStart < u8.length && u8[bodyStart] !== 0x0a) bodyStart++;
    bodyStart++;

    const head = new TextDecoder().decode(u8.subarray(0, headEnd));
    const lines = head.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let format = 'ascii';
    const elements = [];
    for (const ln of lines) {
      const p = ln.split(/\s+/);
      if (p[0] === 'format') format = p[1];
      else if (p[0] === 'element') elements.push({ name: p[1], count: parseInt(p[2], 10), props: [] });
      else if (p[0] === 'property' && elements.length) {
        const cur = elements[elements.length - 1];
        if (p[1] === 'list') cur.props.push({ list: true, countType: p[2], type: p[3], name: p[4] });
        else cur.props.push({ list: false, type: p[1], name: p[2] });
      }
    }

    const vEl = elements.find(e => e.name === 'vertex');
    const fEl = elements.find(e => e.name === 'face');
    if (!vEl) throw new Error('PLY 中没有 vertex 元素');

    const pos = [];
    const tris = [];
    const uv = [];
    const plyHasUV = vEl.props.some(p => p.name === 's' || p.name === 'texture_u');

    if (format === 'ascii') {
      const txt = new TextDecoder().decode(u8.subarray(bodyStart));
      const tok = txt.split(/\s+/).filter(s => s.length);
      let ti = 0;
      const readVerts = () => {
        for (let i = 0; i < vEl.count; i++) {
          let x = 0, y = 0, z = 0, u = 0, w = 0;
          for (const pr of vEl.props) {
            const v = parseFloat(tok[ti++]);
            if (pr.name === 'x') x = v;
            else if (pr.name === 'y') y = v;
            else if (pr.name === 'z') z = v;
            else if (pr.name === 's' || pr.name === 'texture_u') u = v;
            else if (pr.name === 't' || pr.name === 'texture_v') w = v;
          }
          pos.push(x, y, z);
          if (plyHasUV) uv.push(u, w);
        }
      };
      readVerts();
      for (const el of elements) {
        if (el.name === 'vertex') continue;
        for (let i = 0; i < el.count; i++) {
          const vals = {};
          for (const pr of el.props) {
            if (pr.list) {
              const n = parseInt(tok[ti++], 10);
              const arr = [];
              for (let k = 0; k < n; k++) arr.push(parseInt(tok[ti++], 10));
              vals[pr.name] = arr;
            } else vals[pr.name] = parseFloat(tok[ti++]);
          }
          if (el.name === 'face' && vals.vertex_indices) {
            const a = vals.vertex_indices;
            for (let k = 2; k < a.length; k++) tris.push(a[0], a[k - 1], a[k]);
          }
        }
      }
    } else {
      const le = format.indexOf('little') >= 0;
      const dv = new DataView(buf);
      let o = bodyStart;
      const rd = (t) => {
        let v;
        switch (t) {
          case 'char': case 'int8': v = dv.getInt8(o); o += 1; break;
          case 'uchar': case 'uint8': v = dv.getUint8(o); o += 1; break;
          case 'short': case 'int16': v = dv.getInt16(o, le); o += 2; break;
          case 'ushort': case 'uint16': v = dv.getUint16(o, le); o += 2; break;
          case 'int': case 'int32': v = dv.getInt32(o, le); o += 4; break;
          case 'uint': case 'uint32': v = dv.getUint32(o, le); o += 4; break;
          case 'float': case 'float32': v = dv.getFloat32(o, le); o += 4; break;
          case 'double': case 'float64': v = dv.getFloat64(o, le); o += 8; break;
          default: v = 0;
        }
        return v;
      };
      for (let i = 0; i < vEl.count; i++) {
        let x = 0, y = 0, z = 0, u = 0, w = 0;
        for (const pr of vEl.props) {
          const v = rd(pr.type);
          if (pr.name === 'x') x = v;
          else if (pr.name === 'y') y = v;
          else if (pr.name === 'z') z = v;
          else if (pr.name === 's' || pr.name === 'texture_u') u = v;
          else if (pr.name === 't' || pr.name === 'texture_v') w = v;
        }
        pos.push(x, y, z);
        if (plyHasUV) uv.push(u, w);
      }
      for (const el of elements) {
        if (el.name === 'vertex') continue;
        for (let i = 0; i < el.count; i++) {
          const vals = {};
          for (const pr of el.props) {
            if (pr.list) {
              const n = rd(pr.countType);
              const arr = [];
              for (let k = 0; k < n; k++) arr.push(rd(pr.type));
              vals[pr.name] = arr;
            } else vals[pr.name] = rd(pr.type);
          }
          if (el.name === 'face' && vals.vertex_indices) {
            const a = vals.vertex_indices;
            for (let k = 2; k < a.length; k++) tris.push(a[0], a[k - 1], a[k]);
          }
        }
      }
    }
    if (pos.length === 0) throw new Error('PLY 中没有顶点数据');
    return {
      positions: new Float32Array(pos),
      indices: tris.length ? new Uint32Array(tris) : null,
      uvs: plyHasUV && uv.length ? new Float32Array(uv) : null,
      name: 'model'
    };
  }

  /* ---------------- OFF ---------------- */
  function parseOFF(txt) {
    const lines = txt.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
    let header = (lines[i] || '').trim();
    if (!/^(\d|\s)/.test(header)) i++; // 跳过 OFF / COFF 关键字行
    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
    const cnt = (lines[i] || '').trim().split(/\s+/).map(Number);
    const nv = cnt[0] | 0, nf = cnt[1] | 0;
    i++;
    const pos = [];
    for (let k = 0; k < nv && i < lines.length; k++, i++) {
      const p = lines[i].trim().split(/\s+/).map(Number);
      pos.push(p[0], p[1], p[2]);
    }
    const tris = [];
    for (let k = 0; k < nf && i < lines.length; k++, i++) {
      const p = lines[i].trim().split(/\s+/).map(Number);
      const n = p[0] | 0;
      for (let t = 2; t < n; t++) tris.push(p[1], p[t], p[t + 1]);
    }
    if (pos.length === 0 || tris.length === 0) throw new Error('OFF 中未找到顶点或面');
    return { positions: new Float32Array(pos), indices: new Uint32Array(tris), name: 'model' };
  }

  /* ============================================================
   FBX 解析（二进制节点树 + ASCII 文本两种容器）
   ============================================================ */

/* ---------- zlib 解压（浏览器用 DecompressionStream，Node 用 zlib） ---------- */
function inflateBytes(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(stream).arrayBuffer().then(ab => new Uint8Array(ab));
  }
  return new Promise((resolve, reject) => {
    try {
      // eslint-disable-next-line no-undef
      const zlib = require('zlib');
      resolve(new Uint8Array(zlib.inflateSync(Buffer.from(bytes))));
    } catch (e) { reject(new Error('当前环境无法解压 FBX 数组（缺少 zlib 支持）')); }
  });
}

/* ---------- 数组属性转定型数组 ---------- */
function fbxArrayToTyped(item) {
  const len = item.len;
  const src = item.data;
  if (!src || len === 0) return new Float64Array(0);
  const ab = src.buffer.slice(src.byteOffset, src.byteOffset + Math.min(src.byteLength, len * (item.type === 'd' || item.type === 'l' ? 8 : 4)));
  try {
    switch (item.type) {
      case 'f': return new Float32Array(ab, 0, len);
      case 'd': return new Float64Array(ab, 0, len);
      case 'i': return new Int32Array(ab, 0, len);
      case 'b': return new Uint8Array(ab, 0, len);
      case 'l': {
        const big = new BigInt64Array(ab, 0, len);
        const out = new Float64Array(len);
        for (let i = 0; i < len; i++) out[i] = Number(big[i]);
        return out;
      }
    }
  } catch (e) {
    // 对齐失败时退化为逐元素读取
    const dv = new DataView(ab);
    const out = new Float64Array(len);
    const size = item.type === 'd' || item.type === 'l' ? 8 : 4;
    for (let i = 0; i < len; i++) {
      if (item.type === 'f') out[i] = dv.getFloat32(i * 4, true);
      else if (item.type === 'd') out[i] = dv.getFloat64(i * 8, true);
      else if (item.type === 'i') out[i] = dv.getInt32(i * 4, true);
      else if (item.type === 'b') out[i] = dv.getUint8(i);
      else out[i] = Number(dv.getBigInt64(i * 8, true));
      void size;
    }
    return out;
  }
  return new Float64Array(0);
}

/* ---------- 二进制 FBX 节点树 ---------- */
function parseFBXBinary(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const magic = 'Kaydara FBX Binary  ';
  for (let i = 0; i < magic.length; i++) {
    if (u8[i] !== magic.charCodeAt(i)) throw new Error('不是合法的二进制 FBX 文件');
  }
  const version = dv.getUint32(23, true);
  const wide = version >= 7500;
  const HEAD = wide ? 25 : 13;
  const dec = new TextDecoder();
  const pending = [];
  let pos = 27;

  function readProp() {
    const t = String.fromCharCode(u8[pos]); pos += 1;
    switch (t) {
      case 'Y': { const v = dv.getInt16(pos, true); pos += 2; return v; }
      case 'C': { const v = u8[pos]; pos += 1; return v === 1; }
      case 'I': { const v = dv.getInt32(pos, true); pos += 4; return v; }
      case 'F': { const v = dv.getFloat32(pos, true); pos += 4; return v; }
      case 'D': { const v = dv.getFloat64(pos, true); pos += 8; return v; }
      case 'L': { const v = Number(dv.getBigInt64(pos, true)); pos += 8; return v; }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const len = dv.getUint32(pos, true); pos += 4;
        const enc = dv.getUint32(pos, true); pos += 4;
        const clen = dv.getUint32(pos, true); pos += 4;
        const raw = u8.subarray(pos, pos + clen);
        pos += clen;
        const item = { __arr: true, type: t, len, enc, raw, data: null };
        if (enc === 0) item.data = raw;
        else pending.push(item);
        return item;
      }
      case 'S': {
        const len = dv.getUint32(pos, true); pos += 4;
        const s = dec.decode(u8.subarray(pos, pos + len));
        pos += len;
        return s;
      }
      case 'R': {
        const len = dv.getUint32(pos, true); pos += 4;
        const r = u8.subarray(pos, pos + len);
        pos += len;
        return r;
      }
      default:
        throw new Error('FBX 中出现未知属性类型 "' + t + '"（偏移 ' + (pos - 1) + '）');
    }
  }

  function readRecord() {
    if (pos + HEAD > buf.byteLength) return null;
    let endOffset, numProps, propLen;
    if (wide) {
      endOffset = Number(dv.getBigUint64(pos, true)); pos += 8;
      numProps = Number(dv.getBigUint64(pos, true)); pos += 8;
      propLen = Number(dv.getBigUint64(pos, true)); pos += 8;
    } else {
      endOffset = dv.getUint32(pos, true); pos += 4;
      numProps = dv.getUint32(pos, true); pos += 4;
      propLen = dv.getUint32(pos, true); pos += 4;
    }
    const nameLen = u8[pos]; pos += 1;
    if (endOffset === 0) return null;
    if (endOffset > buf.byteLength) throw new Error('FBX 记录越界，文件可能已损坏');
    const name = dec.decode(u8.subarray(pos, pos + nameLen));
    pos += nameLen;
    const props = [];
    for (let i = 0; i < numProps; i++) props.push(readProp());
    const children = [];
    while (pos < endOffset) {
      const child = readRecord();
      if (!child) { pos = endOffset; break; }
      children.push(child);
    }
    pos = endOffset;
    void propLen;
    return { name, props, children };
  }

  const roots = [];
  while (pos + HEAD <= buf.byteLength) {
    const r = readRecord();
    if (!r) break;
    roots.push(r);
  }

  return Promise.all(pending.map(it =>
    inflateBytes(it.raw).then(bytes => { it.data = bytes; })
  )).then(() => ({ version, roots, ascii: false }));
}

/* ---------- ASCII FBX ---------- */
function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') i++; }
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findAsciiBlocks(text, kw) {
  const out = [];
  const re = new RegExp('\\b' + kw + ':\\s*(-?\\d+)\\s*,', 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    const close = matchBrace(text, open);
    if (close < 0) continue;
    out.push({ id: parseInt(m[1], 10), body: text.slice(open + 1, close) });
    re.lastIndex = close;
  }
  return out;
}

function asciiNumList(s) {
  const out = [];
  const re = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(parseFloat(m[0]));
  return out;
}

function asciiArray(body, name) {
  const re = new RegExp(name + ':\\s*\\*\\d+\\s*\\{[\\s\\S]*?a:\\s*([-\\d.eE+,\\s]+)\\}');
  const m = body.match(re);
  return m ? asciiNumList(m[1]) : null;
}

function asciiBlock(text, key) {
  const idx = text.indexOf(key + ':');
  if (idx < 0) return null;
  const open = text.indexOf('{', idx);
  if (open < 0) return null;
  const close = matchBrace(text, open);
  if (close < 0) return null;
  return text.slice(open + 1, close);
}

function asciiProp(body, name) {
  const re = new RegExp('P:\\s*"' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\/* ---------------- 顶点焊接（去重） ---------------- */') + '"\\s*,\\s*"[^"]*"\\s*,\\s*"[^"]*"\\s*,\\s*"[^"]*"\\s*,([^\\n}]*)');
  const m = body.match(re);
  if (!m) return null;
  return asciiNumList(m[1]);
}

function parseFBXAscii(text) {
  const geos = findAsciiBlocks(text, 'Geometry');
  const models = findAsciiBlocks(text, 'Model');
  const conns = [];
  const re = /C:\s*"OO"\s*,\s*(-?\d+)\s*,\s*(-?\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) conns.push([parseInt(m[1], 10), parseInt(m[2], 10)]);

  const geoMap = new Map();
  for (const g of geos) {
    const v = asciiArray(g.body, 'Vertices');
    const p = asciiArray(g.body, 'PolygonVertexIndex');
    if (!v || !p) continue;
    let uvArr = null, uvIdx = null, uvMap = 'ByPolygonVertex', uvRef = 'IndexToDirect';
    const uvBlock = asciiBlock(g.body, 'LayerElementUV');
    if (uvBlock) {
      uvArr = asciiArray(uvBlock, 'UV');
      uvIdx = asciiArray(uvBlock, 'UVIndex');
      const mm = uvBlock.match(/MappingInformationType:\s*"([^"]*)"/);
      if (mm) uvMap = mm[1];
      const rr = uvBlock.match(/ReferenceInformationType:\s*"([^"]*)"/);
      if (rr) uvRef = rr[1];
    }
    if (uvArr) for (let i = 1; i < uvArr.length; i += 2) uvArr[i] = 1 - uvArr[i];
    geoMap.set(g.id, { verts: v, pvi: p, uvArr, uvIdx, uvMap, uvRef });
  }
  const modelMap = new Map();
  for (const mo of models) {
    modelMap.set(mo.id, {
      t: asciiProp(mo.body, 'Lcl Translation'),
      r: asciiProp(mo.body, 'Lcl Rotation'),
      s: asciiProp(mo.body, 'Lcl Scaling'),
      pre: asciiProp(mo.body, 'PreRotation'),
      post: asciiProp(mo.body, 'PostRotation'),
      roff: asciiProp(mo.body, 'RotationOffset'),
      rp: asciiProp(mo.body, 'RotationPivot'),
      soff: asciiProp(mo.body, 'ScalingOffset'),
      sp: asciiProp(mo.body, 'ScalingPivot'),
      order: asciiProp(mo.body, 'RotationOrder')
    });
  }
  return { geoMap, modelMap, conns };
}

/* ---------- 4x4 矩阵（列主序，与渲染器一致） ---------- */
function m4id() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function m4mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
function m4t(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; }
function m4s(x, y, z) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; }
function m4rx(d) {
  const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
function m4ry(d) {
  const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
function m4rz(d) {
  const a = d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function m4euler(v, order) {
  const x = v[0] || 0, y = v[1] || 0, z = v[2] || 0;
  const RX = m4rx(x), RY = m4ry(y), RZ = m4rz(z);
  // 0:XYZ 1:XZY 2:YZX 3:YXZ 4:ZXY 5:ZYX
  switch (order | 0) {
    case 1: return m4mul(m4mul(RX, RZ), RY);
    case 2: return m4mul(m4mul(RY, RZ), RX);
    case 3: return m4mul(m4mul(RY, RX), RZ);
    case 4: return m4mul(m4mul(RZ, RX), RY);
    case 5: return m4mul(m4mul(RZ, RY), RX);
    default: return m4mul(m4mul(RX, RY), RZ);
  }
}
function v3(a, dflt) { return a && a.length >= 3 ? [a[0], a[1], a[2]] : dflt; }

function fbxNodeMatrix(p) {
  const T = m4t.apply(null, v3(p.t, [0, 0, 0]));
  const S = m4s.apply(null, v3(p.s, [1, 1, 1]));
  const Roff = m4t.apply(null, v3(p.roff, [0, 0, 0]));
  const Rp = m4t.apply(null, v3(p.rp, [0, 0, 0]));
  const RpInv = m4t(-Rp[12], -Rp[13], -Rp[14]);
  const Rpre = m4euler(v3(p.pre, [0, 0, 0]), p.order ? p.order[0] : 0);
  const R = m4euler(v3(p.r, [0, 0, 0]), p.order ? p.order[0] : 0);
  const Rpost = m4euler(v3(p.post, [0, 0, 0]), p.order ? p.order[0] : 0);
  // Rpost 的逆：转置旋转部分
  const RpostInv = [
    Rpost[0], Rpost[4], Rpost[8], 0,
    Rpost[1], Rpost[5], Rpost[9], 0,
    Rpost[2], Rpost[6], Rpost[10], 0,
    0, 0, 0, 1
  ];
  const Soff = m4t.apply(null, v3(p.soff, [0, 0, 0]));
  const Sp = m4t.apply(null, v3(p.sp, [0, 0, 0]));
  const SpInv = m4t(-Sp[12], -Sp[13], -Sp[14]);

  let M = T;
  M = m4mul(M, Roff);
  M = m4mul(M, Rp);
  M = m4mul(M, Rpre);
  M = m4mul(M, R);
  M = m4mul(M, RpostInv);
  M = m4mul(M, RpInv);
  M = m4mul(M, Soff);
  M = m4mul(M, Sp);
  M = m4mul(M, S);
  M = m4mul(M, SpInv);
  return M;
}

/* ---------- 从节点树组装几何 ---------- */
function fbxBuild(geoMap, modelMap, conns) {
  const parentOf = new Map();
  for (const [c, p] of conns) parentOf.set(c, p);

  const modelCache = new Map();
  function worldOf(modelId) {
    if (modelCache.has(modelId)) return modelCache.get(modelId);
    const chain = [];
    let cur = modelId;
    const seen = new Set();
    while (cur !== undefined && cur !== 0 && modelMap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    let M = m4id();
    for (let i = chain.length - 1; i >= 0; i--) M = m4mul(M, fbxNodeMatrix(modelMap.get(chain[i])));
    modelCache.set(modelId, M);
    return M;
  }

  const allPos = [];
  const allUV = [];
  const triPos = [];
  const triUv = [];
  let base = 0;
  let baseUv = 0;
  let anyUV = false;

  for (const [gid, geo] of geoMap) {
    const mid = parentOf.get(gid);
    const M = (mid !== undefined && modelMap.has(mid)) ? worldOf(mid) : m4id();
    const V = geo.verts;
    const nv = V.length / 3;
    for (let i = 0; i < nv; i++) {
      const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
      allPos.push(
        M[0] * x + M[4] * y + M[8] * z + M[12],
        M[1] * x + M[5] * y + M[9] * z + M[13],
        M[2] * x + M[6] * y + M[10] * z + M[14]
      );
    }

    const hasUV = !!(geo.uvArr && geo.uvArr.length >= 2);
    const uvCount = hasUV ? geo.uvArr.length / 2 : 1;
    if (hasUV) {
      for (let i = 0; i < geo.uvArr.length; i++) allUV.push(geo.uvArr[i]);
      anyUV = true;
    } else {
      allUV.push(0, 0); // 无 UV 的几何占一个槽位，避免串到别的几何
    }

    const byVertex = geo.uvMap === 'ByVertice' || geo.uvMap === 'ByVertex';
    const direct = geo.uvRef === 'Direct';

    const P = geo.pvi;
    let poly = [];
    let polyUv = [];
    for (let i = 0; i < P.length; i++) {
      let idx = P[i];
      let localUv = 0;
      if (hasUV) {
        if (direct) {
          localUv = byVertex ? idx : i;
        } else if (geo.uvIdx && geo.uvIdx.length) {
          const raw = byVertex ? geo.uvIdx[idx] : geo.uvIdx[i];
          localUv = isFinite(raw) ? raw : 0;
        } else {
          localUv = byVertex ? idx : i;
        }
        if (localUv < 0 || localUv >= uvCount) localUv = 0;
      }
      const uvGlobal = baseUv + localUv;

      if (idx < 0) {
        idx = -idx - 1;
        poly.push(idx); polyUv.push(uvGlobal);
        for (let k = 2; k < poly.length; k++) {
          triPos.push(poly[0] + base, poly[k - 1] + base, poly[k] + base);
          triUv.push(polyUv[0], polyUv[k - 1], polyUv[k]);
        }
        poly = []; polyUv = [];
      } else {
        poly.push(idx); polyUv.push(uvGlobal);
      }
    }
    base += nv;
    baseUv += uvCount;
  }

  if (allPos.length === 0) throw new Error('FBX 中没有找到可读取的网格（可能只含骨骼/动画，或使用了不支持的编码）');
  const r = assemble(new Float32Array(allPos), triPos, anyUV ? new Float32Array(allUV) : null, anyUV ? triUv : null);
  r.name = 'model';
  return r;
}

/* ---------- FBX 总入口 ---------- */
function parseFBX(buf) {
  const u8 = new Uint8Array(buf);
  const magic = 'Kaydara FBX Binary  ';
  let isBinary = u8.length > 27;
  for (let i = 0; i < magic.length && isBinary; i++) {
    if (u8[i] !== magic.charCodeAt(i)) isBinary = false;
  }

  if (isBinary) {
    return parseFBXBinary(buf).then(parsed => {
      const objects = parsed.roots.find(r => r.name === 'Objects');
      const connections = parsed.roots.find(r => r.name === 'Connections');
      if (!objects) throw new Error('FBX 缺少 Objects 段');

      const geoMap = new Map();
      const modelMap = new Map();
      for (const o of objects.children) {
        if (o.name === 'Geometry') {
          const id = o.props[0];
          let verts = null, pvi = null;
          let uvArr = null, uvIdx = null, uvMap = 'ByPolygonVertex', uvRef = 'IndexToDirect';
          for (const c of o.children) {
            if (c.name === 'Vertices' && c.props[0] && c.props[0].__arr) verts = fbxArrayToTyped(c.props[0]);
            else if (c.name === 'PolygonVertexIndex' && c.props[0] && c.props[0].__arr) pvi = fbxArrayToTyped(c.props[0]);
            else if (c.name === 'LayerElementUV') {
              for (const u of c.children) {
                if (u.name === 'UV' && u.props[0] && u.props[0].__arr) uvArr = fbxArrayToTyped(u.props[0]);
                else if (u.name === 'UVIndex' && u.props[0] && u.props[0].__arr) uvIdx = fbxArrayToTyped(u.props[0]);
                else if (u.name === 'MappingInformationType') uvMap = u.props[0];
                else if (u.name === 'ReferenceInformationType') uvRef = u.props[0];
              }
            }
          }
          if (verts && pvi && verts.length >= 9 && pvi.length >= 3) {
            // FBX 的 V 轴原点在左下，内部统一转成 glTF 约定
            if (uvArr) for (let i = 1; i < uvArr.length; i += 2) uvArr[i] = 1 - uvArr[i];
            geoMap.set(id, { verts, pvi, uvArr, uvIdx, uvMap, uvRef });
          }
        } else if (o.name === 'Model') {
          const p70 = o.children.find(c => c.name === 'Properties70');
          const p = {};
          if (p70) {
            for (const rec of p70.children) {
              if (rec.name !== 'P') continue;
              const nm = rec.props[0];
              const vals = rec.props.slice(4).filter(v => typeof v === 'number');
              if (nm === 'Lcl Translation') p.t = vals;
              else if (nm === 'Lcl Rotation') p.r = vals;
              else if (nm === 'Lcl Scaling') p.s = vals;
              else if (nm === 'PreRotation') p.pre = vals;
              else if (nm === 'PostRotation') p.post = vals;
              else if (nm === 'RotationOffset') p.roff = vals;
              else if (nm === 'RotationPivot') p.rp = vals;
              else if (nm === 'ScalingOffset') p.soff = vals;
              else if (nm === 'ScalingPivot') p.sp = vals;
              else if (nm === 'RotationOrder') p.order = vals;
            }
          }
          modelMap.set(o.props[0], p);
        }
      }
      const conns = [];
      if (connections) {
        for (const c of connections.children) {
          if (c.name !== 'C') continue;
          if (c.props[0] !== 'OO') continue;
          conns.push([c.props[1], c.props[2]]);
        }
      }
      return fbxBuild(geoMap, modelMap, conns);
    });
  }

  // ASCII
  const text = new TextDecoder().decode(u8);
  if (!/^\s*;/.test(text) && !/FBX\s+\d/.test(text.slice(0, 400))) {
    throw new Error('无法识别的 FBX 文件（既非二进制也非 ASCII 版本）');
  }
  const parsed = parseFBXAscii(text);
  return Promise.resolve(fbxBuild(parsed.geoMap, parsed.modelMap, parsed.conns));
}

  /* ---------------- 角点装配：把 (位置索引, UV索引) 组合成唯一顶点 ---------------- */
  // 用于 OBJ / FBX 这类位置与 UV 分开索引的格式
  function assemble(positions, triPos, uvList, triUv) {
    const hasUV = !!(uvList && triUv && uvList.length > 0);
    const nUv = hasUV ? uvList.length / 2 : 1;
    const keyBase = nUv + 1;
    const map = new Map();
    const outPos = [];
    const outUv = hasUV ? [] : null;
    const outIdx = new Uint32Array(triPos.length);

    for (let i = 0; i < triPos.length; i++) {
      const pi = triPos[i];
      const ui = hasUV ? triUv[i] : 0;
      const k = pi * keyBase + ui;
      let id = map.get(k);
      if (id === undefined) {
        id = outPos.length / 3;
        map.set(k, id);
        outPos.push(positions[pi * 3], positions[pi * 3 + 1], positions[pi * 3 + 2]);
        if (hasUV) outUv.push(uvList[ui * 2], uvList[ui * 2 + 1]);
      }
      outIdx[i] = id;
    }
    return {
      positions: new Float32Array(outPos),
      indices: outIdx,
      uvs: hasUV ? new Float32Array(outUv) : null
    };
  }

  /* ---------------- 顶点焊接（按位置 + UV 去重，保留 UV 接缝） ---------------- */
  function weld(positions, indices, uvs) {
    const n = positions.length / 3;
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    const diag = Math.hypot(maxx - minx, maxy - miny, maxz - minz) || 1;
    const scale = 1 / (diag * 1e-6);
    const hasUV = !!(uvs && uvs.length >= n * 2);

    const map = new Map();
    const outPos = [];
    const outUv = hasUV ? [] : null;
    const remap = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      let k = Math.round(x * scale) + ',' + Math.round(y * scale) + ',' + Math.round(z * scale);
      if (hasUV) {
        // UV 一并参与去重：接缝两侧位置相同但 UV 不同，必须保持分离
        k += '|' + Math.round(uvs[i * 2] * 1e6) + ',' + Math.round(uvs[i * 2 + 1] * 1e6);
      }
      let id = map.get(k);
      if (id === undefined) {
        id = outPos.length / 3;
        map.set(k, id);
        outPos.push(x, y, z);
        if (hasUV) outUv.push(uvs[i * 2], uvs[i * 2 + 1]);
      }
      remap[i] = id;
    }

    const src = indices && indices.length ? indices : null;
    const triCount = src ? src.length / 3 : n / 3;
    const outIdx = [];
    for (let t = 0; t < triCount; t++) {
      const a = remap[src ? src[t * 3] : t * 3];
      const b = remap[src ? src[t * 3 + 1] : t * 3 + 1];
      const c = remap[src ? src[t * 3 + 2] : t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      outIdx.push(a, b, c);
    }
    return {
      positions: new Float32Array(outPos),
      indices: new Uint32Array(outIdx),
      uvs: hasUV ? new Float32Array(outUv) : null
    };
  }

  /* ---------------- 包围盒 / 统计 ---------------- */
  function bbox(positions) {
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    return { min: [minx, miny, minz], max: [maxx, maxy, maxz] };
  }

  /* ---------------- 四边形误差度量 (QEM) 简化 ---------------- */
  // 每个顶点 10 个四元数系数，对称 4x4 的上三角
  function qAddPlane(q, vi, a, b, c, d, w, cnt) {
    const o = vi * 10;
    const ww = w || 1;
    if (cnt) cnt[vi] += 1;
    q[o + 0] += ww * a * a; q[o + 1] += ww * a * b; q[o + 2] += ww * a * c; q[o + 3] += ww * a * d;
    q[o + 4] += ww * b * b; q[o + 5] += ww * b * c; q[o + 6] += ww * b * d;
    q[o + 7] += ww * c * c; q[o + 8] += ww * c * d; q[o + 9] += ww * d * d;
  }
  function qError(q, vi, x, y, z) {
    const o = vi * 10;
    return q[o] * x * x + 2 * q[o + 1] * x * y + 2 * q[o + 2] * x * z + 2 * q[o + 3] * x
      + q[o + 4] * y * y + 2 * q[o + 5] * y * z + 2 * q[o + 6] * y
      + q[o + 7] * z * z + 2 * q[o + 8] * z + q[o + 9];
  }

  /* ---------------- 简化引擎 ----------------
     主引擎：meshoptimizer（与原站完全相同的算法）
     回退：本文件内置的手写 QEM（meshopt 不可用时）
  ------------------------------------------- */
  let _engine = null;

  function initEngine(candidate) {
    const S = candidate ||
      (typeof window !== 'undefined' && window.MeshoptSimplifier) ||
      (typeof globalThis !== 'undefined' && globalThis.MeshoptSimplifier) ||
      null;
    if (!S) return Promise.resolve(false);
    return Promise.resolve(S.ready)
      .then(() => { _engine = S; return true; })
      .catch(() => { _engine = null; return false; });
  }

  function engineName() { return _engine ? 'meshoptimizer' : 'qem'; }

  function simplify(mesh, targetFaces, opts) {
    opts = opts || {};
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const S = opts.simplifier || _engine;
    if (S && S.supported) {
      try {
        return simplifyMeshopt(mesh, targetFaces, opts, S, t0);
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[simplify] meshopt 失败，回退 QEM：' + e.message);
      }
    }
    return simplifyQEM(mesh, targetFaces, opts, t0);
  }

  /* ---------- meshoptimizer 路径 ---------- */
  function simplifyMeshopt(mesh, targetFaces, opts, S, t0) {
    const pos = mesh.positions instanceof Float32Array ? mesh.positions : new Float32Array(mesh.positions);
    const idx = mesh.indices instanceof Uint32Array ? mesh.indices : new Uint32Array(mesh.indices);
    const nv = pos.length / 3;
    const srcFaces = idx.length / 3;
    const target = Math.max(4, Math.min(srcFaces, targetFaces | 0));
    const targetIndexCount = target * 3;

    const flags = [];
    if (opts.lockBorder) flags.push('LockBorder');
    const targetError = (opts.maxDist === undefined || opts.maxDist === null)
      ? 1e9 : Math.max(0, opts.maxDist);

    const UV = (mesh.uvs && mesh.uvs.length >= nv * 2) ? mesh.uvs : null;

    let raw, err;
    if (UV && opts.uvWeight > 0) {
      // 属性感知简化：把 UV 计入误差度量，贴图拉伸更小
      const w = opts.uvWeight;
      const r = S.simplifyWithAttributes(
        idx, pos, 3,
        UV, 2, [w, w],
        null,
        targetIndexCount, targetError, flags
      );
      raw = r[0]; err = r[1];
    } else {
      const r = S.simplify(idx, pos, 3, targetIndexCount, targetError, flags);
      raw = r[0]; err = r[1];
    }

    // 顶点压缩（自己实现，避免依赖 compactMesh 的重映射语义）
    const remap = new Int32Array(nv).fill(-1);
    const outPos = [];
    const outUv = UV ? [] : null;
    const finalIdx = new Uint32Array(raw.length);
    let n = 0;
    for (let i = 0; i < raw.length; i++) {
      const o = raw[i];
      let m = remap[o];
      if (m < 0) {
        m = n++;
        remap[o] = m;
        outPos.push(pos[o * 3], pos[o * 3 + 1], pos[o * 3 + 2]);
        if (outUv) outUv.push(UV[o * 2], UV[o * 2 + 1]);
      }
      finalIdx[i] = m;
    }

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return {
      positions: new Float32Array(outPos),
      indices: finalIdx,
      uvs: outUv ? new Float32Array(outUv) : null,
      stats: {
        srcFaces: srcFaces, srcVerts: nv,
        dstFaces: finalIdx.length / 3, dstVerts: n,
        hasUV: !!UV,
        engine: 'meshoptimizer',
        error: err,
        ms: Math.round(t1 - t0)
      }
    };
  }

  /* ---------- 手写 QEM 回退路径 ---------- */
  function simplifyQEM(mesh, targetFaces, opts, t0) {
    opts = opts || {};
    if (t0 === undefined) t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const V = Float32Array.from(mesh.positions);
    const F = Uint32Array.from(mesh.indices);
    const nv = V.length / 3;
    const nf = F.length / 3;
    const faceDead = new Uint8Array(nf);
    let facesAlive = nf;

    // 模型对角线（用于把相对误差换算成绝对距离）
    let _mnx = Infinity, _mny = Infinity, _mnz = Infinity;
    let _mxx = -Infinity, _mxy = -Infinity, _mxz = -Infinity;
    for (let i = 0; i < nv; i++) {
      const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
      if (x < _mnx) _mnx = x; if (x > _mxx) _mxx = x;
      if (y < _mny) _mny = y; if (y > _mxy) _mxy = y;
      if (z < _mnz) _mnz = z; if (z > _mxz) _mxz = z;
    }
    const _diag = Math.hypot(_mxx - _mnx, _mxy - _mny, _mxz - _mnz) || 1;
    const maxDistAbs = (opts.maxDist === undefined || opts.maxDist === null) ? null : opts.maxDist * _diag;

    // UV 数据：接缝两侧位置相同但 UV 不同，必须作为独立顶点处理
    const UV = (mesh.uvs && mesh.uvs.length >= nv * 2) ? Float32Array.from(mesh.uvs) : null;

    // 标记「同一位置存在多个顶点」的接缝顶点 —— 它们的位置必须锁死，
    // 否则一侧移动、另一侧不动，模型会裂开
    const locked = new Uint8Array(nv);
    if (UV) {
      let mnx = Infinity, mny = Infinity, mnz = Infinity;
      let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (let i = 0; i < nv; i++) {
        const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1;
      const qs = 1 / (diag * 1e-5);
      const pmap = new Map();
      for (let i = 0; i < nv; i++) {
        const k = Math.round(V[i * 3] * qs) + ',' + Math.round(V[i * 3 + 1] * qs) + ',' + Math.round(V[i * 3 + 2] * qs);
        const prev = pmap.get(k);
        if (prev === undefined) pmap.set(k, i);
        else { locked[i] = 1; locked[prev] = 1; }
      }
    }

    // --- 面邻接 + 边表 ---
    const vfaces = new Array(nv);
    for (let i = 0; i < nv; i++) vfaces[i] = [];
    const edgeMap = new Map();
    const edges = [];
    const K = nv + 1;
    const ekey = (a, b) => (a < b ? a * K + b : b * K + a);

    const addEdge = (a, b, f) => {
      if (a === b) return;
      const k = ekey(a, b);
      let ei = edgeMap.get(k);
      if (ei === undefined) {
        ei = edges.length;
        edges.push({ a: a, b: b, faces: 1, cost: 0, tx: 0, ty: 0, tz: 0, version: 0, active: true });
        edgeMap.set(k, ei);
      } else {
        edges[ei].faces++;
      }
    };

    for (let f = 0; f < nf; f++) {
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      vfaces[a].push(f); vfaces[b].push(f); vfaces[c].push(f);
      addEdge(a, b, f); addEdge(b, c, f); addEdge(c, a, f);
    }

    // --- 面法线缓存 ---
    const fnx = new Float64Array(nf), fny = new Float64Array(nf), fnz = new Float64Array(nf);
    const farea = new Float64Array(nf);
    for (let f = 0; f < nf; f++) {
      const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
      const ax = V[i0 * 3], ay = V[i0 * 3 + 1], az = V[i0 * 3 + 2];
      const bx = V[i1 * 3], by = V[i1 * 3 + 1], bz = V[i1 * 3 + 2];
      const cx = V[i2 * 3], cy = V[i2 * 3 + 1], cz = V[i2 * 3 + 2];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(nx, ny, nz);
      farea[f] = len * 0.5;
      if (len > 1e-14) { nx /= len; ny /= len; nz /= len; }
      fnx[f] = nx; fny[f] = ny; fnz[f] = nz;
    }

    // --- 顶点四元数 ---
    const Q = new Float64Array(nv * 10);
    const QC = new Float64Array(nv);
    for (let f = 0; f < nf; f++) {
      if (farea[f] <= 1e-14) continue;
      const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
      const nx = fnx[f], ny = fny[f], nz = fnz[f];
      const d = -(nx * V[i0 * 3] + ny * V[i0 * 3 + 1] + nz * V[i0 * 3 + 2]);
      qAddPlane(Q, i0, nx, ny, nz, d, 1, QC);
      qAddPlane(Q, i1, nx, ny, nz, d, 1, QC);
      qAddPlane(Q, i2, nx, ny, nz, d, 1, QC);
    }
    // --- 边界约束（只被一个面共享的边） ---
    const boundW = opts.boundaryWeight === undefined ? 8 : opts.boundaryWeight;
    if (boundW > 0) {
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        if (e.faces !== 1) continue;
        const ax = V[e.a * 3], ay = V[e.a * 3 + 1], az = V[e.a * 3 + 2];
        const bx = V[e.b * 3], by = V[e.b * 3 + 1], bz = V[e.b * 3 + 2];
        let dx = bx - ax, dy = by - ay, dz = bz - az;
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;
        // 用任一相邻面的法线构造约束平面
        let fn = [0, 0, 1];
        for (const f of vfaces[e.a]) {
          const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
          if (i0 === e.b || i1 === e.b || i2 === e.b) { fn = [fnx[f], fny[f], fnz[f]]; break; }
        }
        let px = dy * fn[2] - dz * fn[1];
        let py = dz * fn[0] - dx * fn[2];
        let pz = dx * fn[1] - dy * fn[0];
        const pl = Math.hypot(px, py, pz);
        if (pl < 1e-12) continue;
        px /= pl; py /= pl; pz /= pl;
        const d = -(px * ax + py * ay + pz * az);
        qAddPlane(Q, e.a, px, py, pz, d, boundW, QC);
        qAddPlane(Q, e.b, px, py, pz, d, boundW, QC);
      }
    }

    // --- 顶点→边 邻接 ---
    const vEdges = new Array(nv);
    for (let i = 0; i < nv; i++) vEdges[i] = new Set();
    for (let ei = 0; ei < edges.length; ei++) {
      vEdges[edges[ei].a].add(ei);
      vEdges[edges[ei].b].add(ei);
    }

    // --- 最小堆 ---
    const heapCost = [];
    const heapEdge = [];
    const heapVer = [];
    function hpush(c, e, v) {
      let i = heapCost.length;
      heapCost.push(c); heapEdge.push(e); heapVer.push(v);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapCost[p] <= heapCost[i]) break;
        const tc = heapCost[p], te = heapEdge[p], tv = heapVer[p];
        heapCost[p] = heapCost[i]; heapEdge[p] = heapEdge[i]; heapVer[p] = heapVer[i];
        heapCost[i] = tc; heapEdge[i] = te; heapVer[i] = tv;
        i = p;
      }
    }
    function hpop() {
      const n = heapCost.length;
      if (n === 0) return null;
      const rc = heapCost[0], re = heapEdge[0], rv = heapVer[0];
      const lc = heapCost.pop(), le = heapEdge.pop(), lv = heapVer.pop();
      if (n > 1) {
        heapCost[0] = lc; heapEdge[0] = le; heapVer[0] = lv;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let s = i;
          if (l < heapCost.length && heapCost[l] < heapCost[s]) s = l;
          if (r < heapCost.length && heapCost[r] < heapCost[s]) s = r;
          if (s === i) break;
          const tc = heapCost[s], te = heapEdge[s], tv = heapVer[s];
          heapCost[s] = heapCost[i]; heapEdge[s] = heapEdge[i]; heapVer[s] = heapVer[i];
          heapCost[i] = tc; heapEdge[i] = te; heapVer[i] = tv;
          i = s;
        }
      }
      return { c: rc, e: re, v: rv };
    }

    // --- 最优收缩位置 ---
    const tmpP = [0, 0, 0];
    function optimalPoint(qa, qb, vi0, vi1) {
      const o = qa, p = qb;
      const a = Q[o] + Q[p], b = Q[o + 1] + Q[p + 1], c = Q[o + 2] + Q[p + 2];
      const d = Q[o + 3] + Q[p + 3], e = Q[o + 4] + Q[p + 4], f = Q[o + 5] + Q[p + 5];
      const g = Q[o + 6] + Q[p + 6], h = Q[o + 7] + Q[p + 7], i = Q[o + 8] + Q[p + 8];
      const j = Q[o + 9] + Q[p + 9];
      const det = a * (e * h - f * f) - b * (b * h - f * c) + c * (b * f - e * c);
      const scaleRef = Math.max(Math.abs(a), Math.abs(e), Math.abs(h), 1e-30);
      let cand = null;
      if (Math.abs(det) > 1e-12 * scaleRef * scaleRef * scaleRef) {
        const inv = 1 / det;
        const x = (-d * (e * h - f * f) - b * (-g * h - f * -j) + c * (-g * f - e * -j)) * inv;
        const y = (a * (-g * h - f * -j) - -d * (b * h - f * c) + c * (b * -j - -g * c)) * inv;
        const z = (a * (e * -j - -g * f) - b * (b * -j - -g * c) + -d * (b * f - e * c)) * inv;
        if (isFinite(x) && isFinite(y) && isFinite(z)) cand = [x, y, z];
      }
      const cands = [];
      if (cand) cands.push(cand);
      cands.push([V[vi0 * 3], V[vi0 * 3 + 1], V[vi0 * 3 + 2]]);
      cands.push([V[vi1 * 3], V[vi1 * 3 + 1], V[vi1 * 3 + 2]]);
      cands.push([(V[vi0 * 3] + V[vi1 * 3]) / 2, (V[vi0 * 3 + 1] + V[vi1 * 3 + 1]) / 2, (V[vi0 * 3 + 2] + V[vi1 * 3 + 2]) / 2]);
      let best = null, bestE = Infinity;
      for (const c2 of cands) {
        const er = qError(Q, vi0, c2[0], c2[1], c2[2]) + qError(Q, vi1, c2[0], c2[1], c2[2]);
        if (er < bestE) { bestE = er; best = c2; }
      }
      return { p: best, err: bestE };
    }

    function updateEdge(ei) {
      const e = edges[ei];
      if (!e.active) return;
      const v0 = e.a, v1 = e.b;
      const L0 = locked[v0], L1 = locked[v1];

      // 两端都在接缝上：任何收缩都会让接缝错位，直接放弃
      if (L0 && L1) {
        e.cost = Infinity;
        e.tx = V[v0 * 3]; e.ty = V[v0 * 3 + 1]; e.tz = V[v0 * 3 + 2];
        if (UV) { e.tu = UV[v0 * 2]; e.tv = UV[v0 * 2 + 1]; }
        e.version++;
        hpush(e.cost, ei, e.version);
        return;
      }

      let px, py, pz, t;
      if (L0) {
        px = V[v0 * 3]; py = V[v0 * 3 + 1]; pz = V[v0 * 3 + 2]; t = 0;
        e.cost = Math.max(0, qError(Q, v0, px, py, pz) + qError(Q, v1, px, py, pz));
      } else if (L1) {
        px = V[v1 * 3]; py = V[v1 * 3 + 1]; pz = V[v1 * 3 + 2]; t = 1;
        e.cost = Math.max(0, qError(Q, v0, px, py, pz) + qError(Q, v1, px, py, pz));
      } else {
        const r = optimalPoint(v0 * 10, v1 * 10, v0, v1);
        px = r.p[0]; py = r.p[1]; pz = r.p[2];
        e.cost = Math.max(0, r.err);
        // UV 插值参数：目标点投影到边上的比例
        const dx = V[v1 * 3] - V[v0 * 3], dy = V[v1 * 3 + 1] - V[v0 * 3 + 1], dz = V[v1 * 3 + 2] - V[v0 * 3 + 2];
        const len2 = dx * dx + dy * dy + dz * dz;
        if (len2 > 1e-20) {
          t = ((px - V[v0 * 3]) * dx + (py - V[v0 * 3 + 1]) * dy + (pz - V[v0 * 3 + 2]) * dz) / len2;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
        } else t = 0;
      }

      e.tx = px; e.ty = py; e.tz = pz;
      if (UV) {
        e.tu = UV[v0 * 2] + (UV[v1 * 2] - UV[v0 * 2]) * t;
        e.tv = UV[v0 * 2 + 1] + (UV[v1 * 2 + 1] - UV[v0 * 2 + 1]) * t;
      }
      e.version++;
      hpush(e.cost, ei, e.version);
    }
    for (let ei = 0; ei < edges.length; ei++) updateEdge(ei);

    // --- 主循环 ---
    const limit = Math.max(4, targetFaces | 0);
    let guard = 0;
    let stale = 0;
    let idle = 0;
    const maxIter = edges.length * 30 + nf * 30 + 5000;

    // 惰性删除会让堆里堆满过期条目，定期重建，避免迭代预算被无效项吃掉
    function rebuildHeap() {
      heapCost.length = 0; heapEdge.length = 0; heapVer.length = 0;
      for (let i = 0; i < edges.length; i++) {
        const e2 = edges[i];
        if (e2.active) hpush(e2.cost, i, e2.version);
      }
    }

    while (facesAlive > limit && guard++ < maxIter) {
      const top = hpop();
      if (!top) {
        rebuildHeap();
        if (heapCost.length === 0) break;
        continue;
      }
      if (idle++ > 60000) break;
      const e = edges[top.e];
      if (!e.active || e.version !== top.v) {
        if (++stale >= 40000) { rebuildHeap(); stale = 0; }
        continue;
      }

      const v0 = e.a, v1 = e.b;
      if (v0 === v1) { e.active = false; continue; }
      if (!isFinite(top.c)) continue;   // 接缝锁定的边，跳过

      // UV 退化守卫：收缩后若某个面的 UV 面积塌成 0，这个面在 UV 空间里就消失了
      // （贴图会出现破洞），直接放弃这次收缩
      if (UV) {
        const tu = e.tu, tv = e.tv;
        let uvBad = false;
        for (let pass = 0; pass < 2 && !uvBad; pass++) {
          const vv = pass === 0 ? v1 : v0;
          const list = vfaces[vv];
          if (!list) continue;
          for (let n = 0; n < list.length; n++) {
            const f = list[n];
            if (faceDead[f]) continue;
            const b = f * 3;
            const a0 = F[b], a1 = F[b + 1], a2 = F[b + 2];
            // 同时含两端点的面会在收缩中退化成线并被删除，不该参与检查
            const hasV0 = (a0 === v0 || a1 === v0 || a2 === v0);
            const hasV1 = (a0 === v1 || a1 === v1 || a2 === v1);
            if (hasV0 && hasV1) continue;
            const u0 = (a0 === v0 || a0 === v1) ? tu : UV[a0 * 2];
            const w0 = (a0 === v0 || a0 === v1) ? tv : UV[a0 * 2 + 1];
            const u1 = (a1 === v0 || a1 === v1) ? tu : UV[a1 * 2];
            const w1 = (a1 === v0 || a1 === v1) ? tv : UV[a1 * 2 + 1];
            const u2 = (a2 === v0 || a2 === v1) ? tu : UV[a2 * 2];
            const w2 = (a2 === v0 || a2 === v1) ? tv : UV[a2 * 2 + 1];
            const cr = (u1 - u0) * (w2 - w0) - (u2 - u0) * (w1 - w0);
            if (Math.abs(cr) < 1e-10) { uvBad = true; break; }
          }
        }
        if (uvBad) continue;
      }

      // 收缩代价过高（QEM 崩塌）时停止，避免模型碎掉
      if (maxDistAbs !== null) {
        const kk = Math.max(1, (QC[v0] + QC[v1]) / 2);
        if (Math.sqrt(Math.max(0, e.cost) / kk) > maxDistAbs) break;
      }

      // 1. 位置、UV 与四元数合并
      V[v0 * 3] = e.tx; V[v0 * 3 + 1] = e.ty; V[v0 * 3 + 2] = e.tz;
      if (UV) { UV[v0 * 2] = e.tu; UV[v0 * 2 + 1] = e.tv; }
      for (let k = 0; k < 10; k++) Q[v0 * 10 + k] += Q[v1 * 10 + k];

      // 2. 面重定向
      const vf = vfaces[v1];
      let removed = 0;
      for (let n = 0; n < vf.length; n++) {
        const f = vf[n];
        if (faceDead[f]) continue;
        const b = f * 3;
        let a0 = F[b], a1 = F[b + 1], a2 = F[b + 2];
        let changed = false;
        if (a0 === v1) { a0 = v0; changed = true; }
        if (a1 === v1) { a1 = v0; changed = true; }
        if (a2 === v1) { a2 = v0; changed = true; }
        if (!changed) continue;
        F[b] = a0; F[b + 1] = a1; F[b + 2] = a2;
        if (a0 === a1 || a1 === a2 || a0 === a2) {
          faceDead[f] = 1; facesAlive--; removed++;
        } else {
          vfaces[v0].push(f);
        }
      }
      vfaces[v1] = null;
      idle = 0;   // 有实际进展，重置空转计数

      // 3. 边重定向
      const ve = Array.from(vEdges[v1]);
      vEdges[v1].clear();
      for (const ei2 of ve) {
        const e2 = edges[ei2];
        if (!e2.active) continue;
        const other = e2.a === v1 ? e2.b : e2.a;
        if (other === v0) { e2.active = false; edgeMap.delete(ekey(v0, v1)); continue; }
        // 去掉旧 key
        edgeMap.delete(ekey(v1, other));
        const nk = ekey(v0, other);
        if (edgeMap.has(nk)) { e2.active = false; continue; }
        if (e2.a === v1) e2.a = v0; else e2.b = v0;
        edgeMap.set(nk, ei2);
        vEdges[v0].add(ei2);
      }

      // 4. 刷新 v0 邻域代价
      for (const ei3 of vEdges[v0]) updateEdge(ei3);
    }

    // --- 压缩输出 ---
    let dbg = null;
    if (facesAlive > limit) {
      let act = 0, fin = 0, inf = 0, nan = 0;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (!e.active) continue;
        act++;
        if (!isFinite(e.cost)) { if (e.cost !== e.cost) nan++; else inf++; }
        else fin++;
      }
      dbg = { facesAlive, limit, heap: heapCost.length, guard, maxIter, stale, idle, act, fin, inf, nan };
    }
    const used = new Uint8Array(nv);
    const outIdx = [];
    for (let f = 0; f < nf; f++) {
      if (faceDead[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === b || b === c || a === c) continue;
      outIdx.push(a, b, c);
      used[a] = 1; used[b] = 1; used[c] = 1;
    }
    const remap = new Int32Array(nv).fill(-1);
    const outPos = [];
    const outUv = UV ? [] : null;
    for (let f = 0; f < outIdx.length; f++) {
      const oi = outIdx[f];
      if (remap[oi] === -1) {
        remap[oi] = outPos.length / 3;
        outPos.push(V[oi * 3], V[oi * 3 + 1], V[oi * 3 + 2]);
        if (UV) outUv.push(UV[oi * 2], UV[oi * 2 + 1]);
      }
    }
    const finalIdx = new Uint32Array(outIdx.length);
    for (let f = 0; f < outIdx.length; f++) finalIdx[f] = remap[outIdx[f]];

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return {
      positions: new Float32Array(outPos),
      indices: finalIdx,
      uvs: outUv ? new Float32Array(outUv) : null,
      stats: {
        srcFaces: nf, srcVerts: nv,
        dstFaces: finalIdx.length / 3, dstVerts: outPos.length / 3,
        hasUV: !!UV,
        engine: 'qem',
        dbg: dbg,
        ms: Math.round(t1 - t0)
      }
    };
  }

  /* ---------------- 法线 ---------------- */
  function computeNormals(positions, indices, flat) {
    const nv = positions.length / 3;
    const nf = indices.length / 3;
    const normals = new Float32Array(nv * 3);
    if (flat) {
      const outN = new Float32Array(nf * 9);
      for (let f = 0; f < nf; f++) {
        const i0 = indices[f * 3], i1 = indices[f * 3 + 1], i2 = indices[f * 3 + 2];
        const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
        const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
        const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
        let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (let k = 0; k < 3; k++) {
          outN[f * 9 + k * 3] = nx; outN[f * 9 + k * 3 + 1] = ny; outN[f * 9 + k * 3 + 2] = nz;
        }
      }
      return { normals: outN, flat: true };
    }
    for (let f = 0; f < nf; f++) {
      const i0 = indices[f * 3], i1 = indices[f * 3 + 1], i2 = indices[f * 3 + 2];
      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      for (const ii of [i0, i1, i2]) {
        normals[ii * 3] += nx; normals[ii * 3 + 1] += ny; normals[ii * 3 + 2] += nz;
      }
    }
    for (let i = 0; i < nv; i++) {
      const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
      normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
    }
    return { normals, flat: false };
  }

  /* ---------------- 导出 ---------------- */
  function exportOBJ(positions, indices, name, uvs) {
    const hasUV = !!(uvs && uvs.length >= (positions.length / 3) * 2);
    const L = ['# 由本地 3D 模型简化器导出', 'o ' + (name || 'mesh')];
    for (let i = 0; i < positions.length; i += 3) {
      L.push('v ' + positions[i].toFixed(6) + ' ' + positions[i + 1].toFixed(6) + ' ' + positions[i + 2].toFixed(6));
    }
    if (hasUV) {
      // 内部为 glTF 约定（V 向下），OBJ 的 V 原点在左下，需翻回去
      for (let i = 0; i < uvs.length; i += 2) {
        L.push('vt ' + uvs[i].toFixed(6) + ' ' + (1 - uvs[i + 1]).toFixed(6));
      }
    }
    for (let f = 0; f < indices.length; f += 3) {
      const a = indices[f] + 1, b = indices[f + 1] + 1, c = indices[f + 2] + 1;
      if (hasUV) L.push('f ' + a + '/' + a + ' ' + b + '/' + b + ' ' + c + '/' + c);
      else L.push('f ' + a + ' ' + b + ' ' + c);
    }
    return new Blob([L.join('\n')], { type: 'text/plain' });
  }

  function exportSTL(positions, indices) {
    const nf = indices.length / 3;
    const buf = new ArrayBuffer(84 + nf * 50);
    const dv = new DataView(buf);
    const head = 'Binary STL - Local 3D Simplifier';
    for (let i = 0; i < head.length && i < 80; i++) dv.setUint8(i, head.charCodeAt(i));
    dv.setUint32(80, nf, true);
    let o = 84;
    for (let f = 0; f < nf; f++) {
      const i0 = indices[f * 3], i1 = indices[f * 3 + 1], i2 = indices[f * 3 + 2];
      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
      o += 12;
      const pts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
      for (const p of pts) {
        dv.setFloat32(o, p[0], true); dv.setFloat32(o + 4, p[1], true); dv.setFloat32(o + 8, p[2], true);
        o += 12;
      }
      dv.setUint16(o, 0, true); o += 2;
    }
    return new Blob([buf], { type: 'model/stl' });
  }

  function exportGLB(positions, indices, flat, uvs) {
    const hasUV = !!(uvs && uvs.length >= (positions.length / 3) * 2);
    const nrm = computeNormals(positions, indices, !!flat);
    const nv = positions.length / 3;
    const nf = indices.length / 3;

    let posArr = positions, nrmArr, idxArr, uvArr = uvs;
    if (nrm.flat) {
      // 非索引化（UV 一并展开）
      const P = new Float32Array(nf * 9);
      const N = nrm.normals;
      const I = new Uint32Array(nf * 3);
      const U = hasUV ? new Float32Array(nf * 6) : null;
      for (let f = 0; f < nf; f++) {
        for (let k = 0; k < 3; k++) {
          const vi = indices[f * 3 + k];
          P[f * 9 + k * 3] = positions[vi * 3];
          P[f * 9 + k * 3 + 1] = positions[vi * 3 + 1];
          P[f * 9 + k * 3 + 2] = positions[vi * 3 + 2];
          if (U) { U[f * 6 + k * 2] = uvs[vi * 2]; U[f * 6 + k * 2 + 1] = uvs[vi * 2 + 1]; }
          I[f * 3 + k] = f * 3 + k;
        }
      }
      posArr = P; nrmArr = N; idxArr = I; uvArr = U;
    } else {
      nrmArr = nrm.normals; idxArr = indices;
    }
    const outVerts = posArr.length / 3;

    const bb = bbox(posArr);
    const posBytes = posArr.byteLength;
    const nrmBytes = nrmArr.byteLength;
    const uvBytes = hasUV ? uvArr.byteLength : 0;
    const idxBytes = idxArr.byteLength;
    const idxOff = posBytes + nrmBytes + uvBytes;

    const bin = new Uint8Array(idxOff + idxBytes);
    bin.set(new Uint8Array(posArr.buffer, posArr.byteOffset, posBytes), 0);
    bin.set(new Uint8Array(nrmArr.buffer, nrmArr.byteOffset, nrmBytes), posBytes);
    if (hasUV) bin.set(new Uint8Array(uvArr.buffer, uvArr.byteOffset, uvBytes), posBytes + nrmBytes);
    bin.set(new Uint8Array(idxArr.buffer, idxArr.byteOffset, idxBytes), idxOff);

    const bufferViews = [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: nrmBytes, target: 34962 }
    ];
    const accessors = [
      { bufferView: 0, componentType: 5126, count: outVerts, type: 'VEC3', min: bb.min, max: bb.max },
      { bufferView: 1, componentType: 5126, count: outVerts, type: 'VEC3' }
    ];
    const attributes = { POSITION: 0, NORMAL: 1 };
    if (hasUV) {
      bufferViews.push({ buffer: 0, byteOffset: posBytes + nrmBytes, byteLength: uvBytes, target: 34962 });
      accessors.push({ bufferView: 2, componentType: 5126, count: outVerts, type: 'VEC2' });
      attributes.TEXCOORD_0 = 2;
    }
    bufferViews.push({ buffer: 0, byteOffset: idxOff, byteLength: idxBytes, target: 34963 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5125, count: idxArr.length, type: 'SCALAR' });

    const json = {
      asset: { version: '2.0', generator: 'Local 3D Simplifier (offline)' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes, indices: accessors.length - 1, mode: 4 }] }],
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews,
      accessors
    };
    let js = JSON.stringify(json);
    while (js.length % 4 !== 0) js += ' ';
    const jsBytes = new TextEncoder().encode(js);
    let binPad = bin.byteLength;
    while (binPad % 4 !== 0) binPad++;
    const total = 12 + 8 + jsBytes.byteLength + 8 + binPad;
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsBytes.byteLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    u8.set(jsBytes, 20);
    const bo = 20 + jsBytes.byteLength;
    dv.setUint32(bo, binPad, true);
    dv.setUint32(bo + 4, 0x004e4942, true);
    u8.set(bin, bo + 8);
    return new Blob([out], { type: 'model/gltf-binary' });
  }

  /* ---------------- 统一入口 ---------------- */
  async function loadBuffer(buf, filename) {
    const lower = (filename || '').toLowerCase();
    let raw;
    if (lower.endsWith('.fbx')) raw = await parseFBX(buf);
    else if (lower.endsWith('.glb') || lower.endsWith('.gltf')) raw = parseGLB(buf);
    else if (lower.endsWith('.obj')) raw = parseOBJ(new TextDecoder().decode(buf));
    else if (lower.endsWith('.stl')) raw = parseSTL(buf);
    else if (lower.endsWith('.ply')) raw = parsePLY(buf);
    else if (lower.endsWith('.off')) raw = parseOFF(new TextDecoder().decode(buf));
    else {
      // 猜
      const head = new Uint8Array(buf, 0, Math.min(24, buf.byteLength));
      let isFbxBinary = head.length >= 18;
      const fbxMagic = 'Kaydara FBX Binary  ';
      for (let i = 0; i < fbxMagic.length && isFbxBinary; i++) if (head[i] !== fbxMagic.charCodeAt(i)) isFbxBinary = false;

      if (head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46) raw = parseGLB(buf);
      else if (isFbxBinary) raw = await parseFBX(buf);
      else {
        const txt = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(4000, buf.byteLength)));
        if (/^\s*ply/m.test(txt)) raw = parsePLY(buf);
        else if (/^\s*;.*FBX/m.test(txt) || /FBXHeaderExtension/.test(txt)) raw = await parseFBX(buf);
        else if (/^\s*(OFF|COFF)\s/m.test(txt) || /^\s*\d+\s+\d+\s+\d+\s*$/m.test(txt.split(/\r?\n/)[0] || '')) raw = parseOFF(txt);
        else if (/^\s*solid/i.test(txt) && /facet/i.test(txt)) raw = parseSTL(buf);
        else if (/^\s*(v|f|o|g|mtllib)\s/m.test(txt)) raw = parseOBJ(new TextDecoder().decode(buf));
        else raw = parseSTL(buf);
      }
    }
    const w = weld(raw.positions, raw.indices, raw.uvs || null);
    w.name = (filename || 'model').replace(/\.[^.]+$/, '');
    w.raw = raw;                       // 保留未焊接版本，供「保留 UV」开关重新焊接
    w.hasUV = !!(w.uvs && w.uvs.length);
    return w;
  }

  return {
    parseSTL, parseOBJ, parseGLB, parsePLY, parseOFF, parseFBX,
    assemble, weld, simplify, simplifyQEM, initEngine, engineName,
    computeNormals, bbox,
    exportOBJ, exportSTL, exportGLB, loadBuffer, emptyMesh
  };
});
