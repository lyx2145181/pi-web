# Subagent Web 交互控制台实施计划

## 计划定位

本计划用于跨会话实施 Pi Web-only 的 Subagent Web 交互控制台。功能归属以 [`docs/specs/00-规范索引.md`](../specs/00-规范索引.md) 的正式功能登记为准，功能范围和交互契约以 [`docs/specs/features/30-Subagent-Web交互控制台.md`](../specs/features/30-Subagent-Web交互控制台.md) 为唯一权威来源；本文件只定义实施顺序、代码影响、验证门槛和交接证据。

本计划不得通过修改 `pi-subagents`、读取插件内部运行文件、解析状态文本、启动所有历史会话或建立无界任务历史来补齐公共协议缺失能力。实现便利与功能规格冲突时，以功能规格为准。

## 当前焦点

- 对应功能：Subagent Web 交互控制台。
- 当前目标：先形成当前会话异步任务的结构化只读闭环，再逐步加入按需详情、直接控制和全局活动聚合。
- 已满足前置：产品范围、Pi Web-only 边界、控制语义、历史降级、通知和安全规则已经确认；Pi Web 已有公共 status RPC 后台工作探针。
- 明确不处理：插件修改、supervisor 直接回复、手动 spawn、Mission/Schedule/external runs、永久历史、跨会话直接控制。
- 停止并询问条件：公共协议无法提供已确认功能所需的可靠身份或状态；必须读取插件私有文件/解析文本；需要新增持久任务数据库；需要改变父 Agent supervisor 流程；或实现要求弱化会话归属和路径隐私边界。

## 实施基线

### 当前具备

- `lib/rpc-manager.ts` 为每个 AgentSession 创建独立扩展事件总线，并管理 wrapper registry、SSE、extension UI、空闲回收和销毁。
- `lib/subagent-background-work.ts` 已监听 `subagents:rpc:v1:ready`，并调用公共 `status` RPC 判断当前 wrapper 是否拥有活动异步工作。
- `ExtensionStatusBar` 和 `ExtensionWidgets` 已承载扩展 status/widget 的紧凑展示。
- `MessageView` 已能渲染通用 custom message，session reader 会保留 `customType`、content 和 details。
- 侧边栏已有运行会话聚合、未读状态和会话跳转能力。

### 尚未具备

- 可复用的公共 subagent RPC Host 客户端、能力快照和安全浏览器 DTO。
- 任务树 API/SSE 投影、inspect request correlation 和控制请求入口。
- 当前会话任务抽屉、节点详情、控制按钮和 destructive confirmation。
- 跨现有 wrapper 的全局活动任务聚合。
- subagent 专用 custom message、通知和降级界面。

### 开始实施前必须复核

- 当前工作区和 [`docs/plans/01-交互加载性能优化计划.md`](01-交互加载性能优化计划.md) 的最终实现，尤其是 `SessionSidebar.tsx`、`AppShell.tsx`、会话切换 generation 和浏览器性能基线。
- 当前安装版本 `pi-subagents` 的 `ping`、`status`、`asyncSnapshot` 和 control RPC 实际 payload；status/control 只按 capability 编程，不按版本字符串写死。
- 精确注册命令 `subagents-inspect-rpc` 的发现、冲突处理、版本化回执，以及 Pi SDK 当前 RPC-mode command、widget emit/retract 和 session shutdown 行为；不得从 `ping` 推断 inspect 可用。
- Agent route、SSE 和 HTTP Basic Auth/allowed-host 的现有安全边界。
- 不运行 `next build`；开发验证遵守根目录 `AGENTS.md` 的命令限制。

## 实施原则

- 一条公共事件总线只由所属 wrapper 的 Host 客户端使用；销毁 wrapper 时取消监听、超时和在途请求。
- 服务端先校验和白名单投影，再把状态、详情和错误交给浏览器。
- Subagent 使用独立服务端命令面，不复用父 Agent 的 `steer`/`follow_up` command type；只允许已确认的固定控制枚举并执行服务端输入、并发和速率限制。
- 当前会话状态优先；当前/全局 Subagent 入口都只读取现有 wrapper，不沿用通用 Agent POST 的缺失 wrapper 自动启动行为。
- 先交付只读状态，再加入详情，再加入写控制；每一阶段都能独立验证和回退。
- 所有浏览器请求使用 session/generation guard，迟到响应不得跨会话落地。
- 新 UI 复用一个任务中心组件和现有主题变量，不恢复独立的扩展 widget 带。
- 功能契约变化先更新权威规格，再调整本计划；纯实施证据只写入完成记录。

## 阶段状态

| 阶段 | 主题 | 依赖 | 状态 |
|---|---|---|---|
| 0 | 固定公共协议、性能和安全基线 | 无 | 未开始 |
| 1 | 建立通用 Host RPC 客户端与安全服务端投影 | 阶段 0 | 未开始 |
| 2 | 交付当前会话异步任务只读中心 | 阶段 1 | 未开始 |
| 3 | 增加按需 inspect 与直接运行控制 | 阶段 2 | 未开始 |
| 4 | 聚合现有 wrapper 的全局活动任务 | 阶段 2～3 | 未开始 |
| 5 | 补齐聊天关键节点、通知和兼容降级 | 阶段 2～4 | 未开始 |
| 6 | 综合回归、性能验证与规范收口 | 阶段 1～5 | 未开始 |

状态只使用“未开始 / 进行中 / 已完成 / 阻塞”。跨会话开始工作前必须依据当前代码、测试和计划完成记录复核状态。

## 功能、契约与实现映射

| 功能 | 契约主题 | 权威位置 | 预计代码落点 | 实施说明 |
|---|---|---|---|---|
| 公共协议桥接 | 数据来源、兼容、安全 | [功能规格](../specs/features/30-Subagent-Web交互控制台.md#数据来源与职责边界) | `lib/subagent-background-work.ts`、`lib/rpc-manager.ts`、`lib/pi-types.ts` | 从已有 probe 提炼共享 RPC 客户端，不复制事件监听实现 |
| 当前会话任务中心 | 任务状态、信息架构、历史 | [功能规格](../specs/features/30-Subagent-Web交互控制台.md#信息架构) | `components/ChatWindow.tsx`、`components/ExtensionStatusBar.tsx`、新任务中心组件与 hook | 异步任务完整展示，前台任务能力不足时只读 |
| 详情和运行控制 | 控制、并发、恢复、安全 | [功能规格](../specs/features/30-Subagent-Web交互控制台.md#控制语义) | `app/api/agent/[id]/`、`lib/rpc-manager.ts`、任务详情组件 | inspect 按需加载；控制直接走公共 RPC |
| 全局活动聚合 | 全局视图、会话生命周期 | [功能规格](../specs/features/30-Subagent-Web交互控制台.md#全局视图) | `components/SessionSidebar.tsx`、`components/AppShell.tsx`、wrapper registry 只读投影 | 只遍历现有 wrapper，先跳转再控制 |
| 关键节点和通知 | Supervisor、通知 | [功能规格](../specs/features/30-Subagent-Web交互控制台.md#通知规则) | `components/MessageView.tsx`、`hooks/useAgentSession.ts`、现有通知/音频能力 | supervisor 仍由父 Agent处理 |

## 分阶段实施

### 阶段 0：固定公共协议、性能和安全基线

目标：用测试 fixture 固定 Pi Web 实际依赖的公共能力和不可泄露字段，避免后续 UI 依赖插件私有 details。

预计影响：

- `lib/subagent-background-work.ts` 及其测试。
- 新增纯解析/投影测试模块；不改变用户界面。
- 关联规范：无契约变化，只验证现有功能规格。

实施内容：

1. 分别记录 event-bus `ping/status/control` 和注册命令 `subagents-inspect-rpc`/inspect reply 的最小 fixture，不把 inspect 写入 RPC capability fixture。
2. 为插件缺失、bridge 未 ready、inspect 命令缺失或冲突、未知版本、malformed payload、omitted、byte-limit、超时、emit/retract 失败和 extension reload 建立失败关闭测试。
3. 固定浏览器 DTO 禁止字段测试，至少覆盖 `asyncDir`、session/artifact/output path、原始 details 和堆栈。
4. 记录现有后台工作 probe 请求次数、超时和 wrapper 空闲回收行为，确保后续共享客户端不增加重复 RPC。
5. 用合成 snapshot 测量 20 个根任务、嵌套节点和快速状态更新时的解析/投影成本，作为阶段 6 对照。
6. 固定首版资源预算：
   - 当前抽屉关闭时，活动会话新增状态对账不超过每 10 秒一次；页面隐藏后 1 秒内停止浏览器发起的 status/inspect 对账。
   - 当前抽屉打开时，每个当前 wrapper 的 status 不超过每秒一次；inspect 只由显式展开/刷新触发，同一节点最多一个在途请求。
   - 全局视图打开时，浏览器聚合请求不超过每 2.5 秒一次、每个现有 wrapper 的 status 不超过每 2.5 秒一次；全局视图关闭时不维持聚合轮询。
   - 单次浏览器 status DTO 不超过 128 KiB，inspect DTO 不超过 64 KiB；本地额外设置 1000 个节点和当前会话 2 MiB 保留状态的安全上限，超限失败关闭或明确截断。
   - 已缓存状态下抽屉打开 P95 不高于 200ms，不新增超过 50ms 的交互长任务；关闭后 1 秒内释放 inspect waiter、刷新 timer 和 transcript 引用。
   - 插件缺失时现有页面新增 HTTP/RPC 请求为 0；普通会话切换 P95 相对既有生产基线增量不超过 50ms。

阶段门槛：

- fixture 只来自公开协议，不包含用户路径、任务正文或真实会话数据。
- malformed/unknown payload 不导致 wrapper 销毁、主聊天失败或未捕获异常。
- 能明确区分“插件不存在”“能力不支持”“请求失败”“结果被截断”。
- 已记录现有 probe 的请求与生命周期基线。

### 阶段 1：建立通用 Host RPC 客户端与安全服务端投影

目标：在每个 wrapper 内建立唯一、可释放、可超时的公共 subagent RPC 客户端，为只读状态和后续控制提供统一入口。

预计影响：

- `lib/subagent-background-work.ts`
- `lib/rpc-manager.ts`
- `lib/pi-types.ts`
- `lib/types.ts`
- `app/api/agent/[id]/` 下职责一致的状态入口

实施内容：

1. 将 ready 监听、requestId correlation、timeout、unsubscribe 和保守错误处理提炼为共享客户端；后台工作 probe 复用该客户端，不再注册第二套 bridge 监听。
2. 缓存最近一次 `ping/capabilities`；session start 和 extension reload 后递增协议 epoch、取消旧在途请求并重新协商，未知版本禁止写操作。
3. 实现当前 wrapper 的 `status` 请求和严格 asyncSnapshot/Fleet 投影，保留 caps/omitted/total 语义。
4. 定义独立的 Subagent 服务端 command/route 和白名单 DTO：固定允许 `status`、`inspect`、`steer`、`interrupt`、`stop`、`resume`，明确拒绝 `spawn`、管理操作、`dir`、未知 method 和额外字段；不向浏览器返回插件内部路径或原始 details。
5. 在服务端限制目标 ID、消息和请求体长度，合并并发 status，并限制同目标同 method 在途数及总体速率；客户端按钮禁用不是安全边界。
6. 明确生命周期：reload 保留或重新安装基础 ready/reply 监听，只清除旧 epoch 的能力缓存和在途请求；destroy、fork 和 session shutdown 才永久 dispose。session 创建中途失败时也必须释放已创建的 Host 客户端、probe、listener 和 timer。
7. 为并发 status 合并、超时后迟到 reply、重复 requestId、旧 generation、bridge ready、reload 重挂接和启动失败清理竞态增加测试。

阶段门槛：

- 同一 wrapper 只有一个公共 RPC 客户端和一套 ready/reply 监听；reload 后可继续工作且没有重复 listener。
- 现有后台工作保活语义不退化；bridge 曾声明可用后，状态异常仍按现有保守策略处理。
- Subagent route 不复用父 Agent命令、不自动启动缺失 wrapper，并通过方法白名单、输入长度、并发、速率、路径泄露和 schema 边界测试。
- session 创建失败、fork、destroy 和 shutdown 后没有残留 listener、timer 或 pending Promise。
- 插件缺失时不创建可见错误入口，主聊天行为不变。

### 阶段 2：交付当前会话异步任务只读中心

目标：形成不含写操作的完整观察闭环，验证任务树、切换和 UI 性能后再开放控制。

预计影响：

- 新任务中心、任务树和节点摘要组件。
- 当前会话 subagent 状态 hook。
- `components/ChatWindow.tsx`
- `components/ExtensionStatusBar.tsx`
- `app/globals.css` 和 i18n 文案。

实施内容：

1. 在 `ExtensionStatusBar` 增加当前会话任务入口，保持 status/widget 仍由同一紧凑 shelf 承载。
2. 建立桌面抽屉和移动端全屏 Sheet，共享一个任务中心组件。
3. 渲染异步根任务、Workflow/parallel 步骤和嵌套节点，显示状态、耗时、活动摘要及截断/遗漏提示。
4. Fleet 前台任务以只读区展示；不从 opaque key 推导 run ID，不显示不可证明的操作。
5. 当前会话切换、快速 A→B→A、页面隐藏/恢复和网络重连使用 abort/generation guard，旧状态不得覆盖目标会话。
6. 抽屉关闭和页面隐藏时降低或停止状态对账；主聊天不订阅节点级高频进度。
7. 增加键盘焦点、屏幕阅读器状态、窄屏和任务树展开测试。

阶段门槛：

- 单任务、并行、Workflow、嵌套、未知状态和 omitted fixture 均正确展示。
- 插件缺失时入口隐藏；只支持 Fleet 时只读降级。
- 快速切换无串会话、幽灵任务或旧抽屉操作。
- 关闭抽屉后没有 transcript 请求和高频 React 重渲染。
- 不改变现有 ExtensionStatusBar widget 布局约束。

### 阶段 3：增加按需 inspect 与直接运行控制

目标：在当前会话只读闭环上增加有界详情和确定性的运行控制，并落实 destructive confirmation 与结果重新对账。

预计影响：

- 阶段 1 的 Host 客户端和 Agent API。
- 任务详情、控制表单和确认组件。
- RPC-mode extension command/widget correlation 适配。
- 相关 route、schema、错误和竞态测试。

实施内容：

1. 通过精确注册命令 `subagents-inspect-rpc` 发送 requestId/target/lines，并只消费匹配的 emit-then-retract payload；inspect widget 不进入普通 ExtensionWidgets 渲染。命令缺失、同名冲突或回执不匹配时关闭详情能力。
2. 详情首次展开时请求；切换节点时取消本地 waiter、释放监听并忽略迟到回执。当前 Host 命令没有插件端取消契约时，不宣称取消了插件读取。只显示 task、bounded transcript、最终输出和 truncated 标记中的公共字段。
3. 通过独立 Subagent command 接入 steer 的 `steer`、`follow_up`、`auto` mode，展示 delivered/queued/failed 等插件实际回执；不得调用父 Agent wrapper 的 `steer`/`follow_up`。
4. 接入 interrupt、stop 和 resume；服务端固定 method 枚举，拒绝 spawn/manage/dir/额外字段，控制前使用当前会话和目标状态，提交后以重新查询状态收口。
5. 实现服务端目标/消息/请求体长度、同目标并发和速率限制，并实现安全确认：工具执行中的 interrupt 需确认；stop 始终确认并说明不可恢复与不回滚文件；resume 说明创建新运行。
6. 每个目标同类操作串行；会话切换、超时和断线后显示结果未知，不进行乐观终态更新。
7. 映射 `not_found`、`invalid_state`、`unsupported_method`、execution failure 和 transport timeout 的中文提示。

阶段门槛：

- inspect 命令发现、冲突、request correlation、错配 reply、retract、超时、截断和快速节点切换测试通过。
- 所有控制只对 RPC capability 和目标身份允许的节点可见；inspect 可见性独立依据精确注册命令与有效回执。
- stop 接受只显示“停止请求已提交”，直到权威状态变更；stopped 不显示 resume。
- 浏览器不能提交任意 `dir`、路径、spawn/manage 或未知控制，超长/超频请求被服务端拒绝。
- 控制失败不影响父 Agent运行和 SSE 聊天链路。

### 阶段 4：聚合现有 wrapper 的全局活动任务

目标：在不扫描历史会话或创建 wrapper 的前提下，提供全局活动数量、关注提示和父会话跳转。

前置条件：

- 阶段 2 的任务展示稳定。
- 阶段 3 的控制严格绑定当前父会话。
- 已复核交互加载性能计划对 Sidebar、AppShell 和 request ordering 的最终约束。

预计影响：

- `components/SessionSidebar.tsx`
- `components/AppShell.tsx`
- wrapper registry 的只读全局状态投影。
- 全局活动事件/API 和相关竞态测试。

实施内容：

1. 为现有 registry 提供有界全局摘要，只查询已存活 wrapper，不调用 `startRpcSession()` 创建历史会话。
2. 聚合活动任务、needs-attention、失败提示和 omitted 数量；仅返回会话跳转所需的最小身份及白名单摘要。
3. 侧边栏增加全局入口和徽标，打开同一任务中心的全局过滤视图。
4. 全局视图不显示控制按钮；用户选择任务后先切换父会话并重新查询，再由当前会话视图提供控制。
5. 处理 wrapper 创建/销毁、session id 变化、fork destroy、页面恢复和全局请求乱序。
6. 与现有 running SSE/轮询协调，避免为同一 wrapper 建立重复高频全局轮询。

阶段门槛：

- 0、1、多个活动 wrapper 和 wrapper 销毁场景下数量准确或明确使用“至少”语义。
- 打开全局视图不会创建 AgentSession、加载历史扩展或触发全量会话扫描。
- 全局跳转后控制目标重新绑定，迟到全局响应不能覆盖当前会话。
- 满足阶段 0 数值预算：全局视图打开时聚合请求不超过每 2.5 秒一次、每 wrapper status 不超过每 2.5 秒一次；关闭时停止聚合轮询，且不新增超过 50ms 的交互长任务。

### 阶段 5：补齐聊天关键节点、通知和兼容降级

目标：让重要事件可发现，同时保持父聊天为长期结果来源且不引入高频消息重渲染。

预计影响：

- `components/MessageView.tsx`
- `hooks/useAgentSession.ts`
- `components/ChatWindow.tsx`
- 现有通知、未读和声音能力。
- i18n 资源和可访问性测试。

实施内容：

1. 为已存在的 subagent 启动、supervisor 请求、失败/暂停/停止和完成消息增加专用卡片，不伪造插件未发送的持久事件。
2. 关键卡片可以打开任务中心；任务已不可用时显示明确降级，不读取私有产物。
3. supervisor 卡片只说明父 Agent处理流程，不提供直接回复、认领或延迟触发控件。
4. 按规格实现分级 Toast、全局徽标、未读和可选浏览器通知；通知正文不含任务内容、路径或代码。
5. 相近成功完成事件合并，失败和 needs-attention 及时显示；不自动切换会话或展开面板。
6. 完成声音复用现有开关和 AudioContext 解锁，不增加第二套声音设置。
7. 覆盖英文和简体中文文案、键盘操作和屏幕阅读器标签。

阶段门槛：

- supervisor 仍立即走现有父 Agent链路，Web 卡片不改变 triggerTurn 时序。
- 高频进度不进入主聊天 messages 更新路径。
- 后台通知不泄露敏感内容，未授权时静默降级。
- 重复 completion/attention 事件不会产生通知风暴或重复未读状态。

### 阶段 6：综合回归、性能验证与规范收口

目标：证明控制台建立在公共协议和有界资源上，不影响 Agent 主聊天、会话切换、扩展生命周期和现有性能成果。

实施内容：

1. 执行完整状态矩阵：插件缺失、旧 capability、malformed、截断、单任务、并行、Workflow、嵌套、前台只读、完成、失败、暂停、停止和拒绝。
2. 执行控制矩阵：steer 三种 mode、interrupt、stop、resume、重复提交、状态竞态、wrong session、超时、extension reload 和 wrapper destroy。
3. 执行 UI 矩阵：当前/全局入口、桌面抽屉、移动 Sheet、快速切换、后台恢复、通知、声音和可访问性。
4. 按阶段 0 数值预算复测抽屉关闭/打开、页面后台、全局入口和多个 wrapper 的 RPC/HTTP 频率、DTO 字节、节点数、主线程长任务、保留状态、SSE 数量和 wrapper 数量，确认没有历史会话启动、无界轮询或 transcript 常驻。
5. 扩展 `npm run perf:browser` 覆盖任务抽屉和全局入口，或提供同等可重复的专用浏览器证据；执行 `npm test`、`node_modules/.bin/tsc --noEmit`、`npm run lint`、`git diff --check`。不运行 `next build`。
6. 检查浏览器 DTO、日志、通知和 Server-Timing 的敏感字段泄露。
7. 根据最终稳定代码落点和不变量增量更新功能规格与 `AGENTS.md` 摘要；纯验证数据只写入本计划完成记录。

阶段门槛：

- 功能规格验收标准全部有自动测试或明确手工证据。
- 主聊天发送、SSE 重连、会话切换、extension widget、后台保活和 wrapper 销毁无回归。
- 不存在通过插件私有文件、文本解析或版本字符串推测能力的实现。
- 无路径泄露、跨会话控制、旧响应串线或破坏性操作误报成功。
- 满足阶段 0 的请求频率、128/64 KiB DTO、1000 节点、2 MiB 状态、P95 200ms、50ms 长任务和会话切换增量 50ms 数值预算；无法满足时先形成证据并重新确认契约，不在实现中静默放宽。

## 整体验收矩阵

### 协议与兼容

- 插件不存在、bridge 未 ready、ready 后 reload、session 创建失败清理。
- ping/status/control capability 分别存在或缺失；`subagents-inspect-rpc` 命令存在、缺失、冲突或回执失败。
- 未知版本、未知字段、malformed、timeout、late reply。
- caps、omitted、byteLimitExceeded 和 totalActive。

### 状态与任务树

- 单异步任务、并行、chain、Workflow、嵌套 fanout。
- queued、running、complete、failed、paused、stopped、rejected、未知状态。
- needs_attention、长时间工具执行、无活动摘要。
- Fleet 前台任务只读和 opaque key 不可控制。

### 控制

- steer、follow_up、auto 的送达与排队回执。
- interrupt 工具执行确认。
- stop 二次确认、stopping 对账、最终 stopped。
- resume 新运行、消息必填、stopped 不可恢复。
- 重复点击、网络断开、错会话、任务刚好终止。

### 会话与全局视图

- 当前会话切换、A→B→A、fork 后 wrapper 销毁。
- 多个活动 wrapper、wrapper 超时、后台任务保活。
- 全局跳转后重新查询，禁止跨会话直接控制。
- 不创建历史 wrapper，不触发全量 session list force。

### 安全与隐私

- 状态、详情、错误和控制回执中的路径过滤。
- 浏览器不能提交 `dir`、artifact path 或任意 session identity。
- 通知、日志、Server-Timing 不包含任务正文和敏感路径。
- custom message 内容按文本/Markdown安全渲染，不注入 HTML。

## 风险与控制

| 风险 | 控制 | 主要阶段 |
|---|---|---|
| 公共 RPC payload 变化导致控制错误 | capability 协商、严格解析、未知版本禁写、fixture 测试 | 0、1 |
| 共享客户端改坏后台任务保活 | 复用现有保守策略、请求次数基线、wrapper 生命周期测试 | 0、1 |
| inspect emit/retract 与普通 widget 串线 | requestId correlation、专用缓冲、禁止普通渲染、超时清理 | 3 |
| 迟到状态或控制响应串会话 | session/generation guard、切换取消、服务端重新校验 | 1～4 |
| 全局入口触发历史扩展加载和性能回退 | 只遍历 registry、禁止 startRpcSession、请求计数门槛 | 4、6 |
| 路径或原始插件 details 泄露到浏览器 | 白名单 DTO、禁止字段测试、日志/通知复查 | 0、1、3、6 |
| stop/interrupt UI 误报或掩盖副作用 | 二次确认、接受不等于终止、结果未知后重新对账 | 3 |
| 前台 opaque key 被误作控制身份 | 前台默认只读、禁止 key 推导、capability+目标双门槛 | 2、3 |
| 高频任务更新拖慢聊天 | 独立任务状态、抽屉关闭降频、聊天只保留关键节点 | 2、5、6 |
| 与现有 Sidebar 性能改动冲突 | 阶段 4 前复核性能计划最终代码和基线，不覆盖既有修改 | 4 |

## 交接记录规则

每阶段完成后才追加完成记录，且只包含：

- 完成日期和提交或最终变更范围；未提交时明确写“尚未形成提交”。
- 实际新增或变化的公共 DTO/API；没有数据迁移时写“无”。
- 实际验证命令、结果和必要性能数据。
- 已确认的计划偏差及对应权威规范链接。
- 下一阶段明确入口和禁止提前处理的范围。

不记录临时报错流水账、未确认猜测或短期分支状态。实现改变功能范围、控制语义、安全或历史边界时，先更新权威功能规格，再更新本计划。
