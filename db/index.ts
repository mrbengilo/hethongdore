import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { getDatabase } from "./platform";

export async function getDb() {
  return drizzle(await getDatabase(), { schema });
}
