CREATE TABLE delegation_broker_jobs (
  action_id TEXT PRIMARY KEY REFERENCES actions(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES delegation_tasks(task_id),
  result_json TEXT
);
