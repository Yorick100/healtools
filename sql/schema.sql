CREATE DATABASE IF NOT EXISTS healtools CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE healtools;

CREATE TABLE IF NOT EXISTS healtools_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_uuid CHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  last_login_at DATETIME NULL,
  last_active_at DATETIME NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_user_uuid(user_uuid), KEY idx_active(last_active_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_wechat_identities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  appid VARCHAR(64) NOT NULL,
  openid VARCHAR(128) NOT NULL,
  unionid VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  last_login_at DATETIME NOT NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_app_openid(appid,openid), UNIQUE KEY uq_user_app(user_id,appid), KEY idx_user(user_id), KEY idx_unionid(unionid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_user_profiles (
  user_id BIGINT UNSIGNED NOT NULL,
  nickname VARCHAR(40) NULL,
  server_version BIGINT NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_user_routines (
  user_id BIGINT UNSIGNED NOT NULL,
  usual_wake_time TIME NULL,
  usual_sleep_time TIME NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  server_version BIGINT NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_consent_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  consent_type VARCHAR(30) NOT NULL,
  version VARCHAR(30) NOT NULL,
  agreed_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_consent(user_id,consent_type,version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_daily_cards (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  health_date DATE NOT NULL,
  card_no TINYINT NOT NULL,
  core_task_type VARCHAR(30) NOT NULL,
  core_mode_id VARCHAR(64) NOT NULL,
  action_id VARCHAR(80) NULL,
  title VARCHAR(120) NULL,
  duration_sec INT NOT NULL DEFAULT 0,
  reason_text VARCHAR(255) NULL,
  plan_id CHAR(36) NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'default',
  active TINYINT NOT NULL DEFAULT 1,
  light_mode TINYINT NOT NULL DEFAULT 0,
  schedule_snapshot_json LONGTEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  completed_at DATETIME NULL,
  star_awarded TINYINT NOT NULL DEFAULT 0,
  server_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_day_card(user_id,health_date,card_no), KEY idx_user_active_date(user_id,active,health_date), KEY idx_plan(plan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_task_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_uuid CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  health_date DATE NOT NULL,
  card_no TINYINT NULL,
  tool_type VARCHAR(30) NOT NULL,
  role VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  client_created_at DATETIME NULL,
  client_updated_at DATETIME NULL,
  server_version BIGINT NOT NULL DEFAULT 1,
  deleted_at DATETIME NULL,
  payload_json LONGTEXT NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_record(record_uuid), KEY idx_user_date(user_id,health_date), KEY idx_tool_done(user_id,tool_type,completed_at), KEY idx_deleted(deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_star_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ledger_uuid CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  health_date DATE NOT NULL,
  card_no TINYINT NOT NULL,
  delta SMALLINT NOT NULL,
  reason VARCHAR(30) NOT NULL,
  award_key VARCHAR(160) NOT NULL,
  source_record_uuid CHAR(36) NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_ledger_uuid(ledger_uuid), UNIQUE KEY uq_award(award_key), KEY idx_user_date(user_id,health_date), KEY idx_user_created(user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_sync_changes (
  change_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  resource_type VARCHAR(40) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  operation VARCHAR(12) NOT NULL,
  server_version BIGINT NOT NULL,
  changed_at DATETIME NOT NULL,
  PRIMARY KEY(change_id), KEY idx_user_change(user_id,change_id), KEY idx_changed(changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_usage_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  event_name VARCHAR(64) NOT NULL,
  health_date DATE NULL,
  params_json LONGTEXT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY(id), KEY idx_event_created(event_name,created_at), KEY idx_user_created(user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS healtools_daily_insights (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  insight_date DATE NOT NULL,
  based_on_date DATE NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'deterministic_v045',
  content_json LONGTEXT NOT NULL,
  generated_at DATETIME NOT NULL,
  PRIMARY KEY(id),
  UNIQUE KEY uq_user_insight_date(user_id,insight_date),
  KEY idx_insight_date(insight_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS healtools_settings (
  setting_key VARCHAR(80) NOT NULL,
  setting_value LONGTEXT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY(setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS healtools_advisor_insights (
 user_id BIGINT UNSIGNED NOT NULL, insight_date DATE NOT NULL, source_hash CHAR(64) NOT NULL,
 provider VARCHAR(32) NOT NULL, content_json LONGTEXT NOT NULL, generated_at DATETIME NOT NULL,
 PRIMARY KEY(user_id,insight_date), KEY idx_generated(generated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS healtools_user_daily_activity (
 user_id BIGINT UNSIGNED NOT NULL, activity_date DATE NOT NULL, first_active_at DATETIME NOT NULL,
 last_active_at DATETIME NOT NULL, request_count INT UNSIGNED NOT NULL DEFAULT 1,
 PRIMARY KEY(user_id,activity_date),KEY idx_activity_date(activity_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
