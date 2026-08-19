-- 迁移：为 script_lines 增加「游戏角色 / 声优姓名」冗余列
-- 用途：上传 v3 台账 xlsx 解析汇总、按声优导出单页发录音棚
-- 在现有 CVM 库上执行一次即可（init.sql 已含这些列，新建库无需再跑）

ALTER TABLE script_lines
  ADD COLUMN role_cn VARCHAR(128) DEFAULT '' COMMENT '游戏角色名（中文，上传台账时记录）' AFTER gp_audio_event,
  ADD COLUMN va_cn   VARCHAR(128) DEFAULT '' COMMENT '声优姓名-中（按角色从 voice_roles 派生）' AFTER role_cn,
  ADD COLUMN va_en   VARCHAR(255) DEFAULT '' COMMENT '声优姓名-英' AFTER va_cn;
