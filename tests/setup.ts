try {
  // .env is optional in CI, where real env vars are supplied directly (see prisma.config.ts).
  process.loadEnvFile(".env");
} catch {
  // ignore missing .env
}
