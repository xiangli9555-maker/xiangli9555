-- ============================================================
-- Vo Manager · 建库建表 SQL
-- 用于 MySQL 8.0 · utf8mb4 · InnoDB
-- ============================================================

-- 关键：MySQL 8 容器初始化时客户端默认字符集是 latin1，
-- 会把 UTF-8 编码的中文当 latin1 读入 → 存成 utf8mb4 时产生"双重编码"
-- 必须显式声明，才能让下面的 INSERT 中文种子数据正确落库
SET NAMES 'utf8mb4' COLLATE 'utf8mb4_unicode_ci';
SET character_set_client = 'utf8mb4';
SET character_set_connection = 'utf8mb4';
SET character_set_results = 'utf8mb4';

CREATE DATABASE IF NOT EXISTS vo_manager
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE vo_manager;

-- ----------------------------
-- 1. 声优库
-- ----------------------------
CREATE TABLE IF NOT EXISTS voice_actors (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(64)  NOT NULL UNIQUE COMMENT '声优姓名，全局唯一，枚举来源',
  role_type    VARCHAR(32)  NOT NULL DEFAULT '干员' COMMENT '干员/指挥官/路人角色',
  languages    VARCHAR(64)  DEFAULT '中文' COMMENT '中文/英文/中英双语',
  schedule     VARCHAR(128) DEFAULT '—' COMMENT '当前档期文本描述',
  available    TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否可接新角色',
  portfolio_url VARCHAR(512) COMMENT '选角资料链接',
  is_deleted   TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '软删除标记',
  deleted_at   DATETIME     NULL COMMENT '进入回收站时间',
  deleted_by   VARCHAR(64)  NULL COMMENT '删除操作者',
  revision     BIGINT       NOT NULL DEFAULT 1 COMMENT '乐观锁版本',
  created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_role (role_type),
  INDEX idx_avail (available)
) ENGINE=InnoDB COMMENT='声优库';

-- ----------------------------
-- 2. 需求汇总（TAPD 同步）
-- ----------------------------
CREATE TABLE IF NOT EXISTS demands (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  external_id   BIGINT       UNIQUE COMMENT 'TAPD/DFAI Story ID',
  release_plan  VARCHAR(32)  COMMENT '发布计划 Yang1..Yang5',
  version       VARCHAR(32)  COMMENT '版本冗余（同 release_plan）',
  area          VARCHAR(32)  COMMENT '干员/AI/SOL/MP',
  task_name     VARCHAR(255) NOT NULL COMMENT '标题',
  description   TEXT         COMMENT '需求描述',
  video_sync    VARCHAR(16)  DEFAULT '无需视频' COMMENT '音画同步 / 无需视频',
  story_type    VARCHAR(32)  DEFAULT '音频',
  creator          VARCHAR(64)  COMMENT '创建人（需求策划，来自 TAPD）',
  developer        VARCHAR(255) COMMENT '开发人员（可多个）',
  handler          VARCHAR(64)  COMMENT '处理人',
  cn_lines_handler VARCHAR(64)  COMMENT '文案策划（读取 TAPD 单子【台词-中】处理人，只读）',
  clarification    TEXT         COMMENT '需求澄清（PM 可编辑，区别于 TAPD 原始需求概述）',
  progress_lines_cn  VARCHAR(16) DEFAULT '待开始' COMMENT '台词-中 进度：待开始/进行中/已完成/无需',
  progress_lines_en  VARCHAR(16) DEFAULT '待开始' COMMENT '台词-英 进度',
  progress_voice_cn  VARCHAR(16) DEFAULT '待开始' COMMENT '语音-中 进度',
  progress_voice_en  VARCHAR(16) DEFAULT '待开始' COMMENT '语音-英 进度',
  remark        TEXT         COMMENT '备注（手动填）',
  script_doc_url VARCHAR(512) COMMENT '台词表 · 腾讯在线文档 URL（每份需求 1 个）',
  status        VARCHAR(32)  DEFAULT 'new' COMMENT 'new/planning/audited/in_progress/status_1/product_experience/testing/resolved',
  sync_source   VARCHAR(16)  DEFAULT 'manual' COMMENT 'dfai / manual',
  last_synced_at DATETIME    COMMENT '最近同步时间',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_release_area (release_plan, area),
  INDEX idx_status (status),
  INDEX idx_ext (external_id)
) ENGINE=InnoDB COMMENT='需求汇总';

-- ----------------------------
-- 3. 台词表
-- ----------------------------
CREATE TABLE IF NOT EXISTS script_lines (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  demand_id          INT COMMENT '归属需求 id',
  area               VARCHAR(32) COMMENT '冗余：AI/SOL/MP',
  no                 VARCHAR(16) COMMENT '序号',
  voice_actor_id     INT COMMENT '声优 id（下拉选择，禁止手输）',
  text_cn            TEXT COMMENT '文案台词-中',
  text_en            TEXT COMMENT '文案台词-英',
  recorded_text_cn   TEXT COMMENT '录制版台词-中',
  recorded_text_en   TEXT COMMENT '录制版台词-英',
  trigger_condition  VARCHAR(128) COMMENT '触发条件',
  emotion            VARCHAR(64) COMMENT '语言情绪',
  gp_audio_event     VARCHAR(128) COMMENT 'GP Audio Event',
  role_cn            VARCHAR(128) DEFAULT '' COMMENT '游戏角色名（中文，上传台账时记录）',
  va_cn              VARCHAR(128) DEFAULT '' COMMENT '声优姓名-中（按角色从 voice_roles 派生，冗余存储）',
  va_en              VARCHAR(255) DEFAULT '' COMMENT '声优姓名-英',
  remark             VARCHAR(255) COMMENT '备注',
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_demand (demand_id),
  INDEX idx_area (area),
  INDEX idx_va (voice_actor_id),
  FOREIGN KEY (voice_actor_id) REFERENCES voice_actors(id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='台词表';

-- ----------------------------
-- 4. 台词修改留痕
-- ----------------------------
CREATE TABLE IF NOT EXISTS script_line_history (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  script_line_id INT NOT NULL,
  field_name    VARCHAR(64),
  old_value     TEXT,
  new_value     TEXT,
  changed_by    VARCHAR(64),
  changed_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_line (script_line_id)
) ENGINE=InnoDB COMMENT='台词修改留痕';

-- ----------------------------
-- 5. 录制档期
-- ----------------------------
CREATE TABLE IF NOT EXISTS recording_schedules (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  voice_actor_id  INT NULL,
  record_date     DATE NOT NULL,
  language        VARCHAR(16) COMMENT 'cn/en',
  gp_audio_event  VARCHAR(128),
  duration_hours  DECIMAL(4,1) DEFAULT 2.0,
  status          VARCHAR(16) DEFAULT 'pending' COMMENT 'pending/done/canceled',
  demand_id       INT NOT NULL,
  release_plan    VARCHAR(64),
  studio          VARCHAR(128),
  time_slot       VARCHAR(64),
  line_count      INT NOT NULL DEFAULT 0,
  client_draft_id VARCHAR(64) UNIQUE,
  published_at    DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_date (record_date),
  INDEX idx_demand_lang_date (demand_id, language, record_date),
  INDEX idx_va_date (voice_actor_id, record_date),
  FOREIGN KEY (voice_actor_id) REFERENCES voice_actors(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='录制档期';

-- ----------------------------
-- 6. 音频资产库
-- ----------------------------
CREATE TABLE IF NOT EXISTS audio_assets (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  script_line_id INT COMMENT '关联台词行',
  voice_actor_id INT COMMENT '声优',
  version        VARCHAR(32) COMMENT 'MA 5.0/SOL/MP',
  gp_audio_event VARCHAR(128),
  language       VARCHAR(16) COMMENT '中文/英文',
  file_name      VARCHAR(255) NOT NULL,
  file_url       VARCHAR(512) NOT NULL COMMENT '存储路径（本地或 COS）',
  duration       VARCHAR(16) COMMENT '00:03',
  size_bytes     BIGINT,
  uploaded_by    VARCHAR(64),
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_va (voice_actor_id),
  INDEX idx_event (gp_audio_event),
  INDEX idx_ver (version)
) ENGINE=InnoDB COMMENT='音频资产库';

-- ----------------------------
-- 7. 声优库·角色映射表（严格对齐 Excel「声优库.xlsx」10 列）
--   一行 = 一个游戏角色（模块+中文名）→ 中/英配声优+录制地点+录制棚
--   与 voice_actors（真人声优列表）解耦，独立存储
-- ----------------------------
CREATE TABLE IF NOT EXISTS voice_roles (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  module         VARCHAR(32)  NOT NULL COMMENT '一级模块：AI兵/Boss/指挥官/干员/NPC/路人角色/AI系统音',
  role_cn        VARCHAR(128) NOT NULL COMMENT '中文角色名（游戏内角色）',
  gender         VARCHAR(8)   DEFAULT '' COMMENT '男/女',
  role_en        VARCHAR(255) DEFAULT '' COMMENT '英文角色名（Excel 第 4 列）',
  cn_va          VARCHAR(128) DEFAULT '' COMMENT '中文声优（真人姓名）',
  cn_loc         VARCHAR(32)  DEFAULT '' COMMENT '录制地点-中：北京/上海',
  cn_studio      VARCHAR(64)  DEFAULT '' COMMENT '录制棚-中',
  en_va          VARCHAR(255) DEFAULT '' COMMENT '英文声优（真人姓名）',
  en_loc         VARCHAR(32)  DEFAULT '' COMMENT '录制地点-英：LA/UK/北京 等',
  en_studio      VARCHAR(64)  DEFAULT '' COMMENT '录制棚-英',
  sort_order     INT          DEFAULT 0 COMMENT '排序权重（同模块内）',
  remark         TEXT         NULL COMMENT '角色备注',
  casting_note   MEDIUMTEXT   NULL COMMENT '选角资料正文/摘要',
  rec_time_cn    JSON         NULL COMMENT '中文录制档期数组',
  rec_time_en    JSON         NULL COMMENT '英文录制档期数组',
  is_deleted    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '软删除标记',
  deleted_at    DATETIME     NULL COMMENT '进入回收站时间',
  deleted_by    VARCHAR(64)  NULL COMMENT '删除操作者',
  revision      BIGINT       NOT NULL DEFAULT 1 COMMENT '乐观锁版本',
  created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_module (module),
  INDEX idx_role_cn (role_cn)
) ENGINE=InnoDB COMMENT='声优库·角色映射（Excel 10 列）';

-- ============================================================
-- 初始种子数据（用于第一次登录看到有内容）
-- ============================================================

INSERT INTO voice_actors (name, role_type, languages, schedule, available, portfolio_url) VALUES
  ('林小熊', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('莫文凯', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('狩生', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('凃雄飞', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('仔姜', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('彭士腾', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('王天资', '干员', '中文', '—', 1, '北京·居然翁'),
  ('小爵', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('王哲', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('王孜阳', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('张扬', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('大北', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('老鬼(关帅)', '路人角色', '中文', '—', 1, '北京·8082'),
  ('吴凌云', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('金琪', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('七七', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('桑毓泽', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('苏鑫', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('大象', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('小凡', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('立国', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('HBH', '路人角色', '中文', '—', 1, '北京·8082'),
  ('任景行', '路人角色', '中文', '—', 1, '北京·8082'),
  ('朱潇', '路人角色', '中文', '—', 1, '北京·8082'),
  ('刘照坤', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('苏翼', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('贾邱', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('张恩泽', '指挥官', '中文', '—', 1, '北京·8082'),
  ('万纯', '指挥官', '中文', '—', 1, '北京·8082'),
  ('林强', '指挥官', '中文', '—', 1, '北京·居然翁'),
  ('武向彤', '指挥官', '中文', '—', 1, '上海·叽咔'),
  ('卢晓彤', '指挥官', '中文', '—', 1, '上海·叽咔'),
  ('莫云凯', '指挥官', '中文', '—', 1, '北京·居然翁'),
  ('青琳昊', '干员', '中文', '—', 1, '北京·8082'),
  ('姜英俊', '干员', '中文', '—', 1, '北京·8082'),
  ('张琦', '干员', '中文', '—', 1, '上海·叽咔'),
  ('张远韬', '干员', '中文', '—', 1, '北京·8082'),
  ('孟祥龙', '干员', '中文', '—', 1, '上海·叽咔'),
  ('周越', '干员', '中文', '—', 1, '北京·8082'),
  ('戴海嘉', '干员', '中文', '—', 1, '北京·8082'),
  ('言浩', '干员', '中文', '—', 1, '北京·8082'),
  ('穆雪婷', '干员', '中文', '—', 1, '上海·叽咔'),
  ('赵梓涵', '干员', '中文', '—', 1, '上海·叽咔'),
  ('黑石稔(刘雨轩)', '干员', '中文', '—', 1, '上海·叽咔'),
  ('曹真', '干员', '中文', '—', 1, '上海·叽咔'),
  ('陆敏悦', '干员', '中文', '—', 1, '上海·叽咔'),
  ('图特哈蒙', '干员', '中文', '—', 1, '北京·藤韵'),
  ('李洋', '干员', '中文', '—', 1, '上海·叽咔'),
  ('杜晴晴', '干员', '中文', '—', 1, '上海·叽咔'),
  ('苏至豪', '干员', '中文', '—', 1, '上海·叽咔'),
  ('森中人', '干员', '中文', '—', 1, '北京·藤韵'),
  ('李春胤', '干员', '中文', '—', 1, '上海·叽咔'),
  ('王和逸', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('萧清源', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('邹亮', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('唐子晰', '路人角色', '中文', '—', 1, '北京·8082'),
  ('朔小兔(赵欣)', '路人角色', '中文', '—', 1, '北京·8082'),
  ('王宇航', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('苗洋', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('李程远', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('张沛', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('唐策', '路人角色', '中文', '—', 1, '北京·8082'),
  ('汪滢滢', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('唐雅菁', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('姜玉玲', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('孙畅', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('刘北辰', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('高量浩', '路人角色', '中文', '—', 1, '北京·藤韵'),
  ('刘映含', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('周健', '路人角色', '中文', '—', 1, '北京·8082'),
  ('杨洁(小米)', '路人角色', '中文', '—', 1, '北京·8082'),
  ('壮博雄', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('郭聿喆', '路人角色', '中文', '—', 1, '北京·藤韵'),
  ('梁爽', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('刘圣博', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('楚越', '路人角色', '中文', '—', 1, '北京·藤韵'),
  ('阎么么', '路人角色', '中文', '—', 1, '北京·藤韵'),
  ('谢莹', '路人角色', '中文', '—', 1, '上海·叽咔'),
  ('张树彬', '路人角色', '中文', '—', 1, '北京·藤韵'),
  ('知否', '路人角色', '中文', '—', 1, '北京·居然翁'),
  ('宝木中阳', '路人角色', '中文', '—', 1, '北京·藤韵'),
  ('Christopher Lee Parson', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Michael Benyaer', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Haruun Muse', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Matt Wolf', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Ali Faizaan', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Joshua Sterling', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Shridhar Solanki', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Ulf Bjorlin', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Yussef Benelbar', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Mike Bodie', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Omri Rose', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Kerem Erdinc', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Kamran Nikhad', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Debra Wilson', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Allegra Clark', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('James T Alexander', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Elias Toufexis', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('SeanRohani', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Jaouhar Ben Ayed', '路人角色', '英文', '—', 1, 'LA·SIDE；UK·SIDE'),
  ('Mido Hamada', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Scott Joseph', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Will De Renzy-Martin', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Andrew Wheildon-Dennis', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Joshua Manning', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Sam Woolf', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Jason Marnocha', '指挥官', '英文', '—', 1, 'LA·SIDE'),
  ('Keith Silverstein', '指挥官', '英文', '—', 1, 'LA·SIDE'),
  ('Salli Saffioti', '指挥官', '英文', '—', 1, 'LA·SIDE'),
  ('Bec', '指挥官', '英文', '—', 1, '北京·居然翁'),
  ('Josh', '指挥官', '英文', '—', 1, '北京·居然翁'),
  ('Ben Balmaceda', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Alice Lee', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Robyn Addison', '干员', '英文', '—', 1, 'UK·SIDE'),
  ('Gregg Lowe', '干员', '英文', '—', 1, 'UK·SIDE'),
  ('Chris Okawa', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Xanthe Huynh', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Yungi Chang', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Lee Shorten', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Sarah Natochenny', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('MacLeod Andrews
PashaSol（俄）', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Ossian Perret', '干员', '英文', '—', 1, 'UK·SIDE'),
  ('David Hayter', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Claire Mcorlett', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Sky Soleil', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Nezar Alderazi', '干员', '英文', '—', 1, 'UK·SIDE'),
  ('Holly Earl', '干员', '英文', '—', 1, 'UK·SIDE'),
  ('Kevin Kemp', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Phil Sterman', '干员', '英文', '—', 1, 'LA·SIDE'),
  ('Patrick O''Leary', '干员', '英文', '—', 1, 'UK·SIDE'),
  ('AlBa', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('NaWa', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('DaveBMitchell', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Essam Ferris', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Monia Ayachi', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Darin De Paul', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Callie Ray', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Zadrana Wali', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('AleksLe', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Ulka Simone Mohanty', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Naomi Mcdonald', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Bethan Dixon Bate', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('无', '路人角色', '英文', '—', 1, ''),
  ('Matt Lowe', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('John (JS)', '路人角色', '英文', '—', 1, '北京·居然翁'),
  ('Amuche Chukudebelu', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Alex', '路人角色', '英文', '—', 1, '上海·恒声'),
  ('Tariq', '路人角色', '英文', '—', 1, ''),
  ('Farid', '路人角色', '英文', '—', 1, ''),
  ('Kyle', '路人角色', '英文', '—', 1, '上海·恒声'),
  ('Apryl', '路人角色', '英文', '—', 1, '北京·居然翁'),
  ('Kuan', '路人角色', '英文', '—', 1, '上海·恒声'),
  ('AR', '路人角色', '英文', '—', 1, '北京·居然翁'),
  ('Aprol', '路人角色', '英文', '—', 1, '北京·居然翁'),
  ('Aleksandra Siepielska', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Michael Tcherepashenets', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Erica Lindbeck', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('Cynthia Hamidi', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('JerryHabibi', '路人角色', '英文', '—', 1, 'LA·SIDE'),
  ('EmTu', '路人角色', '英文', '—', 1, 'UK·SIDE'),
  ('Amy', '路人角色', '英文', '—', 1, '北京·居然翁'),
  ('SX', '路人角色', '英文', '—', 1, '北京·居然翁'),
  ('RS', '路人角色', '英文', '—', 1, '北京·居然翁')
ON DUPLICATE KEY UPDATE role_type=VALUES(role_type), languages=VALUES(languages), portfolio_url=VALUES(portfolio_url);

INSERT INTO demands
  (release_plan, version, area, task_name, description, video_sync, story_type,
   creator, developer, handler, cn_lines_handler, clarification,
   progress_lines_cn, progress_lines_en, progress_voice_cn, progress_voice_en,
   remark, status)
VALUES
  ('Ma 5','Ma 5','AI','Ma 5.0 合金装备联动语音需求','哈夫克/阴阳线小儿，各2组','无需视频','音频','xiangyuling(向雨林)','','','Ailyayu(玉琳琳)','哈夫克/阴阳线小儿，各2组','已完成','已完成','进行中','待开始','7.15 送出中英 · Ma4 备本录制中英','in_progress'),
  ('Ma 5','Ma 5','AI','Ma 5.0《拿呀大米》TVOS呼喝汇报/NPC演绎 需求','各30句','无需视频','音频','mattwang','','','Ailyayu(玉琳琳)','各30句','进行中','进行中','待开始','待开始','','in_progress'),
  ('Ma 5','Ma 5','AI','Ma 5.0《新蜀道疑武》v0','无需完美同步，峰面16、减法1','音画同步','音频','qimuzhang','','','Ailyayu(玉琳琳)','无需完美同步，峰面16、减法1','已完成','已完成','进行中','待开始','7.15 送出中英 · Ma5 备本录制中英','in_progress'),
  ('Ma 5','Ma 5','SOL','Ma 5.0 巴音干上D阻火克隆星联大战克有sequence需要更本','阵阵评论小队(K30)；哈夫克小狼(K30 各2)；哈夫克(K20)；哈夫克(K30 各2)；小队(K30)（章-7.15号）','无需视频','音频','reevessmu','','','kaiguanyang(阳庆玉)','阵阵评论小队(K30)；哈夫克小狼(K30 各2)；哈夫克(K20)；哈夫克(K30 各2)；小队(K30)（章-7.15号）','已完成','已完成','进行中','待开始','7.17 送评中英','in_progress'),
  ('Ma 5','Ma 5','SOL','Ma 5.0 巴音干2.D 相夫克陌盛联大给克有sequence需要更本','哈夫克小狼(K30)（如阴阳线）；哈夫克小狼(K30)（章-7.15号）；哈夫克小狼(K30)（章-7.15号）','无需视频','音频','reevessmu','','','kaiguanyang(阳庆玉)','哈夫克小狼(K30)（如阴阳线）；哈夫克小狼(K30)（章-7.15号）；哈夫克小狼(K30)（章-7.15号）','已完成','进行中','待开始','待开始','7.17 中英 / 7.20 送英','in_progress'),
  ('Ma 5','Ma 5','SOL','Ma 5.0 单音陪陪监声/双肢体全线','梅本狼陪陪 Q1-1 描本Q2-11 相带Q2-11','音画同步','音频','mingqiu','','','Ailyayu(玉琳琳)','梅本狼陪陪 Q1-1 描本Q2-11 相带Q2-11','进行中','待开始','待开始','待开始','7.25 中英 全部完成','in_progress'),
  ('Ma 5','Ma 5','SOL','Ma 5.0 新音语活地-海外','《平里前系列》感应部Kai-3 峰重Vprox-3 阻重Rapter-5 银服Musse-3 银朋Rapter-5 银服Morse-4 银朋NJ-1，无','无需视频','音频','xiangyanfu(张宇兵)','','','luxxchen(陈勇)','《平里前系列》感应部Kai-3 峰重Vprox-3 阻重Rapter-5 银服Musse-3 银朋Rapter-5 银服Morse-4 银朋NJ-1，无','已完成','已完成','进行中','待开始','2.唐求的75板出 1.3同已','in_progress'),
  ('Ma 5','Ma 5','大战场','Ma 5.0 大战场 前左社会需要更本','各15句','音画同步','音频','zokanghui(闾克重)','','','Ailyayu(玉琳琳)','各15句','进行中','待开始','待开始','待开始','7.30 中英','in_progress'),
  ('Ma 5','Ma 5','大战场','Ma 5.0 大战场 [出行1] -区域切换VO','浓宁双方九易切换语音，各10句','音画同步','音频','mingyliu(向英义)','','','baipeigyuan(白佩园)','浓宁双方九易切换语音，各10句','进行中','待开始','待开始','待开始','7.30 中英','in_progress'),
  ('Ma 5','Ma 5','大战场','Ma 5.0 大战场 [出行3] -区域切换VO','浓宁双方九易切换语音，各10句','音画同步','音频','mingyliu(向英义)','','','baipeigyuan(白佩园)','浓宁双方九易切换语音，各10句','进行中','待开始','待开始','待开始','7.30 中英','in_progress'),
  ('Ma 5','Ma 5','大战场','Ma 5.0 大战场 [东京] -最之进语','长辽泉围双方十10句；哈夫克 击杀语音15句（申7.7）','音画同步','音频','mingyliu(向英义)','','','baipeigyuan(白佩园)','长辽泉围双方十10句；哈夫克 击杀语音15句（申7.7）','待开始','待开始','待开始','待开始','7.7 中英','new'),
  ('Ma 5','Ma 5','大战场','Ma 5.0 大战场 [东京] -距重','女红需要浓宁X10句；G.T.T 上力室X10句；哈夫克双方力玉击杀语音15句；GTU阻阻电斯里力玉','音画同步','音频','mingyliu(向英义)','','','baipeigyuan(白佩园)','女红需要浓宁X10句；G.T.T 上力室X10句；哈夫克双方力玉击杀语音15句；GTU阻阻电斯里力玉','进行中','待开始','待开始','待开始','需前编制7.7 高教场30 申英','in_progress'),
  ('Ma 5','Ma 5','系统','Ma 5.0 隔离运动 --loading入间演绎视频','【平息素同】 老量7.7','无需视频','音频','yizhecao(蒋渊淡)','','','','【平息素同】 老量7.7','待开始','待开始','待开始','待开始','','new'),
  ('Ma 5','Ma 5','系统','Ma 5.0 需求活动','《童子少年 20》(峰达章)：村庄5 列步长军警5 军人 列步 峰前(选五)A(五段)20 阻挤利(选选)5 军人 峰前(选选)B(五段)20 阻挤利(选选)5 军人 5 应至方三方进 高阻服务方(选选)7 五段2','音画同步','音频','luxxchen(陈勇)','','','luochen(陈勇)','《童子少年 20》(峰达章)：村庄5 列步长军警5 军人 列步 峰前(选五)A(五段)20 阻挤利(选选)5 军人 峰前(选选)B(五段)20 阻挤利(选选)5 军人 5 应至方三方进 高阻服务方(选选)7 五段2','待开始','待开始','待开始','待开始','7.30 中英 · 7.30 送出中英','new'),
  ('Ma 5','Ma 5','干员','Ma 5.0 军事线','钱子少年 500句+军事100句','无需视频','音频','jiejieluo(罗英义)','','','','钱子少年 500句+军事100句','待开始','待开始','待开始','待开始','Ma4 送出中英 · 8.75 应至台阵后中英','new'),
  ('Ma 5','Ma 5','干员','Ma 5.0《恒地》-沙漠地A -[恒Ⅰ] 5句','阴阳线Kai15 敢求15 阴阳X5 阴阳K10 阴阳线10 敢求K(15) 20','音画同步','音频','jiejieluo(罗英义)','','','','阴阳线Kai15 敢求15 阴阳X5 阴阳K10 阴阳线10 敢求K(15) 20','待开始','待开始','待开始','待开始','','new'),
  ('Ma 5','Ma 5','干员','Ma 5.0《恒地》-恒黑社会','50句围围应100句','音画同步','音频','jiejieluo(罗英义)','','','','50句围围应100句','待开始','待开始','待开始','待开始','','new');

