// Writes schema/factory.schema.json from the TypeBox schema in src/config.ts (npm run schema).
import { writeFileSync } from "node:fs";
import { FactoryFile } from "../src/config.ts";

export const SCHEMA_PATH = new URL("../schema/factory.schema.json", import.meta.url);

export function schemaText(): string {
  return JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...FactoryFile }, null, 2) + "\n";
}

if (import.meta.main) {
  writeFileSync(SCHEMA_PATH, schemaText());
  console.log("wrote schema/factory.schema.json");
}
