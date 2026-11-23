// Creates the boutique's first owner account. Run once on the server:
//   node src/scripts/createOwner.js --name "Owner Name" --email owner@example.com
// Prints a temporary password once; it must be changed, and two-step login set up, at first sign-in.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { connectDb, disconnectDb } from "../db.js";
import { User } from "../models/index.js";
import { hashPassword, temporaryPassword } from "../security/password.js";

const { values } = parseArgs({ options: { name: { type: "string" }, email: { type: "string" } } });
if (!values.name || !values.email) {
  console.error('Usage: node src/scripts/createOwner.js --name "Owner Name" --email owner@example.com');
  process.exit(1);
}

const config = loadConfig();
await connectDb(config.MONGODB_URI);
const email = values.email.trim().toLowerCase();
if (await User.exists({ tenantId: config.TENANT_ID, email })) {
  console.error(`An account with ${email} already exists.`);
  await disconnectDb();
  process.exit(1);
}
const password = temporaryPassword();
await User.create({ tenantId: config.TENANT_ID, name: values.name.trim(), email, role: "owner", passwordHash: await hashPassword(password), mustChangePassword: true });
console.log(`Owner created: ${email}`);
console.log(`Temporary password (shown once): ${password}`);
await disconnectDb();
