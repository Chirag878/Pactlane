import { z } from "zod";

export const personResult = z.object({
  id: z.string(),
  projectId: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  email: z.string().nullable(),
});
