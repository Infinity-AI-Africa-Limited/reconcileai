CREATE TABLE `compliance_assessments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(64) NOT NULL,
	`respondentName` varchar(255),
	`respondentEmail` varchar(320),
	`respondentRole` varchar(100),
	`institutionName` varchar(255),
	`institutionType` enum('commercial_bank','microfinance_bank','fintech','payment_processor','corporate_b2b','other'),
	`answers` json NOT NULL,
	`overallScore` int NOT NULL,
	`riskLevel` enum('critical','high','medium','low') NOT NULL,
	`categoryScores` json NOT NULL,
	`aiNarrative` text,
	`consentToContact` boolean NOT NULL DEFAULT false,
	`userId` int,
	`completedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `compliance_assessments_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_assessments_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE INDEX `idx_assessments_token` ON `compliance_assessments` (`token`);--> statement-breakpoint
CREATE INDEX `idx_assessments_email` ON `compliance_assessments` (`respondentEmail`);--> statement-breakpoint
CREATE INDEX `idx_assessments_risk` ON `compliance_assessments` (`riskLevel`);