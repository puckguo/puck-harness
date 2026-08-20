小重构：src/format.js 里 formatTag 拼接单词后再交给 slugify。请把它改为直接逐词 slugify（每个词各自转换后再用 - 连接），保持对外行为对常规输入不变；改完运行 npm test 确认不回归，并简述你动了哪些文件。
