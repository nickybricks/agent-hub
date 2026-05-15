CREATE TABLE "agent_memory" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"confidence" real,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"superseded_by" integer,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"sender_email" text,
	"mailbox_id" integer,
	"message_ids_json" text NOT NULL,
	"suggested_action" text NOT NULL,
	"score" real NOT NULL,
	"reasoning" text,
	"created_at" text NOT NULL,
	"dismissed_at" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_message_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" text NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	CONSTRAINT "audit_overrides_msg_kind_user_idx" UNIQUE("message_id","kind","user_id")
);
--> statement-breakpoint
CREATE TABLE "audit_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"findings_count" integer,
	"status" text,
	"error" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "folder_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_type" text NOT NULL,
	"match_value" text NOT NULL,
	"action" text NOT NULL,
	"target_folder" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source" text NOT NULL,
	"confidence" real,
	"created_at" text NOT NULL,
	"decided_at" text,
	"last_applied_at" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"account" text NOT NULL,
	"message_count" integer,
	"unread_count" integer,
	"last_scanned_at" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	CONSTRAINT "mailboxes_name_account_user_idx" UNIQUE("name","account","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" integer,
	"sender_email" text NOT NULL,
	"sender_name" text,
	"subject" text,
	"date_received" text NOT NULL,
	"is_read" boolean NOT NULL,
	"size_bytes" integer,
	"scanned_at" text NOT NULL,
	"headers_json" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "move_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"from_mailbox" text NOT NULL,
	"to_mailbox" text NOT NULL,
	"account" text NOT NULL,
	"provider" text NOT NULL,
	"rule_id" integer,
	"batch_id" text NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"applied_at" text NOT NULL,
	"undone_at" text,
	"error" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "proposed_folders" (
	"id" serial PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" text NOT NULL,
	"decided_at" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"messages_scanned" integer,
	"watermark_date" text,
	"status" text,
	"error" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "senders" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"domain" text NOT NULL,
	"display_name" text,
	"category" text,
	"classified_at" text,
	"classification_model" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	CONSTRAINT "senders_email_user_idx" UNIQUE("email","user_id")
);
--> statement-breakpoint
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_log" ADD CONSTRAINT "move_log_rule_id_folder_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."folder_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_kind_key" ON "agent_memory" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "idx_memory_active" ON "agent_memory" USING btree ("superseded_by");--> statement-breakpoint
CREATE INDEX "idx_findings_kind" ON "audit_findings" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_findings_sender" ON "audit_findings" USING btree ("sender_email");--> statement-breakpoint
CREATE INDEX "idx_rules_match" ON "folder_rules" USING btree ("match_type","match_value");--> statement-breakpoint
CREATE INDEX "idx_rules_status" ON "folder_rules" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_messages_sender" ON "messages" USING btree ("sender_email");--> statement-breakpoint
CREATE INDEX "idx_messages_date" ON "messages" USING btree ("date_received");--> statement-breakpoint
CREATE INDEX "idx_messages_mailbox" ON "messages" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "idx_messages_user" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_movelog_batch" ON "move_log" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "idx_movelog_message" ON "move_log" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_movelog_status" ON "move_log" USING btree ("status");