import { closePools, ownerPool } from './db.js';
import { hashPassword } from './security.js';

// Creates the platform's super admin, or resets its password if it exists.
const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SUPER_ADMIN_PASSWORD;

if (!email || !password) throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in .env first');
if (password.length < 12) throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters');

const passwordHash = await hashPassword(password);
const existing = await ownerPool.query(`SELECT id FROM users WHERE agency_id IS NULL AND email = $1`, [email]);

if (existing.rows[0]) {
  await ownerPool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, existing.rows[0].id]);
  console.log(`Password reset for super admin ${email}`);
} else {
  await ownerPool.query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Super admin', $2, 'super_admin')`,
    [email, passwordHash],
  );
  console.log(`Created super admin ${email}`);
}

await closePools();
