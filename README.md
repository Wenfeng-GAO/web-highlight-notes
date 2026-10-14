# web-highlight-notes

在网页上划线、写评论，并用 Chrome 侧边栏汇总、导出 Markdown 的扩展（Manifest V3，版本 0.1.2）。

## 功能

- 选中网页文字后出现工具条，可以「划线」或「划线+评论」。输入框、文本域和 `contenteditable` 区域不会弹出工具条。
- 点击划线打开评论气泡，可以编辑评论或删除划线。⌘/Ctrl+Enter 保存，Esc 关闭。没保存的草稿会留下来，再次打开时恢复。
- 侧边栏顶部是页面摘要，输入时防抖保存，失焦或离开页面时立即落盘。下面是页面标题、「x 条划线 · y 条评论」和「导出 MD」。
- 划线按在页面中的顺序排列。点击一条会滚到对应位置并闪一下。
- 正文改了、找不到原句时，这条划线仍会保留，并标成「⚠ 未定位」，导出时也会带上。
- 「导出 MD」把笔记复制到剪贴板，同时下载 `.md` 文件。按钮会显示「已复制 ✓」约 1.5 秒。

笔记存在 `chrome.storage.local`，键是去掉 hash 的页面 URL。再次打开页面时，用原文加上前后约 30 个字重新定位，匹配可以跨过多个文本节点。

## 安装

先运行 `npm run build`，得到 `dist/web-highlight-notes-v0.1.2.zip`。

先解压 zip → 打开 chrome://extensions → 开启「开发者模式」 → 点击「加载已解压的扩展程序」选择解压后的目录。

然后点击工具栏图标，侧边栏会打开。

## 使用

1. 打开普通网页，选中一段文字，点「划线」或「划线+评论」。
2. 在气泡里写评论。⌘/Ctrl+Enter 或「保存」会记下评论；Esc 只关闭气泡，草稿还在。
3. 打开侧边栏，写这一页的摘要。点列表里的划线可以跳回正文。
4. 点「导出 MD」。文件里包含标题、来源、摘要，以及每条划线和它的评论。

## 开发与测试

```bash
npm install
npm test
npx playwright install --with-deps chromium
xvfb-run npm run e2e
npm run build
```

- `npm test`：锚定（含重复文本消歧、原文改变后失败）和 Markdown 导出的单元测试。
- `npm run e2e`：Playwright 加载未打包扩展，对本地文章页跑端到端场景。需要图形界面；没有显示器时用 `xvfb-run`。
- `npm run build`：生成 `dist/web-highlight-notes-v0.1.2.zip`，压缩包根目录就是 `manifest.json`。
