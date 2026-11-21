import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDb } from "@sisaku/db";
import { createImpactServer } from "./server";

// Local and Anvia Studio transport. Reads DATABASE_URL (the start:stdio script loads the root .env).
const { db } = createDb();
serveStdio(() => createImpactServer(db));
