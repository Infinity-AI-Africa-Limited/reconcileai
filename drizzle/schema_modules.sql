-- Module Configuration Table
-- Allows organizations to enable/disable specific reconciliation modules

CREATE TABLE IF NOT EXISTS module_configurations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  module_type ENUM('transaction_integrity', 'settlement', 'account_level') NOT NULL,
  is_enabled BOOLEAN DEFAULT TRUE NOT NULL,
  configuration JSON, -- Module-specific settings
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
  INDEX idx_module_config_org (organization_id),
  INDEX idx_module_config_type (module_type),
  UNIQUE KEY unique_org_module (organization_id, module_type)
);

-- Add module_type to reconciliation_jobs table
ALTER TABLE reconciliation_jobs 
ADD COLUMN module_type ENUM('transaction_integrity', 'settlement', 'account_level') 
DEFAULT 'transaction_integrity' NOT NULL
AFTER organization_id;

-- Add index for module_type
ALTER TABLE reconciliation_jobs 
ADD INDEX idx_recon_jobs_module (module_type);
