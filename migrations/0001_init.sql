-- Migration number: 0001 	 initial schema
CREATE TABLE bookmarks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- 번호 재사용 금지 (Vectorize ID와 공유)
  url            TEXT    NOT NULL UNIQUE,
  title          TEXT    NOT NULL DEFAULT '',
  description    TEXT    NOT NULL DEFAULT '',        -- meta description
  memo           TEXT    NOT NULL DEFAULT '',
  content        TEXT    NOT NULL DEFAULT '',        -- 본문 앞부분, 재임베딩용 (검색 제외)
  created_at     INTEGER NOT NULL,                   -- 서버 시각, Unix ms

  embed_status   TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (embed_status IN ('pending', 'embedded', 'indexed')),
  embed_model    TEXT,                               -- 예: '@cf/baai/bge-m3'
  embedding      BLOB,                               -- Float32 x 1024 = 4,096 bytes
  embed_attempts INTEGER NOT NULL DEFAULT 0,         -- 현재 단계의 연속 실패 횟수
  embed_error    TEXT                                -- 마지막 실패 메시지
);

CREATE INDEX idx_bookmarks_created_at ON bookmarks (created_at);

-- 아직 인덱싱이 끝나지 않은 소수의 행만 담는 부분 인덱스 (Cron 조회용)
CREATE INDEX idx_bookmarks_unfinished ON bookmarks (embed_status)
  WHERE embed_status != 'indexed';
