import postgres from "postgres";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const tables = await pg`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    ` as { table_name: string }[];
    console.log("Tables:", tables.map((r) => r.table_name).join(", ") || "(none)");

    if (tables.length) {
      const [{ n }] = await pg`SELECT COUNT(*) as n FROM messages` as { n: string }[];
      console.log("messages rows:", n);
      const [{ n: mb }] = await pg`SELECT COUNT(*) as n FROM mailboxes` as { n: string }[];
      console.log("mailboxes rows:", mb);
    }
  } catch (e: unknown) {
    console.error("Error:", (e as Error).message);
  } finally {
    await pg.end();
  }
}

main();
