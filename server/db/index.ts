import { createGetDb } from "@agent-native/core/db";
import { registerIdentityColumns } from "@agent-native/core/org";
import {
  registerHostAccessResolver,
  registerShareableResource,
} from "@agent-native/core/sharing";

import { resolveOrganizationProjectAccess } from "../lib/organization-access.js";
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

// Organization projects need an active membership as well as ownership or a
// direct share (ADR-020). This covers assertAccess and the framework's share
// actions; `projectAccessWhere` and `list-projects` apply the same rule in SQL.
registerHostAccessResolver("project", resolveOrganizationProjectAccess);

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
