# Chrome Web Store：权限说明（0.1.5）

依据 0.1.5 的 `manifest.json`。Developer Dashboard → Privacy 页逐项填写。

| 权限 | 为什么需要 | 代码位置 | 商店说明（中文） | Store justification (English) |
|---|---|---|---|---|
| `storage` | 划线、评论、摘要和「此网站暂不授权」的选择都存在 `chrome.storage.local`，不上传 | `src/content/content.js`（`persist`、`init`、`onStorage`）、`src/sidepanel/sidepanel.js`（`persist`、`flushSummarySave`、`showTab`）、`src/background/service-worker.js`（`autoSites`、`clearDeclined`）、`src/prompt/prompt.js`（`decline`） | 把用户在网页上的划线、评论和页面摘要保存在本机（chrome.storage.local），刷新或重新打开页面后恢复；数据不上传、不共享。 | Saves the user's highlights, notes and page summaries locally in chrome.storage.local so they come back when the page is reopened. Nothing is uploaded or shared. |
| `sidePanel` | 侧边栏列出当前页划线、写摘要、导出 Markdown；点击图标打开 | `manifest.json` `side_panel`、`src/background/service-worker.js`（`setPanelBehavior`、`chrome.sidePanel.open`） | 在侧边栏列出当前页面的划线和评论，编辑页面摘要，并导出为 Markdown。 | Shows the current page's highlights and notes in the side panel, where the user writes a page summary and exports everything as Markdown. |
| `activeTab` | 用户点击工具栏图标（或快捷键）时，只对当前标签页注入划线脚本、读取页面网址 | `src/background/service-worker.js`（`action.onClicked` → `injectTab`） | 用户点击插件图标时，只在当前标签页启用划线并显示该页已保存的划线；不点击不会访问页面。 | When the user clicks the toolbar icon, enables highlighting on the current tab only and shows that page's saved highlights. Pages are not accessed without that click. |
| `scripting` | `executeScript`/`insertCSS` 在点击后注入；`registerContentScripts` 为用户授权的网站注册持久内容脚本，刷新后自动恢复划线 | `src/background/service-worker.js`（`injectTab`、`syncAutoScripts`） | 在用户点击图标后向当前页注入划线功能；对用户明确授权的网站注册内容脚本，以便刷新后自动显示划线。 | Injects the highlighter into the current tab after the user clicks the icon, and registers a content script only for sites the user explicitly allowed, so highlights reappear on reload. |
| `host_permissions`: `file:///*` | 本地 HTML 文件（`file://`）上划线并在刷新后自动恢复；只有用户在扩展详情里打开「允许访问文件网址」后才生效，不产生安装警告 | `manifest.json`、`src/background/service-worker.js`（`autoSites`、`siteStatus`）、`src/sidepanel/sidepanel.js`（`showTab`、`#notice`） | 让用户也能在本机保存的 HTML 文件上划线；仅在用户于扩展详情中开启「允许访问文件网址」后生效，不访问任何网站。 | Lets the user highlight local HTML files (file://). It only takes effect after the user turns on "Allow access to file URLs" for the extension, and grants no website access. |
| `optional_host_permissions`: `http://*/*`, `https://*/*`（安装时不授予） | 仅在用户点「允许」/「去授权」时，用 `chrome.permissions.request` 申请**当前这一个网站**（如 `https://example.com/*`），用于自动恢复划线 | `src/prompt/prompt.js`、`src/sidepanel/sidepanel.js`（`onGrant`）、`src/background/service-worker.js`（`permissions.onAdded`、`hasSite`） | 安装时不申请任何网站权限。用户在某个网站划线后，可选择只允许这一个网站，以便刷新页面后自动显示划线；拒绝也不影响保存和导出。 | No site access at install. After highlighting on a site, the user may allow that one site so highlights reappear automatically on reload. Declining still keeps, lists and exports the notes. |

已移除：`tabs`（侧边栏只在有权限的标签页读网址，`activeTab`/站点授权已覆盖；无权限时向页内脚本询问）、`host_permissions: <all_urls>`、静态 `content_scripts`。

远程代码：不使用。所有脚本都打包在扩展内。

单一用途：在网页上划线、写批注，并在侧边栏汇总导出 Markdown。
