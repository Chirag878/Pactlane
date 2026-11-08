import { runMigrations } from "@agent-native/core/db";

import "../db/index.js";
import { migrations } from "../db/migrations.js";

export default runMigrations(migrations, { table: "pactlane_migrations" });
