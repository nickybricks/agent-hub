-- Multi-tenancy fix: messages was PRIMARY KEY (id) — the RFC822 Message-ID
-- alone — so two users could never store the same Message-ID. A second user's
-- scan would ON CONFLICT-update the first user's row (leaving its user_id
-- unchanged) instead of inserting its own, silently dropping almost all of the
-- second user's mail. Make the key tenant-scoped.

ALTER TABLE public.messages DROP CONSTRAINT messages_pkey;
ALTER TABLE public.messages ADD CONSTRAINT messages_pkey PRIMARY KEY (user_id, id);
