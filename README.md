# omp-xai-video

[oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）的扩展插件。它给 omp 的 agent 增加一个 `xai_generate_video` 工具，用 xAI Grok Imagine 根据文字或图片生成短视频，并保存成 MP4 文件。

插件独立于 omp 主仓库，不修改 omp 源码；omp 升级后不需要重新合并代码，换一台电脑用一行命令就能装上。

## 功能

- **文生视频 / 图生视频**：只给 `prompt` 是文生视频；再给 `image` 就把这张图当作第一帧做动画。
- **复用 omp 已有凭据**：直接读取 omp 里配置好的 xAI key 或登录状态，插件本身不保存任何密钥。
- **可指向自己的服务地址**：在 `models.yml` 里配置专用的 `xai-video` provider，视频请求就发到你的中转或代理服务，xAI 聊天模型的请求不受影响。
- **防止重复扣费**：xAI 接受任务之后，无论轮询失败、任务失败、下载失败、写文件失败还是你手动取消，都只报告任务 ID（有视频地址时一并给出），绝不自动重新提交。
- **轮询容错**：网络错误、408/429/5xx、响应体损坏都算临时故障，连续 6 次才放弃；遇到 401 会刷新 key 后继续查询同一个任务。

## 前置条件

- omp 18.14.0 或更高版本
- 本机能用 `git` 访问 GitHub。这是私有仓库，需要配置好 SSH key。
- 一份 xAI API key，或者你自己的 xAI 兼容视频服务。见下文「配置凭据」。

插件安装时用的是 omp 内置的 Bun，不需要另外安装 Bun 或 Node。

## 安装

```bash
omp plugin install git@github.com:linyqh/omp-xai-video.git
```

装完后重启 omp 即可使用。常用的管理命令：

| 用途 | 命令 |
|---|---|
| 安装指定版本 | `omp plugin install git@github.com:linyqh/omp-xai-video.git#v0.1.0` |
| 更新 | `omp plugin upgrade omp-xai-video` |
| 查看状态 | `omp plugin list`，或 `omp plugin doctor` |
| 停用 / 启用 | `omp plugin disable omp-xai-video` / `omp plugin enable omp-xai-video` |
| 卸载 | `omp plugin uninstall omp-xai-video` |

不要把 GitHub token 写进安装地址。omp 会把安装地址原样记录到 `~/.omp/plugins/package.json` 和 `bun.lock` 中。私有仓库请用 SSH 或 git 凭据助手认证。

## 配置凭据

插件按下面的顺序查找凭据，用找到的第一个：

1. `models.yml` 里的 `xai-video` provider
2. provider `xai` 的 API key
3. provider `xai-oauth` 的登录状态（SuperGrok 订阅）

如果都没有，工具会直接返回错误，不会发出任何请求。

凭据只保存在本机。换一台电脑，插件可以一行命令装好，凭据需要在那台电脑上重新配置。

### 方式一：用官方 xAI key（最简单）

先在 [console.x.ai](https://console.x.ai) 创建 API key，然后任选一种方式交给 omp：

```bash
omp login xai              # 保存到 omp 凭据库；保存前会先校验 key 是否有效
```

```bash
export XAI_API_KEY="xai-..."   # 或者设置环境变量，写进 ~/.zshrc 之类
```

### 方式二：在 models.yml 中配置专用 provider（可自定义地址）

想把视频请求发到自己的中转、代理或网关，或者想把视频用的 key 和聊天用的 key 分开，就在 `~/.omp/agent/models.yml` 的 `providers:` 下加一个 `xai-video`：

```yaml
providers:
  xai-video:
    baseUrl: https://relay.example.com/v1   # 可省略，省略时用 https://api.x.ai/v1
    apiKey: XAI_VIDEO_API_KEY               # 见下面的 apiKey 写法
```

`apiKey` 有三种写法：

| 写法 | 含义 |
|---|---|
| `XAI_VIDEO_API_KEY` | 如果存在同名且非空的环境变量，就用它的值；否则把这串文字本身当作 key |
| `xai-xxxxxxxx` | 直接写 key 本身 |
| `"!op read op://dev/xai/key"` | 以 `!` 开头时执行这条命令，取它输出的内容作为 key |

注意事项：

- 用单独的 `xai-video`，而不是给内置的 `xai` 改 `baseUrl`：后者没有限定 `api` 时会作用于整个 provider，连 Grok 聊天模型也会被转到你的地址。
- `xai-video` 只写 `baseUrl`、没写 `apiKey` 时，插件会跳过它，改用 `xai` 的 key 请求官方地址。工具的返回结果里会写明用的是哪个 provider，比如 `xai-video/grok-imagine-video`。
- 改完 `models.yml` 后重启 omp 才会生效。

### 自定义服务需要实现的接口

`baseUrl` 指向的服务需要兼容 xAI 视频接口：

| 请求 | 用途 | 关键字段 |
|---|---|---|
| `POST {baseUrl}/videos/generations` | 提交任务 | 请求体：`model`、`prompt`、`duration`、`aspect_ratio`、`resolution`、`image.url`；响应：`request_id` |
| `GET {baseUrl}/videos/{request_id}` | 查询进度 | `status` 取值 `pending` / `done` / `failed` / `expired`；完成时 `video.url`；可选 `usage.cost_in_usd_ticks`（单位 1e-10 美元） |
| `GET {video.url}` | 下载视频 | 视频文件本身 |

所有请求都带 `Authorization: Bearer <key>`。`video.url` 可以是相对路径（如 `files/abc.mp4`），这时会带着 key 到你服务的同一域名下下载；如果是其他域名的完整地址（比如 xAI 的 CDN 预签名链接），下载时不带 key。

## 使用

在 omp 会话里直接用自然语言描述你要的视频即可，例如：

```
生成一段 5 秒的视频：一只橘猫在窗台上伸懒腰，镜头缓慢推近，720p，16:9，保存到 videos/cat.mp4
```

```
把 ./assets/logo.png 做成一段 3 秒的动画：logo 从中心淡入并轻微旋转
```

非交互方式：

```bash
omp -p "用 xai_generate_video 生成一段 2 秒 480p 的视频：红色小球在木地板上弹跳"
```

工具参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 画面内容、动作、镜头运动 |
| `image` | 否 | 第一帧图片：https 地址、data URL，或本地 PNG / JPEG / WebP 路径（本地文件会转成 data URL 上传） |
| `duration` | 否 | 时长，整数秒，1–15；不填用服务端默认值 |
| `aspect_ratio` | 否 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`3:2`、`2:3` |
| `resolution` | 否 | `480p`、`720p`、`1080p` |
| `model` | 否 | 默认 `grok-imagine-video` |
| `output_path` | 否 | 保存路径，相对于当前工作目录，支持 `~/`；默认 `xai-video-<任务ID>.mp4` |

在 xAI 上，1080p 只支持图生视频，并且只能用 `grok-imagine-video-1.5`。如果没有指定 `model`：传了图片时会自动切换到这个模型；没传图片时直接拒绝，不提交任务。

## 计费与失败处理

视频按任务计费，费用和时长、分辨率有关。结果里的费用取自 xAI 返回的 `usage`。

| 情况 | 是否扣费 | 插件的处理 |
|---|---|---|
| 参数不合法、图片读不了、`output_path` 是目录、没有凭据 | 不扣费 | 提交前就拒绝 |
| xAI 拒绝提交（如 400、key 无效） | 不扣费 | 返回 xAI 给出的原因 |
| 已经提交后出错（轮询失败、任务失败、超过 20 分钟、下载或写文件失败、你取消了） | 可能已扣费 | 返回任务 ID 和视频地址（有的话），不重新提交 |

如果下载或写文件失败，结果里会附上视频地址，可以手动下载，不需要重新生成。

## 开发

```bash
bun install          # 安装开发依赖（类型定义、TypeScript）
bun test             # 单元测试：用模拟的 xAI 接口验证扣费安全
bun run check        # 类型检查
omp plugin link .    # 让本机 omp 直接加载当前目录，改完代码重启 omp 即可生效
```

目录结构：

```
index.ts        # 注册工具；解析凭据、处理输入图片和输出路径
src/xai.ts      # xAI 视频接口：提交、轮询、下载，以及失败处理
test/xai.test.ts
```

发布新版本：修改 `package.json` 的 `version`，提交后打上 `vX.Y.Z` 标签并推送；其他电脑执行 `omp plugin upgrade omp-xai-video` 即可更新。
