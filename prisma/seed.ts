// Seed data grows module by module. Module 00 session 2 adds roles, permissions, and the five
// named AIES users (docs/DECISIONS-CONFIRMED.md — "The five users"); later modules append their
// own seed calls here. Empty for now: no models exist yet.

async function main() {
  console.log("No seed data yet — module 00 session 2 adds RBAC seed data.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
