SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'organizations'
  AND COLUMN_NAME = 'aiAssistanceEnabled'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `organizations` ADD COLUMN `aiAssistanceEnabled` boolean NOT NULL DEFAULT true;',
  'SELECT 1;'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
