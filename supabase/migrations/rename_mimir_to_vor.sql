-- Rename agent_key 'mimir' → 'vor' to avoid colliding with the user-facing
-- "Mimir The All Knowing" interactive chatbot oracle.
--
-- Tables touched:
--   agents              (agent_key)
--   agent_runs          (agent_key)
--   agent_actions       (agent_key)
--   agent_config_history (source — 'mimir_suggestion' → 'vor_suggestion')
--
-- Idempotent: re-running has no effect.

UPDATE agents       SET agent_key = 'vor' WHERE agent_key = 'mimir';
UPDATE agent_runs   SET agent_key = 'vor' WHERE agent_key = 'mimir';
UPDATE agent_actions SET agent_key = 'vor' WHERE agent_key = 'mimir';

UPDATE agent_config_history
   SET source = 'vor_suggestion'
 WHERE source = 'mimir_suggestion';
