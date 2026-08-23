CREATE TABLE `control_fit_briefs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`workflowName` varchar(255) NOT NULL,
	`operationalProblem` text NOT NULL,
	`accountableOwner` varchar(255) NOT NULL,
	`decisionDeadline` varchar(128) NOT NULL,
	`approvedEvidence` json NOT NULL,
	`baseline` text NOT NULL,
	`successMeasure` text NOT NULL,
	`status` enum('draft','baseline_confirmed','parallel_run','accepted','stopped') NOT NULL DEFAULT 'draft',
	`updatedByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `control_fit_briefs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_control_fit_org` UNIQUE(`organizationId`)
);
