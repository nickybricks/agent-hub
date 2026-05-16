CREATE TABLE "chat_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"tool_call_ref" integer,
	"tool_name" text,
	"created_at" text NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"tool_name" text NOT NULL,
	"tool_input" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"preview" text,
	"result" text,
	"reasoning" text,
	"created_at" text NOT NULL,
	"decided_at" text,
	"user_id" uuid NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_chat_threads_user" ON "chat_threads" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX "idx_chat_messages_thread" ON "chat_messages" USING btree ("thread_id","id");
--> statement-breakpoint
CREATE INDEX "idx_tool_calls_thread" ON "tool_calls" USING btree ("thread_id","id");
--> statement-breakpoint
CREATE INDEX "idx_tool_calls_status" ON "tool_calls" USING btree ("status");
--> statement-breakpoint

-- FK to auth.users + RLS for the three new tables (same pattern as 0002_triage_review.sql).
ALTER TABLE "chat_threads"
  ADD CONSTRAINT "chat_threads_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "tool_calls"
  ADD CONSTRAINT "tool_calls_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tool_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chat_threads"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chat_messages"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tool_calls"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
