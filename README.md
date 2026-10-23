# 3D 模型简化器 · 本地离线版

原站 `tiny-online.tools` 的 3D 模型简化器加载极慢，本目录是一个功能对等的**完全离线**替代实现：
双击 HTML 就能用，不联网、不装软件、不上传模型，**保留 UV**，并且用的是**与原站同一份简化算法**（meshoptimizer）。

## 为什么原站那么慢

实测（从中国大陆访问）：

| 指标 | 实测值 | 说明 |
|---|---|---|
| 边缘节点 | `CF-RAY: ...-LAX` | Cloudflare 把请求调度到**洛杉矶**，不是国内或香港节点 |
| TLS 握手 | 2.7 s | 跨境握手，每次新建连接都要付 |
| 首字节 TTFB | 5.0 s | 服务器响应前就要等 5 秒 |
| 整页加载 | > 90 s 未完成 | 单页文档 457 KB（gzip 后仍有 154 KB） |
| 首屏阻塞资源 | `fonts.googleapis.com`、`googletagmanager.com` | **这两个域名在国内被阻断**，浏览器会一直挂起重试，直到超时才渲染 |

结论：慢的主因不是"服务器算得慢"，而是
1. 站点在海外 + Cloudflare 调度到美西；
2. 页面把 Google Fonts 和 Google Tag Manager 放在首屏关键路径上，国内直接卡死；
3. 首屏 HTML 太大（SSR 把整站工具列表都塞进了一页）。

好消息是：它所有工具都是**纯浏览器端运算**（页面原文写着"无需上传"、"在浏览器中处理"），
所以完全可以本地化——本目录就是证明。

## 怎么用

- **单文件版**：`3D模型简化器-离线单文件版.html` —— 双击即用，可随意复制、发给别人。
- **开发版**：`index.html` + `mesh-core.js` —— 便于修改；改完运行 `node build.js` 重新打包单文件版。

操作流程：

1. 拖入或点选模型（GLB / GLTF / **FBX** / OBJ / STL / PLY / OFF）
2. 拖滑块选保留比例，或直接填目标面数
3. 点「开始简化」，左右视图同步对比（可勾选线框看拓扑）
4. 导出 GLB / OBJ / STL

快捷键：`Enter` = 开始简化。视图：左键旋转、滚轮缩放、右键平移。

## 简化引擎（关键）

原站没有自己写简化算法。扒开它的前端分块后确认：

```js
// 原站 tool-KoNvYAoO.js 里的实际调用
const h = Math.floor(ratio * indexCount / 3) * 3;
const [indices, err] = MeshoptSimplifier.simplify(
  indices, positions, 3, h, error, lockBorder ? ["LockBorder"] : []
);
```

也就是说它用的是 **meshoptimizer**（Arseny Kapoulkine 的 WASM 简化器，MIT 许可），
通过 `@gltf-transform/functions` 的 `simplify()` 调用。

本版直接内嵌了**同一个 wasm 模块**（`meshopt-global.js`，118 KB，base64 内联，零外部请求），
参数也按原站的公式传。所以同等输入下结果是**逐索引完全一致**的（`test-equivalence.js` 验证）。

meshoptimizer 与普通 QEM 的差别，也是"同等面数下观感不同"的根本原因：

| | 手写 QEM | meshoptimizer |
|---|---|---|
| 顶点位置 | 会移动到四元数最优解 | **从不移动**，只删除顶点并重连 |
| 表面偏差 | 凹凸球 10% 时均值 2.5e-4 相对尺寸 | **精确 0**（输出顶点都在原表面上） |
| 硬边 | 直角会被磨圆 | 立方体压到 1% 仍是精确直角 |
| 退化/翻面 | 需要额外守卫 | 内部保证拓扑与朝向 |

顶点不移动这一点特别关键：面数减到 10% 时，表面不会出现"轻微起伏"的塑料感，
轮廓也不会漂移——这就是原站看起来更"干净"的原因。

原站的手写 QEM 仍保留在 `mesh-core.js` 里作为回退（wasm 加载失败时自动切换），
它的堆会定期重建以避免惰性删除堆积（早期版本会卡在某个面数下不去，已修）。

## 功能对照

| 功能 | 原站 | 本地版 |
|---|---|---|
| 核心算法 | meshoptimizer（WASM） | **同一份 meshoptimizer（WASM）** |
| 保留比例滑块 | ✅ 1–100% | ✅ 1–100% |
| 指定目标面数 | 只能按比例推算 | ✅ 可直接填 |
| 误差上限 | ✅ 滑块 0.001–0.1，默认 0.01 | ✅ 同范围、同默认值 |
| 顶点焊接 | 可开关，仅当全部属性相同才合并 | 可开关，按 (位置, UV) 合并（对 STL 更有效） |
| 边界锁定 | 可开关，默认关 | ✅ 可开关，默认关 |
| **保留 UV** | ✅ | ✅（见下文） |
| 保护 UV（属性感知简化） | ❌ | ✅ 额外提供，可选 |
| 左右对比视图 | ✅ | ✅ |
| 线框叠加 | ✅ | ✅ |
| 导出 | GLB / STL / OBJ / PLY | GLB / OBJ / STL |
| 输入格式 | GLB/GLTF/OBJ/STL/PLY/FBX/DAE/3MF/OFF | GLB/GLTF/**FBX**/OBJ/STL/PLY/OFF |
| 外部请求 | 字体、统计、第三方脚本 | **0 个** |

未支持：DAE、3MF（DAE 是 XML 需要完整 COLLADA 解析，3MF 是 zip 容器）；PLY 导出（读取支持）。

两处有意保留的差异：

- **焊接策略**：原站要求所有属性完全一致才合并，所以带逐面法线的 STL 几乎合并不动，
  它会提示"焊接几乎没合并任何顶点"。本版按 (位置, UV) 合并，STL 也能正常减面。
- **多材质模型**：原站按 glTF primitive 逐个简化（每个 primitive 各分到 ratio%），
  本版把所有 primitive 合成一个网格统一简化，误差预算分配更合理。

## UV 保留

顶点被定义为 **位置 + UV 的二元组**，整条链路（解析 → 焊接 → 简化 → 导出）都携带 UV。

**四个关键点**

1. **按 (位置, UV) 焊接**
   接缝两侧位置相同但 UV 不同，必须保持为两个独立顶点。只按位置焊接会把 UV 抹平——这正是早期版本丢 UV 的原因。

2. **接缝顶点锁定位置**
   接缝顶点成对存在。若一侧被收缩移动而另一侧不动，模型会**裂开**。
   所以：一端在接缝上 → 收缩目标强制落到该端点上；两端都在接缝上 → 直接放弃这次收缩。
   代价是接缝线保持原始分辨率，实测对压缩率影响很小（见下）。

3. **UV 随收缩插值**
   目标点的 UV 按「目标位置投影到边上的比例 t」线性插值：`uv = uv0 + (uv1 - uv0) * t`。
   当目标被强制到端点时 t = 0 或 1，UV 精确等于该端点的原值。

4. **UV 退化守卫**
   收缩前检查所有受影响面的 UV 面积，若某个面会塌成 0（贴图上会出现破洞），放弃这次收缩。
   注意：同时含边两端点的面本来就会退化成线并被删除，不参与该检查。

**导出**

| 格式 | UV 承载方式 |
|---|---|
| GLB | `TEXCOORD_0` 访问器（VEC2 float），平直着色模式也会正确展开 |
| OBJ | `vt` 行 + `f v/vt` 索引 |
| STL | **不支持**，导出时只写几何并提示 |

V 轴约定：内部统一用 glTF 约定（原点左上）。OBJ / FBX 原点在左下，导入时 `v = 1 - v`、导出时再翻回去，所以往返无损。

**「保留 UV」开关**

勾选（默认，文件含 UV 时自动勾上）：保留 UV，接缝锁定。
取消：退回纯位置焊接，接缝合并、UV 丢弃，可获得更高的压缩率。

**实测**

| 场景 | 结果 |
|---|---|
| UV 球体 2304 面 → 461 面（80%） | UV 面积漂移 < 12%，退化 UV 三角形 0，接缝顶点位移 0 |
| 目标 10% 压缩率 | 仍可达成（接缝锁定未显著阻碍减面） |
| GLB 往返 | UV 数值误差 0 |
| OBJ 往返 | UV 数值误差 5e-7（`toFixed(6)` 精度） |
| Avocado.glb（682 面，真实带贴图模型） | 682 → 136 面，UV 完整 |

**未做**：贴图本身不随模型导出（材质、图片、采样器都没有搬运），只保证 UV 坐标可用，方便你在自己的管线里重新挂贴图。

## FBX 支持说明

两种容器都支持：

| 类型 | 说明 |
|---|---|
| 二进制 FBX | 7.0–7.7 全版本，含 7500 以上记录的 **64 位偏移**；zlib 压缩数组用 `DecompressionStream` 解压 |
| ASCII FBX | 按大括号配对扫描，提取 `Geometry` / `Model` / `Connections` |

变换链按 FBX SDK 公式还原：
`T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹`，
支持 `Lcl Translation/Rotation/Scaling`、Pre/PostRotation、Rotation/ScalingPivot、RotationOffset、RotationOrder（6 种欧拉序），
并通过 `Connections` 的 `OO` 关系沿父级链累乘，多网格场景会合并。

**已验证的真实文件**
- Mixamo 角色（二进制 FBX 7700，3 MB，64 位偏移 + 压缩数组）：49,112 面 → 解析 203 ms，包围盒 Y 轴 0–180.89（180 cm 站立人体，说明变换正确）
- Stanford Bunny（ASCII FBX 7.5.0，8 MB）：30,338 面 → 解析 68 ms

**已知限制**
- 只取静态网格几何：骨骼、蒙皮权重、动画、材质、贴图全部忽略（对减面来说不影响）
- 只读取 `PolygonVertexIndex` 多边形，NURBS / Subdiv 曲面不展开（这类文件会报没有找到可读取的网格）
- 单位不换算：保留文件原始单位（FBX 常以 cm 计），视图会自动适配，导出也不会改尺寸

## 技术说明

- `mesh-core.js`：零依赖，约 900 行。包含 STL（二进制/ASCII）、OBJ、GLB、PLY（ASCII/二进制）、OFF、FBX 解析，
  顶点焊接，简化调度，法线计算，GLB/OBJ/STL 导出。
- `meshopt-global.js`：meshoptimizer v0.21 的浏览器全局版（118 KB，wasm 以 base64 内联）。
  `mesh-core.js` 里的 `initEngine()` 会等它 `ready` 后接管简化。
- 回退算法：Garland-Heckbert 四边形误差度量。每个顶点维护 10 个对称 4×4 二次型系数，
  边折叠代价取最优收缩点的误差，用带惰性失效的二叉堆调度，边界边附加约束平面。
  惰性删除会让堆里堆积过期条目，所以每 4 万次失效弹出就重建一次堆（早期版本因此会卡在某个面数下不去）。
- 渲染：手写 WebGL（WebGL2 优先，回退 WebGL1 + `OES_element_index_uint`），
  按 62° 折角拆分顶点以保留硬边。
- 实测性能（单线程，Chrome / Edge）：
  - meshoptimizer：15,452 面 → 3,322 面，**< 1 ms**
  - 手写 QEM：16 万面 → 10%（1.6 万面）约 0.9 s
  - 拓扑质量：欧拉特征保持 2（球体无破洞），退化面 0，硬边在 1% 压缩下仍精确保持

上限：单文件 90 万面以内（超过会提示先预处理）。

## 自检脚本

```bash
node build.js                                  # 重新生成单文件版
node test-core.js                              # 算法正确性（欧拉特征、偏差、格式往返）
node test-equivalence.js                       # 与原站算法逐索引等价 + QEM 质量对比
node test-hardedge.js                          # 硬边保留（立方体压到 1% 仍是直角）
node test-seam.js                              # UV 接缝在简化后是否裂开
node test-fbx.js                               # FBX 解析：32/64 位偏移、zlib、变换、ASCII（17 项断言）
node test-uv.js                                # UV：接缝不裂、面积守恒、退化守卫、格式往返（30 项断言）
node test-formats.js                           # PLY / OFF / 误差阈值
node run-test.js "3D模型简化器-离线单文件版.html"   # 无头浏览器跑完整流程
node run-test-engine.js "<页面.html>"              # 浏览器里确认引擎加载与 UV 保留
node run-test-visual.js <模型> <比例%> <截图名> "<页面.html>" [线框1/0] [锁边界1/0]
node run-test-fbx.js <文件.fbx> <截图名> "<页面.html>"   # 用真实 FBX 在浏览器里跑完整流程
node run-test-uv.js "<页面.html>"                 # 浏览器里验证 UV 全链路 + 开关行为
```
