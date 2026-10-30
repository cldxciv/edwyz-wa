// Bootstrap helper: marks a user's email as verified so the first platform admin can sign in without email delivery.
//   node scripts/verify-user.mjs you@example.com
// Needs DATABASE_URL in .env. Only touches the one user row; the email must also be listed in PLATFORM_ADMIN_EMAILS to use /admin.
import pg from "pg";

process.loadEnvFile(".env");
const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/verify-user.mjs <email>");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rowCount } = await client.query(`UPDATE "User" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()) WHERE lower(email) = $1`, [email]);
  console.log(rowCount ? `Verified ${email}.` : `No user found for ${email}.`);
  process.exitCode = rowCount ? 0 : 1;
} finally {
  await client.end();
}
