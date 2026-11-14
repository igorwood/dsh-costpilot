# Install / uninstall dsh-costpilot (v0.1)

适用于本地开发验证。**不要**直接改 desktop profile（本 GUI 正在用），建议新建 `costpilot-test`。

## 前置
- macOS 上已安装 DeepSeek Harness（`dsh` CLI 在 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）
- `pnpm` 可用（插件管理会转发 pnpm）
- 目标 profile 有 `pnpm-workspace.yaml`（`--from-default-profile` 创建的 profile 自带）

## 安装
```bash
export DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
export PKG="/path/to/dsh-costpilot"

"$DSH" --profile costpilot-test --from-default-profile headless --dump-config >/dev/null
"$DSH" plugin --profile costpilot-test add "link:$PKG"
```

然后在 `~/.dsh/profiles/costpilot-test/cordis.patch.yml` 追加：

```yaml
- id: costpilot
  name: dsh-costpilot
  config:
    mode: observe
```

验证：
```bash
"$DSH" --profile costpilot-test --dump-config | grep -A2 costpilot
```

## 升级（本地 link）
改代码后无需重新安装；重启 DSH 或依赖 HMR 重新加载。若 profile 缓存了模块，重启即可。

## 卸载
```bash
"$DSH" plugin --profile costpilot-test remove dsh-costpilot
# 或直接删除测试 profile：
rm -rf ~/.dsh/profiles/costpilot-test
```

## 常见问题
- `add` 报 pnpm 错误：确认 `pnpm -v`、profile 目录存在、网络/代理可用（link 本地包仍可能解析 peer 元数据）。
- `--dump-config` 看不到行：检查 patch 缩进（必须是数组项）、id 是否重复、YAML 是否合法。
- 装载后无账本：确认 `DSH_HOME` 与插件进程一致；`mode` 不应为未知值（会回落 defaults）。
- 安装/启用可能要求 `danger-full-access` 或单次审批，这是 DSH 的宿主权限模型，不是本插件要求。
## v1.0 升级注意

- linked bundle 的代码更新后，**重启 DeepSeek Harness** 让 v1 插件代码进入运行进程（client 半也需刷新页面）。
- 推荐把 [examples/desktop-profile-costpilot.yml](examples/desktop-profile-costpilot.yml) 追加到 profile patch；M4 默认在模板中开启，其余模块默认关闭。
- M4 索引：`<workspace>/.dsh-costpilot/index.db`，同一 workspace 跨会话复用。

## 已验证（2026-11-13，DSH 0.2.2-rc.1）

本仓库在隔离的 `DSH_HOME` 中完成了真实装载验证（不触碰 desktop/web 用户 profile）：

```bash
export DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
export DSH_HOME="$PWD/.dsh-test"           # 沙箱内可写；真实用户可省略，默认 ~/.dsh
"$DSH" --profile costpilot-test --from-default-profile headless --dump-config >/dev/null
"$DSH" plugin --profile costpilot-test add "link:$PWD/dsh-costpilot"
"$DSH" --profile costpilot-test --dump-config | grep -A2 costpilot
# -> - id: costpilot
#      name: dsh-costpilot
#      config: { mode: observe }
"$DSH" --profile costpilot-test --help >/dev/null   # 启动即挂载插件
ls "$DSH_HOME/costpilot"                             # 插件 apply 创建的数据目录存在 = 挂载成功
```

Web 侧（client 半）同样验证过：用 web 模板建 profile 后启动临时实例（127.0.0.1:59991），
登录页 HTML 的 plugin preload 列表包含 `dsh-costpilot/client.js`，合并 bundle 中可检出该模块。

## 沙箱/CI 提示

- 直接写 `~/.dsh` 可能被 DSH 文件沙箱拒绝（`mkdtemp ... EPERM`）。此时设置 `DSH_HOME` 到工作区内即可。
- 安装 `link:` 本地包后，profile 的 `package.json` 会增加依赖与 `dsh.profile.bundles` 条目；bundle patch 自动插入 `costpilot` 行。