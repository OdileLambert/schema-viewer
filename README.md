# SEO Inspector

> 原名 Schema Markup Viewer — 页面 SEO 诊断 Chrome 扩展

一键查看当前页面的 SEO 要素：

## 功能

1. **Content** — Title、Description、H1 概览，以及全部 Heading 层级（H1–H6）
2. **Indexability** — Canonical URL（Raw HTML / Rendered 对比）、Robots Meta Tag、Hreflangs
3. **Schema Markup** — JSON-LD / Microdata / RDFa 结构化数据查看、折叠、复制（支持 `@graph` 嵌套实体递归展开）
4. **Links** — 批量检测页面所有 `<a href>` 跳转链接的 HTTP 状态码（2xx / 3xx / 4xx / 5xx / 网络错误），展示完整跳转链与最终 URL，支持按状态筛选与一键复制
5. **访问记录** — 展示当前标签页最近一次主页面访问的 HTTP 状态码、服务器重定向路径和最终 URL；同一标签页再次访问会覆盖上次结果，关闭标签页时清除

### Links 检测说明

- 点击 **🔗 Links** 标签页后不会立即请求。点击「▶ 常规检测」时会重新读取主文档的链接，等待链接列表稳定约 1.2 秒（最长 7 秒）后再触发检测；「🔎 深度扫描」还会合并可访问 iframe 与开放 Shadow DOM 中的链接，但不会自动滚动页面。JJ's House 页面还会显示「🧭 导航扫描」，它会依次模拟顶级导航悬停并收集展开时出现的链接，但不会点击或跳转。结果缓存在内存，切标签不重复请求，点「🔄 刷新」重新检测。
- 请求策略：`HEAD` 优先，遇 403/405/501/400 降级 `GET`；单请求 8s 超时；并发池约 6；跟随重定向。
- 用 `webRequest` 抓完整跳转链（如 301 → 302 → 200），因 `fetch redirect:'manual'` 只能拿到 opaque 响应，读不到 3xx 具体码。
- 检测在 background service worker 中执行：popup 失焦即关闭，会中断批量请求，且扩展上下文 + `host_permissions` 可绕过 CORS。**检测期间建议用右上角 ⛶ 打开独立窗口**。

#### 已知局限

- 扩展身份发起的请求可能被站点风控（Cloudflare 等）返回 403/405，造成误报；
- 纯 JS 跳转（无 `href`、仅 `onclick`）的链接无法检测；
- 访问记录中的 HTTP code 来自浏览器主框架网络请求；从缓存/BFCache 恢复且没有网络响应的访问会显示为未知状态；
- 登录态页面以匿名身份请求（`credentials: omit`），结果可能与本人浏览不同；
- 页面链接较多时检测耗时较长（界面有进度提示）。

## 安装

```bash
# 1. 打开 Chrome 扩展管理
chrome://extensions/

# 2. 开启"开发者模式"
# 3. "加载已解压的扩展程序" → 选中本项目目录
```

## 配色

| 角色 | 色值 |
|------|------|
| 页面背景 | `#f7f3ec` 暖米色 |
| 卡片背景 | `#ffffff` 白色 |
| 主色/强调 | `#be8e3e` 琥珀金 |
| 主色深色 | `#9a6a30` 深琥珀 |
| 主色淡色 | `#e8d5b0` 浅金色 |
| 正文 | `#272422` 近黑暖棕 |
| 辅助文字 | `#8c857f` 暖灰 |
| 边框 | `#e6e0d8` 暖灰边 |
| JSON 键 | `#be8e3e` 琥珀金 |
| JSON 字符串 | `#4a8c5e` 暖绿 |
| JSON 数字 | `#c96b2e` 暖橙 |
| JSON 布尔 | `#7c5f4a` 暖棕 |
| JSON null | `#b8b2ac` 浅灰 |

## 文件结构

```
seo-viewer/
├── manifest.json      # Chrome 扩展清单（MV3）
├── popup.html         # 交互界面
├── popup.js           # 弹窗核心逻辑（提取 + 渲染）
├── background.js      # Service Worker（链接状态码批量检测）
├── styles.css         # DeepLumen 暖金风格样式
├── design-icons.js    # 图标像素生成脚本
├── icon16.png … 256px # 6 尺寸扩展图标
├── icon.svg           # SVG 源文件
└── README.md
```

## License

MIT
