# Hermes Expo 移动客户端工程设计规格书 v2

**状态：** 详细设计，不是实现完成报告；不授权开发、安装、部署、创建测试 Profile 或改动现有 Hermes。
**目标：** 让客户端、BFF、Connector 和测试人员能够依据统一的数据契约并行实施，而非再次自行推测接口与异常语义。
**架构：** Expo / React Native App → HTTPS/WSS BFF → 主动出站 Connector → Hermes canonical Gateway；主动投递另接插件适配器。
**技术栈：** TypeScript、Expo Router、TanStack Query、Zustand、SQLite；Fastify、PostgreSQL、S3 兼容对象存储；Node Connector、本地 SQLite；Python 投递插件。
**证据边界：** 沿用 v1 已读取的官方 Expo 文档和 Hermes 固定源码 `3bcd071226d3d605a2bb3b4f3933e7d583e189d6`，补充静态协议核查。本文件中的 Mobile API、Connector wire、SQL、默认参数、测试和模块接口均为**待实现设计**，不是 Hermes 自带接口或真实运行输出。
**版本关系：** 本文是可独立阅读的 v2 详细设计，保留 v1 的功能范围；冲突时以本版明确的数据契约为准。v1 保留为架构讨论记录。

**阅读导航：** 产品/架构看第1—4、15、19—20章；BFF开发看第5—10、14章；App开发看第7—8、11—12章；Connector开发看第3、11、13章；测试/运维看第17—18章。第21章说明本轮实际验证边界，Sources提供官方文档及固定源码链接。

---

## 1. 本版到底增加了什么

| v1 缺口 | v2 必须落到的粒度 |
|---|---|
| 只有模块名 | 模块职责、输入/输出、禁止依赖、代码路径 |
| 只有 API 路径 | 方法、权限、请求字段、回执、幂等、错误语义 |
| 只有数据表名 | 字段类型、外键、索引、状态约束、事务边界 |
| “支持断线恢复” | 游标种类、snapshot cut、重放、ACK、去重、过期处理 |
| “支持审批” | 请求形态、响应 CAS、上游确认、丢 ACK、多设备竞态 |
| “支持通知” | 收件箱、推送 attempt、渠道选择、回执、主动投递缺口 |
| “按阶段开发” | 工作包、依赖、变更路径、失败测试、完成证据 |

**设计底线：** 不把网络重试变成业务重做，不把一次连接等同于一个会话，不把 BFF 持久接收等同于 Hermes 接纳，不把 OS Push 接纳等同于用户收到。

### 1.1 全量能力与版本标签

范围仍为通过 Telegram 使用 Hermes 的能力，而非 Telegram 社交平台本身。标为“核心版”的阶段可以先用于个人聊天，但“全量替代验收”必须包括：多 Profile、Topic、多会话并发、流式与工具过程、审批/clarify、图片文件语音视频、命令、离线恢复、Cron/send-message、引用/回应、分享接收/导出、位置/联系人、群聊/@/Topic 技能。上游 Telegram 文档存在相关工作流，不能省略后宣称全量。[11]

每项功能在 capability 中具有：`available | disabled_by_policy | unavailable_upstream | requires_native_build | pending_validation`。实施看板另有 `not_started | implemented | verified`，产品可用性与工程进度不得混用。

## 2. 首版明确的技术决策（ADR）

| 决策 | 推荐值 | 原因与被放弃选项 |
|---|---|---|
| 主聊天 UI | 原生 React Native | 不以 WebView 包装 Desktop renderer；平台 API 和后台差异可控 |
| 对 Hermes 的接入 | canonical WS | 复用多会话、控制与恢复契约；不通过 PTY 抓文本，也不混用 legacy payload。[7][8] |
| 公网入口 | 单 BFF 域名，HTTPS/WSS 443 | 不公开 Dashboard、本地控制 socket、Hermes 管理凭据 |
| App 写操作 | HTTPS JSON | 易定义幂等/超时/状态码；WS 只用于订阅和同步控制 |
| BFF→Connector 命令 | 主动出站 WSS 上的业务命令 | 不做任意 JSON-RPC 透传 |
| 上游执行主权 | Hermes | BFF 不直接编辑 state.db、不启动第二套 Agent |
| 服务端持久化 | PostgreSQL 事务 + DB worker | 首版不强制 Redis/Kafka/Kubernetes |
| 附件 | 私有对象存储 + 本地 staging | 不把手机 URI 或用户任意路径传给 Hermes |
| 设备历史 | SQLite 单事实源 | Query 管 metadata，Zustand 管瞬态，不三份历史互相覆盖 |
| 推送 | Inbox 先持久，再 Outbox | 系统通知只是提醒，结果靠同步恢复 |
| 运行实例 | 一台 BFF + 一个 Connector owner/后端 | 首版不做自动跨主机 Connector HA；先消除双执行风险 |
| 协议升级 | Mobile API v1 + adapter capability manifest | 不要求 App 跟着 Hermes 每个 commit 更新 |

### 2.1 物理部署

```text
App ──443── BFF API + WS             （公网可信服务区）
              │
              ├── PostgreSQL         （私网，不开放公网端口）
              ├── Private S3 bucket   （短期上传/下载授权）
              └── DB workers         （同步、对账、媒体、Push）
              ▲
              │ Connector 主动出站 WSS
Connector + spool + staging          （Hermes 所在主机）
              │ 本地 attach 获取一次性 ticket
              ▼
Hermes canonical Gateway → Agent/Tools/Profiles
              │
              └── delivery plugin → 本地 spool → BFF Inbox
```

Connector 同机读取本地 attach 信息；一次性票据不传到手机、不写日志。官方有 attach/能力发现契约，但部署时仍以实际安装版本为准。[7]

Mac 休眠时：App 仍可读缓存/BFF 历史，BFF 可保存有有效期的待发送输入；执行显示 `waiting_connector`。不能把 Mac 在线与 BFF 在线合成一个绿点。

### 2.2 建议起始参数（全部可配置，非官方上限/实测 SLA）

| 参数 | 初始建议 | 超限行为 |
|---|---|---|
| API JSON body | 256 KiB | 413；附件不得 base64 塞进正文 |
| 单条文本 | 64 KiB UTF-8 | 422，建议改为文本附件 |
| 单条附件 | 最多 10 个 | 422，不悄悄丢后面的附件 |
| 普通附件上限 | 100 MiB | capability 可降低；模型支持另算 |
| 上传分片 | 8 MiB，手机并发 2 | 每片重试；不整文件重传 |
| 上传会话 | 24 小时有效 | 过期后显式重新创建，不能拼接旧部分 |
| 未发普通消息有效期 | 24 小时 | 过期转 expired，用户再次确认 |
| 审批响应有效期 | 上游 deadline 为准 | 没有精确 deadline 时不编造剩余秒数 |
| access token | 10 分钟 | refresh；不自动登出清空草稿 |
| refresh 会话 | 滚动 30 天 | 设备撤销立即生效 |
| 配对授权 | 5 分钟，单次 | 过期重签，禁止无限次猜码 |
| WS 应用心跳 | 25 秒；75 秒未收到则重连 | 不把短断线当执行失败 |
| 重连退避 | full jitter，基数 1 秒，上限 30 秒 | 回到前台可立即尝试一次 |
| RPC 查询/命令接纳超时 | 15 秒 | 接纳不明则查询；不重新生成 ID |
| feed 同步批量 | 200 条或 512 KiB | 返回 next_cursor；不半截 JSON |
| WS batch | 最多 100 条或 256 KiB | 大工具结果改引用资源 |
| App 未 ACK 缓冲 | 512 条或 2 MiB | sync_required 后断开，改 HTTP 补拉 |
| Connector lease | 60 秒，20 秒续租 | 失租停接新命令；不自动转移执行权 |
| feed 增量保留 | 7 天 | 旧 cursor 要求 snapshot |
| snapshot materialization | 10 分钟下载期 | 过期重建，旧本地数据不提前清空 |

大小是服务端产品限额而非模型可处理能力。`capabilities` 返回实际有效限额，服务端始终复核。

## 3. 统一标识、归属与版本语义

### 3.1 ID 字典

本项目生成的 ID 使用 UUID 字符串。上游 Hermes ID 是 opaque string，**原样保存，禁止“修正”或重造**。

| 字段 | 归属/用途 | 唯一与变更规则 |
|---|---|---|
| account_id | 本 App 的租户/工作区 | 首版只有个人 account，但不是全局硬编码 |
| user_id / device_id | 用户与设备 | 多设备同用户；device 不决定上游 owner |
| backend_id | 一个 Hermes 后端注册 | 更换主机不复用旧凭据 |
| profile_id | App 内 Profile 记录 UUID | 与 `gateway_profile_ref` 分开，default 不是 UUID |
| gateway_profile_ref | 上游真实 Profile 标识/名称 | 来自可信发现，不由手机自由传路径 |
| topic_id | App 稳定逻辑话题 | 重置会话仍可保留 Topic；分支创建新 Topic |
| binding_id | Topic→Hermes 绑定版本 | 每次 reset/handoff 递增 binding_revision |
| hermes_session_id | canonical 逻辑 ID | 服从上游快照，不能只存 current stored row |
| stored_session_id | 当前持久历史片段 | 压缩/重置可变化。[6][9] |
| submission_id | 用户一次发送意图 | 客户端首次发送前生成，重试不变 |
| admission_id | Hermes 接纳回执 | 收到后原样保存，不能用 submission_id 代替 |
| message_id / block_id | BFF 展示实体 | 同一流式气泡稳定，不随 delta 变化 |
| control_id | BFF 交互卡片 | 映射上游 prompt/request+epoch+generation |
| response_id | 一次审批/clarify回答 | 幂等响应身份，不等于 control_id |
| event_id / ingest_id | 下游事件/上游入库身份 | 事件重发保留原 ID |
| command_id / lease_generation | 云→Connector命令/租约代次 | ACK 和终态都围绕 command_id |
| delivery_id | 主动消息投递身份 | 有稳定来源才可跨重试去重 |

### 3.2 四种版本，禁止混用

1. `api_version`：本项目接口版本，当前提案 v1。
2. `entity_version`：BFF 单个投影实体版本，用于 UI 归约与乐观并发。
3. `binding_revision` / Hermes `execution_generation`：分别约束话题绑定和目标执行代次。
4. `feed_epoch + sequence`：客户端同步位置，与上游 `replay_epoch + seq` 无关。

时间用 UTC RFC3339，UI 转本地显示；时间戳不作为排序/幂等唯一依据。64 位 sequence 通过 JSON 发送十进制字符串。

本项目版本/代次的JSON也统一十进制字符串；adapter转入Hermes整数参数时检查整数范围并用无损编码，不能先转JavaScript Number再发现已丢精度。上游authority/replay标识按实际schema保留，不因应用ID规范而改写。

### 3.3 权限实体

每个业务资源带 account_id；所有 Topic 带 backend_id/profile_id；可写命令还需 `chat.send / session.control / control.respond` 等应用权限。上游连接被授权并不意味着任何 App 用户可使用它。

首版个人 owner 映射 Connector 的固定 principal，不随设备改变。群聊阶段需增加成员授权和作者归属；不得直接向群成员下放 operator 级权限。

## 4. 数据所有权和模块依赖

| 数据 | 权威写入者 | 其他层如何使用 |
|---|---|---|
| Agent 历史、工具执行、admission | Hermes | Connector 读取并归一化，BFF不可直接SQL写 |
| Profile 授权、设备与会话安全 | BFF | App缓存但不决定授权 |
| Topic展示、Inbox、已读、回应 | BFF | AppSQLite是离线副本 |
| 流式临时块 | Connector→BFF投影 | 完成后与上游历史对账 |
| 原始附件对象 | BFF媒体服务 | Connector只访问被授权附件 |
| 本地待发消息/未完成录音 | AppSQLite+文件目录 | 提交确认后转服务端权威 |
| 上游原始事件缓冲 | Connector spool | ACK后可清理，不能替代无限上游历史 |

### 4.1 后端依赖方向

```text
routes → application services → domain rules → repositories
                         └── connector ports / media ports / push ports
workers → 相同 application services（不复制业务逻辑）
```

- `routes` 不直接执行 Hermes method。
- `repositories` 不发送 WS，不调用 Push。
- 事务内只做 DB 操作，不等待网络或模型。
- API/worker 用同一权限与状态转换函数。
- 协议 package 不依赖 Fastify、React Native、Electron 或 Node fs。

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
| pairing_grants | grant_id,account_id uuid; token_hash bytea; allowed_scopes jsonb; expires_at,consumed_at | token_hash UQ；原 token 不落DB |
| backends | account_id,backend_id uuid; name text; status text; approved_instance_ref text | PK(account_id,backend_id) |
| profiles | account_id,backend_id,profile_id uuid; gateway_profile_ref text; label text; capabilities jsonb | UQ(account_id,backend_id,gateway_profile_ref) |
| profile_grants | account_id,profile_id,user_id uuid; scopes text[]; acl_revision bigint | PK(account_id,profile_id,user_id) |
| connector_leases | account_id,backend_id,connector_id uuid; generation bigint; lease_until; identity_ref text | PK(account_id,backend_id); 不等于上游fence |
| topic_members | account_id,topic_id,user_id uuid; role text; joined_at,removed_at | PK(account_id,topic_id,user_id) |
| topic_preferences | account_id,topic_id,user_id uuid; pinned bool; mute_until; color text | PK(account_id,topic_id,user_id) |
| read_cursors | account_id,topic_id,user_id uuid; last_read_message_order bigint; updated_at | PK(account_id,topic_id,user_id)；仅单调前进 |
| attachments | account_id,attachment_id,profile_id,uploader_user_id uuid; object_key text; mime,size,sha256; state text; refs bigint | UQ(account_id,object_key)；size>=0；state受限 |
| uploads | account_id,upload_id,attachment_id uuid; storage_upload_id text; part_size int; status text; expires_at | PK(account_id,upload_id); storage_upload_id不可给业务当路径 |
| upload_parts | account_id,upload_id uuid; part_number int; etag text; bytes bigint; checksum text | PK(account_id,upload_id,part_number) |
| attachment_refs | account_id,attachment_id,topic_id,resource_id uuid; resource_kind text | UQ(account_id,attachment_id,resource_kind,resource_id) |
| push_registrations | account_id,device_id uuid; provider,environment,app_id text; encrypted_token bytea; token_hash bytea; active bool | UQ(device_id,provider,environment,app_id) |
| push_attempts | account_id,attempt_id,notification_id uuid; provider,ticket_id,status text; error_code; created_at | notification_id/created_at索引；不存正文 |
| delivery_receipts | account_id,delivery_id,profile_id uuid; producer_ref,source_execution_id text; payload_hash text; inbox_item_id uuid | 稳定source时UQ(account_id,producer_ref,source_execution_id) |
| sync_snapshots | account_id,user_id,snapshot_id uuid; feed_epoch uuid; watermark bigint; acl_revision bigint; state; expires_at | snapshot_id PK；绑定用户且过期受控 |
| snapshot_rows | snapshot_id uuid; ordinal bigint; entity_kind text; entity jsonb | PK(snapshot_id,ordinal)；创建后只读 |
| mutation_receipts | account_id,request_id,actor_user_id,topic_id uuid; kind,payload_hash,status text; result jsonb | UQ(account_id,request_id) |
| audit_events | account_id,audit_id,actor_user_id uuid; action,target_ref,result text; request_id uuid; at | 不存secret；按时间保留 |
| idempotency_tombstones | account_id,operation_id uuid; kind,payload_hash,final_status text; expires_at | 防止清理正文后旧请求复活 |

### 5.3 事务与清理要求

- 所有写入统一锁顺序：先按稳定user_id顺序锁定受影响feed_heads，再锁Topic/control/submission等业务行。接收者集合先按ACL revision读取，取得锁后重验；集合或ACL变化则整体回滚重试，不能持有业务锁后反向追加feed锁。权限变更和清理器也服从该顺序。
- `payload_hash` 对严格验证后的规范化 JSON 计算：不随 request_id/http header改变；附件顺序、引用和用户明确选择属于正文。采用固定规范化算法和测试向量，不用不同语言默认 JSON 序列化碰运气。
- 同 ID 同 hash 返回既有结果；同 ID 不同 hash 返回 409，不悄悄当新意图。
- 权限、附件归属、Topic state、binding_revision 在接纳事务前/内复核。
- 正文删除与幂等身份保留分离；tombstone期限覆盖允许重试窗口，过期旧键不自动当新命令执行。
- ORM迁移必须补齐本节字典的外键/检查约束，迁移回归禁止跨 account FK 或 orphan refs；这里的核心DDL不是声称完整生产schema已就绪。

## 6. Mobile API v1：公共协议

### 6.1 通用约定

路径前缀 `/mobile/v1`；JSON UTF-8；HTTPS。写请求带 `X-Request-ID`，业务幂等 ID 同时放 body/`Idempotency-Key`，两者不一致返回 422。除 refresh/pairing 外均要求应用访问凭证，不接受上游 Hermes Token。

成功 envelope：`{data, request_id, server_time}`；列表增加 `next_cursor, has_more`。`has_more` 由服务端分页查询决定，不按数组长度猜测。错误统一 envelope：

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
| POST /pairings/redeem | 单次pairing grant | grant+device注册意图 | 201应用会话；丢响应按安全章重新配对 |
| POST /auth/refresh | refresh secret | refresh_request_id | 200轮换凭证；受控重放 |
| DELETE /auth/session | 当前设备 | 重复成功 | 204；关闭WS/清理推送注册 |
| GET /devices | device.manage或本人 | — | 本人设备列表 |
| DELETE /devices/{id} | device.manage | 重复成功 | 204撤销；不删除服务器历史 |
| GET /profiles | profile.read | 仅授权目录 | backend/profile状态与版本 |
| GET /capabilities?profile_id=… | profile.read | 目录中获准profile | 能力、限额、理由、policy_revision |
| POST /topics | chat.send | request_id+profile_id | 202creating或重放原Topic |
| GET /topics?profile_id=… | chat.read | cursor/limit | 可见Topic，不返回管理密钥 |
| GET /topics/{id} | chat.read | — | 投影、binding_revision、运行状态 |
| GET /topics/{id}/messages | chat.read | before/order cursor | 稳定message_order分页 |
| POST /topics/{id}/submissions | chat.send | submission_id、binding_revision | 202，明确accepted不是started |
| GET /submissions/{id} | chat.read且可见Topic | — | 当前业务状态+权威receipt摘要 |
| POST /topics/{id}/actions | 动作对应scope | request_id+expected_version/generation | 202待执行或200已完成重放 |
| GET /actions/{request_id} | 动作发起者/授权人 | — | pending/applied/rejected/unknown |
| GET /controls?state=pending | control.read | 分页 | 跨Profile待处理清单 |
| POST /controls/{id}/responses | control.respond | response_id、version、generation | 202responding，不等于resolved |
| GET /control-responses/{id} | control.read | — | claimed/sent/confirmed/rejected/unknown |
| POST /uploads | media.upload | request_id、profile_id、大小类型 | 201上传会话 |
| POST /uploads/{id}/parts/authorize | media.upload | part_numbers | 限范围短期上传授权 |
| GET /uploads/{id} | uploader | — | 已确认片、缺片、期限 |
| POST /uploads/{id}/complete | uploader | request_id、parts清单 | 202校验中；禁止直接ready |
| DELETE /uploads/{id} | uploader | 重复成功 | 202清理multipart |
| GET /attachments/{id} | media.read及引用授权 | — | 状态/尺寸/类型，无主机路径 |
| POST /attachments/{id}/download-grant | media.read | 短期用途授权 | 下载/播放URL与过期时间 |
| GET /inbox | inbox.read | 分页 | 主动结果/完成提醒 |
| PUT /topics/{id}/read-cursor | chat.read | message_order | max合并；不推进到不存在消息 |
| POST /devices/{id}/push-registration | 本设备 | provider+environment+app_id | upsert；同token不重复注册 |
| DELETE /devices/{id}/push-registration | 本设备 | provider | 停用通道 |
| POST /sync/snapshots | sync.read | 当前身份/ACL | 202构建或201已就绪 |
| GET /sync/snapshots/{id} | 同一用户 | — | state、水位、分页入口 |
| GET /sync/snapshots/{id}/rows | 同一用户 | page_cursor | 不可变分页实体 |
| GET /sync?cursor=… | sync.read | 用户绑定cursor | events、next_cursor、has_more |
| POST /ws-tickets | 当前设备 | 一次性 | 短期App WS票据，非Hermes票据 |
| GET /events | WS票据握手 | 接受后消费票据 | Mobile Event v1订阅 |

### 6.3 核心 DTO：新建 Topic

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
- BFF创建 `creating` Topic和create command；Connector取得canonical snapshot后转ready。
- 手机断网重试原request_id；返回同topic_id。创建期间输入可存本地草稿，不先向未绑定Session发消息。

### 6.4 核心 DTO：发送消息

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

`mode`首版只允许normal/queue；steer是单独动作，避免重试同消息时突然改变语义。附件必须同account且允许该Profile/Topic引用；attachment READY不等于已在Hermes staging，因此提交可先accepted但dispatch前须等staged。手机超过server允许TTL时拒绝，不任其设置无限有效。

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

BFF accepted ACK前必须提交：submission、user message、command_outbox和用户feed事件。任何网络调用都在commit后。HTTP丢ACK用相同submission_id再次POST返回同message_id，不新增气泡。

### 6.5 业务动作约束

| action | 必填前置字段 | 上游策略 | 不支持/竞态处理 |
|---|---|---|---|
| rename/archive | expected_entity_version | canonical mutate，保留上游revision | 409刷新；重复request_id返回原回执 |
| model/reasoning | binding_revision、execution_generation | 能力允许才调用mutate | busy按上游拒绝，不强行中断 |
| interrupt | binding_revision、execution_generation | session.interrupt | 代次变更返回409，不停新任务 |
| steer | binding_revision、execution_generation、text | session.steer | delivered不明不自动转新prompt |
| cancel_submission | submission_id、allow_interrupt=true | 已接纳时prompt.cancel | UI明确“若已开始，也会停止”；否则不开放这个上游动作 |
| replace_queued | submission_id、新submission_id、text | advertised replace方法 | 若已开始返回冲突；不先cancel再submit制造空窗 |
| reset/branch/delete | revision+generation+二次确认 | canonical mutate | 先成功后更新binding，不能预先清空本地历史 |
| retry_as_new | original_submission_id+new_submission_id | 新意图 | 显示副作用可能重复，需用户确认 |
| resolve_unknown | admission_id+generation+确认 | 仅支持时调用专用控制 | 解除队列阻塞≠重做丢失输入 |

**重要竞态：** `prompt.cancel`在已开始时可能中断执行，先GET看见queued再cancel并不能消除竞态。不能给用户承诺“绝不影响正在运行的任务”，除非未来上游提供原子queue-only控制。[10]

### 6.6 错误码表

| HTTP | code | 客户端动作 |
|---|---|---|
| 400 | INVALID_JSON | 不重试，修请求 |
| 401 | AUTH_EXPIRED | single-flight刷新一次再原ID重试 |
| 401 | DEVICE_REVOKED | 关闭连接、锁定缓存/注销；不循环刷新 |
| 404 | RESOURCE_NOT_FOUND | 资源不存在或不可见，不泄漏归属 |
| 409 | IDEMPOTENCY_CONFLICT | 禁止自动重试；用户另建意图 |
| 409 | VERSION_CONFLICT | 读取最新状态再让用户决定 |
| 409 | BINDING_CHANGED | 不把旧输入悄悄转投新会话 |
| 409 | EXECUTION_CHANGED | 不作用于新generation |
| 409 | CONTROL_ALREADY_HANDLED | 展示最新状态/其他设备处理 |
| 409 | REFRESH_IN_PROGRESS | 读取原持久refresh意图合并重试，不再生成新request_id |
| 410 | CONTROL_EXPIRED | 卡片过期不可再提交 |
| 410 | CURSOR_EXPIRED / SNAPSHOT_EXPIRED | 进入snapshot流程，不删除未发outbox |
| 413 | PAYLOAD_TOO_LARGE | 建议附件/减少选择 |
| 422 | VALIDATION_FAILED | 按field_errors标注，不靠message字符串分支 |
| 422 | ATTACHMENT_NOT_READY | 等校验/staging状态，不重复上传完整文件 |
| 429 | RATE_LIMITED | 使用Retry-After，原业务ID重试 |
| 503 | BACKEND_UNAVAILABLE | 可保存待发送时返回202；本操作不允许延迟则503 |
| 503 | CAPABILITY_UNAVAILABLE | 禁用对应入口并显示reason，不发自然语言冒充命令 |
| 500 | INTERNAL_ERROR | 显示request_id，查询接纳状态后决定重试 |

控制timeout或unknown属于资源状态，不能所有都粗暴映射500。

### 6.7 Control响应、同步批次和上传DTO

control响应是按kind区分的联合，所有请求均带response_id、expected_version、binding_revision。canonical prompt另有execution_generation；server request由control记录绑定connection generation，不允许客户端自行给旧请求补一个新代次。

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

其他允许形态：canonical clarify使用`answer:{text:string,skipped:boolean}`，skipped=true转换上游空字符串；批量clarify使用`answer:{questions:[{qid,selected_choices:string[],free_text:string|null,skipped:boolean}],outcome:"submitted"|"cancelled"}`。BFF按当前控件校验qid集合、是否允许多选、选项和文本上限；不同时允许skipped和非空答案。free_text不是隐式额外选择，UI明确展示“其他”。客户端不发送raw上游request id，adapter负责映射。服务器返回`{response_id,control_id,status:"claimed",control_state:"responding",entity_version}`，完整envelope遵循6.1；后续从GET响应状态和feed得知确认结果。

HTTP同步返回data形态：`{events:MobileEvent[],next_cursor:string,has_more:boolean,watermark_sequence:string}`；WS的events控制帧增加from_sequence/to_sequence。cursor字段仅作说明性字符串，不提供可构造的token示例。一个batch只含同用户同feed_epoch；无事件也返回可安全保存的next_cursor。分页limit在1—200之间，按bytes预算提前结束但不丢事件。

创建上传的完整业务body示例：

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

返回data包含upload_id、attachment_id、part_size_bytes、expires_at、state和effective_limits，不返回本地主机路径。parts/authorize输入`{part_numbers:number[]}`，输出每片part_number、method=PUT、headers、url、expires_at；真实url/签名在日志统一脱敏。complete输入`{request_id,parts:[{part_number,etag,checksum}],total_size_bytes}`；etag为opaque字符串不能改引号/大小写。声明sha256可空，但服务端最终验证不能省略。

## 7. 客户端同步协议：HTTP + WSS

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

使用UTF-16 code unit offset以匹配JS字符串；Connector Python来源须在TS归一化，不能把UTF-8字节数/Unicode码点数混用。offset仅用于append验证，不能将surrogate pair切开。

### 7.2 事件注册表

| kind | payload必含 | reducer行为 |
|---|---|---|
| topic.upsert | 完整Topic投影/version | 高版本替换 |
| topic.deleted | topic_id、deletion_version | tombstone；不让旧upsert复活 |
| submission.upsert | submission_id、status、admission摘要、version | optimistic气泡与服务端message_id合并 |
| message.upsert | 完整message metadata+blocks/version | 新建/修复，较旧投影忽略 |
| message.text.delta | message_id、block_id、base_version、offset_utf16、append | 仅base_version和长度匹配才append |
| message.final | message_id、完整final blocks、version、finish_kind | 权威替换流式块并清除pending动画 |
| tool.upsert | tool_call_id、状态、redacted args、result_ref、version | 同tool卡片更新，不造新气泡 |
| control.upsert | control_id、transport、kind、state、version、choices | 恢复待办，幂等替换 |
| control.closed | control_id、state、version、reason | 卡片禁用；不能推断用户选择 |
| inbox.upsert | item_id、target、summary、version | upsert并更新未读 |
| read.updated | topic_id、last_read_message_order | max合并 |
| attachment.upsert | id、state、meta、version | 不把下载URL作为永久属性 |
| capabilities.changed | profile_id、policy_revision | 查询新能力，不停止既有任务 |

WS控制帧不进入业务feed：`hello`、`subscribe`、`events`、`ack`、`heartbeat`、`sync_required`、`auth_expiring`、`error`。

### 7.3 WS握手与ACK

1. App通过已认证HTTPS取短期单次 `/ws-tickets`，ticket绑定device/user/api version，建议30秒过期。
2. WebSocket子协议携带票据（实现时过滤反向代理握手header日志），服务端消费后返回hello；这是本App协议，不复用Hermes ticket。
3. App发送subscribe包含opaque cursor；BFF校验用户/epoch，先补齐DB再进入tail。
4. BFF每个batch包含 `from_sequence/to_sequence/next_cursor/events`。
5. App在**一个SQLite事务**应用事件并保存cursor，commit后才ACK该next_cursor。
6. BFF只接受自己发给该连接的cursor，防止客户端伪造已读；ACK是同步完成，不是read。
7. 超出缓冲时发送sync_required并断开，App用HTTP分批补拉；不无限积压内存。

实时广播只是低延迟唤醒：每次订阅完成和每个心跳周期都读取持久feed head，与该连接已发游标比较，发现落后就补拉。这样commit后广播进程崩溃不会造成在线连接永远漏掉事件。

cursor是服务端签名或随机映射的不透明token，绑定account/user/epoch/seq。App可以保存，不自行构造和递增。多设备各自有已同步cursor，业务已读是用户级read_cursor。

### 7.4 可重现的snapshot流程

- BFF在REPEATABLE READ事务内读取用户feed head的epoch/watermark/ACL revision，并把可见Topic、message projections、controls、Inbox、read state写成不可变snapshot_rows；相同事务快照保证这些投影与水位一致。
- 业务投影与feed更新在同一事务，feed序号分配在user head行锁下进行，因此不会发生小seq迟提交被漏掉。
- snapshot仅初始化近期消息窗口，例如每Topic最近50条；更早历史通过message_order分页。必须返回哪些窗口被覆盖，不谎称snapshot包含全部历史。
- 发布snapshot时创建对watermark之后增量的retention pin；与feed清理器使用共同的用户级保留锁，发布前复核min_retained_seq。pin持续到客户端完成快照与增量交接或到期。若pin发布前已有缺口，则废弃重建，不能靠“通常七天不会过期”忽略清理竞态。
- Snapshot每页再次验权。ACL revision/epoch变化立即失效，不能让被移除成员继续下载旧页。
- App把所有页写入带snapshot_id的staging表；全部成功后事务切换为新的cache generation并记录watermark cursor，**保留本地draft/outbox/uploads**。
- 然后GET sync读取watermark之后的事件直至has_more=false，再以该cursor订阅WS。
- 订阅仍须先从DB补齐cursor之后增量，再tail；接实时连接不是历史补齐的替代。
- 快照过期/中断保留旧缓存只读，删除未完成staging后重建。不得为了内存方便逐页覆盖正式表，导致半新半旧历史。

### 7.5 Delta缺口处理

同event_id重复：忽略副作用，但确认游标可前进。base_version不匹配：不盲目append，标该entity `needs_repair`，在同一SQLite事务记录repair任务后可推进feed cursor；随后读取完整message投影修复。修复任务在重启后仍存在，不允许仅设置一个会丢的内存flag。

`message.final`是完整替换，不把最终完整文本追加到已积累delta后面。最终内容为空但附有文件时仍是有效final，不能以text非空作为唯一完成判断。

## 8. 状态机与并发不变量

### 8.1 Submission

```text
local_pending（仅App）
 → accepted → waiting_connector → dispatching
 → admitted → queued → running ↔ waiting_control
 → completed | failed | cancelled
任一未执行状态 → expired
执行/接纳不明 → unknown → 权威对账或人工确认（禁止自动新建输入）
```

每个状态变更需要证据：accepted有DB commit；admitted有上游receipt；completed有权威终态；final_message_available另标投影已存在。不要将消息流暂时结束当completed。

### 8.2 Control

```text
pending → responding → resolved
                 ├→ resolution_unknown
                 └→ pending（仅确认未被上游接收且仍有效）
pending/responding → expired | cancelled
```

响应本地持久、云命令送达、上游接收、工具已继续是不同层次。resolved只在上游显式确认或可确认的结果对账后成立；open_request消失但无选择证据只能closed_unknown，不虚构“已批准”。

### 8.3 Attachment

```text
created → uploading → uploaded → verifying → ready → staging → staged
                       └→ rejected
任何可取消阶段 → abandoned → deleted
```

ready指对象存储中合法可用；staged指特定backend/binding可以读取。跨backend复用同附件需新staging记录；不能把一个主机路径缓存成全球可用。

### 8.4 不变量

- 一个submission_id只对应一个规范化payload和一个展示user message。
- 一个Topic在一个binding_revision只指向一个canonical session，reset不能悄悄转移旧命令。
- entity_version单调前进；迟到事件不能复活deleted实体。
- feed ACK之后的事件效果必须已在设备SQLite持久化。
- BFF transaction commit之前不发成功ACK或Push。
- 处理control的设备必须仍有权限、仍是同request和generation。
- connector lease只限制本系统命令路由，不宣称能阻止旧进程已经发往Hermes的请求。
- 未知执行不能自动重跑；未知投递不能自动重新执行原任务。

## 9. 关键业务时序与事务伪代码

以下伪代码描述逻辑，不是已运行代码。

### TX-01 用户提交接纳

```text
validate schema and allowed profile
canonicalize payload; compute digest
BEGIN
  lock candidate recipients' feed heads in sorted user_id order; recheck ACL revision
  lock topic row; recheck membership/state/binding_revision
  if existing submission_id:
    same hash -> return persisted receipt after commit
    different hash -> rollback, IDEMPOTENCY_CONFLICT
  validate attachments ownership/readiness/reference policy
  insert submissions(status=accepted)
  allocate message_order under topic lock; insert user message/blocks
  insert command_outbox(kind=submit, original submission_id)
  increment sequence; insert user_events + update read-side projection
COMMIT
return 202 accepted
worker dispatches later (not inside transaction)
```

多个群成员feed用固定锁顺序避免deadlock；遇数据库serialization/deadlock可在无外部副作用的事务边界按相同业务ID有限重试。

### TX-02 Connector事件入库

```text
Connector receives Hermes event -> redact/allowlist -> spool transaction (ingest_id, upstream refs, normalized data)
Connector sends ingest batch
BFF BEGIN
  verify connector identity/backend/profile mapping/lease routing policy
  lock candidate recipients' feed heads in sorted order; recheck ACL revision
  INSERT connector_ingest ON CONFLICT ...
  if exact duplicate -> return existing ACK only
  if same ingest_id different hash -> reject and alert
  lock affected projection; validate upstream epoch/generation/order
  apply upsert/delta; update submission/control as supported
  allocate commit-ordered seq, insert user_events
  if authoritative terminal and final projection available:
    insert inbox with unique source_key
    insert push_outbox for eligible devices
COMMIT
BFF ACK exact ingest IDs
Connector marks ACKed locally then later GC
```

同批次不是全部必成功时返回逐条ACK/error，不用最高UUID推断连续完成。终态早于final投影时先记 `final_pending` repair，修复后再发“结果可看”的通知，避免点开空页面。

### TX-03 审批回答抢占

```text
BEGIN
  lock authorized recipients' feed heads in sorted order; recheck ACL revision
  lock controls
  check ACL + expected_version + binding/generation + deadline + allowed choice
  if same response_id+same hash -> return persisted response status
  if state != pending -> return conflict/current state
  insert control_responses(status=claimed)
  update controls(state=responding, response_id, version=version+1)
  insert command_outbox(kind=respond_control)
  append control.upsert feed event
COMMIT
return 202 responding
Connector sends using correct upstream transport
upstream confirmed -> separate transaction marks confirmed/resolved
timeout -> mark resolution_unknown, fetch upstream pending/state; do not blindly grant again
```

### TX-04 已读与badge

```text
BEGIN
  lock the user's feed head; recheck ACL revision
  verify requested message_order exists in visible topic
  read_cursor = max(existing, requested)
  update per-user read state
  compute unread from visible message orders/inbox state, not token deltas
  append read.updated to user's feed
COMMIT
```

同步ACK不更新read_cursor；只有页面呈现到对应消息并满足可见判定才读。被用户静音不代表已读。

### TX-05 推送任务领取

```text
BEGIN
  claim due rows with SELECT ... FOR UPDATE SKIP LOCKED
  set sending/lease_until/attempts
COMMIT
send to provider outside transaction
BEGIN
  store provider attempt + ticket/receipt status
  update accepted/retry/dead/expired using current attempt fence
COMMIT
```

worker在provider接受后崩溃可能重发通知；用稳定notification_id/collapse key尽量合并，但承认OS可能显示重复提醒，Inbox本身仍去重。对过期control不再发送提醒。

## 10. 鉴权、配对与安全协议

### 10.1 配对

- 管理员在受保护界面创建高熵短期单次grant，限定account/scopes。QR包含服务器origin与grant，App展示origin要求用户确认，禁止二维码静默切换到陌生服务。
- App持久保存pairing_request_id和本次设备注册意图，兑换grant；BFF原子consume并建立device/auth family。
- 首版配对响应丢失时不提供凭据重领接口：管理员撤销未完成设备授权并创建新grant，手机重新配对。不能把“已消费grant”变成任何人可领凭据；以后若增加恢复，必须单独设计设备持有证明及重放窗口。
- pairing/admin API仅限运维身份，普通App用户不能创建管理员。

### 10.2 Refresh丢响应与并发

每个device单独auth family；客户端single-flight刷新，所有401等待同一refresh promise，不同时轮换。

请求含 `refresh_request_id`。客户端发送前在SecureStore持久化旧凭据与刷新意图，收到响应后原子替换凭据包再清理意图。服务端锁family，校验旧secret hash与generation后轮换；用服务器KMS/密钥封装短暂保存同请求的响应，建议60秒可重放期。响应丢失时仅凭原refresh secret、同request_id、同family/device绑定取得同一结果，不再次向前轮换；每次仍检查未被撤销。已使用旧token+不同request_id在窗口内返回REFRESH_IN_PROGRESS，客户端合并到原持久意图，不再次轮换；窗口外视为疑似重用，撤销该family并重新配对，不影响其他设备。精确旧操作超过封套保留期也要求重新认证，不凭空给旧token“宽松接受”。UUID device_id本身不是设备持有证明，首版安全基础仍是TLS和高熵refresh secret，不虚称实现硬件绑定。

敏感原token不入日志；存hash并不意味着低熵码安全，所以grant/refresh均使用高熵随机值。refresh在SecureStore，access尽量仅内存；SecureStore不是消息数据库加密方案。[4]

### 10.3 WS与撤销

应用WS ticket单次使用、短时过期。连接建立后记录auth family、ACL revision与access expiry；到期前发auth_expiring，App重新取得票据重连。服务端设备撤销或权限变更时主动close并使sync epoch失效，不等token自然过期。

建议应用关闭码：4401认证失效、4403撤销/权限变化、4409需snapshot、4429背压/限流、4503后端暂不可用。代码是本项目提案，不是Hermes标准。

### 10.4 权限清单与危险操作

- `chat.read / chat.send / session.control / control.read / control.respond / media.upload / media.read / inbox.read / device.manage / room.manage / admin.manage`。
- BFF根据principal推导account/user，不接受body覆盖这些身份。
- high-risk approve要求最近解锁/认证；不提供锁屏无上下文“全部允许”。
- secret/sudo/vault不走普通消息/日志/Push。未完成安全表单前明确unsupported，不能关闭审批来规避。
- 普通event spool只保留允许的脱敏字段及必要上游身份，不整包持久化任意原始帧；凭据表单内容禁止落入普通spool、projection、telemetry。白名单和脱敏在磁盘写入前完成。
- 错误消息、trace、遥测、反向代理access log统一过滤token/ticket/cookie/push token和连接串。
- 传输TLS、对象/备份加密、App数据库加密分别验收；本系统可信BFF/Connector可见明文，不能宣称E2EE。

## 11. 媒体协议与资源生命周期

### 11.1 上传

`POST /uploads`输入：request_id、profile_id、file_name、declared_mime、size_bytes、可选客户端checksum。服务器先校验配额和目标权限，分配upload_id/attachment_id/object_key，不允许客户端选择object_key。

返回part_size、expiry、upload mode。客户端按parts/authorize获取指定分片URL；PUT结束保存part ETag/checksum。中断重启先GET upload状态，向存储核对缺片，不能信任仅存在于手机内存的进度。

complete提交part_number/etag/checksum有序数组；BFF校验远端真实part集合后合并，进入verifying。后台检查真实大小、MIME magic、摘要、恶意内容/可解码性。`ready`前不能交给Connector处理。S3 ETag不当作全文件SHA-256。

### 11.2 暂存

Connector用媒体服务签发的限attachment/backend授权下载，落在专有staging根目录：`<root>/<account>/<profile>/<attachment>/payload`，每层使用验证后的内部ID，不拼接原文件名。写临时文件→完整性检查→原子rename→保存staging receipt。

创建RPC中的CanonicalAttachment使用可信生成的 `path,mime`，不是手机提交的路径。[9] 避免symlink/TOCTOU：用受控目录、no-follow打开策略及实际文件句柄校验。后台工具在Docker/SSH时另走backend media bridge并验收，不能将host path直接当remote path。

### 11.3 输出

只导出有来源证明且在允许工作区/输出目录的文件；模型文本中的任意绝对路径不足以授权读取。收集媒体引用→安全读取→上传私有对象→插入message block→再展示可下载状态。

音视频Range播放通过短期grant；URL过期刷新grant后从播放位置恢复。内容较大可先显示“媒体处理中”，文字final不必等待TTS，但最终媒体状态独立可追踪。

首版敏感媒体推荐BFF授权代理并支持Range，每个新请求重验ACL；已有流撤权后中止。若为吞吐改用S3直签URL，明确其在短TTL内通常仍可使用，撤权不能立即收回已签链接；建议TTL不超过60秒并禁缓存。选择直签就不得把“撤权即所有旧URL失效”列为已满足。

### 11.4 生命周期

- 未complete上传24小时自动abandon并清multipart。
- 已提交但未引用附件设回收宽限期，建议24小时；cleanup先检查refs和pending submissions，再删对象。
- Hermes执行未结束/staging仍被引用时不删除文件；任务unknown时人工确认或较长保留，禁止短期GC破坏对账。
- 删除话题只解除当前授权引用；共享附件有其他合法refs则保留，但旧话题下载grant尽快失效。
- 备份中对象删除按备份生命周期独立过期，向用户说明不是点击删除瞬间抹除所有备份。

### 11.5 语音与分享的精确语义

原始音频保存到document级目录后才写outbox；cache目录可被系统回收。[14] 原音、转写、发送给模型的文本是三项独立记录；转写失败不能编造文本，也不能丢原音。用户选择“先转写确认”时，STT不是一次Agent输入；确认后才创建submission。

share-in原生入口先把系统临时URI安全复制到App Group/应用私有暂存区，再写分享草稿；打开主App后选择Profile/Topic并确认发送。原生extension不持有Hermes凭据，不在分享扩展里启动长Agent任务。share-out与share-in分别验收。Expo当前未版本化文档已有实验性share-in，但官方指出其iOS扩展打开主App的方式不受Apple正式支持，未来可能失效；不能说完全没有该能力，也不能认为生产接收链路已解决。首选独立原生桥，实验入口仅作为锁定SDK后的验证候选。[27]

## 12. Expo 客户端：页面、组件、状态与持久化

### 12.1 页面与交互规格

下面路由均为拟建Expo Router路径。所有路由先解析topic_id，再从本地/服务端授权目录取得完整scope；不能把URL参数当权限证明。

| 页面 | 布局和主要动作 | 空态/错误/离线 | 运行中行为 |
|---|---|---|---|
| `app/pair.tsx` | origin确认、扫码、配对进度 | TLS失败不允许忽略证书；grant过期重新签发 | 防双击；失败不打印grant |
| `app/(tabs)/sessions.tsx` | 顶部Profile切换，搜索、置顶、Topic列表、新建 | 无授权与无Topic分开；缓存可读并标最后同步时间 | 各Topic显示running/control/unknown徽标，不只观察当前Topic |
| `app/chat/[topicId].tsx` | 头部Profile/模型/状态，虚拟消息列表，composer和附件栏 | 首屏失败与分页失败分开；离线可写草稿 | stop只针对展示的generation；切页面不取消执行 |
| `app/(tabs)/controls.tsx` | 跨Profile待办，按请求类型筛选 | 无待办；离线允许编辑，不发送批准 | responding不是resolved；冲突后刷新，不自动覆盖另一设备 |
| `app/(tabs)/inbox.tsx` | 任务完成、Cron、外部主动消息 | 缓存可看，未同步明确标记 | 点开真实结果再标已读，不靠点击Push标完成 |
| `app/compose/media.tsx` | 选择、录音、试听、原音/转写预览 | 权限、存储满、上传失败分别处理 | 准备/上传/校验/可发送状态可见 |
| `app/share/import.tsx` | 分享项预览、选择账户/Profile/Topic | URI失效提示重新分享；未登录保留隔离暂存 | 只有用户确认才创建submission |
| `app/(tabs)/settings.tsx` | 设备、后端状态、推送诊断、本地缓存、退出 | BFF在线不代表Hermes在线 | 撤销当前设备后关闭所有连接，保留服务端历史 |
| `app/topics/[topicId]/settings.tsx` | 标题、置顶、静音、技能预设、导出 | 上游不支持的动作显示原因 | reset/delete需确认并阻止旧绑定命令静默迁移 |

交互细则：
- 用户在底部才跟随流式滚动；离底后保持message_id+像素偏移锚点，显示“有新内容”按钮。
- 工具参数与结果可完整展开/复制，但先执行服务端脱敏；长工具结果从独立资源按需读取，不把整段塞进列表每个render。
- markdown禁止原始HTML执行、任意WebView脚本与自动加载外部图片；链接打开前校验scheme，外链经系统浏览器并提示。代码块可横向滚动。
- pending/queued/running/waiting_control/unknown具有不同文字，不靠颜色区分。未知状态不展示“重试任务”默认按钮。
- 输入法组合期间不触发发送；发送后只清空对应draft_version，避免迟到ACK清掉新草稿。
- MessageList按稳定message_id/block_id取key，不用数组index；流式更新单个块，不重渲染整段历史。

### 12.2 数据与模块契约

Expo模块分工：`expo-sqlite`提供跨重启持久数据库；`expo-audio`负责录音/播放，`expo-video`负责视频播放。[14][15][17] `expo-file-system`负责应用文件操作，跨进程断点续传仍由本设计的上传会话和本地队列补齐，不能只凭一次upload调用承诺恢复。[16]

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

`HistoryRepository`是历史唯一读入口；`SyncEngine`是feed唯一消费者；`AuthCoordinator`持有刷新锁；`UploadManager`持有上传状态机。TanStack Query只缓存授权目录、capabilities等meta。Zustand只存滚动锚点、当前选择、录音计时、未提交表单的瞬时缓冲；持久草稿仍归SQLite。

### 12.3 SQLite本地模型

每个已配对account使用独立数据库和文件目录，避免切换账户残留。以下是本地表字典，具体迁移版本在实施时生成：

| 表 | 主键/核心字段 | 清理条件 |
|---|---|---|
| cache_generations | generation_id UUID、active、snapshot_id、created_at | 新generation切换成功后清旧 |
| local_topics/messages/blocks/controls | account_id+entity_id、scope、entity_version、generation_id、body | tombstone或失权；非超时随便清空 |
| processed_events | feed_epoch+event_id、sequence | 不早于活跃cursor/repair所需窗口 |
| sync_state | account_id+user_id、opaque_cursor、feed_epoch、connection_generation | 失权/快照替换事务内修改 |
| repair_jobs | entity_id、target_version、reason、attempts、next_at | 完整投影成功且版本达标 |
| drafts | scope、draft_version、text、attachment_refs、updated_at | 发送事务只清对应版本 |
| local_outbox | submission_id、scope、immutable_payload、hash、state、lease_until、attempts | 服务端接纳关联完成；保留查询所需receipt |
| local_uploads | local_attachment_id、uri、size、upload_id、part_receipts、state | 服务端确认且无草稿/outbox引用 |
| share_imports | import_id、manifest、claimed_account、state | 用户弃用或成功入草稿后回收 |
| notification_intents | notification_id+action、account_hint、target_ids、state | 身份/目标验证后消费 |
| local_read_cursors | topic_id、message_order、pending_sync | 服务端max合并后确认 |

单专用写连接、单writer队列，初始化WAL与外键；网络等待不得放SQLite事务中。当前未版本化Expo文档指出exclusive异步事务使用新连接，原连接PRAGMA不自动继承，不能为“排他”而丢失外键约束；锁定SDK后验证普通事务+专用writer不会被其他查询误入。[28]

本地加密为生产门槛：选择SQLCipher原生构建时必须验证实际cipher支持及错误密钥无法打开数据库，不以SecureStore或一个PRAGMA执行成功冒充数据库已加密。密钥丢失清除不可解密缓存并重新同步；未发消息是否仍可恢复必须真实提示，不能保证所有未提交草稿可恢复。

### 12.4 reducer和离线执行

本版冻结为 `offset_utf16`，不采用子审阅中的UTF-8建议；它与上游已核查字段一致。[23] 归约按第7节：同event重复跳过，版本/offset缺口记录持久repair_job，final完整替换。测试必须包含emoji、组合字符、null分段、重复interim、终态先于迟到delta。

本地发送事务：冻结draft→生成submission_id→登记乐观消息/outbox→清对应draft_version→commit；后台worker再发。正文发送后不可编辑同ID，编辑排队输入走replace动作并产生新submission_id。

网络状态拆成：`transport=offline/connecting/online`、`sync=catching_up/live/repair/auth_blocked/storage_blocked`、`backend=online/offline/unknown`。恢复后同ID查询/重试；401只刷新一次；429按Retry-After；磁盘满暂停同步且不ACK。profile切换时旧请求按原scope入库，不能写到新页面。

本地outbox取消只有在事务中证明尚未进入sending才可直接取消；已发送但ACK丢失先对账，不能删除本地记录假装从未提交。审批离线仅保存表单草稿，联网后重新读取control并要求用户确认；不自动回放过期许可。

### 12.5 录音、权限与可访问性

录音状态：permission→preparing→recording→stopping→persisting→preview。默认不后台录音；来电、退后台或音频设备切换时停止/保存，失败明确提示。文件先写临时路径、rename成功后入DB；文件系统与SQLite无共同事务，启动扫描修复中间状态，GC先核对draft/outbox引用。

麦克风拒绝保留文字/文件入口；有限相册授权只读取选择项；位置/联系人使用单次选择，不上传整库；通知拒绝不阻断聊天。权限永久拒绝提供系统设置入口，但不循环弹窗。

VoiceOver/TalkBack标签包含角色、状态与禁用原因；字体放大不遮住提交按钮；审批modal管理焦点。流式不逐token朗读，按完整块/终态播报；录音提供显式开始/结束按钮，不要求只能长按。

## 13. Connector：真实Hermes映射与出站协议

### 13.1 启动顺序与能力协商

1. 获取本机installation/backend独占进程锁；读取仅含允许backend/profile映射的Connector配置，不遍历所有用户秘密。
2. 打开本地spool并检查可写；不可写不接纳云端命令。
3. 用独立Connector身份连接BFF，取得该backend租约；手机凭据不能冒充Connector。
4. 通过本地公开attach机制取得短期Gateway连接信息；票据只在内存使用，日志统一 `[REDACTED]`。
5. 每Profile独立绑定连接，检查`gateway.ready.payload.session_authority`，再调用`runtime.describe`并登记可用方法/控件；协商支持的server requests。[7][8]
6. `profiles.list`在固定契约中存在，但只作为可信发现候选，目录仍与BFF profile_grants求交；不得因发现某Profile就自动授权。[8]
7. 对已绑定session执行恢复，对unknown命令做身份/receipt对账；完成后才接新写操作。

不得全局切换active profile来路由每条消息。不要机械给每种RPC params加profile：部分模型严格不接受该字段。adapter使用已绑定连接并按实际method schema编码。

### 13.2 方法映射表

| 本项目动作 | Hermes真实入口 | 必须保留的边界 |
|---|---|---|
| 能力/目录 | `runtime.describe`、`profiles.list` | 权限与版本协商，不把schema存在当可执行 |
| 新Topic | `session.create` | request_id、source、服务端固定工具策略 |
| 恢复/历史 | `session.resume`、`session.transcript` | canonical session与stored片段分开 |
| 发送 | `prompt.submit` | 原submission_id；回执只是admission |
| 查询接纳 | `prompt.receipt` | 已知admission；同提交身份或合法control权限 |
| 停止当前 | `session.interrupt` | 当前execution_generation |
| 撤回指定输入 | `prompt.cancel` | admission_id；可能中断已开始输入 |
| 编辑排队输入 | `prompt.replace_queued` | 原admission+新submission；started拒绝，新项去FIFO尾部 |
| 运行中插话 | `session.steer` | generation；不伪装新普通prompt |
| 标题/归档/重置/分支等 | `session.mutate` | revision围栏、request_id幂等、action支持范围 |
| 审批canonical prompt | `approval.respond` | prompt_id+generation+choice；需session:approve |
| 澄清canonical prompt | `clarify.respond` | prompt_id+generation+answer字符串；需session:respond |
| 批量澄清逐题锁定 | `clarify.lock` | 上游server-request的question id，不是本地数组index |
| 补事件 | `session.events.since` | 会话replay_epoch+last_sequence |
| unknown解除 | `prompt.resolve_unknown` | 仅能力允许且人工确认；不是重做原任务 |

入口与主要schema来自固定OpenRPC/Pydantic；审批权限由authority实现核对。[8][9][10] canonical审批需`session:approve`、澄清需`session:respond`，且两者都要订阅实际session和校验generation。[21]

### 13.3 上游真实事件与归一化

上游event帧是`{jsonrpc:"2.0",method:"event",params:{type,session_id,payload,replay_epoch,seq,...}}`；type才是事件名。不要把本项目`message.text.delta`冒充上游method。[9]

| 上游type | 事实字段/规则 | 本项目处理 |
|---|---|---|
| `message.delta` | text可null；turn_id/segment/offset可选；offset是UTF-16 | null封边界；有offset先去重再转换block delta |
| `message.interim` | text、already_streamed、可选turn_id/segment | seal同一segment，不重复append完整文字 |
| `tool.start` | tool_id/name，可能args/args_text/preview | 建稳定tool卡，参数脱敏 |
| `tool.complete` | tool_id/name、result/summary等；没有通用success保证 | 更新同卡；不从缺失字段猜成功 |
| `message.complete` | public status为complete/error/interrupted；canonical可有admission_id/outcome/content | 与receipt对账，再发完整final投影 |
| `approval.request` | prompt_id/generation/command/description/choices | canonical approval card |
| `clarify.request` | prompt_id/generation/question/choices/multi_select | canonical clarify card |
| `approval.settled` | prompt_id/generation | 关闭匹配卡，不等于批准 |
| `clarify.settled` | prompt_id/generation | 关闭匹配卡，不推断答案 |
| `request.cancel` | id/method/reason | 关闭server-request卡，不误关canonical同名项 |

文本和tool字段已核对事件定义，canonical完成扩展与pending控件需额外兼容。[23][24][25] 公共完成schema未覆盖所有canonical字段，取消终态也不保证有status；优先结合receipt，不把缺失status当成功。[21][26]

OpenRPC通知目录并未完整列出四类canonical approval/clarify事件；工程上增加局部validator并保留来源测试，禁止生成union不认识就丢弃。未知影响状态的事件进入诊断/修复，不推进到虚假完成。

消息身份映射：优先绑定上游稳定turn/segment或persisted message identity；临时流式消息先保存映射，完成时重关联而非新建重复气泡。不得用文本hash合并两条相同合法消息。若上游没有稳定message ID，adapter明确使用transcript固定位置/片段身份并验证跨压缩规则；验证前相关恢复能力标pending_validation。

### 13.4 两类交互响应线协议

**A. canonical prompt**：手机的control_id经BFF映射为真实prompt_id；Connector发带自己RPC id的`approval.respond`或`clarify.respond`，收到`resolved/already_resolved`结果。[10][21] 只展示请求提供的choices，不因enum里有always就暴露永久许可。`already_resolved`不能证明本设备答案被采用。

**B. server request**：Gateway发带id和method的请求；Connector回同id的JSON-RPC **response**，不是新RPC。以下仅为结构示例，opaque上游ID为说明性占位，不是实际会话：

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

批量clarify中的qid来自请求；多选在App保留结构化数组，由adapter按已验证上游字符串编码转换；在此版本完成测试前，不臆造数组字段。恢复params.answers是已锁答案，null是跳过；无answers是取消全部，不是正常空提交。[25]

socket.write成功只代表已写出。server response没有“response的RPC回执”；等待可关联的`request.cancel reason=resolved`及open_requests/receipt对账。仅消失而无法归因时`closed_unknown`；禁止自动补批。server-request通道需session:respond和正确订阅/authority，但这不替代canonical审批的session:approve。[22]

未支持的host请求及时返回JSON-RPC错误，不让Agent永久等手机实现terminal/window等桌面功能。secret/sudo/vault请求不写普通spool/Push；首版显示受限并引导在已有安全客户端处理。涉及安全交互的完整替代门槛未通过时，不宣称全量。

### 13.5 云端命令与spool

新增Connector wire是本项目协议，固定为：

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

body按kind严格校验，由BFF可信DB构建完整冻结payload，上例是无附件submit完整业务body；Connector按已持久session binding定位上游，附件ID另经受限授权解析staging，不去任意URL下载。允许kind为create/submit/action/respond_control/stage_attachment/reconcile，不允许手机传任意method或shell。

Connector本地表：`commands(command_id PK,payload_hash,state,upstream_identity,result)`、`event_spool(ingest_id PK,session,replay_epoch,seq,payload,acked_at)`、`session_checkpoints(scope PK,principal_ref,policy_revision,replay_epoch,last_seq,generation)`、`staged_files(attachment_id,backend_id,binding_revision,path,digest,ref_state)`、`delivery_spool(producer_instance_id,delivery_id,payload,state)`。

命令流程：云发command→本地SQLite commit→ACK `connector_stored`→本地prepared/sending记录→上游调用→保存result→BFF持久result→Connector清理。submit result的succeeded只表示拿到admission，不能把submission标completed。server response只写出时result为sent_unconfirmed，不叫succeeded。

未知receipt恢复必须保留原principal、策略与session绑定。更换凭据/恢复旧备份后无法证明owner时，标identity_reconciliation_required并停写，不能用同Profile名称冒充原提交者。

### 13.6 恢复算法与租约

每session一个recovery mutex。重连期间新帧先落spool，不与旧快照并行覆盖：

```text
verify canonical negotiation and principal
if saved session epoch/cursor exists:
  call session.events.since(saved epoch, saved sequence)
  if replay usable: apply/dedupe returned frames
call session.resume
if gap/truncated/snapshot_required or epoch changed:
  freeze stale controls
  replace authoritative execution/pending/open_requests projection
  reconcile transcript + known admission receipts
  establish new session checkpoint
merge buffered post-snapshot frames in upstream order
resume dispatch only after identity/control reconciliation
```

resume和catch-up消除since→subscribe之间的增量缺口，但回放是有限内存缓存，不是durable日志；无法恢复的token动画可丢，final/pending/unknown不可隐藏。[6][7]

lease丢失立即停止新dispatch和控制回答，已收到事件继续落spool，必要时关闭上游连接。云lease_generation只能约束BFF接收，不会让Hermes拒绝已经发出的旧命令。本机独占锁加受控交接是首版前提；云租约过期不自动启动第二writer。接管需证明旧进程/连接已终止，再对账unknown。无法证明就保持离线，不伪称fencing达成。

`source=gui`不能靠`disabled_toolsets:[desktop_ui]`排除宿主工具；固定源码存在再次折入路径。创建时提供显式toolsets白名单，审查展开后的有效工具及server request表；手机不可改此白名单，且它不是工具沙箱。[18]

## 14. Inbox、OS推送与Cron主动投递

### 14.1 三层投递状态

- **结果保存：** inbox_available，有BFF事务与message/artifact引用。
- **通知通道：** pending/sending/provider_accepted/provider_rejected/expired；不混同业务结果。
- **用户端：** device_synced/opened/read；前两者也不能代表用户理解内容。

Expo ticket/receipt只是中转或下游服务接纳，不证明设备收到；通知关闭、系统强停、网络和省电策略都会影响体验。[1][2] 后台任务/静默通知不是常驻WebSocket替代方案。[3]

推送payload只含notification_id、inbox_item_id、profile_id/topic_id/control_id等最小定位信息与通用短文案，不含命令、答案全文、密钥或带签名媒体URL。推送注册按provider/environment/app_id/device分域，生产与开发token不可混用。

### 14.2 通道选择

| 设备 | 推荐路线 | 真实门槛 |
|---|---|---|
| iOS | expo-notifications，开发先走Expo→APNs；生产可选择直连APNs | development/release build、签名权限、真机网络、后台点击 |
| Android有GMS | expo-notifications→FCM或直连FCM | Google服务兼容、channel建立、权限与token轮换 |
| Android无GMS | 目标厂商SDK+自定义原生module/config plugin | 具体厂商账号、SDK、签名配置、真机到达率；不能只换BFF URL |
| 未适配通道 | 前台WS+启动补拉Inbox | 明示后台提醒不可用；不伪装已全量替代 |

FCM依赖兼容Google Play服务环境，因此不能作为无GMS手机唯一方案。[13] Expo Go不作为本项目完整验收环境；从第一阶段使用development build，包含实际原生能力。[5]

### 14.3 通知冷启动时序

先登记通知响应监听并读取初始响应→以notification_id+action去重、持久待解析intent→打开账户DB并迁移/解锁→恢复或刷新身份→拉授权目录→校验目标scope→读取Inbox/control真实状态→补拉相关历史→等待Router ready→导航→上报opened。不要直接信任Push URL或文字触发批准。

离线只打开该账户仍有授权依据的缓存；没有缓存留“等待验证”。撤销/切账号时清除旧intent；旧通知不会恢复过期control。权限拒绝保留完整Inbox功能。

### 14.4 推送worker细则

- 只在结果可读或control仍pending时创建通知；同source_key/device/kind唯一。
- provider transient错误按指数退避，429遵守服务端提示；invalid token停用注册，不能无穷重试。
- receipt独立轮询worker；存provider ticket/错误码，不存完整推送正文。
- TTL：审批不超过已知deadline，普通完成提醒建议24小时；过期仅停止提醒，不删结果。
- mute只抑制Push，不抑制Inbox/已读同步；当前可见Topic可抑制普通完成通知，但不能仅凭旧在线状态永久抑制。
- 同notification_id重发可能仍出现重复系统横幅；App打开和Inbox消费必须去重，不承诺OS exactly-once。

### 14.5 Cron与send_message扩展

现成canonical session订阅不能覆盖所有未打开的Cron目标。新增Python平台投递插件，利用已确认的platform adapter扩展点，把目标映射为account/profile/topic或Inbox；本方案中的mobile目标是**新开发项**，不是现成配置。[19]

插件处理：校验目标→生成/取得稳定delivery_id→本地spool事务保存正文和媒体引用→Connector上传→BFF以delivery_id幂等入Inbox→回传持久接纳receipt。不要在成功推送手机后才算结果保存，也不要先给Hermes返回成功再尝试落盘。

若公开adapter参数给出稳定execution/delivery ID：用其原样构成producer范围内唯一键。若没有：插件第一次收到时生成local_delivery_id并先持久化；之后插件自身重试复用该ID。BFF按`producer_instance_id+local_delivery_id+target`去重。

**有限保证必须暴露：** 无稳定上游ID时，只保证插件落盘后的传输；上游再次调用可能无法识别同一执行，插件接收前崩溃可能漏投。能力标`delivery_reconciliation=limited`。禁止用文本hash、job_id或时间桶当执行ID，同内容的两次合法任务应保留两条。

Hermes投递队列发送中崩溃可能标unknown并不盲目重试。[20] 此时只核对已有产物并补投递，不重跑Cron原任务。公开扩展点若无法满足严格投递身份门槛，形成独立核心变更提案并等待明确授权；不能顺手改Hermes源码。

上线迁移前保留现有Telegram投递，不自动修改所有Cron目的地。用户确认后按单个job canary→对账→逐批切换；如果仍处limited状态，就不能宣布完全不漏的替代。

## 15. 能力覆盖、补充API与明确不支持项

### 15.1 全量验收矩阵

| 工作流 | 实现归属 | 验收标准 | 阻塞全量的条件 |
|---|---|---|---|
| 多Profile | BFF grants+Connector绑定+App切换 | 同名session跨Profile不会串消息/工具/附件 | 靠全局active切换路由 |
| 多Topic并发 | Hermes队列+App多状态 | 多Topic同时执行，单TopicFIFO正确 | 切页取消任务或丢其他会话终态 |
| Markdown/代码/工具 | 原生renderer+投影 | 流式、参数、结果、复制、final对账 | 只显示最终文字 |
| 审批/clarify | 两路adapter+Control UI | 选择范围、多问题、跳过、过期、跨设备抢答 | 自动批准或恢复旧许可 |
| 图片/文件 | 上传/staging/输出导出 | 大文件续传、鉴权、真实工具可读 | 仅上传到S3但Hermes读不到 |
| 语音/音视频 | 录音/STT/TTS/播放器 | 原音保留、转写失败可恢复、Range续播 | 只剩转写文本 |
| 系统分享进/出 | 原生桥+草稿+分享模块 | 杀进程/未登录/多文件时无丢项或误发送 | 实验功能未真机验证 |
| 停止/排队/插话/重置 | canonical controls | 精确目标、代次围栏、竞态解释 | 以自然语言替代真实控制 |
| Cron/主动消息 | delivery插件+Inbox | App未打开Topic也可读，重试不重跑任务 | 无可靠来源对账仍宣称无漏 |
| 背景提醒 | APNs/FCM/厂商通道 | 目标手机与真实网络锁屏/冷启动测试 | 无GMS只配FCM |
| 引用/回应/搜索/导出 | BFF本地业务+授权history | 引用稳定、搜索不泄漏、导出可读 | 把展示回应当已写入Agent上下文 |
| 联系人/位置 | 单次native picker+消息块 | 明确用户确认、最小字段、模型适配 | 整库上传或后台定位 |
| GIF/贴纸 | attachment/render adapter | 动图/静图降级明确，版权/来源由用户提供 | 把任意外部URL当安全媒体代理 |
| 群聊/@/Topic技能 | membership+trigger策略+preset | 成员权限、一次@一次提交、移除立即失权 | 未做成员授权就共享operator控制 |
| 凭据/连接授权等安全交互 | 特殊安全表面或可信客户端handoff | 凭据不进普通历史/日志/Push | 未实现却称所有Telegram交互已覆盖 |

### 15.2 补充拟议接口与字段

除第6节外，下列接口共同构成完整产品范围；权限、envelope、ID与版本规则相同：

| 方法/路径 | 请求或查询字段 | 响应及语义 |
|---|---|---|
| GET /messages/{id} | — | 完整message+blocks+version，用于repair |
| GET /controls/{id} | — | control详情、上次权威观察时间、response摘要 |
| GET /inbox/{id} | — | 当前授权下的定位及可读结果引用 |
| POST /sync/snapshots/{id}/complete | cursor | 验证已交接watermark后释放retention pin，幂等 |
| POST /notifications/{id}/opened | request_id、action | 记录打开，不自动read或approve |
| PUT /topics/{id}/preferences | expected_version、pinned、mute_until | 本用户展示偏好；不是Agent运行配置 |
| POST /topics/{id}/reactions | request_id、message_id、emoji、present | 设置目标状态而非toggle，重试不反转 |
| GET /search | profile_id、q、cursor、limit | 仅可见已索引内容，返回coverage与索引水位 |
| POST /topics/{id}/exports | request_id、format=markdown/json、include_media | 202导出job，读取权限逐步复核 |
| GET /exports/{id} | — | processing/ready/failed；下载仍短期授权 |
| POST /attachments/{id}/transcriptions | request_id、language_hint | 202STT job；不产生Agent turn |
| GET /transcriptions/{id} | — | 原音引用、文本、状态、错误；编辑另存 |
| POST /messages/{id}/speech | request_id、voice_preset_id | 202TTS job；能力允许才出现 |
| GET /speech/{id} | — | audio attachment或失败；不影响原消息终态 |
| GET /presets?profile_id=… | — | 允许的模型/技能/工具组合及revision |
| POST /topics/{id}/preset | request_id、preset_id、expected_revision | 固定策略应用回执；只在支持安全边界时执行 |
| GET /topics/{id}/members | cursor | 可见成员与role |
| PUT /topics/{id}/members/{user_id} | request_id、role、expected_version | room.manage；ACL更新同时更换受影响feed epoch |
| DELETE /topics/{id}/members/{user_id} | request_id | 撤权，旧通知/媒体grant处理遵循撤权规则 |

新增持久实体必须在相应工作包中补迁移：`reactions(account,message,user,emoji UNIQUE)`、`export_jobs`、`transcription_jobs`、`speech_jobs`、`presets/preset_revisions`、`topic_policy_bindings`、`snapshot_retention_pins`、`staging_receipts`、`device_open_events`。全部带account与owner/scope外键；job有request_id唯一约束、状态、错误码、输入hash、输出引用及expires_at。

本版不伪称已经给出这些外围实体的可执行完整迁移；核心DDL+本字典是实现起点，相应工作包必须先写迁移和API schema再写UI。

### 15.3 引用、联系人与群聊的上下文语义

- 引用回复：message_id持久关联，BFF取授权可见且长度受限的引用摘要，明确作为用户提供引用文本送入模型；不把被引用工具输出升级成系统指令。删除源消息后显示引用不可用，不跨权限找回。
- 联系人块：仅用户选定的display_name、可选phone/email；位置块：latitude/longitude、可选精度、用户附言。发送前预览；模型不支持结构化块时转换为明确标记的用户文本，不生成额外工具动作。
- 回应只是应用UI状态，默认不触发Agent；需要触发时作为另一次明确用户输入，不能所有点赞都调用模型。
- 群聊有普通room消息与Agent submission两类。新增`POST /topics/{id}/room-messages`，body为`{room_message_id,text,attachment_ids,reply_to_message_id,invoke_agent:boolean}`；同ID同正文幂等，返回message_id和可选submission_id。room_message_id是应用UUID，@Agent经UI解析为显式invoke_agent，不扫描任意文本中的相似名字。BFF以room_message_id唯一约束创建一个submission，并保留actor身份。普通成员不自动获得approval或session.control；存储迁移补`room_messages`及对应作者/Topic复合外键。
- 群聊上下文只选择该群当前授权范围内消息；不得混入owner其他DM。删除成员会阻止后续授权同步/媒体/推送；已离线设备不能即时获知撤权，收到撤权或再次鉴权时按策略清理缓存。系统无法远程抹掉已截图/复制的内容，直签媒体还受11.3节TTL窗口约束。
- Topic技能绑定用preset_revision；变更影响未来输入还是需要新binding由上游实测决定。未支持时要求新Topic，不在旧运行中悄悄换工具集合。

### 15.4 命令分级

直接UI动作覆盖new/title/model/reasoning/queue/steer/interrupt/branch/reset/export等已映射能力。帮助菜单由capability manifest生成。插件安装、修改凭据、重启Gateway、更新Hermes、yolo不作为普通App入口；需要时在独立管理表面另行授权。canonical支持目录不等于每条Telegram slash命令都可通过同一RPC执行。[7]

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

`packages/protocol`为协议唯一所有者；导出运行时schema+TS类型，服务端/客户端共用。Hermes上游类型另放adapter包；升级上游不能自动改变Mobile API。禁止把Electron的window/Node fs依赖引入RN包。

官方Desktop的`canonical-protocol.ts`可作为适配参考；只选择纯协议逻辑，不直接复制其浏览器/桌面组件依赖。[12]

协议兼容规则：新增可选字段允许；必填字段、语义、enum收窄等breaking变更需API主版本或明确capability。消息状态相关未知enum不能当success；保留原始未知值用于脱敏诊断。上游契约版本/commit、adapter版本、BFF协议、App runtimeVersion都写入诊断摘要，不带凭据。

## 17. 部署、监控、备份与升级

### 17.1 首版部署清单（待授权执行）

- 公网域名+有效TLS，反向代理开启WS，idle timeout大于应用心跳；request-body限制与App capability一致。
- BFF API/worker使用独立进程或同镜像不同entry，PostgreSQL和S3只允许必要访问。先单BFF实例，不提前引入分布式广播问题。
- Connector在Hermes同主机独立监督服务运行，配置自身spool/staging容量与权限；不为启动Connector重启现有Gateway。
- 日志目录、spool目录、临时媒体目录明确分开；磁盘保留阈值触发拒绝新接纳，不能满盘后静默丢事件。
- 审批、Push、S3、API凭据使用部署秘密存储；文档与示例全部 `[REDACTED]`，不从调试响应复制真实token。
- “无需手机VPN”必须验证手机→API、对象存储、Push，以及Hermes主机→模型/工具四条链路。任一可达不代表其余可达；域名/服务地区选型以实际网络测试为准。

### 17.2 监控指标

| 指标 | 维度/用途 | 初始告警建议 |
|---|---|---|
| api_accept_latency / errors | route+error_code，不用message_id作标签 | p95持续恶化或5xx突升 |
| command_oldest_age | backend+kind | 超过消息TTL的十分之一即预警 |
| connector_last_seen / spool_bytes | backend | 离线/接近磁盘配额 |
| upstream_replay_gap_total | adapter_version | 升级后增长回滚评估 |
| unsettled_admissions / unknown_controls | backend+profile | 任一长期unknown需人工对账 |
| final_pending_age | Topic结果完整性 | 终态已有但final投影持续缺失 |
| feed_lag / snapshot_restart_count | 采样设备聚合 | 重连反复快照、版本不兼容 |
| push_provider_errors / invalid_tokens | provider+environment | 接纳下降；不命名为设备送达率 |
| inbox_missing_source_reconciliation | producer | 来源可核对时才测完整性 |
| upload_verify_fail / staging_fail | MIME类别+backend | 大量失败或路径校验拒绝 |

trace用request_id→submission_id→command_id→admission_id→inbox_item_id串联，但进入普通指标时降为聚合维度；正文、工具参数、联系人不写通用telemetry。排障包默认只含脱敏状态和版本，用户明确选择后才能附内容。

### 17.3 备份与灾难恢复

建议目标（未实测）：BFF数据RPO≤15分钟、RTO≤2小时，前提是已配置PostgreSQL持续归档和定期恢复演练；只有每日dump时不能声称此RPO。对象存储版本/保留与DB备份一致管理。加密密钥另行备份并限制访问，密钥丢失不能靠DB dump恢复。

恢复顺序：停新写→恢复DB与对象清单→禁用旧device families并重新认证/换feed epoch→部署同schema兼容版本→恢复Connector只读对账→核对未结command/admission/delivery→确认旧owner终止→开放新写。恢复备份会回退接纳记录，不能盲目把旧outbox全部重发；tombstone、上游receipt与operator审查共同避免重执行。

Connector spool若丢失：能从BFF和上游receipt/transcript恢复的先恢复；无法恢复的原始delta或无稳定ID投递标unknown/limited，不能宣布无损恢复。

### 17.4 版本发布与回滚

- 锁定Expo SDK/RN、Node、PostgreSQL主版本和Hermes adapter基线；不把文档v55路径当当前推荐版本。
- development→preview/internal→production构建渠道分离；签名/Push环境独立。
- 原生module、权限、SQLCipher、Push SDK变化需要新native build；OTA只发与runtimeVersion兼容的JS/assets，不承诺热更新可加原生能力。
- DB迁移采用expand→兼容双读/写窗口→contract，回滚应用版本不自动回滚破坏性数据迁移。
- Hermes升级先运行固定fixture+隔离集成+真机关键链路；失败保留旧adapter，不修改用户运行源代码以“临时兼容”。
- 发布前让现有运行执行完或受控暂停接纳；升级Connector不能把正在运行的任务记成失败并重做。

## 18. 验收与故障注入：从结构检查到真机证明

下面全部是待执行验收，不是本轮测试通过报告。

### 18.1 测试层次

1. **协议与纯函数：** JSON schema、状态转移、UTF-16 reducer、权限判定、幂等hash规范化。
2. **数据库集成：** 真PostgreSQL事务、锁顺序、唯一约束、snapshot retention；不能仅用内存mock替代。
3. **Connector契约：** 固定上游fixtures验证空值/缺省/两路交互；再对隔离Hermes版本实际联调。
4. **移动端持久化：** 真SQLite与文件系统，进程强杀、磁盘满、迁移、密钥错误。
5. **真机网络：** 目标iOS、GMS Android、所需无GMS厂商机，移动网络/Wi-Fi、锁屏、结束进程、权限拒绝。
6. **生产演练：** 备份恢复、撤权、升级回滚、Cron切换及不重做副作用。

### 18.2 必测用例

| ID | 故障/动作 | 通过证据 | 建议测试文件 |
|---|---|---|---|
| AT-01 | 两Profile同名/相同opaque session标识 | 消息/附件/control无串租户 | tests/integration/profile-isolation.test.ts |
| AT-02 | 多Topic并发与单Topic队列 | 并发独立、FIFO受上游控制 | tests/integration/multi-topic.test.ts |
| AT-03 | BFF commit后丢HTTP ACK | 同submission/message仅一份 | tests/faults/submission-lost-ack.test.ts |
| AT-04 | 同ID不同正文或附件 | 409且上游无新增提交 | tests/contracts/idempotency.test.ts |
| AT-05 | Hermes接纳后Connector写receipt前崩溃 | 原身份对账，无新输入/工具重做 | tests/faults/admission-window.test.ts |
| AT-06 | 恢复后principal改变 | 自动提交被阻断并显式待核验 | tests/faults/principal-change.test.ts |
| AT-07 | feed较小序号事务阻塞 | 后序不能先可见形成游标越过 | tests/integration/feed-commit-order.test.ts |
| AT-08 | snapshot翻页中更新/删除/撤权 | 固定cut或失效；无混合页/越权 | tests/integration/snapshot-cut.test.ts |
| AT-09 | snapshot发布与GC并发 | pin正确或明确废弃重建 | tests/integration/snapshot-gc.test.ts |
| AT-10 | App事务commit前后强杀/满盘 | ACK不越过durable cursor | apps/mobile/src/db/__tests__/sync-transaction.test.ts |
| AT-11 | emoji/null边界/重复interim/迟到delta | 不重复字、不破坏字符、final正确 | apps/mobile/src/chat/__tests__/message-reducer.test.ts |
| AT-12 | delta缺口并重启 | repair_job不丢，最终完整块恢复 | apps/mobile/src/sync/__tests__/repair.test.ts |
| AT-13 | 两设备相反审批答案 | 一个BFF claim，真实上游采用可追溯 | tests/faults/control-race.test.ts |
| AT-14 | server-response写出后断线 | sent_unconfirmed/unknown，不虚称批准 | tests/faults/server-response-loss.test.ts |
| AT-15 | control过期、通知迟到、generation变化 | 旧许可无法作用新任务 | tests/integration/control-fencing.test.ts |
| AT-16 | queued查询后立刻started再cancel | UI语义与实际中断目标一致 | tests/faults/cancel-start-race.test.ts |
| AT-17 | 旧Connector失云连接仍能连Hermes | 新writer不自动接管；无双执行 | tests/faults/connector-split-brain.test.ts |
| AT-18 | refresh成功响应丢失/并发/重启 | 同request恢复同child，其他设备不掉线 | tests/faults/refresh-loss.test.ts |
| AT-19 | 撤销设备/成员后用旧WS/URL/通知 | 新请求拒绝，缓存按策略失效 | tests/integration/revocation.test.ts |
| AT-20 | 续传、伪MIME、路径/symlink、跨Profile | 正常文件可用，恶意路径拒绝 | tests/integration/media-security.test.ts |
| AT-21 | 原音持久化各阶段崩溃/STT失败 | 可试听恢复，不丢原音或编文本 | apps/mobile/src/media/__tests__/recording-recovery.test.ts |
| AT-22 | 分享未登录、重复import、多文件、URI失效 | 不误发送、不跨账户、可恢复草稿 | apps/mobile/src/share/__tests__/native-contract.test.ts |
| AT-23 | Push初始与监听重复、Router未ready | 鉴权后只导航一次，旧control只读 | apps/mobile/src/notifications/__tests__/cold-start.test.ts |
| AT-24 | Inbox commit后Push失败 | 冷启动仍读结果，重试只发提醒 | tests/faults/push-outbox.test.ts |
| AT-25 | Cron接收前崩溃/无ID/同文两次 | limited明确，同文两次不错误合并 | plugins/hermes-mobile-delivery/tests/test_identity.py |
| AT-26 | 锁屏/结束进程/禁通知/无GMS | 记录实际状态；能力限制真实可见 | apps/mobile/tests/mobile/push-matrix.yaml |
| AT-27 | 群聊@重放/移除成员 | 一条room消息至多一submission，无DM泄漏 | tests/integration/room-trigger.test.ts |
| AT-28 | 备份恢复与版本回滚 | 未结操作先对账，不批量重发 | tests/faults/restore-reconcile.test.ts |
| AT-29 | 大字体/读屏/减少动态效果 | 核心发送、审批、录音可独立完成 | apps/mobile/tests/mobile/accessibility.yaml |
| AT-30 | final事件到达但历史暂不可见 | final_pending可修复，不发空结果通知 | tests/faults/final-projection.test.ts |

### 18.3 性能与网络门槛

建议验收负载：个人账户、3台设备、5个活跃Topic；另用合成fixture压测，不代表实际模型会并发到该规模。建议目标：
- 已建立连接时BFF接纳p95≤500ms；不含模型排队和生成。
- 收到上游文字到手机可见p95≤300ms；分层记录网络、落盘、渲染，不混成模型首token。
- 本地一万条历史按窗口读取，首屏p95≤1秒；定义具体基准机型后实测。
- 断网恢复且积压不超过一千条事件时，正常网络十秒内恢复一致；超出按分批进度展示。
- 故障注入中传输重试造成的逻辑重复submission为零；外部工具exactly-once不在此保证内。
- Push单独统计provider接纳、设备observed、用户opened；不能拿receipt计算设备到达率。目标机型/网络试验通过前不承诺所有国内网络可达。

这些是开工时可调整的测试目标，不是本次测量结果。

## 19. 可分工工作包与依赖

每个工作包均采用：先失败测试/迁移约束→最小实现→通过测试→联调证据。命令和包脚本要在工程创建后真实定义，不在本方案伪造已存在的`pnpm test`输出。

| 包 | 输入/依赖 | 主要写入范围 | 交付物与完成条件 |
|---|---|---|---|
| W00 契约冻结 | 本规格、设备/网络选择 | packages/protocol、docs/adr | Mobile/Connector schema、错误码、状态机；JSON样例校验；API差异签字 |
| W01 原生与接入验证 | W00 | 临时验证工程、adapter fixtures | 真机流式、审批/clarify、图片、冷启动Push、独立Cron Inbox；报告不能只mock |
| W02 BFF安全与模型 | W00 | services/bff/auth、migrations、repositories | 配对/refresh/ACL/复合FK；AT-01/04/18/19 |
| W03 Connector核心 | W00，W01确认契约 | services/connector、packages/hermes-adapter | attach/能力/submit/receipt/spool/recovery；AT-05/06/16/17 |
| W04 feed与snapshot | W02 | services/bff/sync、workers、App sync | commit-ordered feed、immutable snapshot、pin/repair；AT-07至12 |
| W05 App可靠聊天 | W00+W02/W03/W04集成 | apps/mobile/chat/db/outbox、页面 | 多Profile/Topic、流式、草稿、断线；AT-02/03/10/11 |
| W06 审批与控制中心 | W03+W04 | BFF controls、App controls | 两路协议、多问题、CAS、unknown；AT-13/14/15 |
| W07 媒体和语音 | W02+W03 | BFF media、Connector staging、App media | 续传/输出/Range、原音/STT/TTS；AT-20/21 |
| W08 Inbox与推送 | W02+W04、W01设备验证 | BFF notifications、App notifications/modules | provider adapter、receipt、冷启动；AT-23/24/26 |
| W09 主动投递插件 | W03+W08 | plugins/hermes-mobile-delivery | spool、delivery身份、主动消息与Cron；AT-25，limited如实标注 |
| W10 剩余交互对等 | W05/W06/W07 | App share、BFF rooms/search/export/presets | 分享、位置/联系人、回应、群聊/@、技能；AT-22/27/29 |
| W11 生产加固 | 全部集成 | deploy/runbooks、监控、备份 | 密钥/日志检查、恢复/回滚；AT-28/30与真机完整矩阵 |
| W12 最终验收与迁移 | W11 | docs/release-evidence、迁移清单 | 每个范围项标verified或阻塞；用户确认后逐项切换，不提前删Telegram |

安全并发：W02/W03可并行，W04/W07/W08在各自依赖满足后并行，UI先按冻结fixture开发但不能靠fixture验收。protocol、迁移版本分配和最终集成各有单一owner，避免多人改同一schema。默认profile/技术负责人负责最终整合；本任务没有生活/金融路由需求。

建议阶段门：
- **Gate A 可行性：** W01整条链路真机证明；如果目标无GMS推送失败或Cron身份不足，先解决而非继续堆UI。
- **Gate B 核心可用：** W02—W06核心聊天与恢复；可以个人试用，不称全量。
- **Gate C 功能对等：** 媒体、主动投递、分享、群聊与技能等矩阵逐项通过，安全交互缺口有已验证替代流程。
- **Gate D 生产迁移：** 备份恢复、撤权、监控、发布/回滚和用户目标网络通过；经授权再切Cron目的地。

不在未确认目标手机、人员投入及发行方式前给出伪精确工期；可在W01结束后基于实测缺口与人力估算。每包都必须交付测试报告/日志句柄/构建标识，不以“代码已写”代表通过。

## 20. 风险、待确认决策与默认处理

| 决策 | 当前推荐默认 | 何时必须确认 |
|---|---|---|
| 主要手机与GMS状态 | iOS+Android设计保留，实际先验一台主力机 | W01开始前，决定Push SDK与构建 |
| 服务部署地区/域名 | 手机和Hermes都可稳定访问的单域名 | 购置/部署前；不承诺任意地区无VPN |
| 发行方式 | 先内部development/preview build | 真机安装/正式签名和商店发布前 |
| 用户范围 | 个人单account、多设备；群聊独立后续包 | 不在个人版默认开放公网注册 |
| 聊天保留/本地加密 | 服务端加密+SQLCipher候选、显式删除策略 | 有真实个人内容前必须验收 |
| 旧Telegram会话 | 默认不自动接管写权限 | 专项owner/handoff验证后用户确认 |
| Cron严格投递身份 | 优先公开插件；无稳定ID降级limited | 宣称全量替代前必须解决或明确接受限制 |
| 核心源码变更 | 不改 | 若插件无法满足要求，单独提案并获授权 |

最大的技术风险不是聊天页面，而是原生推送在实际网络的表现、两种控件协议的恢复语义、上游未知执行的对账，以及主动投递在插件边界之外的缺口。架构把它们前置验证，不依赖后期补丁掩盖。

## 21. 本轮交付与验证边界

本轮交付的是这一份整合后的工程设计规格书；三份专项笔记只是审阅输入，不要求开发者自行拼接，也不作为与主文竞争的第二套契约。字段冲突已统一为UTF-16、account级隔离、opaque feed cursor、两路control响应、显式工具白名单和feed head优先锁顺序。

本轮已进行静态源码/官方文档读取及文档结构、JSON示例、引用映射和跨章节一致性检查。未创建Expo应用、BFF或Connector，没有安装依赖、启动服务、创建真实测试会话、调用模型或修改运行中的Hermes；SQL DDL未在PostgreSQL执行，TS签名未编译，真机/集成/故障注入均为后续验收项。任何“通过”只指实际执行的文档检查，不代表系统已经实现。

开始开发的下一步是授权W00/W01并确定主力手机与分发方式，而不是直接把所有工作包同时部署到当前Hermes环境。

## Sources

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
