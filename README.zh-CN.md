# site-mirror

[English README](./README.md)

一个可把网页镜像到本地离线目录的 CLI 工具。

给它一个 URL，它会下载页面 HTML、CSS、JS、图片、字体、媒体等静态资源，并把页面里的资源引用改写成本地相对路径，生成一个可以直接离线打开的快照目录。

## 能力

- 下载入口页面 HTML
- 下载页面引用的 CSS、JS、图片、字体、媒体资源
- 重写 HTML 中的 `src`、`href`、`srcset`、内联 `style`
- 重写 CSS 中的 `@import` 和 `url(...)`
- 可按深度抓取同域页面，并把页面链接改写为本地文件
- 自动生成离线入口文件 `index.html`
- 生成 `mirror-report.json` 报告

## 边界

这个工具镜像的是浏览器能拿到的前端资源，不是目标站点的服务器端源码。

拿不到的内容包括：

- 后端代码
- 数据库
- 运行时接口背后的服务逻辑
- 登录态后端页面中未暴露给浏览器的内容
- 依赖浏览器执行后再动态请求、且页面源码里没有直接暴露的全部运行链路

## 环境要求

- Node.js 20+

## 安装

```bash
npm install
npm run build
```

## 使用

基础用法：

```bash
node dist/cli.js mirror https://example.com
```

指定输出目录：

```bash
node dist/cli.js mirror https://example.com -o ./snapshots/example
```

抓取当前页面加一层站内页面：

```bash
node dist/cli.js mirror https://example.com --depth 1
```

## 常用参数

- `-o, --output <dir>` 输出目录
- `--depth <number>` 站内 HTML 页面抓取深度，默认 `0`
- `--concurrency <number>` 并发下载数，默认 `8`
- `--timeout <ms>` 单请求超时，默认 `20000`
- `--retries <number>` 失败重试次数，默认 `2`
- `--page-scope <scope>` 页面抓取范围：`same-origin`、`same-host`、`all`
- `--asset-scope <scope>` 静态资源抓取范围：`same-origin`、`same-host`、`all`
- `--user-agent <ua>` 自定义 HTTP `User-Agent`
- `--keep-integrity` 保留 SRI 属性，默认会移除被本地重写资源上的 `integrity`
- `--verbose` 输出下载过程

## 输出结构

执行后会生成类似目录：

```text
mirror-output/
  index.html
  mirror-report.json
  pages/
  assets/
```

- `index.html` 是离线入口
- `pages/` 存放镜像后的 HTML 页面
- `assets/` 存放 CSS、JS、图片、字体等资源
- `mirror-report.json` 记录下载结果和失败项

## 开发

```bash
npm test
npm run build
```
