ALTER TABLE "agents" ADD COLUMN "headline_threads" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "headline_message" text DEFAULT '' NOT NULL;