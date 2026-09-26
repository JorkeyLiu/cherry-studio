# 模型元数据与请求身份治理（Model Metadata & Request Identity Governance）

> **文档状态**：Authoritative（权威规范，描述已实现的 durable 语义）。本文档是模型元数据（model metadata）与请求身份（request identity）治理的**唯一详细 owner**：定义 serving ID / canonical ID / display name 三者分离、双源元数据职责与隔离、enrichment-only 原则、精确查找契约、价格/限制/能力的补充分工、缓存与持久化边界、Logo 语义、alias/base_model 现实与治理边界、API dialect 边界、错误透明性、以及变更传播/测试/验收契约。
> **决策锁**：MM-1 … MM-12（§3 决策表，durable decision IDs）。
> **最后更新**：2026-09-26
> **Owner**：Personal fork（jorkeyliu）
> **关联**：`AGENTS.md` 与 `docs/architecture/architecture.md` 链接本文档而非复制其决策表；应用身份由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理，SQLite/Dexie 聊天权威与导入由 [SQLite migration governance](../archived/sqlite-migration.md) 治理，稳定上下文锚点由 [Context window governance](./context-window.md) 治理，投影完备性与权威意图由 [Projection Completeness and Authority Intents](./projection-completeness-authority.md) 治理——本文档不改变、不重述这些治理域的边界。

---

## 1. 背景与问题（Background and Problem）

模型身份在系统内同时以多种形态出现：用户在 provider 配置中填写的**请求身份**（provider API 实际发送的模型标识）、`models.dev` 发布的**规范身份**（跨 provider 的规范模型画像）、以及 UI 展示的**显示名**。若不锁定三者关系与元数据来源，会出现三类漂移：把显示名或相似字符串当作请求身份，把 provider 侧服务清单当作模型准入闸门，把外部元数据缺失解读为能力否定或把推断能力当作参数能力。

本仓库的元数据来自 `models.dev` 的双端点：`models.json`（规范事实）与 `api.json`（provider-serving 服务事实）。二者职责不同、生命周期不同、失败域不同，必须隔离；外部数据只能**丰富（enrich）** 既有体验，不能**决定（gate）** 既有请求能否发出。应用内的 provider 条目均为**用户自定义连接**，不是内建供应商身份；模型元数据是关于已解析模型的**模型中心第三方参考信息**，价格/限制/能力不代表当前连接，**上游响应最终**。本文档以 MM-1…MM-12 锁定一个模型：**身份三分离、双源职责隔离、enrichment-only、模型中心参考查找、缺失为 unknown、上游结果最终、Logo 分层、alias 现实与改写隔离、dialect 仅编码形状**。实现阶段以本文档为契约，`docs/architecture/architecture.md` 描述实现位置，演进计划文档仅引用本文档。

---

## 2. 术语（Terminology）

| 术语 | 标识符 | 定义 |
|---|---|---|
| 服务请求身份 | serving ID | Provider API 请求中原样发送的模型标识。来源是用户配置的 `Model.id`（或 provider 侧可配置覆盖），请求层**惰性直送**，不经元数据改写或归一 |
| 规范身份 | canonical ID | `models.dev` `models.json` 的模型身份（record key，如 `moonshotai/kimi-k3`）。用于跨 provider 的固有事实关联，不决定请求能否发出 |
| 显示名 | display name | 模型的展示字符串（`Model.name` / `model.name` 等可编辑字段）。仅用于展示，永不作为身份推导输入 |
| 规范元数据 | canonical metadata | 来自 `models.json` 的跨 provider 固有事实：模态、能力（attachment/toolCall/structuredOutput/temperature/reasoning）、limits/context 等标准能力画像 |
| 服务元数据 | provider-serving metadata | 来自 `api.json` 的 provider 侧服务事实：特定 source 对特定 serving ID 的服务价格/限制/能力（如 `reasoning_options` type `effort`）。其中 `snapshot.providers[canonicalLab]` 子集作 Edit Model 展示的模型中心参考；请求侧建议仍经 owning-provider 精确映射（MM-5/MM-11），二者语义分离 |
| 拥有者 provider 源 | owning provider source | `Model.provider` 精确匹配的用户自定义连接所解析出的 `models.dev` source id（经 `resolveMetadataSource` / `resolveExactProvider` 的精确契约），仅用于请求侧 serving 建议与 connection logo 归属；Edit Model 展示永不使用该映射。应用内 provider 条目均为用户自定义连接，不是内建供应商身份 |
| 规范匹配 | canonical matching | `models.json` 上的身份解析：exact full id → exact basename（唯一）→ case-folded（唯一且无歧义），歧义/未知一律 fail-closed |
| 参考服务条目 | reference serving entry | `snapshot.providers[canonicalLab]` 内经模型中心参考查找命中的展示条目：价格/限制/effort 等参考字段的唯一来源；显示合并但永不成为请求身份 |
| 模型中心参考查找 | model-centric reference lookup | `api.json` 上的展示查找：canonical 先解析，再仅在 `snapshot.providers[canonicalLab]` 内按序匹配（canonical 全 ID → basename → 唯一精确显示名 → 唯一折叠显示名），fail-closed；永不使用用户 provider/API host |
| Enrichment-only | enrichment-only | 外部元数据只丰富展示与可选参数建议，永不拦截准入或基础请求 |
| Unknown vs false | unknown vs false | 外部缺省的可选字段为 unknown（`undefined`），不是 false；只有经校验的布尔值才能落为 supported/unsupported |
| API dialect | API dialect | Provider 侧请求参数形状的编码（如 `reasoning_effort` / `thinking` 形态），不推断模型是否具备某能力 |

---

## 3. 决策表（Decision Table）

| # | 决策 | 状态 |
|---|---|---|
| **MM-1** | **身份三分离**：serving ID（请求身份，原样发送）/ canonical ID（`models.dev` 规范身份）/ display name（展示名）三者分离。请求层只认 serving ID；规范关联只认 canonical ID；展示层只认 display name。三者永不互相改写或推导 | **Locked** |
| **MM-2** | **双源职责隔离，展示合并永不成为权威对象**：`models.json` 承载跨 provider 固有事实（canonical），`api.json` 承载 provider-serving 服务事实（source `api`/`name` + 可选 `models[*]` 展示字段）。二者隔离存储于同一快照的不同子树（`snapshot.models` vs `snapshot.providers[*].models`），**永不合并**为单一权威对象；`api.json` 的 serving 能力永不写入 canonical 能力。Edit Model 有效视图可将 `snapshot.providers[canonicalLab]` 的参考条目字段覆盖于 canonical 之上（cost/limits/effort 可见），但该合并仅为展示，来源以 `source` 标记区分，永不成为请求身份 | **Locked** |
| **MM-3** | **Enrichment-only，never gate admission/basic request**：元数据缺失/网络/缓存/schema/查找失败时，**用户显式模型与基础请求仍可发出**。外部数据只用于 UI 丰富与参数建议，不决定准入；失败静默降级，不阻断请求 | **Locked** |
| **MM-4** | **缺失 = unknown not false；用户意图惰性发送，上游结果最终**：外部缺省的可选能力字段为 unknown，不是否定；用户显式的模型/模态/reasoning 意图**惰性发送**（按用户配置与当前请求上下文编码，不提前以元数据改写 ID），上游返回为最终事实，错误透明回显 | **Locked** |
| **MM-5** | **模型中心参考查找（展示唯一合法）**：canonical 先按 MM-6 解析，再仅在 `snapshot.providers[canonicalLab]` 内按序匹配——(a) 精确 canonical 全 ID 键；(b) 精确 canonical basename 键；(c) 与 canonical 名唯一精确显示名相等（trimmed 大小写敏感）；(d) 若 (c) 无命中，与 canonical 名唯一折叠显示名相等。歧义/缺 lab provider/缺名一律 fail-closed（undefined）。永不使用用户 provider/API host、永不跨 provider、永不模糊/子串、永不用 family/日期/限制作身份、永不影响请求语义。请求侧 serving 建议（推理强度菜单）仍经 owning-provider 精确映射（`resolveMetadataSource` + exact serving id），与展示参考语义分离 | **Locked** |
| **MM-6** | **Canonical 匹配 fail-closed，禁止猜身份**：canonical 解析按 §5 的分层契约（exact → exact basename唯一 → case-folded唯一无歧义），其余一律 unknown/ambiguous → 未命中。**禁止**从 `apiHost`/`group`/`editable name`/`brand`/`owned_by` 或相似名称猜身份；调用方只传 model id 本体 | **Locked** |
| **MM-7** | **互补的丰富分工，不覆盖 Model/llm slice**：模型中心参考条目可补**参考侧**价格/限制/能力（cost/limits/effort 等显示字段覆盖于 canonical 之上，来源以 `source` 标记），canonical 数据可补**跨 provider 固有事实**（模态/标准能力/limits）。价格/限制/能力是第三方参考信息，不代表当前自定义连接。二者均**不得覆盖** `Model` 对象或 `llm` Redux slice 的持久化状态，不创建持久化/Redux 状态；快照为 renderer memory-only / Main cache-file-only | **Locked** |
| **MM-8** | **缓存边界只引用 source 常量，不复制易变数字**：缓存与归一化边界只引用已锁定的 source/endpoint/version 常量（`MODEL_METADATA_SOURCE`/`MODEL_METADATA_ENDPOINT`/`MODEL_METADATA_PROVIDER_SOURCES_ENDPOINT`/`MODEL_METADATA_CACHE_VERSION`/`MODEL_METADATA_CACHE_REL_PATH`）；价格/限制等易变数值不复制为代码常量，始终以快照为准 | **Locked** |
| **MM-9** | **Logo 语义分层**：模型/logo 解析优先级为 **canonical developer/lab**（`models.json` 的 lab 前缀，如 `moonshotai`）> **owning provider source fallback**（`api.json` 的 provider source，仅在 canonical 未命中时用于 connection 侧回退）> **model initial**（确定性首字母）。Provider fallback **不是** canonical 认定；**connection logo** 归属用户自定义连接经 `resolveMetadataSource` 映射的 source，**model logo** 归属 canonical lab，二者职责分离；应用内 provider 条目均为用户自定义连接，不是内建供应商身份；Logo 准入门槛 fail-closed，不发明 key | **Locked** |
| **MM-10** | **Alias/base_model 现实与治理边界**：上游 source TOML 存在 `base_model`，但公开发布的生成 JSON 会剥离该结构化字段（payload 中无该键），故请求身份永不依赖它。展示侧允许**有界回退**：模型中心参考查找的 (c)/(d) 以 canonical 名与 `snapshot.providers[canonicalLab]` 内 `name` 的唯一精确/折叠相等作别名式命中（如 `DeepSeek V4.1 Flash` → `deepseek-flash` 式），该回退仅为**展示 enrichment**，不是请求身份认定。未来若上游新增结构化 `base_model` 字段或提供显式审计映射，仅可用于 **enrichment**（展示/建议），**自动请求 ID 改写**（以别名/基座名替换 serving ID）须**独立治理与用户确认**，不得静默改写。不维护 ID 清单 | **Locked** |
| **MM-11** | **API dialect 只编码参数形状，不推断模型能力；serving 列表不作 request gate；参考价格不代表当前连接；上游响应最终；错误透明**：aiCore/请求层的 dialect 仅编码“该 provider 该模型族以何种参数形状表达推理/思考”（如 `reasoning_effort` / `thinking` / `effort` 映射），不以 dialect 存在与否推断模型是否具备推理能力；provider 的 serving 模型清单不作为请求闸门，请求层仍为用户 `Model.id` 惰性直送；展示的价格/限制/能力是第三方参考信息，不代表当前自定义供应商或接口；上游错误与上游返回（含认证/限流/模型不存在等）为最终事实，透明回显，不以本地元数据掩盖或改写 | **Locked** |
| **MM-12** | **演进与测试契约**：变更传播、测试分层与验收按 §10–§12 治理；任何新增读取必须声明能力归属（canonical / 参考 serving / 请求侧 serving 建议），任何新增变更必须用稳定 ID 意图；模型中心参考查找的覆盖（全 ID、basename、唯一精确名、唯一折叠名、歧义 fail-closed、缺 lab、无连接依赖）必须有契约测试；禁止以投影外观包装权威 | **Locked** |

> 决策锁 ID 是编排内部协调令牌的产物语义表达：MM-* 是本文档的 durable 决策 ID，不进入代码注释、配置或提交信息。

---

## 4. 身份三分离（Identity Separation）

- **Serving ID** 是请求的唯一身份：`Model.id` 经 `trim` 后原样进入 provider 请求，不因 canonical 命中/未命中而改写。大小写与标点均保留。
- **Canonical ID** 是知识的唯一键：`models.json` record key（如 `deepseek/deepseek-v3.2`），用于关联模态/能力/limits 等固有事实，不参与请求选路。
- **Display name** 是展示的唯一键：`Model.name` / `group` 等可编辑字段仅用于列表与卡片展示，不参与任何匹配或请求编码。
- 三者分离意味着：一次 canonical 未命中不影响请求可发性；一次 serving 未命中不否定 canonical 能力；一次展示名变更不改变请求或知识关联。

---

## 5. 双源职责与隔离（Source Responsibilities & Isolation）

### 5.1 `models.json` — Canonical（`snapshot.models`）

- 承载跨 provider 固有事实：`modalities`、`attachment`/`toolCall`/`structuredOutput`/`temperature`/`reasoning`、`limits`、`family`/`knowledge`/`releaseDate`/`lastUpdated` 等。
- 不发布 provider 侧价格或 `reasoning_options`；归一化时永不从 serving 记录回填。
- 键为 exact canonical ID；值经 `normalizeCanonicalModelsPayload` 的有界归一化后入库，单条异常不污染快照（MM-3）。

### 5.2 `api.json` — Provider-Serving（`snapshot.providers`）

- 承载 provider source 的 `api`（归一化 base URL）+ `name`（展示名），用于 connection logo 归属；可选 `models` 子树按类别保留稳定的展示字段（身份/展示、模态、能力、限制、时间戳、计费、推理选项等），经 `normalizeProviderSourcesPayload` 有界归一化后入库（含 `reasoning_options` type `effort` 的 `max`→`xhigh` 归一作为其中一类）；无 `models` 时仍为可用 source（logo-poor but valid），不视为失败。
- 归一化时仅保留上述展示字段类别，不枚举每个易变 key；超限条目跳过，整体不成比例时拒收快照。
- 其中 `snapshot.providers[canonicalLab]` 子集是 Edit Model 展示的模型中心参考来源（MM-5 的 (a)–(d) 唯一合法读取）；请求侧 serving 建议经 owning-provider 精确映射读取，二者语义分离。
- 该子树的 serving 记录永不合并进 `snapshot.models`（MM-2），仅供 §6 的模型中心参考查找（展示）与请求侧 serving 建议消费；展示合并仅发生在有效视图，不写入快照。

### 5.3 隔离不变量

- 同一快照内，`snapshot.models` 与 `snapshot.providers[*].models` 为**不同命名空间**；任何读取必须显式声明来源语义。
- `models.json` 解析失败不影响 `api.json` 的 connection logo 可用性，反之亦然；任一失败不 gate 请求（MM-3）。

---

## 6. 查找契约（Lookup Contracts）

### 6.1 Model-Centric Reference Lookup（MM-5，展示唯一合法）

```
resolveReferenceServingModel(canonicalId, snapshot, canonicalName?)
  = snapshot.providers[labOf(canonicalId)].models[<ordered match>]?
  （lab 仅为 canonical 前缀；用户 provider/API host 永不参与）
```

1. **(a) 精确 canonical 全 ID 键**：`canonicalId.trim()` 大小写敏感全量相等即命中。
2. **(b) 精确 canonical basename 键**：`basename(canonicalId)` 大小写敏感相等即命中。
3. **(c) 唯一精确显示名**：canonical 名（显式传入或 canonical 条目 `name`，trimmed）与 lab 内某条目 `name`（trimmed）大小写敏感相等，且恰好一条时命中；多条即歧义 → 未命中，不再进入 (d)。
4. **(d) 唯一折叠显示名**：(c) 无命中时，双方 trim 后 case-folded 相等且恰好一条时命中；否则未命中。
5. **Never**：跨 provider、模糊/子串匹配、以 family/日期/限制作身份、剥离 `:xxx` 路由后缀、版本推断、首候选截断、以用户 provider/`apiHost`/`group`/可编辑名推导。
- 缺 lab provider、缺 models 映射、canonical 无名（(c)/(d) 无法比较）、歧义一律为无参考元数据（unknown），不否定请求能力。
- 请求侧 serving 建议（推理强度菜单）仍经 owning-provider 精确映射：`resolveMetadataSource`（`type: 'anthropic'` → `anthropic`、`type: 'gemini'` → `google`、OpenAI 官方 host 精确相等 → `openai`，其余以 `apiHost` 归一化后与 `snapshot.providers[*].api` 唯一精确匹配，零或多匹配均为 unknown）+ `exact case-sensitive trimmed model id`；该映射同时用于 connection logo 归属，不用于 canonical 身份判定与 Edit Model 展示。

### 6.2 Canonical Matching（MM-6）

按 `resolveCanonicalModel` 的分层契约，fail-closed：

1. **Tier 1 — Exact**：`query.trim()` 与 canonical ID 大小写敏感全量相等即命中。
2. **Tier 2 — Exact basename**：`basename(query)`（`/` 后子串）大小写敏感相等，且该 basename 在全 canonical 空间**唯一**时命中。
3. **Tier 3 — Case-folded**：`lower(query)` / `lower(basename)` 各自命中集合的**并集恰好为单一** canonical 时命中；否则 ambiguous → 未命中。
4. **Never**：剥离 `:xxx` 路由后缀、版本推断、前缀/相似度匹配、首候选截断、或以 `apiHost`/`group`/`name`/`brand`/`owned_by` 推导身份。

---

## 7. 能力、限制与价格的补充分工（Enrichment Division）

- **Canonical 补固有事实**：模态、标准能力、limits 等跨 provider 不变量，经 `resolveExternalReasoningSupport` / `resolveCapabilityWithOverride` 进入 UI 判断，但**缺省为 unknown**，不作为 false 分支的否定依据（MM-4）。
- **模型中心参考补参考事实**：`snapshot.providers[canonicalLab]` 的参考条目展示字段类别（含计费/限制/能力等，其中 `reasoning_options` type `effort` 进入 Edit Model 有效视图的 `effort`）与 canonical 合并为有效视图（参考优先、canonical 补缺，`source` 标记来源），仅作展示性 enrichment，按类别归一化，不枚举每个易变 key。请求侧推理强度菜单建议项仍经 owning-provider 精确映射（`resolveProviderServingEffort` / `getResolvedReasoningOptions`），`default`/`none` 为产品固定项永不单独来自 serving。
- **禁止覆盖**：二者均不得写入 `Model` 对象或 `llm` Redux slice；快照仅驻留于 renderer 内存与 Main `Cache/model-metadata/models-dev-models.json`（MM-7）。
- **价格/计费**：不在 canonical 能力画像内；参考侧价格信息仅作展示性 enrichment，不代表当前自定义供应商或接口，不进入请求计费逻辑的本地权威。Edit Model「模型数据」标题旁以 HelpTooltip 声明该第三方参考性质（`models.reference.disclaimer_tooltip`，至少 en-us/zh-cn）。

---

## 8. 缓存与持久化边界（Cache & Persistence Boundary）

- 缓存为 versioned envelope，版本以 `packages/shared/modelMetadata.ts` 的 `MODEL_METADATA_CACHE_VERSION` 为唯一可信引用；路径固定于 `MODEL_METADATA_CACHE_REL_PATH`；`MODEL_METADATA_SOURCE = 'models.dev'` 为快照唯一 source tag。
- 端点与版本常量为**唯一可信引用**（`MODEL_METADATA_ENDPOINT` / `MODEL_METADATA_PROVIDER_SOURCES_ENDPOINT` / `MODEL_METADATA_CACHE_VERSION` / `MODEL_METADATA_CACHE_REL_PATH`）；易变数值（价格/限制/计数）不复制为代码常量，始终以快照为准（MM-8）。
- 归一化边界有界（`DEFAULT_NORMALIZATION_LIMITS`），超限条目跳过、整体不成比例时拒收快照；任一拒收不 gate 请求（MM-3）。
- 状态机：`ready`（有快照，含后台刷新失败仍 ready）/ `loading`（无快照且进行中）/ `unavailable`（无快照且已失败，携带 `ModelMetadataRefreshReason` 消毒原因）；IPC/cache 边界经 `zod` 防御性校验。

---

## 9. Logo 语义（Logo Semantics）

- **Model logo**：解析自 canonical lab（`labOf(canonicalId)`，`/` 前前缀），与 serving proxy 无关；未命中/歧义时回退到**确定性 initial**（模型名首字母），永不回退到 proxy provider logo（MM-9）。
- **Connection logo**：解析自用户自定义连接经 `resolveMetadataSource` 精确映射到的 `api.json` source id，用于 provider 设置行与 provider 头像；无 source 时回退到 initial，不发明 key。应用内 provider 条目均为用户自定义连接，不是内建供应商身份。
- **Fallback 非认定**：provider source fallback 仅用于 connection 侧展示，不构成对 canonical 身份的认定；`getCanonicalLabs` 仅用于 Main 侧 logo 准入门槛的 lab 集合，不发明 logo key。
- **安全门**：`isSafeMetadataKey` / `isSafeLogoSourceId` 对 `__proto__`/`constructor`/`prototype` 等不安全键 fail-closed；上游数据永不污染原型。

---

## 10. Alias / Base Model 现实与治理边界（Alias & Base Model）

- **当前现实**：上游 source TOML 存在 `base_model`，但公开发布的生成 JSON 会剥离该结构化字段（payload 中无该键）；`name`/`family` 字段为展示性文本，**不得**作别名启发式（如家族前缀、名称相似度）推导 canonical 身份（MM-10）。唯一的例外是展示侧有界回退：MM-5 (c)/(d) 以 canonical 名与 `snapshot.providers[canonicalLab]` 内 `name` 的唯一精确/折叠相等作别名式命中，仅为展示 enrichment，不是请求身份认定。
- **未来演进**：若上游新增结构化 `base_model` 字段或提供显式审计映射，仅可用于 **enrichment**（如展示“基于 …”或建议关联），**自动请求 ID 改写**（将用户填写的 serving ID 静默替换为别名/基座 ID）须**独立治理与用户显式确认**，不得自动改写请求身份（MM-1/MM-4）。
- **非规范性例子**：如 `DeepSeek Flash` 场景下某思考变体与基座的关联，仅作理解辅助的非规范性举例，**不维护**任何 ID 清单或硬编码映射；真实关联以未来上游结构化字段或显式审计映射为准。

---

## 11. API Dialect 与错误透明（API Dialect & Error Transparency）

- **Dialect 仅编码形状**：aiCore/Provider 层的 dialect（如 `reasoning_effort: low/medium/high` / `thinking` / `effort: xhigh` 等）仅编码“以何种参数形状向该 provider 表达推理强度”，不据此推断模型是否具备推理能力（MM-11）。
- **Serving 列表不作 gate**：provider 的 serving 模型清单（`api.json` `providers[*].models`）不作为请求闸门；用户显式填写的 serving ID（`Model.id` 惰性直送，元数据永不改写）即使未出现在 serving 列表，仍惰性发送，上游响应最终。
- **错误透明**：认证失败、模型不存在、限流、上游校验错误等一律透明回显，不以本地元数据掩盖或改写错误语义；`reasoning` 等能力的本地 unknown 不转化为请求侧的否定或静默认证。

---

## 12. 变更传播（Change Propagation）

按 `AGENTS.md` 的 Change Propagation 分类，模型元数据变更的边界与证据随边界升高：

| 变更类型 | 边界 | 传播与证据要求 |
|---|---|---|
| 展示/文案（ModelAvatar/ModelMetadataReference 等纯展示，含模型数据 HelpTooltip） | Presentation | 仅影响 renderer 展示；回归以 Vitest/组件测试为主，不触 IPC/持久化/请求 |
| 本地渲染状态（Edit Model 有效视图的参考装配；请求侧 reasoning 菜单的 serving 选项装配） | Local state | 仅影响 renderer 本地选项计算；不触请求编码与持久化；展示参考（canonical-lab）与请求侧 `provider->source` 精确映射的隔离需保持 |
| 跨进程契约（`packages/shared/modelMetadata.ts` 的快照/IPC/cache schema） | Cross-process contract | 共享契约两侧协同变更（shared + Main + preload + renderer）；schema 变更需版本化与兼容解析（`parseModelMetadataSnapshot`/`parseModelMetadataCache`） |
| 持久化/迁移（`ModelMetadataService` 缓存文件、envelope 版本） | Persistence/migration | 版本化迁移（versioned envelope，版本以 `packages/shared/modelMetadata.ts` 的 `MODEL_METADATA_CACHE_VERSION` 为准），旧 envelope 按版本字面量拒收；不触 `llm` slice；`Data/chat.db` 与 `Dexie` 边界不变 |
| 提供方/请求语义（aiCore dialect、请求参数编码） | Provider/request semantics | aiCore 侧 dialect 变更不得以 serving 存在性推断能力；请求身份永不因元数据改写 |
| 身份/治理（本文档的 MM-1…MM-12） | Product identity/governance | ADR 级决策，需用户确认；不得以局部实现代码重释治理语义 |

更高边界要求更广证据与更高决策：单行展示改动不提升为契约变更，以本地推导绕过精确查找即治理违规。

---

## 13. 测试与证据契约（Test/Evidence Contract）

- **单元测试**：双源归一化（`normalizeCanonicalModelsPayload` / `normalizeProviderSourcesPayload`）、有界限幅与不安全键过滤、模型中心参考查找（canonical 全 ID → basename → 唯一精确显示名 → 唯一折叠显示名，歧义 fail-closed，缺 lab、与用户连接无关）、请求侧 owning-provider 精确查找（大小写敏感、trim、source 精确）、canonical 分层匹配（exact → basename唯一 → case-folded唯一无歧义，歧义 fail-closed）、unknown vs false（缺省 unknown）、enrichment-only（网络/缓存/查找失败不阻断请求）。
- **组件测试**：模型卡片/头像的 logo 分层（canonical lab > provider fallback > initial）、Edit Model 模型数据的参考装配与 HelpTooltip（`models.reference.disclaimer_tooltip` 标题）、reasoning 强度菜单的 serving 驱动装配（`default`/`none` 恒为产品项，serving 仅附加）、缺省/未知态的展示正确性。
- **证据层级**：按 `AGENTS.md`「Testing and UI/E2E Evidence」路由；UI 变更的渲染/交互验证经 `ui-verify-change`；跨组件/IPC/持久化/生命周期行为的合同级回归以 Playwright E2E 为准，隔离的稳定展示/逻辑以 Vitest/组件测试为先。
- **禁令回归**：以用户 provider/`apiHost`/`group`/可编辑名/`brand`/`owned_by` 或相似名称猜 canonical 身份、以 serving 列表作 request gate、以参考价格/限制覆盖当前连接事实的任何新增，必须以契约测试失败为门禁（fail-closed），不得以展示正确为通过条件。

---

## 14. 非目标（Non-goals）

- 不定义应用身份、兼容性标识、发布/更新、平台范围——由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理。
- 不定义 SQLite schema、迁移 mechanics、L2 ZIP 导入管线——由 [SQLite migration governance](../archived/sqlite-migration.md) 治理。
- 不定义上下文锚点的详细有效性/默认/继承/修复策略——由 [Context window governance](./context-window.md) 治理。
- 不定义投影完备性与权威意图的窗口/集合/闭包语义——由 [Projection Completeness and Authority Intents](./projection-completeness-authority.md) 治理。
- 不定义同步收敛（基线/操作日志/帧合并/水位）——现状由 [Personal Multi-Device Sync](../work/multi-device-sync.md) 治理，目标由 [Sync Connection & Channel ADR](./sync-connection-channel.md) 与 [Sync Data Convergence ADR](./sync-data-convergence.md) 治理。
- 不重复实现位置与调用链细节（见 `AGENTS.md` 与 `docs/architecture/architecture.md`）；不引入性能阈值、基线或容量策略。
- 不维护模型 ID 清单或家族启发式；不以 dialect 存在性推断模型能力。

---

## 15. 验收标准（Acceptance Criteria）

- **AC-1**：本文档完整覆盖 MM-1…MM-12 决策表、术语表（§2，三身份与双源职责准确）、双源职责与隔离（§5）、查找契约（§6，分层匹配与精确查找准确）、互补分工与缓存边界（§7–§8）、Logo 语义（§9）、alias/base_model 现实与改写隔离（§10）、dialect 与错误透明（§11）、变更传播（§12）、测试契约（§13）、非目标（§14）。
- **AC-2**：全文内部一致——serving ID（用户 `Model.id`）原样发送、canonical ID 仅作知识关联、display name 仅作展示；应用内 provider 条目均为用户自定义连接；参考价格/限制/能力不代表当前连接，上游响应最终；enrichment-only 且 never gate；缺省为 unknown；模型中心参考查找有序且 fail-closed；provider fallback 非 canonical 认定；dialect 不推断能力。
- **AC-3**：`docs/architecture/architecture.md` AI Core 段落与 `AGENTS.md` mental model / Detailed References 链接本文档，且不复制决策表。
- **AC-4**：`AGENTS.md` 既有 MUST/NEVER/gate/security 规则零改动；`CLAUDE.md` 仍为 `AGENTS.md` 的符号链接。
- **AC-5**：文档不宣称不存在的代码，缓存与归一化边界以 `packages/shared/modelMetadata.ts` 的常量（`MODEL_METADATA_CACHE_VERSION` 等）为准；`CLAUDE.md` 保持为 `AGENTS.md` 的符号链接；`git diff --check` 干净，关键 MUST 规则与链接可验证。
