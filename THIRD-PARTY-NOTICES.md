# 第三方组件声明

## meshoptimizer

- 文件：`meshopt-global.js`、`meshopt.mjs`
- 版本：v0.21（取自原站前端分块 `index-BMxv2MNV.js`，未作修改，仅把 ESM 导出改写为浏览器全局变量）
- 作者：Arseny Kapoulkine
- 许可：MIT License
- 仓库：https://github.com/zeux/meshoptimizer

```
MIT License

Copyright (c) 2016-2024 Arseny Kapoulkine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 关于原站

本项目是 `tiny-online.tools` 上 3D 模型简化器的独立离线实现，为复刻其行为而分析了其公开的前端代码，
并调用同一套开源算法库（meshoptimizer）。原站的业务代码、样式、文案均未复制。
