export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // Direct LLM provider (production / Rocket.new / self-hosted)
  // Set DIRECT_LLM_API_KEY to switch away from Manus Forge with zero code changes.
  directLlmApiKey: process.env.DIRECT_LLM_API_KEY ?? "",
  directLlmApiUrl: process.env.DIRECT_LLM_API_URL ?? "",   // e.g. https://api.anthropic.com or https://api.openai.com
  directLlmModel: process.env.DIRECT_LLM_MODEL ?? "",       // e.g. gpt-4o, claude-3-5-sonnet-20241022
  // Woodcore (Fineract) test tenant
  woodcoreDbHost: process.env.WOODCORE_DB_HOST ?? "",
  woodcoreDbPort: parseInt(process.env.WOODCORE_DB_PORT ?? "3306", 10),
  woodcoreDbUser: process.env.WOODCORE_DB_USER ?? "",
  woodcoreDbPassword: process.env.WOODCORE_DB_PASSWORD ?? "",
  woodcoreDbName: process.env.WOODCORE_DB_NAME ?? "",
};
