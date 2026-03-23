CREATE TABLE `extracted_concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`error_message` text,
	`retry_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learning_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `llm_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`stage` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model_id` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`duration_ms` integer,
	`raw_request` text NOT NULL,
	`raw_response` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `song_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`title` text NOT NULL,
	`artist` text NOT NULL,
	`source_language` text NOT NULL,
	`target_language` text NOT NULL,
	`lyrics` text NOT NULL,
	`genre` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
