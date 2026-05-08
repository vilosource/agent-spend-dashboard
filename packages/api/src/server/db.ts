/**
 * Postgres connection pool, wrapped behind a thin interface (`Db`) so
 * tests can swap in an in-memory fake without touching `pg`.
 *
 * The interface exposes only the three ops the auth layer needs in
 * phase 0.3.3: count users (for the first-user-becomes-admin bootstrap),
 * find user by email (for repeat logins), insert user (for new logins).
 *
 * Schema: see deploy/docker-compose/postgres/init/002_auth.sql.
 */

import { Pool as PgPool, type Pool } from "pg";

export type UserRole = "admin" | "developer";

export interface UserRow {
	readonly email: string;
	readonly name: string | null;
	readonly role: UserRole;
}

export interface Db {
	countUsers(): Promise<number>;
	findUserByEmail(email: string): Promise<UserRow | null>;
	insertUser(input: { email: string; name: string | null; role: UserRole }): Promise<UserRow>;
	close(): Promise<void>;
}

export function createDb(databaseUrl: string): Db {
	const pool: Pool = new PgPool({ connectionString: databaseUrl });
	return {
		async countUsers() {
			const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
			return Number.parseInt(rows[0]?.count ?? "0", 10);
		},

		async findUserByEmail(email: string) {
			const { rows } = await pool.query<{ email: string; name: string | null; role: UserRole }>(
				"SELECT email, name, role FROM users WHERE email = $1",
				[email],
			);
			const row = rows[0];
			return row ? { email: row.email, name: row.name, role: row.role } : null;
		},

		async insertUser({ email, name, role }) {
			const { rows } = await pool.query<{ email: string; name: string | null; role: UserRole }>(
				`INSERT INTO users (email, name, role)
				 VALUES ($1, $2, $3)
				 RETURNING email, name, role`,
				[email, name, role],
			);
			const row = rows[0];
			if (!row) throw new Error("INSERT users RETURNING produced no row");
			return { email: row.email, name: row.name, role: row.role };
		},

		async close() {
			await pool.end();
		},
	};
}
