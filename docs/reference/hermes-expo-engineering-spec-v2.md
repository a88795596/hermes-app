# Hermes Expo 移动客户端工程设计规格书 v2

**状态：** 详细设计，不是实现完成报告；不授权开发、安装、部署、创建测试配置档案或改动现有 Hermes。
**目标：** 让客户端、BFF、连接器和测试人员能够依据统一的数据契约并行实施，而非再次自行推测接口与异常语义。
**架构：** Expo / React Native 应用 → HTTPS/WSS BFF → 主动出站连接器 → Hermes Canonical Gateway；主动投递另接插件适配器。
**技术栈：** TypeScript、Expo Router、TanStack Query、Zustand、SQLite；Fastify、PostgreSQL、S3 兼容对象存储；Node 连接器、本地 SQLite；Python 投递插件。
**证据边界：** 沿用 v1 已读取的官方 Expo 文档和 Hermes 固定源码 `3bcd071226d3d605a2bb3b4f3933e7d583e189d6`，补充静态协议核查。本文件中的移动端 API、连接器通信协议、SQL、默认参数、测试和模块接口均为**待实现设计**，不是 Hermes 自带接口或真实运行输出。
**版本关系：** 本文是可独立阅读的 v2 详细设计，保留 v1 的功能范围；冲突时以本版明确的数据契约为准。v1 保留为架构讨论记录。

**阅读导航：** 产品/架构看第1—4、15、19—20章；BFF开发看第5—10、14章；应用开发看第7—8、11—12章；连接器开发看第3、11、13章；测试/运维看第17—18章。第21章说明本轮实际验证边界，文末列有官方文档和固定源码链接。

---

## 1. 本版到底增加了什么

| v1 缺口 | v2 必须落到的粒度 |
|---|---|
| 只有模块名 | 模块职责、输入/输出、禁止依赖、代码路径 |
| 只有 API 路径 | 方法、权限、请求字段、回执、幂等、错误语义 |
| 只有数据表名 | 字段类型、外键、索引、状态约束、事务边界 |
| “支持断线恢复” | 游标种类、快照切点、重放、确认、去重、过期处理 |
| “支持审批” | 请求形态、响应 CAS、上游确认、丢确认、多设备竞态 |
| “支持通知” | 收件箱、推送尝试、渠道选择、回执、主动投递缺口 |
| “按阶段开发” | 工作包、依赖、变更路径、失败测试、完成证据 |

**设计底线：** 不把网络重试变成业务重做，不把一次连接等同于一个会话，不把 BFF 持久接收等同于 Hermes 接纳，不把操作系统推送接纳等同于用户收到。

### 1.1 全量能力与版本标签

范围仍为通过 Telegram 使用 Hermes 的能力。标为「核心版」的阶段可以先用于个人聊天。全量替代验收覆盖多配置档案、话题、多会话并发、流式回复与工具过程、审批与澄清、图片、文件、语音、视频、命令、离线恢复、定时任务与 `send-message`、引用与回应、分享导入与导出、位置、联系人、群聊、@ 提及和话题技能。上游 Telegram 文档记录了相应的使用流程。[11]

每项功能在能力中具有：`available | disabled_by_policy | unavailable_upstream | requires_native_build | pending_validation`。实施看板另有 `not_started | implemented | verified`，产品可用性与工程进度不得混用。

## 2. 首版明确的技术决策（ADR）

| 决策 | 推荐值 | 原因与被放弃选项 |
|---|---|---|
| 主聊天 UI | 原生 React Native | 不以 WebView 包装桌面端渲染进程；平台 API 和后台差异可控 |
| 对 Hermes 的接入 | 标准协议 WebSocket | 复用多会话、控制与恢复契约；不通过 PTY 抓文本，也不混用旧版负载。[7][8] |
| 公网入口 | 单 BFF 域名，HTTPS/WSS 443 | 不公开 Dashboard、本地控制套接字、Hermes 管理凭据 |
| 应用写操作 | HTTPS JSON | 易定义幂等/超时/状态码；WS 只用于订阅和同步控制 |
| BFF→连接器命令 | 主动出站 WSS 上的业务命令 | 不做任意 JSON-RPC 透传 |
| 上游执行主权 | Hermes | BFF 通过适配入口访问 Hermes，执行和状态数据库由现有智能体管理 |
| 服务端持久化 | PostgreSQL 事务 + 数据库工作进程 | 首版不强制 Redis/Kafka/Kubernetes |
| 附件 | 私有对象存储 + 本地暂存 | 不把手机 URI 或用户任意路径传给 Hermes |
| 设备历史 | SQLite 单事实源 | Query 管元数据，Zustand 管瞬态，不三份历史互相覆盖 |
| 推送 | 收件箱先持久，再发件队列 | 系统通知只是提醒，结果靠同步恢复 |
| 运行实例 | 一个 BFF，每个后端由一个连接器实例负责 | 首版各后端由固定实例处理写入，避免重复执行 |
| 协议升级 | 移动端 API v1 + 适配器能力清单 | 不要求应用跟着 Hermes 每个提交更新 |

### 2.1 物理部署

```text
应用 ──443── BFF API 与 WebSocket    （公网可信服务区）
              │
              ├── PostgreSQL         （私网，不开放公网端口）
              ├── 私有 S3 存储桶      （短期上传与下载授权）
              └── 数据库工作进程     （同步、对账、媒体和推送）
              ▲
              │ 连接器主动通过 WSS 连接
连接器、本地队列和暂存区             （Hermes 所在主机）
              │ 通过本地 attach 获取一次性票据
              ▼
Hermes Canonical Gateway → 智能体／工具／配置档案
              │
              └── 投递插件 → 本地队列 → BFF 收件箱
```

连接器同机读取本地 attach 信息；一次性票据不传到手机、不写日志。官方有 attach/能力发现契约，但部署时仍以实际安装版本为准。[7]

Mac 休眠时：应用仍可读缓存/BFF 历史，BFF 可保存有有效期的待发送输入；执行显示 `waiting_connector`。不能把 Mac 在线与 BFF 在线合成一个绿点。

### 2.2 建议起始参数（全部可配置，非官方上限/实测 SLA）

| 参数 | 初始建议 | 超限行为 |
|---|---|---|
| API 的 JSON 请求体 | 256 KiB | 413；附件不得 base64 塞进正文 |
| 单条文本 | 64 KiB UTF-8 | 422，建议改为文本附件 |
| 单条附件 | 最多 10 个 | 422，不悄悄丢后面的附件 |
| 普通附件上限 | 100 MiB | 能力可降低；模型支持另算 |
| 上传分片 | 8 MiB，手机并发 2 | 每片重试；不整文件重传 |
| 上传会话 | 24 小时有效 | 过期后显式重新创建，不能拼接旧部分 |
| 未发普通消息有效期 | 24 小时 | 过期转 expired，用户再次确认 |
| 审批响应有效期 | 以截止时间为准 | 上游提供明确的截止时间时才显示倒计时 |
| 访问令牌 | 10 分钟 | 到期刷新，保留本地草稿 |
| 刷新会话 | 滚动 30 天 | 设备撤销立即生效 |
| 配对授权 | 5 分钟，单次 | 过期重签，禁止无限次猜码 |
| WS 应用心跳 | 25 秒；75 秒未收到则重连 | 不把短断线当执行失败 |
| 重连退避 | 全随机抖动，基数 1 秒，上限 30 秒 | 回到前台可立即尝试一次 |
| RPC 查询/命令接纳超时 | 15 秒 | 接纳不明则查询；不重新生成 ID |
| 事件流同步批量 | 200 条或 512 KiB | 返回 next_cursor；不半截 JSON |
| WS 批次 | 最多 100 条或 256 KiB | 大工具结果改引用资源 |
| 应用未确认缓冲 | 512 条或 2 MiB | sync_required 后断开，改 HTTP 补拉 |
| 连接器租约 | 60 秒，20 秒续租 | 失租停接新命令；不自动转移执行权 |
| 事件流增量保留 | 7 天 | 旧游标要求快照 |
| 物化快照 | 10 分钟下载期 | 过期重建，旧本地数据不提前清空 |

大小是服务端产品限额而非模型可处理能力。`capabilities` 返回实际有效限额，服务端始终复核。

## 3. 统一标识、归属与版本语义

### 3.1 ID 字典

本项目生成的 ID 使用 UUID 字符串。上游 Hermes ID 是不透明字符串，**原样保存，禁止“修正”或重造**。

| 字段 | 归属/用途 | 唯一与变更规则 |
|---|---|---|
| account_id | 本应用的租户/工作区 | 首版只有个人账户，但不是全局硬编码 |
| user_id / device_id | 用户与设备 | 多设备同用户；设备不决定上游负责人 |
| backend_id | 一个 Hermes 后端注册 | 更换主机不复用旧凭据 |
| profile_id | 应用内配置档案记录 UUID | 与 `gateway_profile_ref` 分开，default 不是 UUID |
| gateway_profile_ref | 上游真实配置档案标识/名称 | 来自可信发现，不由手机自由传路径 |
| topic_id | 应用稳定逻辑话题 | 重置会话仍可保留话题；分支创建新话题 |
| binding_id | 话题→Hermes 绑定版本 | 每次重置或交接时递增 `binding_revision` |
| hermes_session_id | 标准协议逻辑 ID | 以快照为准，保存会话逻辑 ID 和当前存储记录的关联 |
| stored_session_id | 当前持久历史片段 | 压缩/重置可变化。[6][9] |
| submission_id | 用户一次发送意图 | 客户端首次发送前生成，重试不变 |
| admission_id | Hermes 接纳回执 | 收到后原样保存，不能用 submission_id 代替 |
| message_id / block_id | BFF 展示实体 | 同一流式气泡稳定，不随增量变化 |
| control_id | BFF 交互卡片 | 映射上游提示或请求及其纪元和代次 |
| response_id | 一次审批或澄清回答 | 幂等响应身份，不等于 control_id |
| event_id / ingest_id | 下游事件/上游入库身份 | 事件重发保留原 ID |
| command_id / lease_generation | 云→连接器命令/租约代次 | 确认和终态都围绕 command_id |
| delivery_id | 主动消息投递身份 | 有稳定来源才可跨重试去重 |

### 3.2 四种版本，禁止混用

1. `api_version`：本项目接口版本，当前提案 v1。
2. `entity_version`：BFF 单个投影实体版本，用于 UI 归约与乐观并发。
3. `binding_revision` / Hermes `execution_generation`：分别约束话题绑定和目标执行代次。
4. `feed_epoch + sequence`：客户端同步位置，与上游 `replay_epoch + seq` 无关。

时间用 UTC RFC3339，界面转为本地时间。排序和幂等性还需依据稳定标识。64 位序号通过 JSON 发送十进制字符串。

本项目版本/代次的JSON也统一十进制字符串；适配器转入Hermes整数参数时检查整数范围并用无损编码，不能先转JavaScript Number再发现已丢精度。上游授权范围与回放标识按实际结构定义保留，不因应用ID规范而改写。

### 3.3 权限实体

每个业务资源带 account_id；所有话题带 backend_id/profile_id；可写命令还需 `chat.send / session.control / control.respond` 等应用权限。上游连接被授权并不意味着任何应用用户可使用它。

首版个人负责人映射连接器的固定认证主体，不随设备改变。群聊阶段需增加成员授权和作者归属；不得直接向群成员下放 操作员级权限。

## 4. 数据所有权和模块依赖

| 数据 | 权威写入者 | 其他层如何使用 |
|---|---|---|
| 智能体历史、工具执行、接纳 | Hermes | 连接器读取并归一化，BFF 通过 Hermes 接口请求变更 |
| 配置档案授权、设备与会话安全 | BFF | 应用缓存但不决定授权 |
| 话题展示、收件箱、已读、回应 | BFF | 应用的 SQLite是离线副本 |
| 流式临时块 | 连接器→BFF投影 | 完成后与上游历史对账 |
| 原始附件对象 | BFF媒体服务 | 连接器只访问被授权附件 |
| 本地待发消息/未完成录音 | 应用的 SQLite+文件目录 | 提交确认后转服务端权威 |
| 上游原始事件缓冲 | 连接器本地队列 | 确认后可清理，不能替代无限上游历史 |

### 4.1 后端依赖方向

```text
路由 → 应用服务 → 领域规则 → 存储层
             └── 连接器接口／媒体接口／推送接口
工作进程 → 同一应用服务
```

- `routes` 通过应用服务调用 Hermes 方法。
- `repositories` 不发送 WS，不调用推送。
- 事务内只做 DB 操作，不等待网络或模型。
- API/worker 用同一权限与状态转换函数。
- 协议包独立于 Fastify、React Native、Electron 和 Node 文件系统 API。

## 5. PostgreSQL 物理模型

以下为**核心迁移设计**。SQL 是提案，不声称已经执行。所有删除默认走业务流程，不使用跨用户隐式级联删除。

### 5.1 核心 DDL

```sql
CREATE TABLE topics (
  account_id uuid NOT NULL,
  topic_id uuid NOT NULL,
  backend_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('direct','room')),
  title text NOT NULL,
  state text NOT NULL CHECK (state IN ('creating','ready','archived','deleting','deleted','error')),
  entity_version bigint NOT NULL DEFAULT 1,
  binding_revision bigint NOT NULL DEFAULT 1,
  next_message_order bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, topic_id),
  UNIQUE (account_id, backend_id, profile_id, topic_id)
);
CREATE INDEX topics_list_idx ON topics
  (account_id, profile_id, state, updated_at DESC, topic_id);

CREATE TABLE session_bindings (
  account_id uuid NOT NULL,
  topic_id uuid NOT NULL,
  binding_revision bigint NOT NULL,
  backend_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  hermes_session_id text NOT NULL,
  stored_session_id text,
  upstream_principal_ref text NOT NULL,
  upstream_revision bigint,
  authority_epoch bigint,
  replay_epoch text,
  last_upstream_sequence bigint NOT NULL DEFAULT 0,
  execution_generation bigint,
  active boolean NOT NULL,
  PRIMARY KEY (account_id, topic_id, binding_revision),
  FOREIGN KEY (account_id, topic_id) REFERENCES topics(account_id, topic_id)
);
CREATE UNIQUE INDEX session_binding_active_idx ON session_bindings(account_id, topic_id) WHERE active;
CREATE UNIQUE INDEX session_binding_upstream_idx ON session_bindings
  (account_id, backend_id, profile_id, hermes_session_id) WHERE active;

CREATE TABLE submissions (
  account_id uuid NOT NULL,
  topic_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  binding_revision bigint NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN
    ('accepted','waiting_connector','dispatching','admitted','queued','running',
     'waiting_control','completed','failed','cancelled','expired','unknown')),
  admission_id text,
  command_id uuid NOT NULL,
  entity_version bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, submission_id),
  UNIQUE (account_id, command_id),
  FOREIGN KEY (account_id, topic_id) REFERENCES topics(account_id, topic_id)
);
CREATE INDEX submissions_unsettled_idx ON submissions(account_id, status, updated_at)
  WHERE status NOT IN ('completed','failed','cancelled','expired');

CREATE TABLE messages (
  account_id uuid NOT NULL,
  topic_id uuid NOT NULL,
  message_id uuid NOT NULL,
  submission_id uuid,
  message_order bigint NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('user','assistant','system','delivery')),
  status text NOT NULL CHECK (status IN ('pending','streaming','final','failed','cancelled','unavailable')),
  entity_version bigint NOT NULL,
  upstream_identity jsonb,
  reply_to_message_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, message_id),
  UNIQUE (account_id, topic_id, message_order),
  UNIQUE (account_id, topic_id, message_id),
  FOREIGN KEY (account_id, topic_id) REFERENCES topics(account_id, topic_id)
);
CREATE TABLE message_blocks (
  account_id uuid NOT NULL,
  message_id uuid NOT NULL,
  block_id uuid NOT NULL,
  ordinal integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text','tool','image','file','audio','video','control','location','contact','notice')),
  entity_version bigint NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (account_id, block_id),
  UNIQUE (account_id, message_id, ordinal),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id)
);

CREATE TABLE feed_heads (
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  epoch uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  min_retained_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, user_id)
);
CREATE TABLE user_events (
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  feed_epoch uuid NOT NULL,
  feed_seq bigint NOT NULL,
  event_id uuid NOT NULL,
  entity_id uuid,
  entity_version bigint,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, user_id, feed_epoch, feed_seq),
  UNIQUE (account_id, user_id, event_id)
);
CREATE TABLE connector_ingest (
  account_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  ingest_id uuid NOT NULL,
  payload_hash text NOT NULL,
  upstream_dedupe_key text,
  stored_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, connector_id, ingest_id)
);
CREATE UNIQUE INDEX connector_upstream_dedupe_idx ON connector_ingest
  (account_id, connector_id, upstream_dedupe_key) WHERE upstream_dedupe_key IS NOT NULL;

CREATE TABLE controls (
  account_id uuid NOT NULL,
  topic_id uuid NOT NULL,
  control_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('approval','clarify','connection','unsupported')),
  transport text NOT NULL CHECK (transport IN ('canonical_prompt','server_request')),
  upstream_key text NOT NULL,
  binding_revision bigint NOT NULL,
  execution_generation bigint,
  state text NOT NULL CHECK (state IN ('pending','responding','resolved','cancelled','expired','resolution_unknown','closed_unknown')),
  entity_version bigint NOT NULL,
  request_payload jsonb NOT NULL,
  response_id uuid,
  deadline_at timestamptz,
  PRIMARY KEY (account_id, control_id),
  UNIQUE (account_id, topic_id, upstream_key),
  FOREIGN KEY (account_id, topic_id) REFERENCES topics(account_id, topic_id)
);
CREATE TABLE control_responses (
  account_id uuid NOT NULL,
  response_id uuid NOT NULL,
  control_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  expected_version bigint NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('claimed','sent','confirmed','rejected','unknown')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, response_id),
  FOREIGN KEY (account_id, control_id) REFERENCES controls(account_id, control_id)
);
CREATE UNIQUE INDEX control_active_response_idx ON control_responses(account_id, control_id)
  WHERE status IN ('claimed','sent','unknown');

CREATE TABLE command_outbox (
  account_id uuid NOT NULL,
  command_id uuid NOT NULL,
  backend_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  topic_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','leased','connector_stored','settled','unknown','expired')),
  lease_owner uuid,
  lease_generation bigint,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  result jsonb,
  PRIMARY KEY (account_id, command_id)
);
CREATE INDEX command_claim_idx ON command_outbox(next_attempt_at, command_id)
  WHERE status IN ('pending','leased');

CREATE TABLE inbox_items (
  account_id uuid NOT NULL,
  inbox_item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  topic_id uuid,
  source_kind text NOT NULL,
  source_key text NOT NULL,
  message_id uuid,
  state text NOT NULL CHECK (state IN ('available','unavailable','deleted')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, inbox_item_id),
  UNIQUE (account_id, user_id, source_kind, source_key)
);
CREATE TABLE push_outbox (
  account_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  inbox_item_id uuid NOT NULL,
  device_id uuid NOT NULL,
  notification_kind text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','sending','accepted','retry','expired','dead','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, notification_id),
  UNIQUE (account_id, inbox_item_id, device_id, notification_kind),
  FOREIGN KEY (account_id, inbox_item_id) REFERENCES inbox_items(account_id, inbox_item_id)
);
```

### 5.2 其他必须建的表与字段

以下字典同属物理模型，不是随意留白；`PK` 为主键，`UQ` 为唯一约束。真实迁移为相关 account/user/backend/profile/device 外键补齐复合引用。所有租户内引用必须含 account_id，禁止只凭 UUID 全球唯一就省略租户校验。

| 表 | 关键字段（类型） | 索引/约束 |
|---|---|---|
| accounts | id uuid, name text, status text, created_at timestamptz | PK(id) |
| users | account_id uuid, user_id uuid, role text, status text | PK(account_id,user_id) |
| devices | account_id,device_id,user_id uuid; platform/name text; revoked_at,last_seen_at timestamptz | PK(account_id,device_id); user_id索引 |
| auth_families | account_id,family_id,device_id uuid; current_generation bigint; status text; expires_at | PK(account_id,family_id) |
| refresh_tokens | account_id,token_id,family_id uuid; secret_hash bytea; generation bigint; used_at,expires_at | UQ(secret_hash); UQ(family_id,generation) |
| refresh_replays | account_id,family_id,request_id uuid; encrypted_response bytea; expires_at | UQ(family_id,request_id); 短期敏感结果，不进日志 |
| pairing_grants | grant_id,account_id uuid; token_hash bytea; allowed_scopes jsonb; expires_at,consumed_at | token_hash UQ；原令牌不落DB |
| backends | account_id,backend_id uuid; name text; status text; approved_instance_ref text | PK(account_id,backend_id) |
| profiles | account_id,backend_id,profile_id uuid; gateway_profile_ref text; label text; capabilities jsonb | UQ(account_id,backend_id,gateway_profile_ref) |
| profile_grants | account_id,profile_id,user_id uuid; scopes text[]; acl_revision bigint | PK(account_id,profile_id,user_id) |
| connector_leases | account_id,backend_id,connector_id uuid; 代次 bigint; lease_until; identity_ref text | PK(account_id,backend_id); 不等于上游fence |
| topic_members | account_id,topic_id,user_id uuid; role text; joined_at,removed_at | PK(account_id,topic_id,user_id) |
| topic_preferences | account_id,topic_id,user_id uuid; pinned bool; mute_until; color text | PK(account_id,topic_id,user_id) |
| read_cursors | account_id,topic_id,user_id uuid; last_read_message_order bigint; updated_at | PK(account_id,topic_id,user_id)；仅单调前进 |
| attachments | account_id,attachment_id,profile_id,uploader_user_id uuid; object_key text; mime,size,sha256; state text; refs bigint | UQ(account_id,object_key)；size>=0；state受限 |
| uploads | account_id,upload_id,attachment_id uuid; storage_upload_id text; part_size int; status text; expires_at | PK(account_id,upload_id); storage_upload_id不可给业务当路径 |
| upload_parts | account_id,upload_id uuid; part_number int; etag text; bytes bigint; checksum text | PK(account_id,upload_id,part_number) |
| attachment_refs | account_id,attachment_id,topic_id,resource_id uuid; resource_kind text | UQ(account_id,attachment_id,resource_kind,resource_id) |
| push_registrations | account_id,device_id uuid; provider,environment,app_id text; encrypted_token bytea; token_hash bytea; active bool | UQ(device_id,provider,environment,app_id) |
| push_attempts | account_id,attempt_id,notification_id uuid; 提供方,ticket_id,status text; error_code; created_at | notification_id/created_at索引；不存正文 |
| delivery_receipts | account_id,delivery_id,profile_id uuid; producer_ref,source_execution_id text; payload_hash text; inbox_item_id uuid | 稳定source时UQ(account_id,producer_ref,source_execution_id) |
| sync_snapshots | account_id,user_id,snapshot_id uuid; feed_epoch uuid; 水位 bigint; acl_revision bigint; state; expires_at | snapshot_id PK；绑定用户且过期受控 |
| snapshot_rows | snapshot_id uuid; ordinal bigint; entity_kind text; entity jsonb | PK(snapshot_id,ordinal)；创建后只读 |
| mutation_receipts | account_id,request_id,actor_user_id,topic_id uuid; kind,payload_hash,status text; result jsonb | UQ(account_id,request_id) |
| audit_events | account_id,audit_id,actor_user_id uuid; action,target_ref,result text; request_id uuid; at | 不存密钥；按时间保留 |
| idempotency_tombstones | account_id,operation_id uuid; kind,payload_hash,final_status text; expires_at | 防止清理正文后旧请求复活 |

### 5.3 事务与清理要求

- 所有写入统一锁顺序：先按稳定user_id顺序锁定受影响feed_heads，再锁Topic/control/submission等业务行。接收者集合先按ACL 修订版本读取，取得锁后重验；集合或ACL变化则整体回滚重试，不能持有业务锁后反向追加事件流锁。权限变更和清理器也服从该顺序。
- `payload_hash` 对严格验证后的规范化 JSON 计算：不随 request_id/http header改变；附件顺序、引用和用户明确选择属于正文。采用固定规范化算法和测试向量，不用不同语言默认 JSON 序列化碰运气。
- 同 ID 同哈希返回既有结果；同 ID 不同哈希返回 409，不悄悄当新意图。
- 权限、附件归属、话题 state、binding_revision 在接纳事务前/内复核。
- 正文删除与幂等身份保留分离；删除标记期限覆盖允许重试窗口，过期旧键不自动当新命令执行。
- ORM迁移必须补齐本节字典的外键/检查约束，迁移回归禁止跨账户 FK 或 orphan refs；这里的核心DDL不是声称完整生产结构定义已就绪。

## 6. 移动端 API v1 公共协议

### 6.1 通用约定

路径前缀 `/mobile/v1`；JSON UTF-8；HTTPS。写请求带 `X-Request-ID`，业务幂等 ID 同时放 body/`Idempotency-Key`，两者不一致返回 422。除 refresh/pairing 外均要求应用访问凭证，不接受上游 Hermes Token。

成功信封：`{data, request_id, server_time}`；列表增加 `next_cursor, has_more`。`has_more` 由服务端分页查询决定，不按数组长度猜测。错误统一信封：

```json
{
  "error": {
    "code": "CONTROL_EXPIRED",
    "message": "该交互已结束，请刷新会话",
    "retryable": false,
    "details": {"current_state": "expired"}
  },
  "request_id": "10000000-0000-4000-8000-000000000001"
}
```

这是设计样例。无权限的具体资源按策略统一404，避免枚举其是否存在；用户已知的服务级权限不足才返回403。API不把Python stack或上游凭据透传到details。

### 6.2 完整端点分组

| 方法与相对路径 | 权限 | 幂等/前置条件 | 结果 |
|---|---|---|---|
| POST /pairings/redeem | 单次pairing 授权 | 授权+设备注册意图 | 201应用会话；丢响应按安全章重新配对 |
| POST /auth/refresh | 刷新密钥 | refresh_request_id | 200轮换凭证；受控重放 |
| DELETE /auth/session | 当前设备 | 重复成功 | 204；关闭WS/清理推送注册 |
| GET /devices | device.manage或本人 | — | 本人设备列表 |
| DELETE /devices/{id} | device.manage | 重复成功 | 204撤销；不删除服务器历史 |
| GET /profiles | profile.read | 仅授权目录 | backend/profile状态与版本 |
| GET /capabilities?profile_id=… | profile.read | 目录中获准配置档案 | 能力、限额、理由、policy_revision |
| POST /topics | chat.send | request_id+profile_id | 202creating或重放原话题 |
| GET /topics?profile_id=… | chat.read | cursor/limit | 可见话题，不返回管理密钥 |
| GET /topics/{id} | chat.read | — | 投影、binding_revision、运行状态 |
| GET /topics/{id}/messages | chat.read | before/order 游标 | 稳定message_order分页 |
| POST /topics/{id}/submissions | chat.send | submission_id、binding_revision | 202，明确accepted不是started |
| GET /submissions/{id} | chat.read且可见话题 | — | 当前业务状态+权威回执摘要 |
| POST /topics/{id}/actions | 动作对应作用域 | request_id+expected_version/generation | 202待执行或200已完成重放 |
| GET /actions/{request_id} | 动作发起者/授权人 | — | pending/applied/rejected/unknown |
| GET /controls?state=pending | control.read | 分页 | 跨配置档案待处理清单 |
| POST /controls/{id}/responses | control.respond | response_id、version、代次 | 202responding，不等于resolved |
| GET /control-responses/{id} | control.read | — | claimed/sent/confirmed/rejected/unknown |
| POST /uploads | media.upload | request_id、profile_id、大小类型 | 201上传会话 |
| POST /uploads/{id}/parts/authorize | media.upload | part_numbers | 限范围短期上传授权 |
| GET /uploads/{id} | uploader | — | 已确认片、缺片、期限 |
| POST /uploads/{id}/complete | uploader | request_id、parts清单 | 202校验中；禁止直接ready |
| DELETE /uploads/{id} | uploader | 重复成功 | 202清理multipart |
| GET /attachments/{id} | media.read及引用授权 | — | 状态/尺寸/类型，无主机路径 |
| POST /attachments/{id}/download-grant | media.read | 短期用途授权 | 下载/播放URL与过期时间 |
| GET /inbox | inbox.read | 分页 | 主动结果/完成提醒 |
| PUT /topics/{id}/read-cursor | chat.read | message_order | 取较大值；不推进到不存在消息 |
| POST /devices/{id}/push-registration | 本设备 | 提供方+environment+app_id | upsert；同令牌不重复注册 |
| DELETE /devices/{id}/push-registration | 本设备 | 提供方 | 停用通道 |
| POST /sync/snapshots | sync.read | 当前身份/ACL | 202构建或201已就绪 |
| GET /sync/snapshots/{id} | 同一用户 | — | state、水位、分页入口 |
| GET /sync/snapshots/{id}/rows | 同一用户 | page_cursor | 不可变分页实体 |
| GET /sync?cursor=… | sync.read | 用户绑定游标 | events、next_cursor、has_more |
| POST /ws-tickets | 当前设备 | 一次性 | 短期应用 WS票据，非Hermes票据 |
| GET /events | WS票据握手 | 接受后消费票据 | 移动端事件 v1订阅 |

### 6.3 新建话题的核心 DTO

```json
{
  "request_id": "10000000-0000-4000-8000-000000000002",
  "profile_id": "10000000-0000-4000-8000-000000000003",
  "title": "开发讨论",
  "kind": "direct",
  "preset_id": null
}
```

- 不允许手机传 cwd、api_key、base_url、client_env、yolo、任意toolsets。
- preset_id 来自服务端允许列表，包含模型/工具/技能策略快照。
- BFF 创建状态为 `creating` 的话题及对应的创建命令。连接器取得标准协议快照后，话题进入 `ready`。
- 手机断网重试原request_id；返回同topic_id。创建期间输入可存本地草稿，会话绑定后才允许发送消息。

### 6.4 发送消息的核心 DTO

```json
{
  "submission_id": "10000000-0000-4000-8000-000000000004",
  "binding_revision": "1",
  "text": "请分析这张截图",
  "attachment_ids": ["10000000-0000-4000-8000-000000000005"],
  "reply_to_message_id": null,
  "mode": "normal",
  "expires_at": "2026-11-12T15:20:00Z"
}
```

`mode` 首版只允许 `normal` 和 `queue`。插话使用独立动作，避免重试同一消息时改变语义。附件必须属于同一账户，且允许该配置档案和话题引用。提交可以在附件通过校验后进入 `accepted`，实际分发要等 Hermes 暂存完成。客户端设置的有效期超过服务端上限时拒绝提交。

```json
{
  "data": {
    "submission_id": "10000000-0000-4000-8000-000000000004",
    "status": "accepted",
    "hermes_admission_id": null,
    "message_id": "10000000-0000-4000-8000-000000000006",
    "replayed": false,
    "entity_version": "1"
  },
  "request_id": "10000000-0000-4000-8000-000000000007",
  "server_time": "2026-11-11T15:20:00Z"
}
```

BFF 提交业务记录、用户消息、`command_outbox` 和用户事件流事件后，才确认接纳。所有网络调用均在提交后执行。HTTP 确认丢失时，使用同一 `submission_id` 重新发起 POST 并返回原 `message_id`，气泡保持一条。

### 6.5 业务动作约束

| action | 必填前置字段 | 上游策略 | 不支持/竞态处理 |
|---|---|---|---|
| rename/archive | expected_entity_version | 标准协议写操作，保留上游修订版本 | 409刷新；重复request_id返回原回执 |
| model/reasoning | binding_revision、execution_generation | 能力允许才调用mutate | busy按上游拒绝，不强行中断 |
| interrupt | binding_revision、execution_generation | session.interrupt | 代次变更返回409，不停新任务 |
| steer | binding_revision、execution_generation、text | session.steer | delivered不明不自动转新prompt |
| cancel_submission | submission_id、allow_interrupt=true | 已接纳时prompt.cancel | UI明确“若已开始，也会停止”；否则不开放这个上游动作 |
| replace_queued | submission_id、新submission_id、text | advertised replace方法 | 若已开始返回冲突；不先cancel再submit制造空窗 |
| reset/branch/delete | 修订版本+代次+二次确认 | 标准协议写操作 | 先成功后更新绑定，不能预先清空本地历史 |
| retry_as_new | original_submission_id+new_submission_id | 新意图 | 显示副作用可能重复，需用户确认 |
| resolve_unknown | admission_id+代次+确认 | 仅支持时调用专用控制 | 解除队列阻塞≠重做丢失输入 |

**重要竞态：** `prompt.cancel`在已开始时可能中断执行，先GET看见queued再cancel并不能消除竞态。不能给用户承诺“绝不影响正在运行的任务”，除非未来上游提供原子仅作用于排队项的控制。[10]

### 6.6 错误码表

| HTTP | code | 客户端动作 |
|---|---|---|
| 400 | INVALID_JSON | 不重试，修请求 |
| 401 | AUTH_EXPIRED | 合并并发刷新请求一次再原ID重试 |
| 401 | DEVICE_REVOKED | 关闭连接、锁定缓存/注销；不循环刷新 |
| 404 | RESOURCE_NOT_FOUND | 资源不存在或不可见，不泄漏归属 |
| 409 | IDEMPOTENCY_CONFLICT | 禁止自动重试；用户另建意图 |
| 409 | VERSION_CONFLICT | 读取最新状态再让用户决定 |
| 409 | BINDING_CHANGED | 不把旧输入悄悄转投新会话 |
| 409 | EXECUTION_CHANGED | 不作用于新代次 |
| 409 | CONTROL_ALREADY_HANDLED | 展示最新状态/其他设备处理 |
| 409 | REFRESH_IN_PROGRESS | 读取原持久刷新意图合并重试，不再生成新request_id |
| 410 | CONTROL_EXPIRED | 卡片过期不可再提交 |
| 410 | CURSOR_EXPIRED / SNAPSHOT_EXPIRED | 进入快照流程，不删除未发发件队列 |
| 413 | PAYLOAD_TOO_LARGE | 建议附件/减少选择 |
| 422 | VALIDATION_FAILED | 按field_errors标注，不靠message字符串分支 |
| 422 | ATTACHMENT_NOT_READY | 等校验/staging状态，不重复上传完整文件 |
| 429 | RATE_LIMITED | 使用Retry-After，原业务ID重试 |
| 503 | BACKEND_UNAVAILABLE | 可保存待发送时返回202；本操作不允许延迟则503 |
| 503 | CAPABILITY_UNAVAILABLE | 禁用对应入口并显示reason，不发自然语言冒充命令 |
| 500 | INTERNAL_ERROR | 显示request_id，查询接纳状态后决定重试 |

控制超时或unknown属于资源状态，不能所有都粗暴映射500。

### 6.7 交互响应、同步批次和上传 DTO

交互响应是按kind区分的联合，所有请求均带response_id、expected_version、binding_revision。标准协议提示另有execution_generation；服务端请求由交互记录绑定connection 代次，不允许客户端自行给旧请求补一个新代次。

```json
{
  "response_id": "30000000-0000-4000-8000-000000000001",
  "expected_version": "3",
  "binding_revision": "1",
  "execution_generation": "7",
  "kind": "approval",
  "answer": {"choice": "once"}
}
```

其他允许形态：标准协议澄清使用`answer:{text:string,skipped:boolean}`，skipped=true转换上游空字符串；批量clarify使用`answer:{questions:[{qid,selected_choices:string[],free_text:string|null,skipped:boolean}],outcome:"submitted"|"cancelled"}`。BFF按当前控件校验qid集合、是否允许多选、选项和文本上限；不同时允许skipped和非空答案。free_text不是隐式额外选择，UI明确展示“其他”。客户端不发送raw上游请求 ID，适配器负责映射。服务器返回`{response_id,control_id,status:"claimed",control_state:"responding",entity_version}`，完整信封遵循6.1；后续从GET响应状态和事件流得知确认结果。

HTTP同步返回data形态：`{events:MobileEvent[],next_cursor:string,has_more:boolean,watermark_sequence:string}`；WS的events控制帧增加from_sequence/to_sequence。游标字段仅作说明性字符串，不提供可构造的令牌示例。一个批次只含同用户同feed_epoch；无事件也返回可安全保存的next_cursor。分页limit在1—200之间，按bytes预算提前结束但不丢事件。

创建上传的完整业务请求体示例：

```json
{
  "request_id": "30000000-0000-4000-8000-000000000002",
  "profile_id": "30000000-0000-4000-8000-000000000003",
  "file_name": "screenshot.png",
  "declared_mime": "image/png",
  "size_bytes": 1048576,
  "sha256": null
}
```

返回data包含upload_id、attachment_id、part_size_bytes、expires_at、state和effective_limits，不返回本地主机路径。parts/authorize输入`{part_numbers:number[]}`，输出每片part_number、method=PUT、headers、url、expires_at；真实url/签名在日志统一脱敏。complete输入`{request_id,parts:[{part_number,etag,checksum}],total_size_bytes}`；etag为不透明字符串不能改引号/大小写。声明sha256可空，但服务端最终验证不能省略。

## 7. 基于 HTTP 和 WSS 的客户端同步协议

### 7.1 统一事件形态

以下 `kind` 是本项目新协议，不是上游同名事件。严格校验未知kind：可忽略不影响状态的扩展事件，但影响状态的未知kind要求升级/重新同步，不能推进游标后丢掉关键状态。

```json
{
  "schema_version": 1,
  "event_id": "10000000-0000-4000-8000-000000000008",
  "feed_epoch": "10000000-0000-4000-8000-000000000009",
  "sequence": "42",
  "kind": "message.text.delta",
  "profile_id": "10000000-0000-4000-8000-000000000003",
  "topic_id": "10000000-0000-4000-8000-000000000010",
  "entity_id": "10000000-0000-4000-8000-000000000011",
  "entity_version": "8",
  "payload": {
    "message_id": "10000000-0000-4000-8000-000000000006",
    "block_id": "10000000-0000-4000-8000-000000000011",
    "base_version": "7",
    "offset_utf16": 4,
    "append": "分析如下："
  }
}
```

使用 UTF-16 码元偏移量以匹配 JavaScript 字符串；连接器 Python来源须在TS归一化，不能把UTF-8字节数/Unicode码点数混用。偏移量仅用于校验追加文本，不能将代理对切开。

### 7.2 事件注册表

| kind | 负载必含 | 归约器行为 |
|---|---|---|
| topic.upsert | 完整话题投影/version | 高版本替换 |
| topic.deleted | topic_id、deletion_version | 以删除标记阻止旧事件恢复已删除记录 |
| submission.upsert | submission_id、status、接纳摘要、version | 将即时显示的气泡与服务端 `message_id` 合并 |
| message.upsert | 完整消息的元数据、消息块和版本 | 新建/修复，较旧投影忽略 |
| message.text.delta | message_id、block_id、base_version、offset_utf16、append | 仅当基础版本和长度匹配时追加 |
| message.final | message_id、完整最终消息块、version、finish_kind | 权威替换流式块并清除等待动画 |
| tool.upsert | tool_call_id、状态、脱敏后的参数、result_ref、version | 更新同一工具卡片，不造新气泡 |
| control.upsert | control_id、传输层、kind、state、version、choices | 恢复待办，幂等替换 |
| control.closed | control_id、state、version、reason | 卡片禁用；不能推断用户选择 |
| inbox.upsert | item_id、target、summary、version | 更新或插入记录，并重新计算未读 |
| read.updated | topic_id、last_read_message_order | 取较大值 |
| attachment.upsert | id、state、meta、version | 不把下载URL作为永久属性 |
| capabilities.changed | profile_id、policy_revision | 查询新能力，不停止既有任务 |

WS控制帧不进入业务事件流：`hello`、`subscribe`、`events`、`ack`、`heartbeat`、`sync_required`、`auth_expiring`、`error`。

### 7.3 WebSocket 握手与确认

1. 应用通过已认证HTTPS取短期单次 `/ws-tickets`，票据绑定device/user/api version，建议30秒过期。
2. WebSocket子协议携带票据（实现时过滤反向代理握手header日志），服务端消费后返回hello；这是本应用协议，不复用Hermes 票据。
3. 应用发送subscribe包含不透明游标；BFF校验用户/epoch，先补齐DB再进入tail。
4. BFF每个批次包含 `from_sequence/to_sequence/next_cursor/events`。
5. 应用在**一个SQLite事务**应用事件并保存游标，提交后才确认该next_cursor。
6. BFF只接受自己发给该连接的游标，防止客户端伪造已读；同步确认与业务已读各自记录。
7. 超出缓冲时发送sync_required并断开，应用用HTTP分批补拉；不无限积压内存。

实时广播只是低延迟唤醒：每次订阅完成和每个心跳周期都读取持久事件流头部，与该连接已发游标比较，发现落后就补拉。这样提交后广播进程崩溃不会造成在线连接永远漏掉事件。

游标是服务端签名或随机映射的不透明令牌，绑定account/user/epoch/seq。应用可以保存，不自行构造和递增。多设备各自有已同步游标，业务已读是用户级read_cursor。

### 7.4 可重现的快照流程

- BFF在REPEATABLE READ事务内读取用户事件流头部的epoch/watermark/ACL 修订版本，并把可见话题、消息投影、交互、收件箱和已读状态写成不可变snapshot_rows；相同事务快照保证这些投影与水位一致。
- 业务投影与事件流更新在同一事务，事件流序号分配在用户头部行锁下进行，因此不会发生小seq迟提交被漏掉。
- 快照仅初始化近期消息窗口，例如每话题最近50条；更早历史通过message_order分页。必须返回哪些窗口被覆盖，不谎称快照包含全部历史。
- 发布快照时创建对水位之后增量的保留标记；与事件流清理器使用共同的用户级保留锁，发布前复核min_retained_seq。保留标记持续到客户端完成快照与增量交接或到期。若保留标记发布前已有缺口，则废弃重建，不能靠“通常七天不会过期”忽略清理竞态。
- 快照每页再次验权。ACL revision/epoch变化立即失效，不能让被移除成员继续下载旧页。
- 应用把所有页写入带snapshot_id的暂存表；全部成功后事务切换为新的缓存代次并记录水位游标，**保留本地draft/outbox/uploads**。
- 调用同步接口读取水位之后的事件，直到 `has_more=false`，再用所得游标订阅 WebSocket。
- 订阅仍须先从DB补齐游标之后增量，再追踪新增事件。
- 快照过期/中断保留旧缓存只读，删除未完成暂存后重建。不得为了内存方便逐页覆盖正式表，导致半新半旧历史。

### 7.5 增量缺口处理

收到重复的 `event_id` 时，跳过副作用并推进确认游标。若 `base_version` 不匹配，将实体标记为 `needs_repair`，在同一 SQLite 事务写入修复任务后推进事件流游标，再读取完整消息投影以修复。持久化修复任务可以在重启后继续执行。

`message.final`是完整替换，不把最终完整文本追加到已积累增量后面。即使最终消息只有附件，它仍是有效的最终结果。

## 8. 状态机与并发不变量

### 8.1 提交

```text
local_pending（仅App）
 → accepted → waiting_connector → dispatching
 → admitted → queued → running ↔ waiting_control
 → completed | failed | cancelled
任一未执行状态 → expired
执行/接纳不明 → unknown → 权威对账或人工确认（禁止自动新建输入）
```

每个状态变更需要证据：accepted有DB 提交；admitted有上游回执；completed有权威终态；final_message_available另标投影已存在。不要将消息流暂时结束当completed。

### 8.2 交互

```text
pending → responding → resolved
                 ├→ resolution_unknown
                 └→ pending（仅确认未被上游接收且仍有效）
pending/responding → expired | cancelled
```

响应本地持久、云命令送达、上游接收、工具已继续是不同层次。resolved只在上游显式确认或可确认的结果对账后成立；open_request消失但无选择证据只能closed_unknown，不虚构“已批准”。

### 8.3 附件

```text
created → uploading → uploaded → verifying → ready → staging → staged
                       └→ rejected
任何可取消阶段 → abandoned → deleted
```

`ready` 表示对象存储中的附件已校验且可用，`staged` 表示特定后端和绑定可以读取附件。跨后端复用同附件需新暂存记录；不能把一个主机路径缓存成全球可用。

### 8.4 不变量

- 一个submission_id只对应一个规范化负载和一个展示用户 message。
- 一个话题在一个binding_revision只指向一个标准协议会话，reset不能悄悄转移旧命令。
- entity_version单调前进；迟到事件不能复活deleted实体。
- 事件流确认之后的事件效果必须已在设备SQLite持久化。
- BFF transaction 提交之前不发成功确认或推送。
- 处理交互的设备必须仍有权限、仍是同request和代次。
- connector lease只限制本系统命令路由，不宣称能阻止旧进程已经发往Hermes的请求。
- 未知执行不能自动重跑；未知投递不能自动重新执行原任务。

## 9. 关键业务时序与事务伪代码

以下伪代码描述逻辑，不是已运行代码。

### TX-01 用户提交接纳

```text
验证数据结构和配置档案权限
规范化负载并计算摘要
开始事务
  按 user_id 顺序锁定候选收件人的事件流头部，复核 ACL 版本
  锁定话题记录，复核成员资格、状态和 binding_revision
  如果 submission_id 已存在
    哈希相同 → 提交后返回已持久化的回执
    哈希不同 → 回滚并返回 IDEMPOTENCY_CONFLICT
  校验附件归属、就绪状态和引用策略
  插入 submissions(status=accepted)
  在持有话题锁时分配 message_order，写入用户消息及消息块
  按原 submission_id 插入 command_outbox(kind=submit)
  递增 sequence，写入 user_events 并更新读侧投影
提交事务
返回 202 accepted
工作进程在事务提交后分发
```

多个群成员事件流用固定锁顺序防止死锁；遇数据库序列化冲突或死锁可在无外部副作用的事务边界按相同业务ID有限重试。

### TX-02 连接器事件入库

```text
连接器收到 Hermes 事件 → 脱敏并按允许名单过滤 → 在本地队列事务中写入 ingest_id、上游引用和规范化数据
连接器发送事件入库批次
BFF 开始事务
  验证连接器身份、后端与配置档案映射、租约路由策略
  按顺序锁定候选收件人的事件流头部，复核 ACL 版本
  INSERT connector_ingest ON CONFLICT ...
  如为完全重复的事件，仅返回现有确认
  若 ingest_id 相同而哈希不同，拒绝并告警
  锁定受影响的投影，验证上游纪元、代次和顺序
  更新或插入投影，或应用增量，按上游能力更新提交和交互
  按提交顺序分配 seq，插入 user_events
  已有权威终态且最终投影可用时
    用唯一的 source_key 写入收件箱
    为符合条件的设备写入 push_outbox
提交事务
BFF 按实际接收的入库 ID 确认
连接器在本地标记为已确认，之后回收记录
```

同批次不是全部必成功时返回逐条ACK/error，不用最高UUID推断连续完成。终态早于final投影时先记录 `final_pending` 修复任务，修复后再发“结果可看”的通知，避免点开空页面。

### TX-03 审批回答抢占

```text
开始事务
  按顺序锁定已授权收件人的事件流头部，复核 ACL 版本
  锁定 controls
  检查 ACL、expected_version、绑定和代次、截止时间及允许的选项
  如果 response_id 与哈希均相同，返回已持久化的响应状态
  如果 state 不为 pending，返回冲突和当前状态
  插入 control_responses(status=claimed)
  更新 controls(state=responding, response_id, version=version+1)
  插入 command_outbox(kind=respond_control)
  追加 control.upsert 事件
提交事务
返回 202 responding
连接器通过对应的上游传输层发送
上游确认后，单独开启事务将响应标记为 confirmed、交互标记为 resolved
超时后标记 resolution_unknown，查询上游待处理交互和状态，依据对账结果决定后续动作
```

### TX-04 已读与角标

```text
开始事务
  锁定该用户的事件流头部，复核 ACL 版本
  确认请求中的 message_order 存在于可见话题内
  read_cursor = max(existing, requested)
  更新该用户的已读状态
  根据可见的消息顺序和收件箱状态计算未读数量
  向该用户的事件流追加 read.updated
提交事务
```

同步确认不更新read_cursor；只有页面呈现到对应消息并满足可见判定才读。被用户静音不代表已读。

### TX-05 推送任务领取

```text
开始事务
  用 SELECT ... FOR UPDATE SKIP LOCKED 领取到期任务
  设置 sending 状态、lease_until 和 attempts
提交事务
在事务之外发送给推送提供方
开始事务
  记录发送尝试和票据或回执的状态
  核对当前尝试标识，更新为 accepted、retry、dead 或 expired
提交事务
```

工作进程在提供方接受后崩溃可能重发通知；用稳定notification_id/collapse 键尽量合并，但承认操作系统可能显示重复提醒，收件箱本身仍去重。对过期交互不再发送提醒。

## 10. 鉴权、配对与安全协议

### 10.1 配对

- 管理员在受保护界面创建高熵、短期、一次性的授权，并限定账户和授权范围。二维码包含服务器源地址与授权，应用展示该地址并要求用户确认。
- 应用持久保存 `pairing_request_id` 和本次设备注册意图，再兑换授权。BFF 在同一次事务中消费授权并创建设备与凭据族。
- 首版配对响应丢失时不提供凭据重领接口：管理员撤销未完成设备授权并创建新授权，手机重新配对。不能把“已消费授权”变成任何人可领凭据；以后若增加恢复，必须单独设计设备持有证明及重放窗口。
- 配对和管理员 API 只向运维身份开放。

### 10.2 凭据刷新丢响应与并发

每个设备使用独立的凭据族。客户端合并并发刷新请求，所有收到 401 的请求都等待同一次刷新完成。

请求含 `refresh_request_id`。客户端发送前在SecureStore持久化旧凭据与刷新意图，收到响应后原子替换凭据包再清理意图。服务端锁凭据族，校验旧密钥哈希与代次后轮换；用服务器KMS/密钥封装短暂保存同请求的响应，建议60秒可重放期。响应丢失时仅凭原刷新密钥、同request_id、同family/device绑定取得同一结果，不再次向前轮换；每次仍检查未被撤销。已使用旧令牌+不同request_id在窗口内返回REFRESH_IN_PROGRESS，客户端合并到原持久意图，不再次轮换；窗口外视为疑似重用，撤销该凭据族并重新配对，不影响其他设备。精确旧操作超过封套保留期也要求重新认证，不凭空给旧令牌“宽松接受”。UUID device_id本身不是设备持有证明，首版安全基础仍是TLS和高熵刷新密钥，不虚称实现硬件绑定。

敏感令牌原文禁止写入日志。配对授权和刷新凭据均使用高熵随机值。刷新凭据存入 SecureStore，访问令牌尽量只留在内存中。消息数据库另行加密。[4]

### 10.3 WebSocket 与撤销

应用 WebSocket 票据只能使用一次，且短时过期。连接建立后记录凭据族、ACL 修订版本和访问凭据到期时间。到期前发送 `auth_expiring`，应用重新取得票据并重连。设备撤销或权限变更时，服务端立即关闭连接并使同步纪元失效。

建议应用关闭码：4401认证失效、4403撤销/权限变化、4409需快照、4429背压/限流、4503后端暂不可用。代码是本项目提案，不是Hermes标准。

### 10.4 权限清单与危险操作

- `chat.read / chat.send / session.control / control.read / control.respond / media.upload / media.read / inbox.read / device.manage / room.manage / admin.manage`。
- BFF 根据认证主体推导账户和用户，且只使用这些身份。
- 高风险审批需要近期解锁或认证。锁屏界面禁止提供无上下文的「全部允许」操作。
- `secret`、`sudo` 和 `vault` 不通过普通消息、日志或推送传输。安全表单上线前须明确显示不支持，并继续执行相关审批策略。
- 事件队列只保留允许的脱敏字段和必要的上游身份。凭据表单内容禁止写入普通队列、投影和遥测。数据落盘前完成名单过滤与脱敏。
- 错误消息、追踪、遥测和反向代理访问日志统一过滤令牌、票据、Cookie、推送令牌和连接字符串。
- 传输TLS、对象/备份加密、应用数据库加密分别验收；本系统可信BFF/Connector可见明文，不能宣称E2EE。

## 11. 媒体协议与资源生命周期

### 11.1 上传

`POST /uploads`输入：request_id、profile_id、file_name、declared_mime、size_bytes、可选客户端checksum。服务器先校验配额和目标权限，分配upload_id/attachment_id/object_key，不允许客户端选择object_key。

返回part_size、expiry、upload mode。客户端按parts/authorize获取指定分片URL；PUT结束保存part ETag/checksum。中断重启先GET upload状态，向存储核对缺片，不能信任仅存在于手机内存的进度。

complete提交part_number/etag/checksum有序数组；BFF校验远端真实part集合后合并，进入verifying。后台检查真实大小、MIME magic、摘要、恶意内容/可解码性。`ready`前不能交给连接器处理。S3 ETag不当作全文件SHA-256。

### 11.2 暂存

连接器使用媒体服务签发的授权下载，授权限于指定附件和后端。文件保存到专用暂存根目录 `<root>/<account>/<profile>/<attachment>/payload`，每层使用已验证的内部 ID。先写临时文件，再检查完整性、原子重命名并保存暂存回执。

创建 RPC 中的 `CanonicalAttachment` 使用可信侧生成的 `path,mime`。[9] 使用受控目录、禁止跟随符号链接的打开策略，并校验实际文件句柄，以防止符号链接攻击和检查时序竞态。后台工具在 Docker 或 SSH 环境执行时，使用后端媒体桥，并独立验收远端路径。

### 11.3 输出

只导出有来源证明且在允许工作区/输出目录的文件；模型文本中的任意绝对路径不足以授权读取。收集媒体引用→安全读取→上传私有对象→插入message block→再展示可下载状态。

音视频Range播放通过短期授权；URL过期刷新授权后从播放位置恢复。内容较大可先显示“媒体处理中”，文字final不必等待TTS，但最终媒体状态独立可追踪。

首版敏感媒体推荐BFF授权代理并支持Range，每个新请求重验ACL；已有流撤权后中止。若为吞吐改用S3直签URL，明确其在短TTL内通常仍可使用，撤权不能立即收回已签链接；建议TTL不超过60秒并禁缓存。选择直签就不得把“撤权即所有旧URL失效”列为已满足。

### 11.4 生命周期

- 未complete上传24小时自动abandon并清multipart。
- 已提交但未引用附件设回收宽限期，建议24小时；cleanup先检查refs和pending submissions，再删对象。
- Hermes执行未结束/staging仍被引用时不删除文件；任务unknown时人工确认或较长保留，禁止短期GC破坏对账。
- 删除话题只解除当前授权引用；共享附件有其他合法refs则保留，但旧话题下载授权尽快失效。
- 备份中对象删除按备份生命周期独立过期，向用户说明不是点击删除瞬间抹除所有备份。

### 11.5 语音与分享的精确语义

原始音频保存到应用文档目录后才写发件队列；缓存目录可被系统回收。[14] 原音、转写、发送给模型的文本是三项独立记录；转写失败不能编造文本，也不能丢原音。用户选择“先转写确认”时，语音转写完成后，经用户确认才创建提交。

原生分享导入入口先将系统临时 URI 安全复制到 App Group 或应用私有暂存区，再写入分享草稿。打开主应用后选择配置档案、话题并确认发送。主应用保管 Hermes 凭据并负责启动长时间运行的智能体任务。分享导出和导入分别验收。Expo 当前未版本化的文档记载了试验性的分享导入。官方指出，iOS 扩展打开主应用的方式未经 Apple 正式支持，未来可能失效。优先使用独立原生桥，试验性入口作为锁定 SDK 版本后的验证候选。[27]

## 12. Expo 客户端：页面、组件、状态与持久化

### 12.1 页面与交互规格

下面路由均为拟建Expo Router路径。所有路由先解析topic_id，再从本地/服务端授权目录取得完整作用域；不能把URL参数当权限证明。

| 页面 | 布局和主要动作 | 空态/错误/离线 | 运行中行为 |
|---|---|---|---|
| `app/pair.tsx` | 源地址确认、扫码、配对进度 | TLS失败不允许忽略证书；授权过期重新签发 | 防双击；失败不打印授权 |
| `app/(tabs)/sessions.tsx` | 顶部配置档案切换，搜索、置顶、话题列表、新建 | 无授权与无话题分开；缓存可读并标最后同步时间 | 各话题显示running/control/unknown徽标，不只观察当前话题 |
| `app/chat/[topicId].tsx` | 顶部显示配置档案、模型与状态，下方是虚拟化消息列表、输入区和附件栏 | 分别提示首屏和分页失败，离线可写草稿 | 停止只针对当前显示的执行代次，换页时继续执行 |
| `app/(tabs)/controls.tsx` | 跨配置档案待办，按请求类型筛选 | 无待办时显示空状态，离线编辑后可在联网时确认提交 | 分别显示正在响应与已完成，冲突后刷新并保留另一设备的决定 |
| `app/(tabs)/inbox.tsx` | 任务完成、定时任务、外部主动消息 | 缓存可看，未同步明确标记 | 点开真实结果再标已读，不靠点击推送标完成 |
| `app/compose/media.tsx` | 选择、录音、试听、原音/转写预览 | 权限、存储满、上传失败分别处理 | 准备/上传/校验/可发送状态可见 |
| `app/share/import.tsx` | 预览分享项，选择账户、配置档案和话题 | URI 失效时提示重新分享，未登录时隔离保存暂存内容 | 只有用户确认才创建提交 |
| `app/(tabs)/settings.tsx` | 设备、后端状态、推送诊断、本地缓存、退出 | BFF在线不代表Hermes在线 | 撤销当前设备后关闭所有连接，保留服务端历史 |
| `app/topics/[topicId]/settings.tsx` | 标题、置顶、静音、技能预设、导出 | 上游不支持的动作显示原因 | reset/delete需确认并阻止旧绑定命令静默迁移 |

交互细则：
- 用户在底部才跟随流式滚动；离底后保持message_id+像素偏移锚点，显示“有新内容”按钮。
- 工具参数与结果可完整展开/复制，但先执行服务端脱敏；长工具结果从独立资源按需读取，不把整段塞进列表每次渲染。
- Markdown 禁止原始 HTML执行、任意WebView脚本与自动加载外部图片；链接打开前校验协议，外链经系统浏览器并提示。代码块可横向滚动。
- pending/queued/running/waiting_control/unknown具有不同文字，不靠颜色区分。未知状态不展示“重试任务”默认按钮。
- 输入法组合期间不触发发送；发送后只清空对应draft_version，避免迟到确认清掉新草稿。
- MessageList按稳定message_id/block_id取键，不用数组索引；流式更新单个块，不重渲染整段历史。

### 12.2 数据与模块契约

Expo模块分工：`expo-sqlite`提供跨重启持久数据库；`expo-audio`负责录音/播放，`expo-video`负责视频播放。[14][15][17] `expo-file-system`负责应用文件操作，跨进程断点续传仍由本设计的上传会话和本地队列补齐，不能只凭单次上传调用承诺恢复。[16]

以下为设计签名，类型名将在协议包定义；不是已编译代码。

```ts
type Scope = Readonly<{
  account_id: string; backend_id: string; profile_id: string; topic_id: string;
}>;
interface HistoryRepository {
  watch(scope: Scope, window: HistoryWindow): Subscription;
  applyFeedBatch(batch: FeedBatch): Promise<ApplyResult>;
  commitHistoryPage(scope: Scope, page: MessagePage): Promise<void>;
  replaceSnapshot(snapshotId: string): Promise<void>;
}
interface SubmissionService {
  enqueue(scope: Scope, draftVersion: number): Promise<string>;
  reconcile(submissionId: string): Promise<void>;
  cancelUndispatched(submissionId: string): Promise<CancelResult>;
}
interface ControlService {
  respond(controlId: string, response: ControlResponse): Promise<ResponseReceipt>;
  refresh(controlId: string): Promise<void>;
}
interface UploadManager {
  prepare(localUri: string, scope: Scope): Promise<LocalAttachment>;
  resume(uploadId: string): Promise<void>;
  abandon(uploadId: string): Promise<void>;
}
interface NotificationRouter {
  capture(intent: NotificationIntent): Promise<void>;
  resolveAfterAuth(): Promise<NavigationIntent | null>;
}
```

组件只发用户意图，不直接HTTP或SQL：
- `ProfileSwitcher({scope, profiles, disabled, onSelect})`
- `MessageList({scope, rows, anchor, hasOlder, onLoadOlder, onVisible})`
- `MessageBlock({block, renderMode, onOpenAttachment, onCopy})`
- `Composer({scope, draft, capabilities, sendState, onEdit, onSubmit})`
- `ControlCard({scope, control, submitting, onRespond})`
- `AttachmentTray({items, limits, onRetry, onRemove})`
- `ConnectionBanner({transport, sync, backend, onRetry})`

`HistoryRepository`是历史唯一读入口；`SyncEngine`是事件流唯一消费者；`AuthCoordinator`持有刷新锁；`UploadManager`持有上传状态机。TanStack Query只缓存授权目录、能力等meta。Zustand只存滚动锚点、当前选择、录音计时、未提交表单的瞬时缓冲；持久草稿仍归SQLite。

### 12.3 SQLite本地模型

每个已配对账户使用独立数据库和文件目录，避免切换账户残留。以下是本地表字典，具体迁移版本在实施时生成：

| 表 | 主键/核心字段 | 清理条件 |
|---|---|---|
| cache_generations | generation_id UUID、active、snapshot_id、created_at | 新代次切换成功后清旧 |
| local_topics/messages/blocks/controls | account_id+entity_id、作用域、entity_version、generation_id、请求体 | 删除标记或失权；非超时随便清空 |
| processed_events | feed_epoch+event_id、sequence | 不早于活跃cursor/repair所需窗口 |
| sync_state | account_id+user_id、opaque_cursor、feed_epoch、connection_generation | 失权/快照替换事务内修改 |
| repair_jobs | entity_id、target_version、reason、attempts、next_at | 完整投影成功且版本达标 |
| drafts | 作用域、draft_version、text、attachment_refs、updated_at | 发送事务只清对应版本 |
| local_outbox | submission_id、作用域、immutable_payload、哈希、state、lease_until、attempts | 服务端接纳关联完成；保留查询所需回执 |
| local_uploads | local_attachment_id、uri、size、upload_id、part_receipts、state | 服务端确认且无草稿/outbox引用 |
| share_imports | import_id、清单、claimed_account、state | 用户弃用或成功入草稿后回收 |
| notification_intents | notification_id+action、account_hint、target_ids、state | 身份/目标验证后消费 |
| local_read_cursors | topic_id、message_order、pending_sync | 服务端取较大值后确认 |

单专用写连接、单写入器队列，初始化WAL与外键；网络等待不得放SQLite事务中。当前未版本化Expo文档指出exclusive异步事务使用新连接，原连接PRAGMA不自动继承，不能为“排他”而丢失外键约束；锁定SDK后验证普通事务+专用写入器不会被其他查询误入。[28]

本地加密为生产门槛：选择SQLCipher原生构建时必须验证实际cipher支持及错误密钥无法打开数据库，不以SecureStore或一个PRAGMA执行成功冒充数据库已加密。密钥丢失清除不可解密缓存并重新同步；未发消息是否仍可恢复必须真实提示，不能保证所有未提交草稿可恢复。

### 12.4 归约器和离线执行

本版冻结为 `offset_utf16`，不采用子审阅中的UTF-8建议；它与上游已核查字段一致。[23] 归约按第7节：同event重复跳过，版本/offset缺口记录持久repair_job，final完整替换。测试必须包含emoji、组合字符、null分段、重复interim、终态先于迟到增量。

本地发送事务：冻结草稿→生成submission_id→登记乐观消息/outbox→清对应draft_version→提交；后台工作进程再发。正文发送后不可编辑同ID，编辑排队输入走replace动作并产生新submission_id。

网络状态拆成：`transport=offline/connecting/online`、`sync=catching_up/live/repair/auth_blocked/storage_blocked`、`backend=online/offline/unknown`。恢复后同ID查询/重试；401只刷新一次；429按Retry-After；磁盘满暂停同步且不确认。配置档案切换时旧请求按原作用域入库，不能写到新页面。

本地发件队列取消只有在事务中证明尚未进入sending才可直接取消；已发送但确认丢失先对账，不能删除本地记录假装从未提交。审批离线仅保存表单草稿，联网后重新读取交互并要求用户确认；不自动回放过期许可。

### 12.5 录音、权限与可访问性

录音状态：permission→preparing→recording→stopping→persisting→preview。默认不后台录音；来电、退后台或音频设备切换时停止/保存，失败明确提示。文件先写临时路径、rename成功后入DB；文件系统与SQLite无共同事务，启动扫描修复中间状态，GC先核对draft/outbox引用。

麦克风拒绝保留文字/文件入口；有限相册授权只读取选择项；位置/联系人使用单次选择，不上传整库；通知拒绝不阻断聊天。权限永久拒绝提供系统设置入口，但不循环弹窗。

VoiceOver/TalkBack标签包含角色、状态与禁用原因；字体放大不遮住提交按钮；审批modal管理焦点。流式不逐令牌朗读，按完整块/终态播报；录音提供显式开始/结束按钮，不要求只能长按。

## 13. 连接器：真实Hermes映射与出站协议

### 13.1 启动顺序与能力协商

1. 获取本机安装实例与后端的独占进程锁；读取仅含允许的后端和配置档案映射的连接器配置，不遍历所有用户秘密。
2. 打开本地队列并检查可写；不可写不接纳云端命令。
3. 用独立连接器身份连接BFF，取得该后端租约；手机凭据不能冒充连接器。
4. 通过本地公开接入机制取得短期网关连接信息；票据只在内存使用，日志统一 `[REDACTED]`。
5. 每配置档案独立绑定连接，检查`gateway.ready.payload.session_authority`，再调用`runtime.describe`并登记可用方法/控件；协商支持的服务端请求。[7][8]
6. `profiles.list`在固定契约中存在，但只作为可信发现候选，目录仍与BFF profile_grants求交；不得因发现某配置档案就自动授权。[8]
7. 对已绑定会话执行恢复，核对结果未知的命令身份与回执；完成后才接新写操作。

不得全局切换活动配置档案来路由每条消息。不要机械在每个 RPC 参数中附加配置档案：部分模型严格不接受该字段。适配器使用已绑定连接并按实际方法的数据结构编码。

### 13.2 方法映射表

| 本项目动作 | Hermes真实入口 | 必须保留的边界 |
|---|---|---|
| 能力/目录 | `runtime.describe`、`profiles.list` | 权限与版本协商，不把结构定义存在当可执行 |
| 新话题 | `session.create` | request_id、source、服务端固定工具策略 |
| 恢复/历史 | `session.resume`、`session.transcript` | 分别处理标准协议会话和已存储的历史片段 |
| 发送 | `prompt.submit` | 原submission_id；回执只是接纳 |
| 查询接纳 | `prompt.receipt` | 已知接纳；同提交身份或合法交互权限 |
| 停止当前 | `session.interrupt` | 当前execution_generation |
| 撤回指定输入 | `prompt.cancel` | admission_id；可能中断已开始输入 |
| 编辑排队输入 | `prompt.replace_queued` | 原接纳+新提交；started拒绝，新项去FIFO尾部 |
| 运行中插话 | `session.steer` | 核对执行代次，使用专用插话入口 |
| 标题/归档/重置/分支等 | `session.mutate` | 修订版本围栏、request_id幂等、action支持范围 |
| 审批标准协议提示 | `approval.respond` | prompt_id+代次+choice；需session:approve |
| 澄清标准协议提示 | `clarify.respond` | prompt_id+代次+answer字符串；需session:respond |
| 批量澄清逐题锁定 | `clarify.lock` | 使用上游服务端请求的问题 ID |
| 补事件 | `session.events.since` | 会话replay_epoch+last_sequence |
| 解除未知执行状态 | `prompt.resolve_unknown` | 仅能力允许且人工确认；不是重做原任务 |

入口与主要结构定义来自固定OpenRPC/Pydantic；审批权限由授权范围实现核对。[8][9][10] 标准协议审批需`session:approve`、澄清需`session:respond`，且两者都要订阅实际会话和校验代次。[21]

### 13.3 上游真实事件与归一化

上游事件帧是`{jsonrpc:"2.0",method:"event",params:{type,session_id,payload,replay_epoch,seq,...}}`；type才是事件名。不要把本项目`message.text.delta`冒充上游方法。[9]

| 上游事件类型 | 事实字段/规则 | 本项目处理 |
|---|---|---|
| `message.delta` | text可null；turn_id/segment/offset可选；offset是UTF-16 | null封边界；有offset先去重再转换为消息块增量 |
| `message.interim` | text、already_streamed、可选turn_id/segment | 封结同一文本段，防止重复追加完整文本 |
| `tool.start` | tool_id/name，可能args/args_text/preview | 为工具建立稳定标识的卡片，参数脱敏 |
| `tool.complete` | tool_id/name、result/summary等；`success` 字段可能缺失 | 更新同卡；不从缺失字段猜成功 |
| `message.complete` | 公开状态为 `complete`、`error` 或 `interrupted`，标准协议还可提供 `admission_id`、`outcome`、`content` | 与回执对账，再发布完整的最终投影 |
| `approval.request` | prompt_id/generation/command/description/choices | 标准协议审批卡片 |
| `clarify.request` | prompt_id/generation/question/choices/multi_select | 标准协议澄清卡片 |
| `approval.settled` | prompt_id/generation | 关闭匹配卡，不等于批准 |
| `clarify.settled` | prompt_id/generation | 关闭匹配卡，不推断答案 |
| `request.cancel` | id/method/reason | 关闭匹配的服务端请求卡片，保留其他同名卡片 |

文本和工具字段已核对事件定义，标准协议的完成扩展与待处理交互需额外兼容。[23][24][25] 公共完成结构定义未覆盖所有标准协议字段，取消终态也不保证有status；优先结合回执，不把缺失status当成功。[21][26]

OpenRPC通知目录并未完整列出四类标准协议的审批和澄清事件；工程上增加局部校验器并保留来源测试，禁止因生成的联合类型未覆盖事件而丢弃事件。未知影响状态的事件进入诊断/修复，不推进到虚假完成。

消息身份映射：优先绑定上游稳定的轮次与消息段标识，或已持久化的消息标识；临时流式消息先保存映射，完成时重关联而非新建重复气泡。不得用文本哈希合并两条相同合法消息。若上游缺少稳定的消息 ID，适配器明确使用会话记录固定位置/片段身份并验证跨压缩规则；验证前相关恢复能力标pending_validation。

### 13.4 两类交互响应的通信协议

**A. 标准协议提示**。BFF 将手机端的 `control_id` 映射为上游 `prompt_id`。连接器发送带自身 RPC ID 的 `approval.respond` 或 `clarify.respond`，接收 `resolved` 或 `already_resolved`。[10][21] 界面仅显示请求实际提供的选项。只有获得可归因的证据时，才显示本设备的答案已被采用。

**B. 服务端请求**。网关发送带 `id` 和 `method` 的请求，连接器使用同一 `id` 返回 JSON-RPC 响应。示例中的上游不透明 ID 使用占位值。

```json
{
  "jsonrpc": "2.0",
  "id": "example-server-request",
  "result": {
    "answers": {"question-a": "选中的答案", "question-b": null},
    "outcome": "submitted"
  }
}
```

批量澄清的问题 ID 来自请求。应用用结构化数组保存多选答案，由适配器按已验证的上游字符串编码转换。恢复时，`params.answers` 中保存已锁定的答案，`null` 表示跳过，省略 `answers` 表示取消全部。[25]

`socket.write` 成功后只记录已写出状态。等待可关联的 `request.cancel reason=resolved`，以及待处理请求和回执的对账结果。若请求已消失且无法确认答案归属，标记为 `closed_unknown` 并保留未确认状态。服务端请求通道需要 `session:respond`、正确的订阅与授权范围，标准协议审批另需 `session:approve`。[22]

对不支持的宿主请求及时返回 JSON-RPC 错误，让智能体结束对终端、窗口等桌面功能的等待。`secret`、`sudo` 和 `vault` 请求禁止写入普通队列或推送。首版提示能力受限，并引导在已有安全客户端处理。安全交互通过验收后才计入完整替代范围。

### 13.5 云端命令与本地队列

新增连接器通信协议是本项目协议，固定为：

```json
{
  "v": 1,
  "command_id": "20000000-0000-4000-8000-000000000001",
  "backend_id": "20000000-0000-4000-8000-000000000002",
  "profile_id": "20000000-0000-4000-8000-000000000003",
  "topic_id": "20000000-0000-4000-8000-000000000004",
  "lease_generation": "12",
  "expires_at": "2026-11-12T15:20:00Z",
  "kind": "submit",
  "body": {
    "submission_id": "20000000-0000-4000-8000-000000000005",
    "binding_revision": "1",
    "text": "请总结当前讨论",
    "attachment_ids": [],
    "reply_to_message_id": null,
    "mode": "normal",
    "expires_at": "2026-11-12T15:20:00Z"
  }
}
```

请求体按 `kind` 严格校验，由BFF可信DB构建完整冻结负载，上例是无附件submit完整业务请求体；连接器按已持久会话绑定定位上游，附件ID另经受限授权解析暂存，不去任意URL下载。允许kind为create/submit/action/respond_control/stage_attachment/reconcile，不允许手机传任意method或shell。

连接器本地表：`commands(command_id PK,payload_hash,state,upstream_identity,result)`、`event_spool(ingest_id PK,session,replay_epoch,seq,payload,acked_at)`、`session_checkpoints(scope PK,principal_ref,policy_revision,replay_epoch,last_seq,generation)`、`staged_files(attachment_id,backend_id,binding_revision,path,digest,ref_state)`、`delivery_spool(producer_instance_id,delivery_id,payload,state)`。

命令依次经过云端发送、本地 SQLite 提交、返回 `connector_stored`、记录 `prepared` 或 `sending`、调用上游、保存结果、BFF 持久化结果、连接器清理。`submit` 的 `succeeded` 只记录上游已接纳。需要权威终态才能将提交标为 `completed`。服务端响应仅成功写出时，结果记为 `sent_unconfirmed`。

未知回执恢复必须保留原认证主体、策略与会话绑定。更换凭据/恢复旧备份后无法证明负责人时，标identity_reconciliation_required并停写，不能用同配置档案名称冒充原提交者。

### 13.6 恢复算法与租约

每个会话有独立的恢复互斥锁。重连期间新帧先落本地队列，不与旧快照并行覆盖：

```text
验证标准协议协商结果和认证主体
若已保存会话纪元和游标
  使用保存的纪元和序号调用 session.events.since
  回放可用时，应用返回的帧并去重
调用 session.resume
若有缺口、数据截断、收到 snapshot_required 或纪元变更
  冻结过时的交互
  按上游权威结果替换执行状态、待处理状态和 open_requests 投影
  核对会话记录及已知的接纳回执
  建立新的会话检查点
按上游顺序合并快照后的缓冲帧
完成身份和交互对账后才恢复分发
```

会话恢复与补拉覆盖回放查询和实时订阅之间的增量。回放使用有限的内存缓存。无法恢复的逐字动画可以跳过，最终结果、待处理和未确认状态仍须显示。[6][7]

租约丢失后立即停止分发新命令和发送交互答案，已收到事件继续写入本地队列，必要时关闭上游连接。云端 `lease_generation` 只约束 BFF 接收，已发往 Hermes 的命令可能继续执行。首版采用本机独占锁和受控交接。证明旧进程或连接已终止并核对未知结果后，才允许新实例接管。证据不足时保持离线。

`source=gui`不能靠`disabled_toolsets:[desktop_ui]`排除宿主工具；固定源码存在再次折入路径。创建时提供显式toolsets白名单，审查展开后的有效工具及服务端请求表；手机不可改此白名单，且它不是工具沙箱。[18]

## 14. 收件箱、操作系统推送与定时任务主动投递

### 14.1 三层投递状态

- **结果保存：** inbox_available，有BFF事务与message/artifact引用。
- **通知通道：** pending/sending/provider_accepted/provider_rejected/expired；不混同业务结果。
- **用户端：** device_synced/opened/read；前两者也不能代表用户理解内容。

Expo ticket/receipt只是中转或下游服务接纳，不证明设备收到；通知关闭、系统强停、网络和省电策略都会影响体验。[1][2] 后台任务/静默通知不是常驻WebSocket替代方案。[3]

推送负载只含notification_id、inbox_item_id、profile_id/topic_id/control_id等最小定位信息与通用短文案，不含命令、答案全文、密钥或带签名媒体URL。推送注册按提供方、环境、应用 ID 和设备分域，生产与开发令牌不可混用。

### 14.2 通道选择

| 设备 | 推荐路线 | 真实门槛 |
|---|---|---|
| iOS | expo-notifications，开发先走Expo→APNs；生产可选择直连APNs | 开发构建或发布构建、签名权限、真机网络、后台点击 |
| Android有GMS | expo-notifications→FCM或直连FCM | Google服务兼容、通道建立、权限与令牌轮换 |
|  Android 无 GMS | 目标厂商 SDK、自定义原生模块和配置插件 | 具体厂商账号、SDK、签名配置、真机到达率；不能只换BFF URL |
| 未适配通道 | 前台WS+启动补拉收件箱 | 明示后台提醒不可用；不伪装已全量替代 |

FCM依赖兼容Google Play服务环境，因此不能作为无GMS手机唯一方案。[13] Expo Go不作为本项目完整验收环境；从第一阶段使用开发构建，包含实际原生能力。[5]

### 14.3 通知冷启动时序

先登记通知响应监听并读取初始响应→以notification_id+action去重、持久待解析意图→打开账户DB并迁移/解锁→恢复或刷新身份→拉授权目录→校验目标作用域→读取Inbox/control真实状态→补拉相关历史→等待Router ready→导航→上报opened。不要直接信任推送 URL或文字触发批准。

离线只打开该账户仍有授权依据的缓存；没有缓存留“等待验证”。撤销/切账号时清除旧意图；旧通知不会恢复过期交互。权限拒绝保留完整收件箱功能。

### 14.4 推送工作进程细则

- 只在结果可读或交互仍待处理时创建通知；同source_key/device/kind唯一。
- 提供方的临时错误按指数退避，429遵守服务端提示；令牌失效后停用对应注册，不能无穷重试。
- 回执独立轮询工作进程；保存提供方的票据与错误码，不存完整推送正文。
- TTL：审批提醒须在已知截止时间前发送，普通完成提醒建议24小时；过期仅停止提醒，不删结果。
- 静音只关闭推送提醒，收件箱和已读状态继续同步；当前可见话题可抑制普通完成通知，但不能仅凭旧在线状态永久抑制。
- 同notification_id重发可能仍出现重复系统横幅；应用打开和收件箱消费必须去重，不承诺操作系统 exactly-once。

### 14.5 定时任务与 `send_message` 扩展

现成标准协议会话订阅不能覆盖所有未打开的定时任务目标。新增Python平台投递插件，利用已确认的平台适配器扩展点，把目标映射到对应的账户、配置档案和话题或收件箱；本方案中的mobile目标是**新开发项**，不是现成配置。[19]

插件处理：校验目标→生成/取得稳定delivery_id→本地队列事务保存正文和媒体引用→连接器上传→BFF以delivery_id幂等入收件箱→回传持久接纳回执。不要在成功推送手机后才算结果保存，也不要先给Hermes返回成功再尝试落盘。

若公开适配器参数给出稳定execution/delivery ID：用其原样构成producer范围内唯一键。若没有：插件第一次收到时生成local_delivery_id并先持久化；之后插件自身重试复用该ID。BFF按`producer_instance_id+local_delivery_id+target`去重。

**有限保证必须暴露：** 无稳定上游ID时，只保证插件落盘后的传输；上游再次调用可能无法识别同一执行，插件接收前崩溃可能漏投。能力标`delivery_reconciliation=limited`。禁止用文本哈希、job_id或时间桶当执行ID，同内容的两次合法任务应保留两条。

Hermes投递队列发送中崩溃可能标unknown并不盲目重试。[20] 此时只核对已有产物并补投递，不重跑定时任务原任务。公开扩展点若无法满足严格投递身份门槛，形成独立核心变更提案并等待明确授权；不能顺手改Hermes源码。

上线迁移前保留现有Telegram投递，不自动修改所有定时任务目的地。用户确认后按单个任务灰度验证→对账→逐批切换；如果仍处limited状态，就不能宣布完全不漏的替代。

## 15. 能力覆盖、补充API与明确不支持项

### 15.1 全量验收矩阵

| 工作流 | 实现归属 | 验收标准 | 阻塞全量的条件 |
|---|---|---|---|
| 多配置档案 | BFF 授权、连接器绑定和应用内切换 | 同名会话跨配置档案不会串消息/工具/附件 | 靠全局切换活动配置档案来路由 |
| 多话题并发 | Hermes队列+应用多状态 | 多话题同时执行，单话题按先进先出处理 | 切页取消任务或丢其他会话终态 |
| Markdown/代码/工具 | 原生渲染器和投影 | 流式、参数、结果、复制、final对账 | 只显示最终文字 |
| 审批与澄清 | 两种协议的适配器和交互界面 | 选择范围、多问题、跳过、过期、跨设备抢答 | 自动批准或恢复旧许可 |
| 图片/文件 | 上传、暂存和输出导出 | 大文件续传、鉴权、真实工具可读 | 仅上传到S3但Hermes读不到 |
| 语音/音视频 | 录音/STT/TTS/播放器 | 原音保留、转写失败可恢复、Range续播 | 只剩转写文本 |
| 系统分享进/出 | 原生桥+草稿+分享模块 | 杀进程/未登录/多文件时无丢项或误发送 | 实验功能未真机验证 |
| 停止/排队/插话/重置 | 标准协议控制 | 精确目标、代次围栏、竞态解释 | 以自然语言替代真实控制 |
| 定时任务与主动消息 | 投递插件和收件箱 | 应用未打开话题也可读，重试仅补投递 | 无法可靠地按来源对账 |
| 背景提醒 | APNs/FCM/厂商通道 | 目标手机与真实网络锁屏/冷启动测试 | 无GMS只配FCM |
| 引用/回应/搜索/导出 | BFF 本地业务和经授权的历史记录 | 引用稳定、搜索不泄漏、导出可读 | 把将界面回应误记为已写入智能体上下文 |
| 联系人/位置 | 单次原生选择器和消息块 | 明确用户确认、最小字段、模型适配 | 整库上传或后台定位 |
| GIF/贴纸 | 附件与渲染适配器 | 动图/静图降级明确，版权/来源由用户提供 | 把任意外部URL当安全媒体代理 |
| 群聊、@ 提及和话题技能 | 成员权限、触发策略和预置 | 成员授权、一次提及最多一次提交、移除后立即失权 | 缺少成员授权即共享操作员控制 |
| 凭据或连接授权等安全交互 | 专用安全界面或转交可信客户端 | 凭据禁止进入普通历史、日志和推送 | 安全交互或等价接力流程尚未实现 |

### 15.2 补充拟议接口与字段

除第6节外，下列接口共同构成完整产品范围；权限、信封、ID与版本规则相同：

| 方法/路径 | 请求或查询字段 | 响应及语义 |
|---|---|---|
| GET /messages/{id} | — | 完整message+blocks+version，用于repair |
| GET /controls/{id} | — | 交互详情、上次权威观察时间、响应摘要 |
| GET /inbox/{id} | — | 当前授权下的定位及可读结果引用 |
| POST /sync/snapshots/{id}/complete | 游标 | 验证已交接水位后释放保留标记，幂等 |
| POST /notifications/{id}/opened | request_id、action | 记录打开，不自动read或approve |
| PUT /topics/{id}/preferences | expected_version、pinned、mute_until | 本用户展示偏好；不是Agent运行配置 |
| POST /topics/{id}/reactions | request_id、message_id、emoji、present | 设置目标状态而非toggle，重试不反转 |
| GET /search | profile_id、q、游标、limit | 仅可见已索引内容，返回coverage与索引水位 |
| POST /topics/{id}/exports | request_id、format=markdown/json、include_media | 202导出任务，读取权限逐步复核 |
| GET /exports/{id} | — | processing/ready/failed；下载仍短期授权 |
| POST /attachments/{id}/transcriptions | request_id、language_hint | 202STT 任务；不产生Agent turn |
| GET /transcriptions/{id} | — | 原音引用、文本、状态、错误；编辑另存 |
| POST /messages/{id}/speech | request_id、voice_preset_id | 202TTS 任务；能力允许才出现 |
| GET /speech/{id} | — | audio attachment或失败；不影响原消息终态 |
| GET /presets?profile_id=… | — | 允许的模型/技能/工具组合及修订版本 |
| POST /topics/{id}/preset | request_id、preset_id、expected_revision | 固定策略应用回执；只在支持安全边界时执行 |
| GET /topics/{id}/members | 游标 | 可见成员与role |
| PUT /topics/{id}/members/{user_id} | request_id、role、expected_version | room.manage；ACL更新同时更换受影响事件流纪元 |
| DELETE /topics/{id}/members/{user_id} | request_id | 撤权，旧通知/媒体授权处理遵循撤权规则 |

新增持久实体必须在相应工作包中补迁移：`reactions(account,message,user,emoji UNIQUE)`、`export_jobs`、`transcription_jobs`、`speech_jobs`、`presets/preset_revisions`、`topic_policy_bindings`、`snapshot_retention_pins`、`staging_receipts`、`device_open_events`。全部带账户与owner/scope外键；任务有request_id唯一约束、状态、错误码、输入哈希、输出引用及expires_at。

本版不伪称已经给出这些外围实体的可执行完整迁移；核心DDL+本字典是实现起点，相应工作包必须先写迁移和API 结构定义再写UI。

### 15.3 引用、联系人与群聊的上下文语义

- 引用回复：message_id持久关联，BFF取授权可见且长度受限的引用摘要，明确作为用户提供引用文本送入模型；不把被引用工具输出升级成系统指令。删除源消息后显示引用不可用，不跨权限找回。
- 联系人块：仅用户选定的display_name、可选phone/email；位置块：latitude/longitude、可选精度、用户附言。发送前预览；模型不支持结构化块时转换为明确标记的用户文本，不生成额外工具动作。
- 回应只是应用UI状态，默认不触发Agent；需要触发时作为另一次明确用户输入，不能所有点赞都调用模型。
- 群聊有普通群聊消息与智能体提交两类。新增`POST /topics/{id}/room-messages`，请求体为`{room_message_id,text,attachment_ids,reply_to_message_id,invoke_agent:boolean}`；同ID同正文幂等，返回message_id和可选submission_id。room_message_id是应用UUID，@Agent经UI解析为显式invoke_agent，不扫描任意文本中的相似名字。BFF以room_message_id唯一约束创建一个提交，并保留发起者身份。普通成员不自动获得approval或session.control；存储迁移补`room_messages`及对应作者/Topic复合外键。
- 群聊上下文只选择该群当前授权范围内消息；不得混入负责人其他DM。删除成员会阻止后续授权同步/媒体/推送；已离线设备不能即时获知撤权，收到撤权或再次鉴权时按策略清理缓存。系统无法远程抹掉已截图/复制的内容，直签媒体还受11.3节TTL窗口约束。
- 话题技能绑定用preset_revision；变更影响未来输入还是需要新绑定由上游实测决定。未支持时要求新话题，不在旧运行中悄悄换工具集合。

### 15.4 命令分级

直接UI动作覆盖new/title/model/reasoning/queue/steer/interrupt/branch/reset/export等已映射能力。帮助菜单由能力清单生成。插件安装、修改凭据、重启网关、更新Hermes、yolo不作为普通应用入口；需要时在独立管理表面另行授权。canonical支持目录不等于每条Telegram slash命令都可通过同一RPC执行。[7]

现有Telegram会话默认只在通过owner/profile授权校验后可读；继续写入或handoff必须专项验证。不能用API Server可列出历史推导可以接管旧Telegram会话，也不能为了“导入”直接改state.db。

## 16. 建议代码目录与接口所有权

所有路径是拟建仓库 `hermes-mobile/` 下的路径，本轮未创建这些源文件。

```text
hermes-mobile/
  apps/mobile/
    app/                         Expo Router页面
    src/auth/                    配对、SecureStore、refresh协调
    src/db/                      schema、migrations、single writer
    src/sync/                    feed/snapshot/repair
    src/outbox/                  submission队列与恢复
    src/chat/                    repository、VM、reducer、组件
    src/controls/                两类交互的统一UI模型
    src/media/                   录音、上传、播放、原音/STT
    src/share/                   原生manifest认领
    src/notifications/           provider适配、冷启动路由
    modules/share-in/            原生Share Extension/Android intent桥
    modules/vendor-push/         目标厂商SDK适配
    plugins/                    Expo config plugins
    tests/mobile/               真机E2E场景
  services/bff/src/
    routes/ application/ domain/ repositories/
    auth/ sync/ connector/ media/ notifications/
    workers/ observability/
  services/bff/migrations/
  services/connector/src/
    transport/ adapter/ spool/ recovery/ staging/
    lease/ policy/ delivery/
  plugins/hermes-mobile-delivery/
    plugin.py spool.py sender.py tests/
  packages/protocol/
    mobile-v1/ connector-v1/ schemas/ fixtures/
  packages/hermes-adapter/
    pinned-contract/ validators/ normalize/ fixtures/
  tests/contracts/ tests/integration/ tests/faults/
  deploy/ docs/ runbooks/
```

`packages/protocol`为协议唯一所有者；导出运行时结构定义+TS类型，服务端/客户端共用。Hermes上游类型另放适配器包；升级上游不能自动改变移动端 API。禁止把Electron的window/Node fs依赖引入RN包。

官方桌面端的`canonical-protocol.ts`可作为适配参考；只选择纯协议逻辑，不直接复制其浏览器/桌面组件依赖。[12]

协议兼容规则：新增可选字段允许；必填字段、语义、枚举收窄等breaking变更需API主版本或明确能力。消息状态相关未知枚举不能当success；保留原始未知值用于脱敏诊断。上游契约版本/commit、适配器版本、BFF协议、应用的 `runtimeVersion`都写入诊断摘要，不带凭据。

## 17. 部署、监控、备份与升级

### 17.1 首版部署清单（待授权执行）

- 公网域名+有效TLS，反向代理开启WS，idle 超时大于应用心跳；request-body限制与应用能力一致。
- BFF API/worker使用独立进程或同镜像不同entry，PostgreSQL和S3只允许必要访问。先单BFF实例，不提前引入分布式广播问题。
- 连接器在Hermes同主机独立监督服务运行，配置自身spool/staging容量与权限；不为启动连接器重启现有网关。
- 日志目录、本地队列目录、临时媒体目录明确分开；磁盘保留阈值触发拒绝新接纳，不能满盘后静默丢事件。
- 审批、推送、S3、API凭据使用部署秘密存储；文档与示例全部 `[REDACTED]`，不从调试响应复制真实令牌。
- “无需手机VPN”必须验证手机→API、对象存储、推送，以及Hermes主机→模型/工具四条链路。任一可达不代表其余可达；域名/服务地区选型以实际网络测试为准。

### 17.2 监控指标

| 指标 | 维度/用途 | 初始告警建议 |
|---|---|---|
| api_accept_latency / errors | route+error_code，不用message_id作标签 | p95持续恶化或5xx突升 |
| command_oldest_age | 后端+kind | 超过消息TTL的十分之一即预警 |
| connector_last_seen / spool_bytes | 后端 | 离线/接近磁盘配额 |
| upstream_replay_gap_total | adapter_version | 升级后增长回滚评估 |
| unsettled_admissions / unknown_controls | 后端+配置档案 | 任一长期unknown需人工对账 |
| final_pending_age | 话题结果完整性 | 终态已有但final投影持续缺失 |
| feed_lag / snapshot_restart_count | 采样设备聚合 | 重连反复快照、版本不兼容 |
| push_provider_errors / invalid_tokens | 提供方+environment | 接纳下降；不命名为设备送达率 |
| inbox_missing_source_reconciliation | producer | 来源可核对时才测完整性 |
| upload_verify_fail / staging_fail | MIME类别+后端 | 大量失败或路径校验拒绝 |

追踪用request_id→submission_id→command_id→admission_id→inbox_item_id串联，但进入普通指标时降为聚合维度；正文、工具参数、联系人不写通用遥测。排障包默认只含脱敏状态和版本，用户明确选择后才能附内容。

### 17.3 备份与灾难恢复

建议目标（未实测）：BFF数据RPO≤15分钟、RTO≤2小时，前提是已配置PostgreSQL持续归档和定期恢复演练；只有每日dump时不能声称此RPO。对象存储版本/保留与DB备份一致管理。加密密钥另行备份并限制访问，密钥丢失不能靠DB dump恢复。

恢复顺序：停新写→恢复DB与对象清单→禁用旧设备凭据族并重新认证/换事件流纪元→部署兼容同一数据结构的版本→恢复连接器只读对账→核对未结command/admission/delivery→确认旧实例已终止→开放新写。恢复备份会回退接纳记录，不能盲目把旧发件队列全部重发；删除标记、上游回执与operator审查共同避免重执行。

连接器本地队列若丢失：能从BFF和上游回执和会话记录恢复的先恢复；无法恢复的原始增量或无稳定ID投递标unknown/limited，不能宣布无损恢复。

### 17.4 版本发布与回滚

- 锁定Expo SDK/RN、Node、PostgreSQL主版本和Hermes 适配器基线；不把文档v55路径当当前推荐版本。
- 开发、预览或内测、生产各用独立构建渠道，并分别配置签名和推送环境。
- 原生模块、权限、SQLCipher、推送 SDK变化需要新的原生构建；OTA只发与runtimeVersion兼容的JS/assets，不承诺热更新可加原生能力。
- DB迁移采用expand→兼容双读/写窗口→contract，回滚应用版本不自动回滚破坏性数据迁移。
- Hermes升级先运行固定测试夹具+隔离集成+真机关键链路；失败保留旧适配器，不修改用户运行源代码以“临时兼容”。
- 发布前让现有运行执行完或受控暂停接纳；升级连接器不能把正在运行的任务记成失败并重做。

## 18. 验收与故障注入：从结构检查到真机证明

下面全部是待执行验收，不是本轮测试通过报告。

### 18.1 测试层次

1. **协议与纯函数：** JSON 结构定义、状态转移、UTF-16 归约器、权限判定、幂等哈希规范化。
2. **数据库集成：** 真PostgreSQL事务、锁顺序、唯一约束、快照保留。使用真实数据库验证。
3. **连接器契约：** 固定上游测试夹具验证空值/缺省/两路交互；再对隔离Hermes版本实际联调。
4. **移动端持久化：** 真SQLite与文件系统，进程强杀、磁盘满、迁移、密钥错误。
5. **真机网络：** 目标iOS、GMS Android、所需无GMS厂商机，移动网络/Wi-Fi、锁屏、结束进程、权限拒绝。
6. **生产演练：** 备份恢复、撤权、升级回滚、定时任务切换及不重做副作用。

### 18.2 必测用例

| ID | 故障/动作 | 通过证据 | 建议测试文件 |
|---|---|---|---|
| AT-01 | 两配置档案同名/相同opaque 会话标识 | 消息/附件/control无串租户 | tests/integration/profile-isolation.test.ts |
| AT-02 | 多话题并发与单话题队列 | 并发独立、FIFO受上游控制 | tests/integration/multi-topic.test.ts |
| AT-03 | BFF 提交后丢HTTP 确认 | 同submission/message仅一份 | tests/faults/submission-lost-ack.test.ts |
| AT-04 | 同ID不同正文或附件 | 409且上游无新增提交 | tests/contracts/idempotency.test.ts |
| AT-05 | Hermes接纳后连接器写回执前崩溃 | 原身份对账，无新输入/工具重做 | tests/faults/admission-window.test.ts |
| AT-06 | 恢复后认证主体改变 | 自动提交被阻断并显式待核验 | tests/faults/principal-change.test.ts |
| AT-07 | 事件流较小序号事务阻塞 | 后序不能先可见形成游标越过 | tests/integration/feed-commit-order.test.ts |
| AT-08 | 快照翻页中更新/删除/撤权 | 固定cut或失效；无混合页/越权 | tests/integration/snapshot-cut.test.ts |
| AT-09 | 快照发布与GC并发 | 保留标记正确或明确废弃重建 | tests/integration/snapshot-gc.test.ts |
| AT-10 | 应用事务提交前后强杀/满盘 | 确认不越过持久化游标 | apps/mobile/src/db/__tests__/sync-transaction.test.ts |
| AT-11 | emoji/null边界/重复interim/迟到增量 | 不重复字、不破坏字符、final正确 | apps/mobile/src/chat/__tests__/message-reducer.test.ts |
| AT-12 | 增量缺口并重启 | repair_job不丢，最终完整块恢复 | apps/mobile/src/sync/__tests__/repair.test.ts |
| AT-13 | 两设备相反审批答案 | 一个BFF claim，真实上游采用可追溯 | tests/faults/control-race.test.ts |
| AT-14 | server-response发送后断线 | sent_unconfirmed/unknown，不虚称批准 | tests/faults/server-response-loss.test.ts |
| AT-15 | 交互过期、通知迟到、代次变化 | 旧许可无法作用新任务 | tests/integration/control-fencing.test.ts |
| AT-16 | queued查询后立刻started再cancel | UI语义与实际中断目标一致 | tests/faults/cancel-start-race.test.ts |
| AT-17 | 旧连接器失云连接仍能连Hermes | 新写入器不自动接管；无双执行 | tests/faults/connector-split-brain.test.ts |
| AT-18 | 刷新成功响应丢失/并发/重启 | 同request恢复同child，其他设备不掉线 | tests/faults/refresh-loss.test.ts |
| AT-19 | 撤销设备/成员后用旧WS/URL/通知 | 新请求拒绝，缓存按策略失效 | tests/integration/revocation.test.ts |
| AT-20 | 续传、伪MIME、路径/symlink、跨配置档案 | 正常文件可用，恶意路径拒绝 | tests/integration/media-security.test.ts |
| AT-21 | 原音持久化各阶段崩溃/STT失败 | 可试听恢复，不丢原音或编文本 | apps/mobile/src/media/__tests__/recording-recovery.test.ts |
| AT-22 | 分享未登录、重复import、多文件、URI失效 | 不误发送、不跨账户、可恢复草稿 | apps/mobile/src/share/__tests__/native-contract.test.ts |
| AT-23 | 推送初始与监听重复、Router未ready | 鉴权后只导航一次，旧交互只读 | apps/mobile/src/notifications/__tests__/cold-start.test.ts |
| AT-24 | 收件箱提交后推送失败 | 冷启动仍读结果，重试只发提醒 | tests/faults/push-outbox.test.ts |
| AT-25 | 定时任务接收前崩溃/无ID/同文两次 | limited明确，同文两次不错误合并 | plugins/hermes-mobile-delivery/tests/test_identity.py |
| AT-26 | 锁屏/结束进程/禁通知/无GMS | 记录实际状态；能力限制真实可见 | apps/mobile/tests/mobile/push-matrix.yaml |
| AT-27 | 群聊@重放/移除成员 | 一条room消息至多一提交，无DM泄漏 | tests/integration/room-trigger.test.ts |
| AT-28 | 备份恢复与版本回滚 | 未结操作先对账，不批量重发 | tests/faults/restore-reconcile.test.ts |
| AT-29 | 大字体/读屏/减少动态效果 | 核心发送、审批、录音可独立完成 | apps/mobile/tests/mobile/accessibility.yaml |
| AT-30 | final事件到达但历史暂不可见 | final_pending可修复，不发空结果通知 | tests/faults/final-projection.test.ts |

### 18.3 性能与网络门槛

建议验收负载：个人账户、3台设备、5个活跃话题；另用合成测试夹具压测，不代表实际模型会并发到该规模。建议目标：
- 已建立连接时BFF接纳p95≤500ms；不含模型排队和生成。
- 收到上游文字到手机可见p95≤300ms；分层记录网络、落盘、渲染，不混成模型首令牌。
- 本地一万条历史按窗口读取，首屏p95≤1秒；定义具体基准机型后实测。
- 断网恢复且积压不超过一千条事件时，正常网络十秒内恢复一致；超出按分批进度展示。
- 故障注入中传输重试造成的逻辑重复提交为零；外部工具exactly-once不在此保证内。
- 推送单独统计提供方接纳、设备observed、用户opened；不能拿回执计算设备到达率。目标机型/网络试验通过前不承诺所有国内网络可达。

这些是开工时可调整的测试目标，不是本次测量结果。

## 19. 可分工工作包与依赖

每个工作包均采用：先失败测试/迁移约束→最小实现→通过测试→联调证据。命令和包脚本要在工程创建后真实定义，不在本方案伪造已存在的`pnpm test`输出。

| 包 | 输入/依赖 | 主要写入范围 | 交付物与完成条件 |
|---|---|---|---|
| W00 契约冻结 | 本规格、设备/网络选择 | packages/protocol、docs/adr | Mobile/Connector 结构定义、错误码、状态机；JSON样例校验；API差异签字 |
| W01 原生与接入验证 | W00 | 临时验证工程、适配器测试夹具 | 真机流式、审批/clarify、图片、冷启动推送、独立定时任务收件箱；报告不能只mock |
| W02 BFF安全与模型 | W00 | services/bff/auth、迁移、repositories | 配对/refresh/ACL/复合FK；AT-01/04/18/19 |
| W03 连接器核心 | W00，W01确认契约 | services/connector、packages/hermes-adapter | attach/能力/submit/receipt/spool/recovery；AT-05/06/16/17 |
| W04 事件流与快照 | W02 | services/bff/sync、workers、应用 sync | 按提交顺序排列的事件流、不可变快照、pin/repair；AT-07至12 |
| W05 应用可靠聊天 | W00+W02/W03/W04集成 | apps/mobile/chat/db/outbox、页面 | 多Profile/Topic、流式、草稿、断线；AT-02/03/10/11 |
| W06 审批与控制中心 | W03+W04 | BFF controls、应用 controls | 两路协议、多问题、CAS、unknown；AT-13/14/15 |
| W07 媒体和语音 | W02+W03 | BFF media、连接器暂存、应用 media | 续传/输出/Range、原音/STT/TTS；AT-20/21 |
| W08 收件箱与推送 | W02+W04、W01设备验证 | BFF notifications、应用 notifications/modules | 提供方适配器、回执、冷启动；AT-23/24/26 |
| W09 主动投递插件 | W03+W08 | plugins/hermes-mobile-delivery | 本地队列、投递身份、主动消息与定时任务；AT-25，limited如实标注 |
| W10 剩余交互对等 | W05/W06/W07 | 应用 share、BFF rooms/search/export/presets | 分享、位置/联系人、回应、群聊/@、技能；AT-22/27/29 |
| W11 生产加固 | 全部集成 | deploy/runbooks、监控、备份 | 密钥/日志检查、恢复/回滚；AT-28/30与真机完整矩阵 |
| W12 最终验收与迁移 | W11 | docs/release-evidence、迁移清单 | 每个范围项标verified或阻塞；用户确认后逐项切换，不提前删Telegram |

安全并发：W02/W03可并行，W04/W07/W08在各自依赖满足后并行，UI先按冻结测试夹具开发但不能靠测试夹具验收。protocol、迁移版本分配和最终集成各有单一负责人，避免多人改同一结构定义。默认profile/技术负责人负责最终整合；本任务没有生活/金融路由需求。

建议阶段门：
- **阶段 A 可行性：** W01整条链路真机证明；如果目标无GMS推送失败或定时任务身份不足，先解决而非继续堆UI。
- **阶段 B 核心可用：** W02—W06核心聊天与恢复；可以个人试用，不称全量。
- **阶段 C 功能对等：** 媒体、主动投递、分享、群聊与技能等矩阵逐项通过，安全交互缺口有已验证替代流程。
- **阶段 D 生产迁移：** 备份恢复、撤权、监控、发布/回滚和用户目标网络通过；经授权再切换定时任务投递目标。

不在未确认目标手机、人员投入及发行方式前给出伪精确工期；可在W01结束后基于实测缺口与人力估算。每包都必须交付测试报告/日志句柄/构建标识，不以“代码已写”代表通过。

## 20. 风险、待确认决策与默认处理

| 决策 | 当前推荐默认 | 何时必须确认 |
|---|---|---|
| 主要手机与GMS状态 | iOS+Android设计保留，实际先验一台主力机 | W01开始前，决定推送 SDK与构建 |
| 服务部署地区/域名 | 手机和Hermes都可稳定访问的单域名 | 购置/部署前；不承诺任意地区无VPN |
| 发行方式 | 先内部开发构建或预览构建 | 真机安装/正式签名和商店发布前 |
| 用户范围 | 个人单账户、多设备；群聊独立后续包 | 不在个人版默认开放公网注册 |
| 聊天保留/本地加密 | 服务端加密+SQLCipher候选、显式删除策略 | 有真实个人内容前必须验收 |
| 旧Telegram会话 | 默认不自动接管写权限 | 专项owner/handoff验证后用户确认 |
| 定时任务严格投递身份 | 优先公开插件；无稳定ID降级limited | 宣称全量替代前必须解决或明确接受限制 |
| 核心源码变更 | 不改 | 若插件无法满足要求，单独提案并获授权 |

最大的技术风险不是聊天页面，而是原生推送在实际网络的表现、两种控件协议的恢复语义、上游未知执行的对账，以及主动投递在插件边界之外的缺口。架构把它们前置验证，不依赖后期补丁掩盖。

## 21. 本轮交付与验证边界

本轮交付的是这一份整合后的工程设计规格书；三份专项笔记只是审阅输入，不要求开发者自行拼接，也不作为与主文竞争的第二套契约。字段冲突已统一为UTF-16、账户级隔离、不透明事件流游标、两路交互响应、显式工具白名单和事件流头部优先锁顺序。

本轮已进行静态源码/官方文档读取及文档结构、JSON示例、引用映射和跨章节一致性检查。未创建Expo应用、BFF或连接器，没有安装依赖、启动服务、创建真实测试会话、调用模型或修改运行中的Hermes；SQL DDL未在PostgreSQL执行，TS签名未编译，真机/集成/故障注入均为后续验收项。任何“通过”只指实际执行的文档检查，不代表系统已经实现。

开始开发的下一步是授权W00/W01并确定主力手机与分发方式，而不是直接把所有工作包同时部署到当前Hermes环境。

## 资料来源

[1] https://docs.expo.dev/push-notifications/what-you-need-to-know
[2] https://docs.expo.dev/push-notifications/sending-notifications
[3] https://docs.expo.dev/versions/latest/sdk/background-task
[4] https://docs.expo.dev/versions/latest/sdk/securestore
[5] https://docs.expo.dev/develop/development-builds/introduction
[6] https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-local-sessions
[7] https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
[8] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/apps/shared/src/gateway-contract.openrpc.json — apps/shared/src/gateway-contract.openrpc.json
[9] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/tui_gateway/contracts/canonical_sessions.py — tui_gateway/contracts/canonical_sessions.py
[10] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/tui_gateway/contracts/canonical.py — tui_gateway/contracts/canonical.py
[11] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/website/docs/user-guide/messaging/telegram.md — website/docs/user-guide/messaging/telegram.md
[12] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/apps/desktop/src/api/canonical-protocol.ts — apps/desktop/src/api/canonical-protocol.ts
[13] https://firebase.google.com/docs/cloud-messaging/android/client
[14] https://docs.expo.dev/versions/latest/sdk/audio
[15] https://docs.expo.dev/versions/latest/sdk/video
[16] https://docs.expo.dev/versions/latest/sdk/filesystem
[17] https://docs.expo.dev/versions/latest/sdk/sqlite
[18] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/gateway/session_policy.py — gateway/session_policy.py
[19] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/website/docs/developer-guide/adding-platform-adapters.md — website/docs/developer-guide/adding-platform-adapters.md
[20] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/cron/delivery_queue.py — cron/delivery_queue.py
[21] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/gateway/session_authority.py — gateway/session_authority.py
[22] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/gateway/session_server_requests.py — gateway/session_server_requests.py
[23] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/tui_gateway/contracts/events.py — tui_gateway/contracts/events.py
[24] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/gateway/session_pending_controls.py — gateway/session_pending_controls.py
[25] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/tui_gateway/contracts/server_requests.py — tui_gateway/contracts/server_requests.py
[26] https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/gateway/session_settlement_recovery.py — gateway/session_settlement_recovery.py
[27] https://raw.githubusercontent.com/expo/expo/main/docs/pages/versions/unversioned/sdk/sharing.mdx
[28] https://raw.githubusercontent.com/expo/expo/main/docs/pages/versions/unversioned/sdk/sqlite.mdx
