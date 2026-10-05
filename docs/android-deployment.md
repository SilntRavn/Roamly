# 漫迹 Android 安装与部署

## 已部署的地址

- 手机入口：`http://6.6.6.6:18080`
- APK 下载：`http://6.6.6.6:18080/download/roamly.apk`
- 安装包：`artifacts/apk/Roamly-1.0.2-arm64.apk`，包名 `com.roamly.app`，Android 8.0+，仅 ARM64 手机。
- Nginx：18080；生产 Node 后端：127.0.0.1:24173。
- 4173 的测试进程不停止、不切换配置；Nginx 默认配置不修改，不启动 80 端口。

手机需要加入与电脑相同的内网穿透网络，能访问 `6.6.6.6`。该 IP 是穿透软件的虚拟网卡地址，不代表普通公网或手机流量直接可达。安装时按系统提示允许当前下载应用安装 APK。

APK 内置 Mozilla GeckoView 157.0.20260924084938 加载电脑上的生产网页，包含原生定位、剪贴板、行程文件保存以及系统文件选择器。账号、AI 规划、高德接口和数据仍在电脑端运行，电脑及穿透软件需要保持在线。连接失败会显示重试入口。内核随 APK 更新，不依赖手机上的 Android System WebView 版本。

页面动画直接使用网页版 `src/motion.tsx` 和 `src/styles.css` 的实现：主导航为 420ms 圆形展开，待删除卡片为 180ms 往复抖动，其他动画也保留原有帧、时长和缓动。应用启动和恢复前台时请求同分辨率的 120Hz 显示模式；没有固定 60fps 的定时器或内核限帧配置，绘制跟随屏幕垂直同步。120Hz 屏幕在系统允许且性能足够时可绘制 120fps；60Hz 屏幕最多显示 60fps。手机的省电和应用刷新率设置也会影响实际结果。

目前按提供的 IP 使用 HTTP。仅此 IP 允许明文连接；将来若配置域名和 HTTPS，重新打包时传入 `-ServerUrl https://你的域名`，不要关闭证书校验。

## 启动、更新网页

在项目目录的 PowerShell 中运行：

```powershell
./scripts/start-deployment.ps1 -Build
```

不需要更新网页时可省略 `-Build`。脚本检查自己的 PID；被其他进程占用的端口不会自动终止。更新 `server/` 或密钥后，用下面的停止脚本停止生产服务，再重新启动。

生产数据库：`data/production.sqlite`。首次启动使用 SQLite 在线备份从 `data/roamly.sqlite` 复制现有账号和行程，此后完全独立，测试数据库的后续变化不会同步进来。生产日志在 `deploy/run/`。启动脚本当前使用本机 Node 25.9.0；需支持 `node:sqlite` 的 `backup` 函数。

## 停止生产服务

```powershell
./scripts/stop-deployment.ps1
```

只停止此部署的 Nginx 与生产后端，保留现有测试服务。

## 重新生成 APK

```powershell
./scripts/build-apk.ps1
# 更换地址：
./scripts/build-apk.ps1 -ServerUrl http://6.6.6.6:18080
```

默认 SDK：`C:\WorkSpace\android-sdk`；JDK：`C:\WorkSpace\roamly-jdk21\jdk-21.0.12.1+1`；Gradle：`C:\WorkSpace\gradle-9.6.0`。可通过 `-SdkRoot`、`-JdkRoot`、`-GradleRoot` 覆盖。构建使用官方 Build Tools 37.0.0 / Android 37.1 平台、AGP 9.4.1，目标 Android 35。完整 JDK 必须包含 `jlink`。Gradle 会合并内核服务、资源和原生库，首次需要下载 Maven 依赖。本机官方 Gecko AAR/POM 缓存在忽略的 `android/vendor/maven/`，其他机器可从 Mozilla Maven 下载相同版本。

默认关闭内核远程调试。`-DebugEngine` 仅用于本地排查，交付前重新运行默认构建。调试包包含动画验证脚本，只有以 `qa=true` Intent 启动时运行；发布包不包含该脚本。发布新版本前更新 `android/build.gradle` 的 `versionCode`、`versionName` 与构建脚本/下载配置里的文件名。

1.0.2 仅打包 `arm64-v8a`，通过 `jniLibs.useLegacyPackaging=true` 压缩原生库，安装时由 Android 解压。APK 为 94,606,713 字节（约 94.6MB / 90.2MiB），比 1.0.1 通用包减少 82.03%。13 个 ARM64 原生库解压后的 SHA-256 与 1.0.1 完全相同，Gecko 内核、原有动画和 120Hz 请求代码不变。构建脚本会检查 ARM64 限定与压缩是否生效。

签名沿用 1.0.0，可在 ARM64 手机上覆盖安装。Gecko 与旧 WebView 的登录 Cookie 不共用，从旧 WebView 版本升级后可能需要重新登录，电脑端账号及行程数据不受影响。

**保存好 `android/signing/roamly-release.p12` 和 `android/signing/password.txt`**。这是当前 APK 的专用签名资料，已加入忽略列表。后续覆盖安装需使用同一签名，不要删除或公开这些文件。首次生成的是本项目专用签名，不是 Android 通用调试签名。

## 验证

- Web 构建：`npm run build`
- 现有回归测试：`npm test`
- APK 构建脚本自动检查 APK 签名与 ZIP 对齐。
- 可先用手机浏览器访问入口，再安装 APK；定位权限仅在点击定位时申请。
- 行程导出打开系统“保存文件”界面；取消不会提示导出成功。导入通过系统文件选择器读取 `.roamly` 文件。
- 1.0.1 通用 Gecko 调试包在本机 Android 9 模拟器中验证了四项原有菜单切换、待删除抖动及确认时暂停、卡片入场、按钮弹跳、弹窗入场和原生复制。完整记录在 `artifacts/apk/gecko-motion-qa.json`，无测试异常。显示模式接受 120Hz 请求，但本机模拟器实际 rAF 约 34.9fps，未证明真机跑满 120fps。
- 1.0.2 的签名、ARM64 限定、压缩、安装解压标记及与上一版内核内容一致性均已校验。完整记录在 `artifacts/apk/arm64-packaging-verification.json`；本机没有 ARM64 真机，因此本次未宣称真机运行测试通过。
- 模拟器缺少系统文件保存器，完整导入/导出及真实 GPS 坐标仍需在手机上确认。

实现参考：[GeckoView](https://firefox-source-docs.mozilla.org/mobile/android/geckoview/index.html)、[GeckoView 原生消息](https://firefox-source-docs.mozilla.org/mobile/android/geckoview/consumer/web-extensions.html)、[APK 签名工具](https://developer.android.com/tools/apksigner)。第三方许可见 `android/assets/THIRD_PARTY_NOTICES.txt`。
