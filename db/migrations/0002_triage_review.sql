CREATE TABLE "triage_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"messages_processed" integer,
	"messages_moved" integer,
	"messages_queued" integer,
	"watermark" text,
	"status" text,
	"error" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"mailbox_id" integer,
	"reason" text NOT NULL,
	"suggested_action" text,
	"suggested_target" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" text,
	"decided_action" text,
	"created_at" text NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	CONSTRAINT "review_queue_msg_reason_user_idx" UNIQUE("message_id","reason","user_id")
);
--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_review_status" ON "review_queue" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "idx_review_reason" ON "review_queue" USING btree ("reason");
--> statement-breakpoint

-- FK to auth.users + RLS for the two new tables (same pattern as 0001_rls_policies.sql).
ALTER TABLE "triage_runs"
  ADD CONSTRAINT "triage_runs_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "review_queue"
  ADD CONSTRAINT "review_queue_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "triage_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "review_queue" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "triage_runs"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "review_queue"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
