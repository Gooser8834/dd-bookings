/* One-shot: promote the sole user in the DB to ADMIN + mark email verified.
   Used when Resend isn't configured yet so verification links can't be sent. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      role: true,
      emailVerified: true,
      createdDate: true,
    },
    orderBy: { createdDate: "desc" },
  });

  console.log(`Found ${users.length} user(s):`);
  for (const u of users) {
    console.log(
      `  id=${u.id}  email=${u.email}  username=${u.username}  role=${u.role}  verified=${u.emailVerified ? "yes" : "no"}`
    );
  }

  if (users.length === 0) {
    console.log("\nNo users yet. Sign up at /auth/signup first.");
    return;
  }
  if (users.length > 1) {
    console.log("\nMore than one user. Aborting to avoid promoting the wrong account.");
    return;
  }

  const u = users[0];
  if (u.role === "ADMIN" && u.emailVerified) {
    console.log("\nAlready an admin with verified email. Nothing to do.");
    return;
  }

  const updated = await prisma.user.update({
    where: { id: u.id },
    data: {
      role: "ADMIN",
      emailVerified: u.emailVerified ?? new Date(),
    },
    select: { id: true, email: true, role: true, emailVerified: true },
  });
  console.log("\nUpdated:");
  console.log(`  id=${updated.id}  email=${updated.email}  role=${updated.role}  verified=${updated.emailVerified ? "yes" : "no"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
