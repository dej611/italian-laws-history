import * as duckdb from "@duckdb/duckdb-wasm";
import { dataUrl } from "../data/load";

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

export async function getDuck(): Promise<duckdb.AsyncDuckDBConnection> {
  if (conn) return conn;

  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], {
      type: "text/javascript",
    }),
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();

  // Load lightweight analytics tables from talk data + acts
  const talkResp = await fetch(dataUrl("/data/data.json"));
  const talk = await talkResp.json();
  const actsResp = await fetch(dataUrl("/data/acts.json"));
  const acts = await actsResp.json();

  await conn.query(`
    CREATE TABLE totals AS SELECT
      ${talk.totals.acts}::INTEGER AS acts,
      ${talk.totals.commits}::INTEGER AS commits,
      ${talk.totals.requests}::INTEGER AS requests;
  `);

  await db!.registerFileText("acts.json", JSON.stringify(acts.acts));
  await conn.query(
    `CREATE TABLE acts AS SELECT * FROM read_json_auto('acts.json');`,
  );

  await db!.registerFileText("by_year.json", JSON.stringify(talk.byYear.rows));
  await conn.query(
    `CREATE TABLE by_year AS SELECT * FROM read_json_auto('by_year.json');`,
  );

  return conn;
}

export async function runSelect(sql: string): Promise<unknown[]> {
  const c = await getDuck();
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Solo SELECT consentite");
  }
  if (/\b(insert|update|delete|drop|alter|attach|copy|pragma)\b/i.test(trimmed)) {
    throw new Error("Query non consentita");
  }
  const result = await c.query(trimmed + " LIMIT 50");
  return result.toArray().map((row) => row.toJSON());
}
