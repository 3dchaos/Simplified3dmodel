// 把 meshopt-global.js 与 mesh-core.js 内联进 index.html，产出单文件版
const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');
const mo = fs.readFileSync('meshopt-global.js', 'utf8');
const core = fs.readFileSync('mesh-core.js', 'utf8');

const tagMo = '<script src="meshopt-global.js"></script>';
const tagCore = '<script src="mesh-core.js"></script>';
if (!html.includes(tagMo)) throw new Error('未找到 meshopt-global.js 引用标记');
if (!html.includes(tagCore)) throw new Error('未找到 mesh-core.js 引用标记');

const inline = (s) => '<script>\n' + s.replace(/<\/script>/gi, '<\\/script>') + '\n</script>';
// 用函数式替换，避免 base64 里的 $ 被当成替换模式
html = html.replace(tagMo, () => inline(mo));
html = html.replace(tagCore, () => inline(core));

const name = '3D模型简化器-离线单文件版.html';
fs.writeFileSync(name, html);
console.log(name + ' 已生成，大小 ' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
