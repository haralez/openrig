import type { Migration } from "../migrate.js";

// What produced the current hook-recorded resume token. A Claude SessionStart hook reports its
// `source` (startup, resume, clear or compact); when the post carries the node's current occupant
// generation and changes the token, the registry records that source and, for `resume`, the token it
// replaced. The identity proof accepts the replaced token in argv only on that evidence (#1077).
// Any other write that changes the token clears both, so they never outlive the token they describe.
// resume_launch_token is the token OpenRig launched this row's Claude process to resume, recorded
// before the launch: the hook can land before any launch path records the token itself.
export const resumeRotationSchema: Migration = {
  name: "099_resume_rotation.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN resume_source TEXT;
    ALTER TABLE sessions ADD COLUMN resume_rotated_from TEXT;
    ALTER TABLE sessions ADD COLUMN resume_launch_token TEXT;
  `,
};
