DROP TABLE IF EXISTS `scout_bridge_jobs`;
--> statement-breakpoint
ALTER TABLE `error_groups` DROP COLUMN `grafana_logs_url`;
--> statement-breakpoint
ALTER TABLE `error_groups` DROP COLUMN `grafana_trace_url`;
