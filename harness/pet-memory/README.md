# Desktop Pet memory Harness bundle

项目携带的可独立安装插件；不修改 Harness 本体，不自动安装，不修改正在运行的 profile。默认不读写记忆；桌面设置与插件配置都须启用。当前首版不增加任何模型调用、向量服务或后台自主任务。

## 安装与隔离

要求已具有 agentPresets、workspaceRegistry、sessionProjections、systemPrompt、tokenMeter 的 Harness web profile（已按 0.2.1-rc.2 checkout 接口验证）。安装本包会写所选 profile 的包依赖和 bundle 选择，**不可能零改动现有 profile 又持久安装插件**。推荐另建宠物 profile 或明确同意后为现有 profile 增加非默认 preset；不要替换 standard、修改全局人格或修改 Harness checkout。

以下是未来人工操作，未执行。CLI 的 plugin --profile <name> add <package> 形式已通过本机源码入口 --help 核验；本机 PATH 无 dsh 时，可在 Harness 根以 node --import tsx/esm apps/cli/src/bin.ts 替代 dsh：

```sh
# 已安装 dsh 时：仅首次初始化一个确认不存在的pet profile；该命令会重置目标，勿用于已有配置。
dsh --profile pet --from-default-profile web --dump-config > /dev/null
# 随后安装（仅更改pet profile；本地包路径必须绝对）
DESKTOP_ROOT="$(pwd)" # 当前目录必须为解压或克隆后的桌面项目根目录
dsh plugin --profile pet add "$DESKTOP_ROOT/harness/pet-memory"
# 绑定与授权核验完成后，在专用端口启动pet profile；不要占用现有3080。
```

本包声明 dsh.bundle.patch，内含一个 @deepseek-ai/dsh-agent-preset，ID 为 desktop-pet。仅在该 preset 的作用域注册人格/记忆数据，不提供编程工具，也不改变部署已有权限。额外工具必须单独审查添加。

不需要手抄 hash。[configure.py](./configure.py) 只读桌面保存的绑定，计算与 native 一致的 scope，自动定位[Python helper](../../src-tauri/helpers/pet_memory.py)，输出用 shlex.quote 安全转义的三条 export；不改 profile、不创建记忆库、不调用模型。它拒绝不同 WSL 用户/发行版；请在绑定的同一 WSL 身份运行。

Windows 绑定位于 `%APPDATA%/io.local.dsh-wsl-desktop/assistant-binding.json`；用 Windows 文件管理器取得绝对路径，WSL 内通过 `/mnt/c/Users/.../AppData/Roaming/io.local.dsh-wsl-desktop/assistant-binding.json` 读取。具体盘符和用户名以本机实际为准。

```sh
# 桌面项目根；先查看打印结果。路径必须是绝对的WSL路径。
/usr/bin/python3 -I harness/pet-memory/configure.py --binding '/mnt/c/Users/<Windows用户>/AppData/Roaming/io.local.dsh-wsl-desktop/assistant-binding.json'
# 核对绑定后可直接导入；命令仅打印被安全引用的固定export，不执行绑定内容。
if pet_exports=$(/usr/bin/python3 -I harness/pet-memory/configure.py --binding '/mnt/c/Users/<Windows用户>/AppData/Roaming/io.local.dsh-wsl-desktop/assistant-binding.json'); then
  eval "$pet_exports"
else
  unset DSH_PET_MEMORY_SCOPE DSH_PET_MEMORY_WORKSPACE DSH_PET_MEMORY_HELPER
fi
# 然后启动所选宠物profile。已有进程不会因当前shell export自动改变配置。
```

生成的变量为 DSH_PET_MEMORY_SCOPE、DSH_PET_MEMORY_WORKSPACE、DSH_PET_MEMORY_HELPER。安装包副本不在桌面源码树时需显式 --helper-path 指向上述 helper 的绝对路径。绑定文件更换后应重新生成并重启目标后端，不应使用旧环境值。

scope 必须与桌面 native 一致：SHA256(JSON.stringify([distribution,user,origin,workspace_id])) 的 UTF-8 小写十六进制值；不可从聊天文本、模型输出或临时 session_id 导出。Python helper 以当前 WSL Unix 用户访问固定私有目录。一个安装配置绑定一个 workspace/scope；变更身份必须重新配置，不复用旧 session。

远程发现：ctx.remote.agentPresets.list()，无参数；返回 {presets:[{id,isDefault,name?,description?,broken?}]}。只有 desktop-pet 存在且无 broken，才创建 {workspaceId,agentPreset:'desktop-pet'} 新会话。公开 session/create 没有任意 scope 字段，session/prompt 没有 context override 字段。不得悄悄降级成 standard。

每次 pre-step、明确记住落库以及最终 provider dispatch 前，插件检查 workspaceRegistry.get(expectedWorkspaceId).sessionIds 包含该 session；不匹配拒绝而不读取 helper。旧会话不会自动切换 preset。

## 数据与预算

helper stdin：{scope,request:{action:'context',session_id,query}} → {enabled,text,bytes,pet_id?}；ingest：{scope,request:{action:'ingest',session_id,message_id,text}} → {processed}。使用固定 /usr/bin/python3 -I 与无 shell 的绝对 helper 路径；5 秒超时、64 KiB stdout 上限、每份记忆资料 6000 UTF-8 字节。Python管理SQLite、稳定pet_id、来源ID幂等与删除墓碑。

只监听当前 agentPreset 投影等于 desktop-pet 且 workspace 匹配的已提交 user/message，source.kind==='user'、全文符合“(?:请)?记住\s*[:：]\s*(.+)”；普通会话即使在同workspace也直接忽略，不抛错、不保存；不处理工具、assistant、runtime-context、旧历史回扫，也不推断用户事实。提交后异步入库，下次 pre-step 等待本session写队列；本轮刚提交的事实不保证同轮立即召回。写队列仅在内存，进程崩溃或关机可能丢失尚未完成的ingest；本版不回扫原始历史自动补提，避免关闭前历史意外重建。已完成的source message id在helper持久化去重。

人格为固定安全段。用户设置名字/语气以及检索记忆按低信任资料放入 interpolate:false 的 scoped system section；每次步骤刷新且按 Agent 独立缓存。**资料变化时声明 startsRequestSeries:true**，由 Harness 真实 SystemPromptProjection 将 system head 替换并清空历史 system tails。不是持续追加 user-role snapshot。关闭/失败时替换为明确不可使用旧资料的标记，不保留旧缓存。

已有聊天原文、assistant曾复述的事实和磁盘事件日志仍可能保留。忘记只阻止记忆检索/重新提取，不等于删除原始DSH历史；需要强遗忘时另行清理历史或开新会话。系统段仍是高优先级通道，资料通过JSON与固定安全说明限定，不能声称prompt injection已完全消除。

预算不是只计记忆：最终 llm/stream（request已组装、路由完成、输入已durable提交，provider尚未调用）按显式宠物session白名单，用 tokenMeter.measure(session,{config:最终请求字段,tools:最终options.tools}) 测量完整当前surface+最终工具定义，不只依赖旧header。拒绝缺失/不匹配的路由contextWindow。agent/request在未设置maxTokens时显式设为4096；最终检验：

```text
estimatedInput <= min(24000, routedContextWindow - actualMaxTokens - 2048)
```

未通过直接抛错，绝不改写frozen请求，不调用provider，不自动多调摘要模型。tokenMeter可能使用估算而非精确tokenizer，故是带安全余量的**估算预算硬闸**，不是provider精确token数保证。已有compaction可另行配置复用，但compaction-basic可能额外调用摘要模型，错误也可能仅warn后继续，不能代替最终闸。此首版超预算提示用户开新宠物会话；不会无限增长发送，尚不提供自动滚动摘要。

## 离线验证（零模型调用）

桌面项目根运行：

```sh
node --test harness/pet-memory/test/plugin.test.js
/usr/bin/python3 -I -B harness/pet-memory/test/configure_test.py
```

[配置测试](./test/configure_test.py) 包含固定 ASCII/中文 scope 向量、shell注入引用及 session/path不影响身份校验。[插件测试](./test/plugin.test.js) 覆盖helper协议、隔离、禁用/失败与预算。

Harness checkout 根运行（只加载源码服务，不启动应用/profile）：

```sh
node --import tsx/esm "$DESKTOP_ROOT/harness/pet-memory/test/harness-integration.mjs"
```

后者使用真实 Cordis / scoped SystemPrompt / SessionStore / SystemPromptProjection：验证 in-history 模型的渲染结果与 deriveMessages 仅有当前snapshot、关闭移除、全局编码人格不变；并用真实 TokenMeter + llm/stream 事件总线证明超预算时终端provider未收到请求。fixture仅返回固定JSON，未调用模型、未访问用户真实记忆数据库。

完整helper闭环另运行：

```sh
node --import tsx/esm "$DESKTOP_ROOT/harness/pet-memory/test/helper-harness-integration.mjs"
```

该测试创建临时HOME并使用真实Python SQLite helper、真实Agents/AgentLoop创建与scoped session/event分发，验证‘请记住 ：我喜欢花茶’持久化、新session同scope召回、forget后当前system资料移除、关闭、同workspace普通session不被存储。清理仅由mkdtemp生成的临时目录，未调用模型。根AgentLoop由已有base/web profile提供，宠物preset不重复注册loop服务。

安装后仍应由用户检查目标profile的完整加载配置与实际权限；仅包安装成功或roster存在不证明scope/helper/env配置正确。测试文件只在仓库开发树，不进入发布包。
