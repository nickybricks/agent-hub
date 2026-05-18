-- classify/propose joined senders↔messages on LOWER(m.sender_email) and ran a
-- per-sender LOWER(sender_email) subject lookup. LOWER() can't use the plain
-- idx_messages_sender, so each was a 41k-row seq scan — fine in-process on
-- SQLite, catastrophic over the network at multi-tenant scale. Functional
-- index makes the join + LATERAL index-assisted.

CREATE INDEX IF NOT EXISTS idx_messages_lower_sender
  ON public.messages (LOWER(sender_email), user_id);
