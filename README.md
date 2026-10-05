# 漫迹 Roamly

漫迹是一款旅行规划应用。用自然语言描述目的地、天数和出行偏好，通过 AI 对话生成和调整行程，再结合地图查看景点、路线与每日安排。

项目提供响应式网页和 Android APK，手机与桌面共用同一套界面。Android 版内置 GeckoView 浏览器内核，账号、行程数据、AI 和地图服务由 Node.js 后端提供。

<img src="docs/images/android-home.png" alt="漫迹 Android 首页" width="280" />

## 功能

- **AI 旅行规划**：连续对话生成、修改路线，保存出行约束，提供进度、取消和重试。
- **地图与景点**：高德地点检索、交通路线、分类 POI、景点详情和照片；支持步行、公共交通、自驾和智能选择。
- **附近探索**：独立于行程的景点、美食、住宿、玩乐分类地图；三档地图/笔记面板，公开内容摘要与来源、地点详情卡片，加入行程后直接与 AI 旅伴继续安排。
- **行程管理**：每日时间线、手动调整、收藏、草稿、待删除状态及旅行足迹。
- **账号与分享**：用户名登录、多设备访问、个人偏好、分享快照与链接撤回。
- **文件交换**：导入、导出 `.roamly` 行程文件。
- **Android 集成**：原生定位、剪贴板、系统文件选择与保存，保留网页版动画，并请求 120Hz 显示模式。

AI 生成和修改行程需要登录，并配置可用的 AI 与地图服务。120Hz 设置不代表所有设备都能稳定绘制 120fps，实际帧率由屏幕、系统设置和性能决定。

## 技术栈

| 部分 | 实现 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 7、CSS、Web Animations / View Transitions |
| 后端 | Node.js、Express 5、Zod |
| 数据 | Node.js 内置 SQLite，账号、行程与偏好保存在本机数据库 |
| AI | 火山方舟 / 豆包，支持单独配置景点内容模型 |
| 地图 | 高德 Web 服务与 JavaScript API，服务端代理安全密钥 |
| Android | Java、GeckoView 157、Gradle 9.6、Android Gradle Plugin 9.4.1 |

## 本地运行

需要 **Node.js 22.13 或更高版本**；当前项目在 Node.js 25.9.0 上验证。以下命令适用于 PowerShell：

```powershell
git clone https://github.com/SilntRavn/Roamly.git
cd Roamly
npm ci
Copy-Item .env.example .env
```

编辑 `.env`，填写自己的服务配置，然后启动：

```powershell
npm run dev
```

浏览器打开 [http://localhost:4173](http://localhost:4173)。开发模式由 Express 提供 API，并使用 Vite 更新前端；修改后端或服务配置后需要重启进程。首次运行会自动创建 `data/roamly.sqlite`。

### 服务配置

`.env.example` 只包含配置模板，不包含真实密钥。

| 变量 | 用途 |
| --- | --- |
| `PORT` | 服务端口，默认 `4173` |
| `ARK_API_KEY`、`ARK_MODEL`、`ARK_BASE_URL` | AI 服务凭据、模型或推理接入点，以及 API 地址 |
| `ARK_CONTENT_API_KEY`、`ARK_CONTENT_MODEL`、`ARK_CONTENT_BASE_URL` | 可选的景点内容模型配置 |
| `AMAP_WEB_KEYS` | 高德 Web 服务 Key；多个 Key 用逗号分隔 |
| `AMAP_JS_KEY` | 高德 JavaScript API Key |
| `AMAP_SECURITY_JS_CODE` | 高德 JS 安全密钥，由服务端代理使用 |
| `AMAP_MAP_STYLE` | 可选的高德自定义底图样式 |
| `ROAMLY_HOST`、`ROAMLY_DB` | 可选的监听地址和数据库路径 |
| `ROAMLY_AI_MONITOR` | AI 调试监视配置，详见下方文档 |

项目也兼容本地 `key.txt` 配置，环境变量优先。账号密码使用 scrypt 加盐散列，会话使用 HttpOnly Cookie。真实密钥、数据库、用户导出文件与 Android 签名资料均不进入 Git。

### 常用命令

```powershell
npm run build           # TypeScript 检查与前端生产构建
npm start               # 使用 dist 启动生产服务，默认仍为 4173
npm test                # 本地回归测试
npm run check:services  # 检查已配置的外部服务，会发起网络请求
npm run eval:planner    # 规划评估，会调用已配置的服务
```

## 生产部署

项目包含一套 Windows Nginx 部署脚本。当前本机配置使用 Nginx `18080` 和仅监听回环地址的后端 `24173`，保留原有 `4173` 测试服务，不使用 `80`。

```powershell
./scripts/start-deployment.ps1 -Build
./scripts/stop-deployment.ps1
```

这套脚本和 Nginx 配置含当前机器的目录与端口设置，在其他机器上使用前需调整路径。生产数据保存在 `data/production.sqlite`，与开发数据库独立。手机通过内网穿透地址访问时，电脑后端和穿透服务需要保持在线。

部署地址、启动停止方法、数据库初始化与日志位置见 [Android 安装与部署说明](docs/android-deployment.md)。公开部署应使用 HTTPS，并自行安排数据库备份。

## Android APK

当前版本为 **1.0.2**，仅支持 **ARM64 / Android 8.0+**。APK 内置 GeckoView 157，原生库使用压缩打包，当前发布包约 **94.6MB**。

APK 加载部署后的网页，业务数据仍在服务端；更新网页通常无需重新打包，修改内核、原生功能或服务器地址则需要生成新 APK。

构建前需要准备：

1. 完整 JDK 21、Gradle 9.6.0。
2. Android SDK Platform 37.1 和 Build Tools 37.0.0。
3. 自己的 `android/signing/roamly-release.p12`（别名 `roamly`）及 `android/signing/password.txt`。

签名文件不在仓库中。已有版本的维护者需要恢复原签名才能覆盖更新；独立构建者使用自己的签名。构建依赖首次会从官方 Maven 仓库下载。

```powershell
./scripts/build-apk.ps1 -SdkRoot 'C:\path\to\android-sdk' -JdkRoot 'C:\path\to\jdk21' -GradleRoot 'C:\path\to\gradle-9.6.0' -ServerUrl 'https://your-domain.example'
```

默认输出为 `artifacts/apk/Roamly-1.0.2-arm64.apk`。构建脚本检查 ARM64 架构、原生库压缩、APK 签名和 ZIP 对齐。可用 `-DebugEngine` 生成调试包，发布包默认关闭远程调试且不包含动画验证脚本。

## 目录

```text
src/       网页界面、地图、动画与 Android 原生消息调用
server/    API、账号、SQLite、AI 规划和地图服务
shared/    数据结构、约束与前后端共用逻辑
public/    图标、图片等静态资源
android/   Android 外壳、GeckoView 配置与消息扩展
scripts/   构建、部署、服务检查和规划评估工具
deploy/    Nginx 配置
tests/     回归测试
docs/      项目文档
```

## 文档

- [Android 安装与部署](docs/android-deployment.md)
- [行程文件格式](docs/roamly-format.md)
- [AI 调试监视](docs/ai-monitor.md)
- [地图路线符号](docs/route-symbols.md)
- [附近探索与推荐笔记](docs/explore-notes.md)

仓库保存源代码、配置模板与必要静态资源。`node_modules`、`dist`、本机缓存、日志、APK、数据库、密钥和签名资料由本地生成或自行配置，不随源码上传。
