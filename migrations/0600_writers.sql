-- WP-7: provider references persisted by writers BEFORE an irreversible provider call
-- (e.g. the Graph immutable draft id), so lookup() can reconcile an uncertain send.

CREATE TABLE writer_provider_refs (
  id          TEXT PRIMARY KEY,
  action_id   TEXT NOT NULL REFERENCES actions(id),
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
  attempt     INTEGER NOT NULL,
  writer      TEXT NOT NULL,
  ref_kind    TEXT NOT NULL,        -- graph_message_id | ...
  ref_value   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (dispatch_id, ref_kind)
);
CREATE INDEX writer_provider_refs_action ON writer_provider_refs(action_id);
