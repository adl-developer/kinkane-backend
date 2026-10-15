-- Domains whose every short link is switched off, subdomains included, so a
-- blocked phishing page cannot come back with a new query string.
CREATE TABLE IF NOT EXISTS "blocked_link_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"reason" text,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
