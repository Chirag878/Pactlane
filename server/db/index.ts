import { createGetDb } from "@agent-native/core/db";
import { registerIdentityColumns } from "@agent-native/core/org";
import { registerShareableResource } from "@agent-native/core/sharing";

import * as schema from "./schema.js";

export const getDb = createGetDb(schema);
export { schema };

registerShareableResource({
  type: "project",
  resourceTable: schema.projects,
  sharesTable: schema.projectShares,
  displayName: "Project",
  titleColumn: "name",
  getDb,
  // Projects hold private meeting transcripts, so they are never link-public.
  allowPublic: false,
});

registerIdentityColumns([
  {
    table: "people",
    column: "email",
    emailChange: "retain",
    offboard: "retain",
    reason:
      "Optional contact detail for a meeting participant, not a Pactlane sign-in.",
  },
]);
