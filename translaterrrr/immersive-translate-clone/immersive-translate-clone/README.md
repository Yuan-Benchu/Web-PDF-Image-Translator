# 沉浸式翻译（简化版）

网页双语对照翻译 Chrome 插件，Manifest V3。默认使用免费翻译接口，也可在设置中切换为 Google Gemini（需自备 API Key）。

## 安装方法（开发者模式加载）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目文件夹（`immersive-translate-clone`）
5. 打开任意网页，点击浏览器工具栏中的插件图标，点「在此页面开启翻译」
   （也可用快捷键 Alt+T 切换）

## 功能

- 扫描网页正文文本，在每个段落下方插入译文（双语对照）
- 支持动态加载内容（如无限滚动页面）的持续翻译
- 三种翻译引擎可选（设置页切换）：
  - **免费引擎**：调用 Google 翻译公开接口，无需配置，有一定频率限制
  - **Gemini 引擎**：填入自己的 Gemini API Key（https://aistudio.google.com/apikey）
  - **DeepSeek 引擎**：填入自己的 DeepSeek API Key（https://platform.deepseek.com/api_keys）
- 可设置目标语言（中文/英文/日文/韩文等）

## 已知限制 / 后续可扩展方向

- 未做请求频率控制，短时间大量翻译免费接口可能被限流 → 可加入重试与排队
- 未处理 PDF、视频字幕翻译（沉浸式翻译原版功能）→ 需要单独模块
- 未做「划词翻译」「输入框翻译」等交互功能
- 未做多语言 UI（当前设置界面为中文）
- 图标为占位图，可自行替换 `icons/` 下的 PNG

## 文件结构

```
manifest.json     插件配置（MV3）
background.js     后台 service worker，实际发起翻译请求
content.js        内容脚本，扫描页面 DOM 并插入译文
content.css       译文展示样式
popup.html/js     工具栏弹窗，开关当前页翻译
options.html/js   设置页，选择引擎/语言/填写 API Key
icons/            插件图标
```
