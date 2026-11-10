import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { organizationSummaryResult } from "../server/lib/organization-results.js";
import { listActiveMemberships } from "../server/lib/organizations.js";

export default defineAction({
  description:
    "List the organizations the signed-in user is an active member of, with their role and member count.",
  schema: z.strictObject({}),
  http: { method: "GET" },
  outputSchema: z.object({ organizations: z.array(organizationSummaryResult) }),
  run: async (_args, ctx) => {
    const actor = requireActor(ctx);
    return {
      organizations: await listActiveMemberships(getDb(), actor.email),
    };
  },
});
